import {createHash,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,realpathSync,lstatSync,statSync,readdirSync,mkdirSync,writeFileSync,renameSync,unlinkSync,constants} from 'node:fs';
import {open} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {authorizeManagedSource} from './managed-path.mjs';
import {extractFrontmatter,parseSimpleFrontmatter,normalizeEol} from './frontmatter.mjs';
import {extractFirstHeading} from './extractors.mjs';
import {sourceRevision,SourceEditError} from './source-editor.mjs';
import {readPlanStage,readShipsFrontmatter} from './stages.mjs';
import {libraryKind,matchesLibraryStage} from './app-library.mjs';
import {withSemanticClient} from './semantic-search-client.mjs';

const inside=(root,file)=>{const rel=path.relative(root,file);return rel!== '..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel);};
const messages={tool_missing:'gmax is optional and is not installed. Exact search is available.',tool_unavailable:'gmax could not be opened. Check its paths in Settings or update it for existing-index-only search.',unsupported_tool:'This gmax installation does not support existing-index-only document search. Update gmax externally, then retry.',unsupported_daemon:'The running gmax daemon needs the existing-index-only contract. Update it externally, then retry.',no_index:'This checkout has no matching gmax index. Add it through gmax externally, then retry.',index_unavailable:'This gmax index is not ready. Exact search is available.',daemon_unavailable:'Start gmax externally, then retry. Runlist does not start its services.',store_unavailable:'This index store is unavailable to the existing-index-only integration.',embedding_unavailable:'gmax has no available warm embedding worker. Finish its startup or current work externally, then retry.',embedding_mismatch:'The index and embedding runtime do not match. Repair through gmax externally.',host_pressure:'gmax declined the request because host resources could not be admitted. Exact search is available.',busy:'gmax is busy. Retry when its current work finishes.',cancelled:'Semantic search cancelled.',timeout:'Semantic search timed out. Narrow the query or retry.',no_coverage:'No indexed Markdown was found in the checked document scope. Check gmax indexing rules externally.',invalid_response:'gmax returned an unsupported response. Exact search is available.',response_too_large:'gmax returned too much data. Narrow the document scope.',tool_changed:'The saved gmax installation changed. Select its paths again in Settings.',search_unavailable:'Semantic search is unavailable. Exact search is available.'};
const failure=state=>{state=Object.hasOwn(messages,state)?state:'search_unavailable';return {state,message:messages[state],documents:[],sections:[]};};
function validateInstallation(value){
 if(!value||typeof value.nodePath!=='string'||typeof value.entryPath!=='string'||!path.isAbsolute(value.nodePath)||!path.isAbsolute(value.entryPath)||value.nodePath.length>4096||value.entryPath.length>4096)throw new SourceEditError('invalid-request','Use absolute paths for the external Node executable and gmax entry file.');
 const nodePath=realpathSync(value.nodePath),entryPath=realpathSync(value.entryPath),node=statSync(nodePath),entry=statSync(entryPath);
 if(!node.isFile()||!entry.isFile()||entry.size>1024*1024||!['.js','.mjs','.cjs'].includes(path.extname(entryPath)))throw new Error('invalid installation');
 const packagePath=path.resolve(path.dirname(entryPath),'../package.json');
 if(statSync(packagePath).size>65536||!['node','node.exe'].includes(path.basename(nodePath)))throw new Error('invalid runtime');
 const packageBytes=readFileSync(packagePath),pkg=JSON.parse(packageBytes.toString('utf8'));
 if(pkg.name!=='grepmax')throw new Error('not gmax');
 return {nodePath,entryPath,identity:`${node.dev}:${node.ino}:${node.size}:${node.mtimeMs}:${createHash('sha256').update(readFileSync(entryPath)).update(packageBytes).digest('hex')}`,version:pkg.version};
}
function discover(){
 const candidates=[];
 for(const directory of (process.env.PATH??'').split(path.delimiter).filter(p=>path.isAbsolute(p)))candidates.push({nodePath:path.join(directory,process.platform==='win32'?'node.exe':'node'),entryPath:path.join(directory,'gmax')});
 const nvm=path.join(os.homedir(),'.nvm/versions/node');try{for(const version of readdirSync(nvm).filter(v=>/^v\d+\.\d+\.\d+$/.test(v)).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true})).slice(0,12))candidates.push({nodePath:path.join(nvm,version,'bin/node'),entryPath:path.join(nvm,version,'lib/node_modules/grepmax/dist/bin.js')});}catch{}
 if(process.platform==='win32')for(const prefix of [process.env.APPDATA&&path.join(process.env.APPDATA,'npm')].filter(Boolean))for(const candidate of candidates.slice(0,32))candidates.push({nodePath:candidate.nodePath,entryPath:path.join(prefix,'node_modules/grepmax/dist/bin.js')});
 for(const candidate of candidates.slice(0,80))try{return validateInstallation(candidate);}catch{}
 return null;
}
const defaultSettings=()=>path.join(process.env.XDG_CONFIG_HOME??(process.platform==='win32'?process.env.APPDATA??os.homedir():path.join(os.homedir(),'.config')),'runlist/semantic-search.json');
export function createAppSemanticSearch({config,library,settingsFile=defaultSettings(),connect=withSemanticClient,timeoutMs=10000}){
 const jobs=new Map();let active=null;
 function installation(){try{if(existsSync(settingsFile)){if(lstatSync(settingsFile).isSymbolicLink()||statSync(settingsFile).size>16384)return null;const value=JSON.parse(readFileSync(settingsFile,'utf8'));if(value.nodePath&&value.entryPath){const current=validateInstallation(value);return current.identity===value.identity?current:null;}}}catch{return null;}return discover();}
 function settings(){const selected=installation();return {available:!!selected,nodePath:selected?.nodePath??'',entryPath:selected?.entryPath??'',version:selected?.version??null,experimental:true,readiness:'not_checked',message:selected?'External gmax was found. Index and embedding readiness are checked only when you search. Semantic search is experimental; text search remains available.':messages.tool_missing};}
 function saveSettings(body){if(Object.keys(body).some(k=>!['nodePath','entryPath'].includes(k)))throw new SourceEditError('invalid-request','Choose only the external tool paths.');
   const dir=path.dirname(settingsFile);mkdirSync(dir,{recursive:true,mode:0o700});if(lstatSync(dir).isSymbolicLink()||existsSync(settingsFile)&&lstatSync(settingsFile).isSymbolicLink())throw new SourceEditError('unsafe-local-state','Tool settings must be ordinary local files.');
   if(body.nodePath===''&&body.entryPath===''){if(existsSync(settingsFile))unlinkSync(settingsFile);return settings();}
   let value;try{value=validateInstallation(body);}catch{throw new SourceEditError('invalid-request','Choose a valid external Node executable and grepmax dist/bin.js entry file.');}
   active?.controller.abort();const temp=settingsFile+'.'+randomUUID();writeFileSync(temp,JSON.stringify(value)+'\n',{mode:0o600,flag:'wx'});renameSync(temp,settingsFile);return settings();
 }
 function clean(){for(const [id,job] of jobs)if(job.finished&&Date.now()-job.at>60000)jobs.delete(id);while(jobs.size>=16){const first=[...jobs].find(([,job])=>job.finished);if(!first)break;jobs.delete(first[0]);}}
 const inspect=id=>{const job=jobs.get(id);if(!job)return failure('cancelled');return job.state==='running'?{id,state:'running'}:{id,...job.result};};
 function cancel(id){const job=jobs.get(id);if(job?.state==='running'){job.controller.abort();job.state='complete';job.result=failure('cancelled');}return inspect(id);}
 function start(body){
   if(!body||Object.keys(body).some(k=>!['query','archived','kind','status','type','folder','stage'].includes(k))||typeof body.query!=='string'||body.query.length>500||!body.query.trim()||Object.values(body).some(v=>!['string','boolean'].includes(typeof v)||typeof v==='string'&&v.length>512)||body.archived!==undefined&&typeof body.archived!=='boolean'||body.stage!==undefined&&typeof body.stage!=='string')throw new SourceEditError('invalid-request','Supply a semantic query up to 500 characters and supported document filters.');
   clean();if(jobs.size>=16)throw new SourceEditError('search-busy','Semantic search is finishing cancelled work. Retry shortly.');const previous=active;if(active?.state==='running')cancel(active.id);const job={id:randomUUID(),controller:new AbortController(),state:'running',at:Date.now(),result:null,finished:false};jobs.set(job.id,job);active=job;
   const timer=setTimeout(()=>{job.timedOut=true;job.controller.abort();},timeoutMs);timer.unref();
   job.done=(async()=>{await previous?.done;job.controller.signal.throwIfAborted();return run(body,job.controller.signal);})().then(value=>{if(job.state==='running'){job.result=value;job.state='complete';}},error=>{if(job.state==='running'){job.result=failure(job.timedOut?'timeout':job.controller.signal.aborted?'cancelled':error.code??'search_unavailable');job.state='complete';}}).finally(()=>{clearTimeout(timer);job.at=Date.now();job.finished=true;if(active===job)active=null;});
   return {id:job.id,state:'running'};
 }
 async function run(body,signal){
   const selected=installation();if(!selected)return failure(existsSync(settingsFile)?'tool_changed':'tool_missing');
   const checkout=realpathSync(config.repoRoot),all=await library.all();signal.throwIfAborted();
   let roots=(config.docsRoots??[config.docsRoot]).map(p=>realpathSync(p)).filter(p=>inside(checkout,p));
   if(body.folder){const folder=realpathSync(path.resolve(config.repoRoot,body.folder));if(!inside(checkout,folder))return failure('no_coverage');roots=roots.flatMap(root=>inside(root,folder)?[folder]:inside(folder,root)?[root]:[]);}
   if(!roots.length||roots.length>32)return failure('no_coverage');
   const allowed=new Map(all.flatMap(row=>{try{return [[authorizeManagedSource(path.resolve(config.repoRoot,row.path),config).canonicalPath,row]];}catch{return [];}}));
   const scopePaths=[...allowed.keys()].filter(p=>roots.some(root=>inside(root,p))),paths=[];let pathBytes=0;for(const p of scopePaths){pathBytes+=Buffer.byteLength(p)+8;if(paths.length>=2000||pathBytes>512*1024)break;paths.push(p);}
   return connect(selected,checkout,signal,async client=>{
     const status=await client.tool('document_search_status',{paths});
     if(status.state!=='ready')return failure(status.state);
     if(!Number.isSafeInteger(status.generation)||status.generation<1)return failure('embedding_mismatch');
     if(!status.project||!path.isAbsolute(status.project.root)||!inside(status.project.root,checkout)||!Array.isArray(status.covered)||status.covered.length>paths.length)throw new Error('invalid status');
     const sample=new Set(paths);if(status.covered.some(entry=>typeof entry.path!=='string'||!sample.has(entry.path)))throw new Error('invalid coverage');
     if(!status.covered.length&&paths.length===scopePaths.length)return failure('no_coverage');
     const response=await client.tool('semantic_search',{query:body.query.trim(),prefixes:roots});
     if(response.state!=='ready')return failure(response.state);
     if(response.generation!==status.generation)return failure('embedding_mismatch');
     if(response.root!==status.project.root||response.store!==status.project.store||!Array.isArray(response.matches)||response.matches.length>50)throw new Error('invalid results');
     const documents=[],sections=[],seen=new Set();let bytes=0,stale=0;
     for(const match of response.matches){signal.throwIfAborted();let fd;
       try{
         if(typeof match.path!=='string'||!path.isAbsolute(match.path)||!Number.isInteger(match.startLine)||!Number.isInteger(match.endLine)||match.startLine<1||match.endLine<match.startLine)continue;
         const pointer=authorizeManagedSource(match.path,config);if(!inside(checkout,pointer.canonicalPath))continue;
         const row=allowed.get(pointer.canonicalPath);if(!row||seen.has(row.path)||documents.length>=20)continue;
         const file=authorizeManagedSource(match.path,config).path;
         if(path.relative(config.repoRoot,file).split(path.sep).some(p=>p==='prompts'||p==='.git'||config.excludeDirs?.has(p))||file===config.indexPath)continue;
         fd=await open(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));const before=await fd.stat();if(!before.isFile()||before.size>8*1024*1024||bytes+before.size>128*1024*1024)continue;
         bytes+=before.size;const buffer=Buffer.alloc(before.size);let offset=0;while(offset<buffer.length){signal.throwIfAborted();const read=await fd.read(buffer,offset,buffer.length-offset,offset);if(!read.bytesRead)break;offset+=read.bytesRead;}if(offset!==buffer.length)continue;
         const after=await fd.stat();authorizeManagedSource(file,config);const current=statSync(file);if(before.dev!==current.dev||before.ino!==current.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||current.size!==after.size||current.mtimeMs!==after.mtimeMs)continue;
         const source=buffer.toString('utf8'),parts=extractFrontmatter(source),fm=parseSimpleFrontmatter(parts.frontmatter);
         if(fm.type!==undefined&&typeof fm.type!=='string'||fm.type==='prompt'||/^---\r?\n/.test(source)&&!parts.bodyLineOffset)continue;
         const doc={...row,title:String(fm.title||extractFirstHeading(parts.body)||path.basename(file,'.md')).slice(0,300),type:fm.type??'untyped',status:fm.status??'untyped',kind:libraryKind(fm,row.path)};
         if(doc.kind==='plan'){const stage=readPlanStage(readShipsFrontmatter(parts.frontmatter));doc.stage=stage.word;doc.stageInvalid=stage.invalid;}else{delete doc.stage;delete doc.stageInvalid;}
         const archived=row.path.split('/').includes(path.basename(config.archiveDir??'archived'))||doc.status==='archived';
         if(!matchesLibraryStage(doc,body.stage)||!body.archived&&archived||body.kind&&body.kind!=='all'&&({plans:'plan',hubs:'hub',documents:'document'}[body.kind]??body.kind)!==doc.kind||body.status&&body.status!==doc.status||body.type&&body.type!==doc.type||body.folder&&row.folder!==body.folder&&!row.folder.startsWith(body.folder+'/'))continue;
         const verified=match.hashAlgorithm==='sha256-bytes'&&typeof match.hash==='string'&&/^[a-f0-9]{64}$/.test(match.hash)&&createHash('sha256').update(buffer).digest('hex')===match.hash;
         const lines=normalizeEol(parts.body).split('\n'),at=verified?match.startLine-parts.bodyLineOffset-1:0;
         const excerpt=lines.slice(Math.max(0,at),Math.max(0,at)+4).join(' ').replace(/\s+/g,' ').slice(0,240);
         const revision=sourceRevision(source);documents.push({...doc,excerpt,revision,location:verified?'verified':'changed'});seen.add(row.path);if(!verified){stale++;continue;}
         // Bound the section lookup to ordinary ATX headings; fences/comments never become jump targets.
         let fence=null,comment=false,heading=null;for(let i=0;i<=Math.min(at,lines.length-1);i++){const raw=lines[i];if(raw.includes('<!--'))comment=true;const marker=raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);if(marker&&!comment){if(!fence)fence=marker[1];else if(marker[1][0]===fence[0]&&marker[1].length>=fence.length&&!marker[2].trim())fence=null;}const h=!fence&&!comment&&raw.match(/^ {0,3}#{1,6}\s+(.*?)(?:\s+#+\s*)?$/);if(h)heading={path:row.path,title:h[1].slice(0,200),line:i+1,revision};if(raw.includes('-->'))comment=false;}
         if(heading)sections.push(heading);
       }catch{if(signal.aborted)signal.throwIfAborted();}finally{await fd?.close();}
     }
     return {state:'ready',documents,sections,total:documents.length,limited:true,stale,coverage:{partial:paths.length<scopePaths.length||status.covered.length<paths.length||status.coverage?.partial===true||response.indexState?.degraded===true||Number(response.indexState?.failedFiles)>0||response.indexState?.verifying===true},lastIndexed:status.project.lastIndexed??null,indexUpdating:response.indexState?.indexing===true,message:'Top semantic matches from the existing local index.'};
   });
 }
 return {settings,saveSettings,start,inspect,cancel,close(){for(const job of jobs.values())job.controller.abort();return Promise.allSettled([...jobs.values()].map(job=>job.done));}};
}
