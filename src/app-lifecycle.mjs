import {fork} from 'node:child_process';import {createHash} from 'node:crypto';
import {existsSync,readFileSync,lstatSync,mkdirSync,readdirSync,openSync,fsyncSync,closeSync} from 'node:fs';import path from 'node:path';
import {authorizeRepoGeneratedPath,authorizeManagedDestination} from './managed-path.mjs';import {currentProcessOwner,processStartIdentity,processOwnerLiveness,inspectTransactions,withPathLocks,snapshotFile,replaceSnapshot,createFileExclusive} from './atomic-mutation.mjs';
import {readPlanOwnership,canonicalPlanIdentity} from './pickup.mjs';import {stateDir} from './naming.mjs';import {SourceEditError,sourceRevision,assertPrivateEditorStorage} from './source-editor.mjs';
import {containingRoot} from './path-containment.mjs';
import {isBundledRunlistRuntime} from './desktop-runtime.mjs';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail=(code,message)=>{throw new SourceEditError(code,message);};const json=value=>JSON.stringify(value,null,2)+'\n';
const activeJobs=new Set();
function worker(request,onStart){return new Promise((resolve,reject)=>{
 const env={...process.env};for(const key of Object.keys(env))if(/SESSION|^CODEX_|^OPENCODE_/.test(key))delete env[key];
 const child=fork(new URL('./app-lifecycle-worker.mjs',import.meta.url),[],{env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],execArgv:isBundledRunlistRuntime(process.execPath)?['--max-old-space-size=256','--max-semi-space-size=4']:[]});let report='',result;
 const timer=setTimeout(()=>{child.kill();reject(new SourceEditError('lifecycle-uncertain','The lifecycle runner timed out. Inspect its retained operation before retrying.'));},60_000);
 const append=data=>{if(report.length<128000)report+=data;};child.stdout.on('data',append);child.stderr.on('data',append);child.on('message',value=>{result=value;});child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',()=>{clearTimeout(timer);if(!result)return reject(new SourceEditError('lifecycle-uncertain','The lifecycle runner stopped. Inspect its retained operation before retrying.'));if(!result.ok)return reject(new SourceEditError(result.code,result.message,{report}));resolve({result:result.result,report:report.replace(/\x1b\[[0-9;]*m/g,'')});});try{onStart?.({...currentProcessOwner(),pid:child.pid,processStartIdentity:processStartIdentity(child.pid),processStartedAt:new Date().toISOString()});child.send(request);}catch(error){child.kill();clearTimeout(timer);reject(error);}
 });}
export function createAppLifecycle({config,read,actor}) {
 const directory=path.join(stateDir(config.repoRoot),'editor','lifecycle');
 const safe=input=>{const file=authorizeRepoGeneratedPath(input,config,{kind:'Lifecycle receipt'}).path;let current=config.repoRoot;for(const part of path.relative(config.repoRoot,file).split(path.sep)){current=path.join(current,part);if(existsSync(current)&&lstatSync(current).isSymbolicLink())fail('unsafe-local-state','Lifecycle receipts may not traverse symlinks.');}return file;};
 const location=id=>{if(!uuid.test(id??''))fail('invalid-id','A UUID v4 operation is required.');return safe(path.join(directory,`${id}.json`));};
 function storage(){assertPrivateEditorStorage(config.repoRoot,directory);
   const make=dir=>{safe(dir);if(existsSync(dir)){if(!lstatSync(dir).isDirectory())fail('unsafe-local-state','Receipt storage must be a directory.');return;}make(path.dirname(dir));mkdirSync(dir,{mode:0o700});let fd;try{fd=openSync(path.dirname(dir),'r');fsyncSync(fd);}catch(error){if(!['EINVAL','ENOTSUP','EPERM','EACCES','EBADF','EISDIR'].includes(error.code))throw error;}finally{if(fd!==undefined)closeSync(fd);}};make(directory);
 }
 function receipt(id){const file=location(id);if(!existsSync(file))return null;if(!lstatSync(file).isFile()||lstatSync(file).size>16*1024*1024)fail('state-corrupt','Inspect the lifecycle receipt before continuing.');try{const value=JSON.parse(readFileSync(file,'utf8'));if(value.id!==id||value.schema!==1||!['reviewed','running','committed','failed','settled-unknown'].includes(value.state)||typeof value.path!=='string'||typeof value.newPath!=='string'||value.file!==path.resolve(config.repoRoot,value.path)||!value.actor||!Array.isArray(value.guards)||value.guards[0]?.path!==value.file||sourceRevision(value.guards[0]?.expectedContent)!==value.expectedRevision)throw new Error('invalid');return value;}catch{fail('state-corrupt','Inspect the lifecycle receipt before continuing.');}}
 function write(value){const file=location(value.id);if(existsSync(file))replaceSnapshot(snapshotFile(file),json(value),{repoRoot:config.repoRoot,locked:true});else createFileExclusive(file,json(value),{repoRoot:config.repoRoot,locked:true,mode:0o600});}
 const own=(context,value)=>{const current=actor(context);if(current.kind!==value.actor.kind||current.id!==value.actor.id)fail('forbidden','This lifecycle review belongs to another actor.');};
 function eligible(context,input){const doc=read(context,input);if(!doc.editable||['flag','decision','prompt'].includes(doc.type))fail('lifecycle-unavailable','Use this document’s domain actions or repair its source before changing lifecycle status.');if(doc.metadata?.record_schema)fail('lifecycle-unavailable','Status changes for structured plans are not available yet. You can continue editing this plan’s text; its current status and history are kept.');const ownership=readPlanOwnership(doc.path,config);if(ownership?.corrupt||ownership?.state==='owned'||doc.status==='in-session')fail('claim-conflict','This source is claimed. Coordinate or release its claim through the CLI first.');
  if(existsSync(directory)){safe(directory);for(const name of readdirSync(directory).filter(n=>n.endsWith('.json'))){const value=receipt(name.slice(0,-5));if(value?.state==='running'&&[value.path,value.newPath].includes(doc.path))fail('lifecycle-repair-required','A lifecycle operation for this document may be interrupted. Inspect its receipt and CLI transactions before starting another change.');}}
  const edits=safe(path.join(stateDir(config.repoRoot),'editor','operations'));if(existsSync(edits))for(const name of readdirSync(edits).filter(n=>n.endsWith('.json'))){const file=safe(path.join(edits,name));let value;try{value=JSON.parse(readFileSync(file,'utf8'));}catch{fail('state-corrupt','Inspect private editor operations before changing lifecycle status.');}if(value.state==='prepared'&&value.path===path.resolve(config.repoRoot,doc.path))fail('lifecycle-repair-required','Inspect the pending editor save before moving this source or changing its lifecycle status.');}
  return doc;}
 function statuses(doc){const rootLabel=path.relative(config.repoRoot,containingRoot(path.resolve(config.repoRoot,doc.path),config.docsRoots??[config.docsRoot])??config.docsRoot).split(path.sep).join('/');return [...(config.typeStatuses?.get(doc.type)??config.rootValidStatuses?.get(rootLabel)??config.validStatuses)].filter(s=>s!=='in-session');}
 function information(context,input){const doc=read(context,input);try{eligible(context,input);return {statuses:statuses(doc),current:doc.status,enabled:true};}catch(error){return {statuses:[],current:doc.status,enabled:false,reason:error.message};}}
 async function preview(context,request){const doc=eligible(context,request.path),who=actor(context);if(who.kind!=='human')fail('forbidden','The application lifecycle runner is human scoped.');if(!statuses(doc).includes(request.status)||request.status===doc.status)fail('invalid-status','Choose a different configured status.');if(doc.revision!==request.expectedRevision)fail('revision-conflict','The document changed. Reload it before reviewing lifecycle changes.');if(typeof request.note!=='string'||!request.note.trim()||request.note.length>4000)fail('invalid-request','Give a reason, up to 4,000 characters.');
  const file=path.resolve(config.repoRoot,doc.path),owner=path.join(stateDir(config.repoRoot),'ownership',canonicalPlanIdentity(file,config).key+'.json');
  const guards=[{path:file,expectedContent:doc.source},existsSync(owner)?{path:owner,expectedContent:readFileSync(owner,'utf8')}:{path:owner,absent:true}];if(config.configPath)guards.push({path:config.configPath,expectedContent:readFileSync(config.configPath,'utf8')});
  const requestHash=createHash('sha256').update(JSON.stringify([doc.path,doc.revision,request.status,request.note,who.id])).digest('hex');
  const note=`${request.note.trim().replace(/[\r\n]+/g,' ')} — ${who.label??who.id} (human)`;
  const prepared=await worker({repoRoot:config.repoRoot,configPath:config.configPath,file,status:request.status,note,dryRun:true});storage();
  return withPathLocks([location(request.operationId)],{repoRoot:config.repoRoot},()=>{const prior=receipt(request.operationId);if(prior){own(context,prior);if(prior.requestHash!==requestHash)fail('operation-reused','This ID already belongs to another lifecycle review.');return publicReview(prior);}
   const value={schema:1,id:request.operationId,state:'reviewed',actor:who,requestHash,path:doc.path,file,status:request.status,note,guards,expectedRevision:doc.revision,report:prepared.report,newPath:prepared.result?.newRepoPath??doc.path,at:new Date().toISOString()};write(value);return publicReview(value);
  });
 }
 function publicReview(value){return {operationId:value.id,path:value.path,newPath:value.newPath,status:value.status,report:value.report,state:value.state,result:value.result??null};}
 async function commit(context,{operationId}){storage();const current=withPathLocks([location(operationId)],{repoRoot:config.repoRoot},()=>{const value=receipt(operationId);if(!value)fail('operation-missing','Review this lifecycle change first.');own(context,value);if(value.state==='committed')return value;if(value.state==='running')fail('lifecycle-repair-required','This lifecycle operation may be running or interrupted. Inspect it before starting another change.');if(value.state==='settled-unknown')fail('lifecycle-settled','This operation was acknowledged without replay. Review a new change against the current source.');if(value.state==='failed')fail(value.failure.code,value.failure.message);const doc=eligible(context,value.path);if(doc.revision!==value.expectedRevision)fail('revision-conflict','The source changed since this review. Your review is kept; reload and review it again.');value.state='running';value.parentOwner=currentProcessOwner();write(value);return value;});if(current.state==='committed')return {...publicReview(current),replayed:true};
  const activeKey=config.repoRoot+':'+operationId;activeJobs.add(activeKey);
  try{const outcome=await worker({repoRoot:config.repoRoot,configPath:config.configPath,file:current.file,status:current.status,note:current.note,guards:current.guards,expectedDestination:path.resolve(config.repoRoot,current.newPath),dryRun:false},owner=>withPathLocks([location(operationId)],{repoRoot:config.repoRoot},()=>{const value=receipt(operationId);value.workerOwner=owner;write(value);}));return withPathLocks([location(operationId)],{repoRoot:config.repoRoot},()=>{const value=receipt(operationId);if(value.state!=='running')fail('lifecycle-repair-required','The retained lifecycle outcome changed while the runner was finishing. Inspect it before continuing.');value.state='committed';value.result=outcome.result;value.report=outcome.report;write(value);return publicReview(value);});}
  catch(error){withPathLocks([location(operationId)],{repoRoot:config.repoRoot},()=>{const value=receipt(operationId);value.failure={code:error.code??'lifecycle-failed',message:error.message};if(error.code!=='lifecycle-uncertain'&&existsSync(current.file)&&sourceRevision(readFileSync(current.file,'utf8'))===current.expectedRevision&&inspectTransactions(config.repoRoot).every(tx=>tx.generation==='old'&&tx.resolvable)){value.state='failed';}write(value);});throw error;}
  finally{activeJobs.delete(activeKey);}
 }
 function currentDocument(context,value){const target=path.resolve(config.repoRoot,value.newPath);return existsSync(target)?read(context,value.newPath):existsSync(value.file)?read(context,value.path):null;}
 const running=value=>activeJobs.has(config.repoRoot+':'+value.id)||(value.workerOwner?processOwnerLiveness(value.workerOwner)!=='dead':value.parentOwner&&processOwnerLiveness(value.parentOwner)!=='dead');
 function inspect(context,{operationId}){const value=receipt(operationId);if(!value)return null;own(context,value);return {...publicReview(value),canAcknowledge:value.state==='running'&&!running(value),failure:value.failure??null,settlement:value.settlement??null,current:currentDocument(context,value)};}
 function settle(context,{operationId,expectedRevision,note}){
  storage();const existing=receipt(operationId);if(!existing)fail('operation-missing','There is no retained lifecycle operation.');own(context,existing);
  return withPathLocks([location(operationId),existing.file,path.resolve(config.repoRoot,existing.newPath)],{repoRoot:config.repoRoot},()=>{
   const value=receipt(operationId);own(context,value);if(value.state!=='running')fail('invalid-request','Only an uncertain lifecycle operation can be acknowledged.');
   if(running(value))fail('operation-running','The lifecycle runner is still active or cannot be verified as stopped. Wait before acknowledging its outcome.');
   if(actor(context).kind!=='human')fail('forbidden','A human must acknowledge an inspected lifecycle outcome.');
   if(typeof note!=='string'||!note.trim()||note.length>4000)fail('invalid-request','Record what you inspected, up to 4,000 characters.');
   if(inspectTransactions(config.repoRoot).length)fail('lifecycle-repair-required','Inspect and resolve retained CLI transactions with runlist doctor --transactions before acknowledging this operation.');
   const current=currentDocument(context,value);if(!current||current.revision!==expectedRevision)fail('revision-conflict','The current source changed. Inspect the operation again before acknowledging it.');
   value.state='settled-unknown';value.settlement={by:actor(context),at:new Date().toISOString(),reason:note.trim(),outcome:'unknown',current:{path:current.path,revision:current.revision,status:current.status}};write(value);
   return {...publicReview(value),current,settlement:value.settlement};
  });
 }
 function list(context){
  safe(directory);if(!existsSync(directory))return {items:[],unavailable:0};
  const items=[];let unavailable=0;
  for(const name of readdirSync(directory).filter(n=>n.endsWith('.json')&&uuid.test(n.slice(0,-5))))try{
   const value=receipt(name.slice(0,-5));if(value.actor.id!==actor(context).id||!['reviewed','running','failed'].includes(value.state))continue;own(context,value);
   // Use the same path authorization as document opening, including exclusions.
   authorizeManagedDestination(path.resolve(config.repoRoot,value.newPath),config);
   let doc=null;try{doc=currentDocument(context,value);}catch{unavailable++;continue;}
   if(!doc){unavailable++;continue;}
   items.push({kind:'lifecycle',path:doc.path,operationId:value.id,state:value.state,at:value.at,available:true,newPath:value.newPath});
  }catch{unavailable++;}
  return {items,unavailable};
 }
 return {information,preview,commit,inspect,settle,list};
}
