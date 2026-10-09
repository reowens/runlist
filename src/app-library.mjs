import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldThread } from 'node:timers/promises';
import { collectDocFiles } from './index.mjs';
import { authorizeManagedSource } from './managed-path.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { extractFirstHeading } from './extractors.mjs';
import { isHubDoc, detectBodyRunlistRefs } from './hub.mjs';
import { normalizeStringList } from './util.mjs';
import { getStageDefinitions, readPlanStage, readShipsFrontmatter } from './stages.mjs';

const list = value => normalizeStringList(value).map(v=>v.slice(0,200)).slice(0,40);
const repoPath = (file,config) => path.relative(config.repoRoot,file).split(path.sep).join('/');
async function readHeader(fd,size) {
  const limit=Math.min(128*1024,size),chunks=[];let length=0,source='';
  while(length<limit){
    const bytes=Buffer.alloc(Math.min(4096,limit-length)),{bytesRead}=await fd.read(bytes,0,bytes.length,length);
    if(!bytesRead)break;
    chunks.push(bytes.subarray(0,bytesRead));length+=bytesRead;
    source=Buffer.concat(chunks,length).toString('utf8');
    const parts=extractFrontmatter(source),complete=parts.bodyLineOffset>0||!/^---\r?\n/.test(source);
    if(complete&&(parseSimpleFrontmatter(parts.frontmatter).title||extractFirstHeading(parts.body.slice(0,parts.body.lastIndexOf('\n')+1))))break;
  }
  return {source,bytesRead:length};
}
export function libraryKind(fm,documentPath) {
  return isHubDoc({type:fm.type,path:documentPath,executionMode:fm.execution_mode,refFields:{runlist:list(fm.runlist)}}) ? 'hub' : fm.type==='plan' ? 'plan' : 'document';
}
export function matchesLibraryStage(row, stage) {
  return !stage || row.kind==='plan' && (stage==='@unset'?row.stage===null&&!row.stageInvalid:stage==='@invalid'?row.stageInvalid:row.stage===(stage.startsWith('word:')?stage.slice(5):stage));
}
export function libraryStageComparator(config) {
  const order=new Map(getStageDefinitions(config).map((stage,index)=>[stage.word,index]));
  const rank=row=>row.stageInvalid?order.size+2:row.stage===null?order.size+1:order.get(row.stage)??order.size;
  return (a,b)=>rank(a)-rank(b)||(rank(a)===order.size?String(a.stage).localeCompare(String(b.stage)):0);
}
export function sortLibraryRows(rows,params,config) {
  const sort=params.get('sort'),compare=sort==='title'?(a,b)=>a.title.localeCompare(b.title)||a.path.localeCompare(b.path):sort==='path'?(a,b)=>a.path.localeCompare(b.path):(a,b)=>String(b.updated??'').localeCompare(String(a.updated??''))||a.path.localeCompare(b.path);
  const stage=params.get('group')==='stage'&&params.get('kind')==='plans'?libraryStageComparator(config):()=>0;
  return rows.sort((a,b)=>stage(a,b)||compare(a,b));
}
export function createDocumentLibrary(config,{refreshMs=15_000}={}) {
  const roots=[...(config.docsRoots??[config.docsRoot])].sort((a,b)=>b.length-a.length);
  const sourceConfig=file=>{const root=roots.find(root=>{const rel=path.relative(root,file);return rel!== '..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel);});return root?{repoRoot:config.repoRoot,docsRoots:[root],docsRoot:root}:config;};
  let rows=[],byPath=new Map(),cache=new Map(),pending,pendingMode,lastScan=0,generation=0,stats={};
  let fullDirty=true,knownFiles=new Set(),unavailable=new Set();
  const dirty=new Set();
  function excluded(documentPath) {return documentPath.split('/').some(p=>p==='prompts'||p==='.git'||config.excludeDirs?.has(p)) || path.resolve(config.repoRoot,documentPath)===config.indexPath;}
  function invalidate(documentPaths) {
    if(documentPaths===undefined){fullDirty=true;dirty.clear();return;}
    for(const input of Array.isArray(documentPaths)?documentPaths:[documentPaths]) {
      if(typeof input!=='string'){fullDirty=true;dirty.clear();return;}
      const file=path.resolve(config.repoRoot,input),relative=repoPath(file,config);
      if(!file.endsWith('.md')||excluded(relative)||!roots.some(root=>{const rel=path.relative(root,file);return rel!== '..'&&!rel.startsWith(`..${path.sep}`)&&!path.isAbsolute(rel);}))continue;
      dirty.add(file);
      // A burst of changes falls back to discovery instead of retaining an
      // unbounded queue. Ordinary saves retain only their changed paths.
      if(dirty.size>512){fullDirty=true;dirty.clear();return;}
    }
  }
  async function refresh(force=false) {
    // Join an existing full discovery. A force request during a targeted read
    // still schedules discovery after it finishes.
    if(force&&pendingMode!=='full')fullDirty=true;
    for(;;) {
      if(pending){await pending;continue;}
      const full=fullDirty||!lastScan||Date.now()-lastScan>=refreshMs;
      if(!full&&!dirty.size)return;
      const changed=[...dirty];dirty.clear();
      if(full)fullDirty=false;
      pendingMode=full?'full':'changed';
      pending=(async()=>{
      const start=performance.now();let headersRead=0,headerBytesRead=0,failures=0,discoveryErrors=0;
      const files=full?collectDocFiles(config,{onError:()=>discoveryErrors++}).filter(file=>!excluded(repoPath(file,config))):changed;
      const next=full?new Map():new Map(cache),nextKnown=full?new Set(files):new Set(knownFiles),nextUnavailable=full?new Set():new Set(unavailable);let index=0;
      const worker=async()=>{while(index<files.length){const file=files[index++],relative=repoPath(file,config);let fd;try{
        const stamp=await lstat(file);if(!stamp.isFile())throw Error('Not a regular document.');
        nextKnown.add(file);nextUnavailable.delete(file);
        const key=`${stamp.dev}:${stamp.ino}:${stamp.size}:${stamp.mtimeMs}:${stamp.ctimeMs}`;
        const cached=cache.get(file);if(cached?.key===key){next.set(file,cached);continue;}
        const authorized=authorizeManagedSource(file,sourceConfig(file));fd=await open(authorized.path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
        const same=(a,b)=>['dev','ino','size','mtimeMs','ctimeMs','mode'].every(key=>a[key]===b[key]);
        if(!same(stamp,await fd.stat()))throw Error('Document changed while opening.');
        const {source,bytesRead}=await readHeader(fd,stamp.size);headersRead++;headerBytesRead+=bytesRead;
        if(!same(stamp,await fd.stat())||!same(stamp,await lstat(file)))throw Error('Document changed while reading.');
        const parts=extractFrontmatter(source),warnings=[],fm=parseSimpleFrontmatter(parts.frontmatter,warnings);
        let row=null;
        if(fm.type!=='prompt') {
          const type=typeof fm.type==='string'?fm.type.slice(0,100):'untyped';
          row={path:relative,bytes:stamp.size,title:String((fm.record_schema==='runlist.record/v1'&&(fm.finding||fm.question))||fm.title||extractFirstHeading(parts.body)||path.basename(file,'.md')).slice(0,300),type,kind:libraryKind(fm,relative),status:String(fm.status||'unknown').slice(0,100),updated:typeof fm.updated==='string'?fm.updated:null,folder:path.posix.dirname(relative),modules:list(fm.modules),surfaces:list(fm.surfaces),parents:normalizeStringList(fm.parent_plan),archived:fm.status==='archived'||relative.split('/').includes(path.basename(config.archiveDir??'archived')),untyped:type==='untyped',metadataWarnings:warnings.length};
        }
        if(row?.kind==='plan'){const stage=readPlanStage(readShipsFrontmatter(parts.frontmatter));row.stage=stage.word;row.stageInvalid=stage.invalid;}
        if(row&&fm.record_schema==='runlist.record/v1')try{const id=JSON.parse(fm.record_data).repository_id;if(/^repo:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))row.recordRepositoryId=id;}catch{}
        // Parsed headings/frontmatter can be V8 substring views into the whole
        // 128 KiB header. Detach the small metadata record before caching it;
        // otherwise a short title/parent can retain an entire document buffer.
        next.set(file,{key,row:row?JSON.parse(JSON.stringify(row)):null});
      }catch(error){next.delete(file);if(error.code==='ENOENT'){nextKnown.delete(file);nextUnavailable.delete(file);}else{failures++;nextUnavailable.add(file);}}finally{await fd?.close();}await yieldThread();}};
      await Promise.all(Array.from({length:12},worker));cache=next;knownFiles=nextKnown;unavailable=nextUnavailable;rows=[...next.values()].flatMap(v=>v.row?[v.row]:[]);byPath=new Map(rows.map(r=>[r.path,r]));
      // Targeted reads must not postpone periodic discovery of external edits.
      if(full)lastScan=Date.now();generation++;
      const previous=stats;
      stats={files:knownFiles.size,checkedFiles:files.length,refreshMode:pendingMode,fullScans:(previous.fullScans??0)+(full?1:0),incrementalRefreshes:(previous.incrementalRefreshes??0)+(full?0:1),headersRead,headerBytesRead,unavailable:unavailable.size,discoveryErrors:full?discoveryErrors:(previous.discoveryErrors??0),refreshFailures:failures,elapsedMs:Math.round(performance.now()-start),indexedAt:new Date(lastScan).toISOString(),generation};
      })().catch(error=>{fullDirty=true;throw error;}).finally(()=>{pending=null;pendingMode=null;});
      // Invalidations received during any await stay queued for the next pass;
      // callers never return a scan that silently consumed a newer mutation.
      await pending;
      if(refreshMs<=0&&!fullDirty&&!dirty.size)return;
    }
  }
  function resolve(ref,from) {
    const clean=String(ref).replace(/^>\s*/,'').split('#')[0].trim();if(!clean.endsWith('.md'))return null;
    const candidates=[path.posix.normalize(path.posix.join(path.posix.dirname(from),clean)),path.posix.normalize(clean.replace(/^\//,''))];
    return candidates.map(p=>byPath.get(p)).find(Boolean)??null;
  }
  function relations(documentPath,fm,body) {
    const parentRefs=normalizeStringList(fm.parent_plan),members=[...new Set([...normalizeStringList(fm.runlist),...(libraryKind(fm,documentPath)==='hub'?detectBodyRunlistRefs(body):[])])];
    const groups=[['Parent hub',parentRefs],['Hub members',members],['Related plans',normalizeStringList(fm.related_plans)],['Related documents',normalizeStringList(fm.related_docs)]];
    const result=groups.flatMap(([label,refs])=>refs.map(ref=>({label,ref,target:resolve(ref,documentPath)})));
    // Parent back-pointers are membership evidence, not arbitrary body links.
    if(libraryKind(fm,documentPath)==='hub')for(const row of rows)if(row.parents.some(ref=>resolve(ref,row.path)?.path===documentPath)&&!result.some(r=>r.label==='Hub members'&&r.target?.path===row.path))result.push({label:'Hub members',ref:row.path,target:row});
    return result.map(r=>({...r,target:r.target?{path:r.target.path,title:r.target.title,status:r.target.status,kind:r.target.kind,type:r.target.type}:null}));
  }
  async function query(params=new URLSearchParams()) {
    await refresh(params.get('refresh')==='1');
    const includeArchived=params.get('archived')==='1',scope=rows.filter(r=>includeArchived||!r.archived),kind=params.get('kind')??'all',status=params.get('status')??'',folder=params.get('folder')??'',type=params.get('type')??'',stage=params.get('stage')??'';
    const words=(params.get('q')??'').slice(0,500).toLowerCase().trim().split(/\s+/).filter(Boolean);
    let matches=scope.filter(r=>(kind==='all'||kind==='documents'&&r.kind==='document'||kind==='hubs'&&r.kind==='hub'||kind==='plans'&&r.kind==='plan')&&matchesLibraryStage(r,stage)&&(!status||r.status===status)&&(!type||r.type===type)&&(!folder||r.folder===folder||r.folder.startsWith(folder+'/'))&&words.every(w=>`${r.title} ${r.path} ${r.status} ${r.type} ${r.modules.join(' ')} ${r.surfaces.join(' ')}`.toLowerCase().includes(w)));
    sortLibraryRows(matches,params,config);
    const number=(key,fallback,max)=>{const n=Number(params.get(key)??fallback);return Number.isInteger(n)&&n>=0?Math.min(n,max):fallback;};
    const limit=Math.max(1,number('limit',50,100)),offset=Math.min(number('offset',0,10_000_000),Math.max(0,Math.floor((matches.length-1)/limit)*limit));
    const counts={all:scope.length,hubs:scope.filter(r=>r.kind==='hub').length,plans:scope.filter(r=>r.kind==='plan').length,documents:scope.filter(r=>r.kind==='document').length};
    const facets=key=>{const counts=new Map();for(const r of scope)counts.set(r[key],(counts.get(r[key])??0)+1);return [...counts].sort(([a],[b])=>a.localeCompare(b)).map(([value,count])=>({value,count}));};
    const stageDefinitions=getStageDefinitions(config),planRows=scope.filter(r=>r.kind==='plan'),stageCounts=new Map();for(const row of planRows){const value=row.stageInvalid?'@invalid':row.stage===null?'@unset':`word:${row.stage}`;stageCounts.set(value,(stageCounts.get(value)??0)+1);}
    const configured=new Set(stageDefinitions.map(s=>`word:${s.word}`)),stages=[...stageDefinitions.map(s=>({value:`word:${s.word}`,label:s.word,meaning:s.meaning,count:stageCounts.get(`word:${s.word}`)??0})),...[...stageCounts].filter(([value])=>!configured.has(value)&&!['@unset','@invalid'].includes(value)).sort(([a],[b])=>a.localeCompare(b)).map(([value,count])=>({value,label:value.slice(5),count,unknown:true})),{value:'@unset',label:'Unset · no stage',count:stageCounts.get('@unset')??0},...(stageCounts.has('@invalid')?[{value:'@invalid',label:'Invalid metadata',count:stageCounts.get('@invalid')}]:[])];
    return {stageDefinitions,group:params.get('group')==='stage'&&kind==='plans'?'stage':null,documents:matches.slice(offset,offset+limit),total:matches.length,inventoryTotal:rows.length,counts,offset,limit,hasMore:offset+limit<matches.length,facets:{stages,statuses:facets('status'),types:facets('type'),folders:facets('folder')},stats};
  }
  return {query,refresh,async all(){await refresh();return rows.map(row=>({...row}));},resolve,relations,invalidate,get stats(){return stats;}};
}
