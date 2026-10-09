import {commitPlatformQualified} from './git-commit-support.mjs';
import {fork} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {gitEnvironment} from './app-git.mjs';
import {commitStore,uuid,fail,hash} from './git-commit-store.mjs';
import {run} from './git-commit-protocol.mjs';
import {currentProcessOwner,processStartIdentity,processOwnerLiveness} from './atomic-mutation.mjs';
// Jobs survive renderer/helper disconnect; no operation ID is ever replayed.
const children=new Map();
function stopped(r){if(!r.workerOwner)return r.state==='reviewed'||r.state==='failed';if(processOwnerLiveness(r.workerOwner)!=='dead')return false;try{process.kill(-r.workerOwner.pid,0);return false;}catch(e){return e.code==='ESRCH';}}
const publicOperation=(r,live)=>({operationId:r.id,state:r.state,running:live,path:r.rows[0]?.path??r.paths[0],paths:r.paths,message:r.message,branch:r.selectedBranch,head:r.head,tree:r.tree??null,commitId:r.commit??null,indexReady:r.indexReady??false,failure:r.failure??null,recovery:r.recovery??null,resolved:!!r.resolved,at:r.at,review:r.state==='reviewed'?r.review:[],execution:{hooks:Object.entries(r.material?.hooks?.files??{}).filter(([,entry])=>entry?.mode&0o111).map(([kind])=>kind),signing:r.material?.signing?.format??'none',filters:(r.material?.filters??[]).map(profile=>profile.name)},canCommit:r.state==='reviewed'&&!live,canRecover:!live&&r.action!=='preview'&&!r.resolved&&['not-committed','committed-index-recovery','committed'].includes(r.state),observedRef:r.observedRef??null,observedIndex:r.observedIndex??null,canSettle:!live&&!r.resolved&&['uncertain-ref-publication','uncertain-external-ref','committed-external-ref'].includes(r.state)&&typeof r.observedRef==='string'&&typeof r.observedIndex==='string',expiresAt:r.expiresAt??null});
export function createAppGitCommits({config,actor,authenticate,git}){
 const root=realpathSync(config.repoRoot),store=commitStore(root,actor);
 const identity=req=>{const candidate=authenticate(req);if(candidate?.kind!=='human'||candidate.id!==actor.id)fail('forbidden','Git commits belong to the authenticated checkout owner.');};
 const platform=()=>{if(!commitPlatformQualified())fail('git-platform-unqualified','Local commits are not yet qualified on this platform and architecture. Use Git; editing and Changes remain available.');};
 function storage(){const r={root};const relative=path.relative(root,store.directory).split(path.sep).join('/');if(run(r,['check-ignore','-q','--',relative+'/'],{allow:[0,1]}).code!==0||run(r,['ls-files','-z','--',relative]).bytes.length)fail('unsafe-local-state','Private Git operations must be ignored and untracked.');store.ensure();}
 function live(r){return children.has(root+':'+r.id)||!stopped(r);}
 function blocker(except){return store.all().find(r=>r.id!==except&&(live(r)||r.action!=='preview'&&!r.resolved&&!(r.state==='committed'&&r.indexReady)));}
 function launch(id,action){
  const token=randomUUID();let child;
  store.update(id,r=>{r.action=action;r.launchToken=token;r.state=action==='preview'?'reviewing':action==='execute'?'starting':r.state;r.parentOwner=currentProcessOwner();delete r.finishedAt;});
  try{
   child=fork(new URL('./git-commit-worker.mjs',import.meta.url),[],{env:gitEnvironment(),detached:true,stdio:['ignore','ignore','ignore','ipc'],execArgv:['--max-old-space-size=192','--max-semi-space-size=4']});
   const key=root+':'+id;children.set(key,child);
   store.update(id,r=>{r.workerOwner={...currentProcessOwner(),pid:child.pid,processStartIdentity:processStartIdentity(child.pid)};});
   const timer=setTimeout(()=>{try{if(processOwnerLiveness(store.read(id)?.workerOwner)==='live')process.kill(-child.pid,'SIGKILL');}catch{}},70000);timer.unref();
   child.once('exit',()=>{clearTimeout(timer);children.delete(key);try{store.update(id,r=>{if(r.action==='preview'&&r.state==='reviewing'){r.state='failed';r.failure={code:r.cancelRequestedAt?'git-cancelled':'git-review-interrupted',message:r.cancelRequestedAt?'The review was stopped. Start a new review when ready.':'The review stopped before completion. Start a new review; no commit was executed.'};}});}catch{}});child.once('error',()=>{clearTimeout(timer);children.delete(key);try{store.update(id,r=>{r.failure={code:'git-job-start',message:'The Git job could not start. Inspect its retained receipt.'};});}catch{}});
   child.send({root,actor,id,action,token});child.unref();child.channel?.unref();
  }catch(error){if(child)try{process.kill(-child.pid,'SIGKILL');}catch{}store.update(id,r=>{r.failure={code:'git-job-start',message:'The Git job could not start. Inspect its retained receipt.'};if(action==='preview')r.state='failed';});throw error;}
  return publicOperation(store.read(id),true);
 }
 async function preview(req,request){
  identity(req);platform();if(!uuid.test(request.operationId??''))fail('invalid-id','Use a UUID v4 local commit review ID.');
  if(typeof request.message!=='string'||!request.message.trim()||Buffer.byteLength(request.message)>8192||request.message.includes('\0')||Buffer.from(request.message).toString('utf8')!==request.message)fail('invalid-request','Write a UTF-8 commit message of at most 8 KiB.');
  const message=request.message.replace(/\n?$/,'\n');if(Buffer.byteLength(message)>8192)fail('invalid-request','The complete commit message must fit in 8 KiB, including its final newline.');const requestHash=hash(JSON.stringify([request.paths,message]));
  const previous=store.read(request.operationId);if(previous){if(previous.requestHash!==requestHash)fail('operation-reused','This operation ID already belongs to another review.');return publicOperation(previous,live(previous));}
  const selection=await git.selection(req,request.paths);identity(req);storage();
  return store.exclusive(()=>{const prior=store.read(request.operationId);if(prior){if(prior.requestHash!==requestHash)fail('operation-reused','This ID already belongs to another review.');return publicOperation(prior,live(prior));}if(blocker())fail('git-operation-active','Inspect the retained Git operation before starting another review.');store.create({schema:1,id:request.operationId,root,actor,requestHash,state:'reviewing',action:'preview',paths:selection.paths,authorizedSources:selection.authorizedSources,rows:selection.rows.map(row=>({path:row.path,original:row.original??null,kind:row.kind})),head:selection.head,selectedBranch:selection.branch,message,configPath:config.configPath??null,at:new Date().toISOString()});return launch(request.operationId,'preview');});
 }
 function inspect(req,id){identity(req);const r=store.read(id);if(!r)return null;return publicOperation(r,live(r));}
 function start(req,{operationId}){identity(req);platform();storage();return store.exclusive(()=>{const r=store.read(operationId);if(!r)fail('git-operation-missing','Review a local commit first.');if(r.state!=='reviewed'||live(r))return publicOperation(r,live(r));if(Date.now()>r.expiresAt)fail('git-review-expired','This review expired. Review current files again.');if(blocker(operationId))fail('git-operation-active','Another retained Git operation needs inspection first.');return launch(operationId,'execute');});}
 function job(req,{operationId,...request},action){identity(req);platform();storage();return store.exclusive(()=>{const r=store.read(operationId);if(!r)fail('git-operation-missing','The retained Git operation is missing.');if(live(r))fail('git-operation-running','The Git process group is still active or cannot be verified as stopped.');if(r.action==='preview')return publicOperation(r,false);if(action==='settle'){if(typeof request.note!=='string'||!request.note.trim()||request.note.length>4000||!/^[a-f0-9]{64}$/.test(request.expectedIndexRevision??'')||request.expectedRef!==r.observedRef||request.expectedIndexRevision!==r.observedIndex)fail('invalid-request','Acknowledge the current inspected ref/index with a note up to 4,000 characters.');store.update(operationId,d=>{d.settlementRequest={note:request.note.trim(),expectedRef:request.expectedRef,expectedIndexRevision:request.expectedIndexRevision};});}if(r.resolved&&action==='recover')return publicOperation(r,false);return launch(operationId,action);});}
 function cancel(req,{operationId}){identity(req);platform();const r=store.read(operationId);if(!r)fail('git-operation-missing','The retained Git operation is missing.');if(live(r)){if(processOwnerLiveness(r.workerOwner)!=='live')fail('git-owner-unverified','The worker identity cannot be verified. Keep its receipt and inspect with Git.');store.update(operationId,d=>{d.cancelRequestedAt=new Date().toISOString();});try{process.kill(-r.workerOwner.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}return publicOperation(store.read(operationId),live(store.read(operationId)));}
 function list(req){identity(req);const items=[];let unavailable=0;try{for(const r of store.all())if(!r.resolved&&(r.state!=='committed'||!r.indexReady))items.push({kind:'git-commit',path:r.rows[0]?.path??r.paths[0],operationId:r.id,state:r.state,at:r.at,available:true});}catch(error){if(error.code==='forbidden')throw error;unavailable++;}return {items,unavailable};}
 return {preview,start,inspect,inspectJob:(req,body)=>job(req,body,'inspect'),recover:(req,body)=>job(req,body,'recover'),cancel,settle:(req,body)=>job(req,body,'settle'),list};
}
