// Guarded ordinary porcelain commits; unqualified execution profiles stay gated.
import {commitPlatformQualified,commitVersionQualified} from './git-commit-support.mjs';
import {spawnSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,lstatSync,statSync,fstatSync,realpathSync,openSync,closeSync,fsyncSync,linkSync,renameSync,unlinkSync,mkdirSync,constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {gitEnvironment} from './app-git.mjs';
import {hash,fail,safeFile,syncDir,commitStore} from './git-commit-store.mjs';
import {processStartIdentity,currentProcessOwner} from './atomic-mutation.mjs';
import {signingProfile,prepareSigning,verifySignature} from './git-commit-signing.mjs';
import {filterProfiles} from './git-commit-filters.mjs';
const MAX_INDEX=2*1024*1024,MAX_SOURCE=8*1024*1024,MAX_REVIEW=1024*1024;
export const hooks=['pre-commit','prepare-commit-msg','commit-msg','reference-transaction','post-commit','post-index-change'];
const decode=b=>{try{return new TextDecoder('utf8',{fatal:true}).decode(b);}catch{fail('git-encoding','Git content is not valid UTF-8. Review it with Git.');}};
const same=(a,b)=>a?.exists===b?.exists&&a?.hash===b?.hash&&a?.mode===b?.mode;
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const shell=value=>"'"+value.replaceAll("'","'\\''")+"'";
export function argumentsFor(args){return ['--no-optional-locks',...(args[0]==='check-ignore'?[]:['--literal-pathspecs']),'-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','gc.auto=0','-c','maintenance.auto=false',...args];}
export function run(r,args,{input,env={},allow=[0],max=16*1024*1024}={}){
 const timeout=Math.min(10000,(r.deadline??Date.now()+10000)-Date.now());if(timeout<=0)fail('git-timeout','The Git job timed out. Inspect its retained operation.');
 // Private index preparation is not a user commit and must never run hooks.
 const internal=['add','read-tree','write-tree','update-index'].includes(args[0])?['-c','core.hooksPath=/dev/null',...args]:args;
 const result=spawnSync(r.binary??'git',argumentsFor(internal),{cwd:r.root,env:{...gitEnvironment(),...env},input,timeout,maxBuffer:max,windowsHide:true});
 if(result.error&&r.material?.filters?.length&&r.workerOwner?.pid===process.pid){const store=commitStore(r.root,r.actor);store.update(r.id,d=>{d.failure={code:'git-filter-limits',message:'The filtered Git step exceeded its limits. Its process group was stopped; no review was accepted.'};if(d.action==='preview')d.state='failed';});process.kill(-process.pid,'SIGKILL');}
 if(result.error)fail(result.error.code==='ETIMEDOUT'?'git-timeout':'git-unavailable','Git stopped or exceeded its job limits. Inspect the retained operation.');
 if(!allow.includes(result.status))fail('git-command-failed',`Git refused the ${args.find(arg=>!arg.startsWith('-'))??'local'} step. The receipt was kept; use Git to inspect this checkout.`);
 return {code:result.status,bytes:result.stdout,text:()=>decode(result.stdout).trim()};
}
const text=(r,...args)=>run(r,args).text();
export function snapshot(file){
 if(!existsSync(file))return {exists:false,hash:null,bytes:null,mode:null};const st=safeFile(file,MAX_INDEX),fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const before=fstatSync(fd),bytes=readFileSync(fd),after=lstatSync(file);if(before.dev!==st.dev||before.ino!==st.ino||bytes.length>MAX_INDEX||before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)fail('git-review-changed','The index changed during inspection. Review again.');return {exists:true,hash:hash(bytes),bytes:bytes.toString('base64'),mode:st.mode&0o777};}finally{closeSync(fd);}
}
export function ownership(file){const st=safeFile(file,MAX_INDEX);return {dev:st.dev,ino:st.ino,hash:hash(readFileSync(file))};}
const matches=(file,owner)=>{try{return equal(ownership(file),owner);}catch{return false;}};
// Git's published index may refresh stat/cache-tree fields. Entries, stages and
// flags must match, and no unqualified index extension is permitted anywhere.
export function plainIndex(bytes,{intent=false}={}){
 if(bytes.length<32||bytes.toString('ascii',0,4)!=='DIRC'||![2,3].includes(bytes.readUInt32BE(4)))fail('git-index-unsupported','This index format is not qualified for local commits. Use Git.');
 const version=bytes.readUInt32BE(4),count=bytes.readUInt32BE(8);let at=12;
 for(let i=0;i<count;i++){
  const start=at;if(at+62>bytes.length-20)fail('git-index-unsupported','The index is incomplete. Use Git.');
  const flags=bytes.readUInt16BE(at+60);if(flags&0xb000)fail('git-index-unsupported','Conflicted or assume-unchanged index entries require Git.');at+=62;
  if(flags&0x4000){if(version!==3||at+2>bytes.length-20)fail('git-index-unsupported','Extended index flags require Git.');const extended=bytes.readUInt16BE(at);if(extended!==0&&!(intent&&extended===0x2000))fail('git-index-unsupported','Sparse, intent-to-add or extended index flags require Git.');at+=2;}
  const end=bytes.indexOf(0,at);if(end<at||end>=bytes.length-20)fail('git-index-unsupported','The index path is incomplete. Use Git.');at=start+Math.ceil((end+1-start)/8)*8;
 }
 while(at<bytes.length-20){if(at+8>bytes.length-20)fail('git-index-unsupported','The index extension is incomplete.');const name=bytes.toString('ascii',at,at+4),size=bytes.readUInt32BE(at+4);if(name!=='TREE')fail('git-index-unsupported',`Index extension ${name} is not qualified. Use Git.`);at+=8+size;}
 if(at!==bytes.length-20)fail('git-index-unsupported','The index has an invalid length. Use Git.');
 const checksum=hash(bytes); // SHA-256 is the receipt generation, not Git's checksum.
 return checksum;
}
export function semantics(r,index,{intent=false}={}){const snap=snapshot(index);if(!snap.exists)fail('git-index-unsupported','This checkout has no regular index. Use Git.');plainIndex(Buffer.from(snap.bytes,'base64'),{intent});const env={GIT_INDEX_FILE:index};return [run(r,['ls-files','--stage','-z'],{env}).bytes.toString('base64'),run(r,['ls-files','-v','-z'],{env}).bytes.toString('base64')];}
function fileMaterial(file,max=2*1024*1024){if(!existsSync(file))return null;const st=safeFile(file,max);return {hash:hash(readFileSync(file)),mode:st.mode&0o777};}
function configuredHooks(r){const explicit=run(r,['config','--path','--get','core.hooksPath'],{allow:[0,1]}),dir=explicit.code===0?path.resolve(r.root,explicit.text()):path.resolve(r.root,text(r,'rev-parse','--git-path','hooks'));const result={dir,files:{}};for(const kind of hooks)result.files[kind]=fileMaterial(path.join(dir,kind));return result;}
function material(r){
 const records=run(r,['config','--null','--list','--show-origin','--show-scope']).bytes;
 // NUL format: scope, origin, key\nvalue. Effective content plus every origin
 // file catches includes, global/system and worktree config generations.
 const fields=decode(records).split('\0'),files=new Set();for(let i=0;i+2<fields.length;i+=3)if(fields[i+1].startsWith('file:'))files.add(path.resolve(r.root,fields[i+1].slice(5)));
 for(const file of [r.configPath,path.join(r.root,'.gitattributes'),path.join(r.common,'info','attributes')])if(file)files.add(file);
 for(const name of r.paths){let here=path.dirname(path.resolve(r.root,name));while(here!==r.root){files.add(path.join(here,'.gitattributes'));here=path.dirname(here);}}
 const global=run(r,['config','--path','--get','core.attributesFile'],{allow:[0,1]});if(global.code===0)files.add(path.resolve(r.root,global.text()));else if(os.homedir())files.add(path.join(process.env.XDG_CONFIG_HOME??path.join(os.homedir(),'.config'),'git','attributes'));
 const values={};for(const file of [...files].sort())values[file]=fileMaterial(file);
 const attrs=run(r,['check-attr','-z','--stdin','filter','working-tree-encoding'],{input:Buffer.from(r.paths.join('\0')+'\0')}).bytes;
 return {effective:hash(records),files:values,attrs:hash(attrs),hooks:configuredHooks(r),signing:signingProfile(r,run),filters:filterProfiles(r,run,gitEnvironment())};
}
function sourceMaterial(r){const result={};for(const name of r.paths){const file=path.resolve(r.root,name);if(path.relative(r.root,file).startsWith('..'))fail('forbidden','A reviewed path escaped the checkout.');let here=r.root;for(const part of name.split('/')){here=path.join(here,part);if(existsSync(here)&&lstatSync(here).isSymbolicLink())fail('git-review-changed','A reviewed path now traverses a symlink.');}if(!existsSync(file)){result[name]=null;continue;}const st=safeFile(file,MAX_SOURCE),bytes=readFileSync(file);result[name]={hash:hash(bytes),mode:st.mode&0o777};}return result;}
function topology(r){const root=realpathSync(text(r,'rev-parse','--show-toplevel'));if(root!==r.root)fail('git-root','Open the canonical Git checkout root.');const gitdir=realpathSync(path.resolve(r.root,text(r,'rev-parse','--git-dir'))),common=realpathSync(path.resolve(r.root,text(r,'rev-parse','--git-common-dir'))),index=path.resolve(r.root,text(r,'rev-parse','--git-path','index'));if(index!==path.join(gitdir,'index'))fail('git-index-unsupported','A nonstandard index location requires Git.');return {gitdir,common,index,identity:[statSync(gitdir).dev,statSync(gitdir).ino,statSync(common).dev,statSync(common).ino]};}
function repoReady(r){if(text(r,'rev-parse','--show-object-format')!=='sha1')fail('git-format-unsupported','SHA-256 repositories require separate qualification. Use Git.');for(const name of ['MERGE_HEAD','CHERRY_PICK_HEAD','REVERT_HEAD','rebase-merge','rebase-apply','BISECT_START','AUTO_MERGE'])if(existsSync(path.resolve(r.root,text(r,'rev-parse','--git-path',name))))fail('git-operation-active','Finish the current Git operation first.');const encoding=run(r,['config','--get','i18n.commitEncoding'],{allow:[0,1]});if(encoding.code===0&&!/^utf-?8$/i.test(encoding.text()))fail('git-encoding','Non-UTF-8 commit messages require Git.');}
function version(r){if(!commitPlatformQualified())fail('git-platform-unqualified','Local commits are not yet qualified on this platform and architecture. Use Git; document editing and Changes remain available.');const result=text(r,'--version');if(!commitVersionQualified(result))fail('git-version-unqualified','This Git version is not qualified for guarded local commits on this platform. Use Git.');return result;}
function assertTopology(r){if(!equal(topology(r),r.topology)||r.gitdir!==r.topology.gitdir||r.common!==r.topology.common||r.index!==r.topology.index)fail('git-recovery-unavailable','Git directories moved or the receipt topology changed. Keep the receipt for manual inspection.');}
function assertReview(r,{prepared=false}={}){assertTopology(r);if(text(r,'--version')!==r.gitVersion||(!prepared&&existsSync(r.index+'.lock')))fail('git-review-changed','Git changed or an index lock is active. Inspect with Git before reviewing again.');if(text(r,'rev-parse','HEAD')!==r.head||text(r,'symbolic-ref','HEAD')!==r.branch||!equal(sourceMaterial(r),r.sources)||!equal(material(r),r.material)||!same(snapshot(r.index),prepared?r.prepared:r.before))fail('git-review-changed','The branch, saved files, configuration or staging changed. Review a new local commit.');repoReady(r);}
function blob(r,tree,name){const record=run(r,['ls-tree','-z',tree,'--',name]).bytes;if(!record.length)return '';const match=decode(record).match(/^100(?:644|755) blob ([a-f0-9]{40})\t/);if(!match)fail('git-review-unavailable','A selected object is not ordinary Markdown.');if(Number(text(r,'cat-file','-s',match[1]))>MAX_REVIEW)fail('git-limit','A selected file exceeds the inline commit review limit.');const value=decode(run(r,['cat-file','blob',match[1]],{max:MAX_REVIEW}).bytes);if(value.includes('\0')||value.split('\n').length>20000)fail('git-limit','A selected file cannot be reviewed inline. Use Git.');return value;}
function privateStorage(r,job){const relative=path.relative(r.root,path.dirname(job)).split(path.sep).join('/');if(run(r,['check-ignore','-q','--',relative+'/'],{allow:[0,1]}).code!==0||run(r,['ls-files','-z','--',relative]).bytes.length)fail('unsafe-local-state','Git operation storage must be ignored and untracked.');}
function stageSelected(r,index){const env={GIT_INDEX_FILE:index},known=new Set(decode(run(r,['ls-files','-z','--',...r.paths],{env}).bytes).split('\0'));let paths=r.paths.filter(name=>known.has(name)||existsSync(path.join(r.root,name)));if(r.material.filters.length&&paths.length){const selectedKnown=paths.filter(name=>known.has(name));if(selectedKnown.length)run(r,['update-index','--force-remove','-z','--stdin'],{env,input:Buffer.from(selectedKnown.join('\0')+'\0')});paths=paths.filter(name=>existsSync(path.join(r.root,name)));}if(paths.length)run(r,['add','-A','--pathspec-from-file=-','--pathspec-file-nul'],{env,input:Buffer.from(paths.join('\0')+'\0')});}
export function previewProtocol(store,id){
 let r=store.read(id);r.deadline=Date.now()+60000;r.gitVersion=version(r);r.topology=topology(r);Object.assign(r,r.topology);repoReady(r);privateStorage(r,store.job(id));
 r.branch=text(r,'symbolic-ref','HEAD');if(r.branch!==`refs/heads/${r.selectedBranch}`||text(r,'rev-parse','HEAD')!==r.head)fail('git-review-changed','The selected branch changed. Refresh Changes.');
 if(existsSync(r.index+'.lock'))fail('git-index-locked','Git has an active index lock. Inspect it with Git before reviewing a local commit.');r.before=snapshot(r.index);semantics(r,r.index);r.material=material(r);r.sources=sourceMaterial(r);
 for(const name of r.paths)if((r.sources[name]?.hash??null)!==r.authorizedSources[name])fail('git-review-changed','A selected file changed after authorization. Refresh Changes.');
 // Retain ownership/material before any trusted filter executes, including
 // timeout/cancellation evidence. The real index and branch are untouched.
 store.write(r);
 const job=store.job(id),scratch=path.join(job,'review-index'),expected=path.join(job,'expected-index'),input=Buffer.from(r.paths.join('\0')+'\0'),env={GIT_INDEX_FILE:scratch};
 run(r,['read-tree',r.head],{env});stageSelected(r,scratch);r.tree=textWithIndex(r,scratch,'write-tree');
 writeFileSync(expected,Buffer.from(r.before.bytes,'base64'),{flag:'wx',mode:0o600});const ee={GIT_INDEX_FILE:expected};
 const staged=decode(run(r,['diff','--no-ext-diff','--no-textconv','--no-renames','--cached','--name-only','-z',r.head,'--',...r.paths]).bytes).split('\0').filter(Boolean);
 stageSelected(r,expected);
 if(!run(r,['ls-files','--stage','-z','--',...r.paths],{env}).bytes.equals(run(r,['ls-files','--stage','-z','--',...r.paths],{env:ee}).bytes))fail('git-filter-unstable','The clean filter produced different Git blobs during review. No commit was accepted.');
 if(staged.length&&!run(r,['ls-files','--stage','-z','--',...staged]).bytes.equals(run(r,['ls-files','--stage','-z','--',...staged],{env:ee}).bytes))fail('git-partial-staging','Selected files have partial staging. Use Git to keep that staging.');
 r.expectedReal=semantics(r,expected);const known=new Set(decode(run(r,['ls-files','-z','--',...r.paths]).bytes).split('\0'));r.new=r.paths.filter(p=>!known.has(p)&&existsSync(path.join(r.root,p)));
 r.review=[];let reviewBytes=2;for(const row of r.rows){const entry={path:row.path,original:row.original??null,kind:row.kind,before:blob(r,r.head,row.original??row.path),after:blob(r,r.tree,row.path)};reviewBytes+=Buffer.byteLength(JSON.stringify(entry))+1;if(reviewBytes>MAX_REVIEW)fail('git-limit','The selected diff exceeds the 1 MiB review limit. Select fewer documents or use Git.');r.review.push(entry);}
 if(r.tree===text(r,'rev-parse',r.head+'^{tree}'))fail('git-empty','The reviewed Git tree has no document changes.');
 assertReview(r);r.state='reviewed';r.reviewedAt=new Date().toISOString();r.expiresAt=Date.now()+30*60*1000;delete r.deadline;store.write(r);return r;
}
const textWithIndex=(r,index,...args)=>run(r,args,{env:{GIT_INDEX_FILE:index}}).text();
export function casIndex(store,r,expected,desired,phase){
 const artifact=path.join(r.gitdir,`.runlist-commit-${r.id}-${phase}`),lock=r.index+'.lock';
 writeFileSync(artifact,Buffer.from(desired.bytes??'','base64'),{flag:'wx',mode:desired.mode??0o600});const fd=openSync(artifact,'r');try{fsyncSync(fd);}finally{closeSync(fd);}const owner=ownership(artifact);
 store.update(r.id,d=>{d.cas={phase,owner,expected:{exists:expected.exists,hash:expected.hash,mode:expected.mode},desired:{exists:desired.exists,hash:desired.hash,mode:desired.mode}};});let acquired=false;
 try{linkSync(artifact,lock);acquired=true;syncDir(r.gitdir);store.update(r.id,d=>{d.cas.lock=owner;});if(!same(snapshot(r.index),expected))fail('git-index-changed','Another process changed Git staging. Its index was preserved.');if(desired.exists)renameSync(lock,r.index);else{if(existsSync(r.index))unlinkSync(r.index);unlinkSync(lock);}acquired=false;syncDir(r.gitdir);}
 finally{if(acquired&&matches(lock,owner)){unlinkSync(lock);syncDir(r.gitdir);}if(matches(artifact,owner)){unlinkSync(artifact);syncDir(r.gitdir);}}
}
export function verifyCommit(r,oid){if(!/^[a-f0-9]{40}$/.test(oid))fail('git-object-unreviewed','Git proposed an invalid commit ID.');const raw=run(r,['cat-file','commit',oid],{max:2*1024*1024}).bytes,split=raw.indexOf('\n\n');if(split<0)fail('git-object-unreviewed','Git proposed an incomplete commit.');const headers=raw.subarray(0,split).toString('utf8').split('\n'),tree=headers.filter(x=>x.startsWith('tree ')),parents=headers.filter(x=>x.startsWith('parent '));if(!equal(tree,['tree '+r.tree])||!equal(parents,['parent '+r.head])||!raw.subarray(split+2).equals(Buffer.from(r.message)))fail('git-object-unreviewed','The actual commit differs from the reviewed tree, parent or message.');verifySignature(r,raw,commitStore(r.root,r.actor).job(r.id));}
export function hookProtocol(store,id,kind,args,input){
 let r=store.read(id);r.deadline=Date.now()+10000;if(!hooks.includes(kind)||r.gitOwner?.pid!==process.ppid||!r.workerOwner||r.gitOwner.processStartIdentity!==processStartIdentity(process.ppid))fail('git-hook-owner','The guard was invoked outside its registered Git process.');
 if(kind==='pre-commit'){
  const temp=process.env.GIT_INDEX_FILE;if(!temp||path.dirname(temp)!==r.gitdir||!path.basename(temp).startsWith('next-index-'))fail('git-hook-owner','Git did not supply an owned temporary commit index.');
  if(!equal(semantics(r,r.index+'.lock',{intent:true}),r.expectedReal))fail('git-index-unreviewed','Git prepared an unreviewed final index.');
  const lock=ownership(r.index+'.lock');if(r.gitLock&&(lock.dev!==r.gitLock.dev||lock.ino!==r.gitLock.ino))fail('git-index-unreviewed','A configured hook replaced the Git-owned index lock.');
  store.update(id,d=>{d.commitIndex=temp;d.tempOwner=ownership(temp);d.gitLock=ownership(r.index+'.lock');d.published=snapshot(r.index+'.lock');});
 }
 if(kind!=='reference-transaction')return;
 const rows=decode(input).trim().split('\n').filter(Boolean).map(line=>line.split(' '));
 if(args[0]==='prepared'){
  if(r.commit&&rows.length===1&&rows[0][2]==='AUTO_MERGE'&&/^0{40}$/.test(rows[0][0])&&/^0{40}$/.test(rows[0][1])&&run(r,['rev-parse','--verify','--quiet','AUTO_MERGE'],{allow:[0,1]}).code===1)return;
  // Git 2.47.3 supplies zero for symbolic HEAD, while the mandatory
  // branch row carries the checked old OID. assertReview below verifies HEAD
  // still resolves to this branch/parent; this never permits a zero branch CAS.
  const symbolicHeadZero=r.gitVersion==='git version 2.47.3'&&process.platform==='linux'&&process.arch==='arm64';
  if(rows.some(row=>row.length!==3||![r.branch,'HEAD'].includes(row[2])||(row[0]!==r.head&&!(symbolicHeadZero&&row[2]==='HEAD'&&/^0{40}$/.test(row[0]))))||rows.filter(row=>row[2]===r.branch).length!==1||rows.filter(row=>row[2]==='HEAD').length>1||new Set(rows.map(row=>row[1])).size!==1)fail('git-ref-unreviewed','Git proposed an unreviewed ref transaction.');
  const oid=rows[0][1];verifyCommit(r,oid);assertReview(r,{prepared:true});
  const lockedOwner=ownership(r.index+'.lock');if(!r.gitLock||lockedOwner.dev!==r.gitLock.dev||lockedOwner.ino!==r.gitLock.ino)fail('git-index-unreviewed','The Git-owned index lock was replaced.');
  if(!equal(semantics(r,r.index+'.lock',{intent:true}),r.expectedReal)||textWithIndex(r,r.commitIndex,'write-tree')!==r.tree)fail('git-index-unreviewed','Git prepared unreviewed index content.');
  store.update(id,d=>{d.candidate=oid;d.state='ref-prepared';d.tempOwner=ownership(r.commitIndex);d.gitLock=ownership(r.index+'.lock');d.published=snapshot(r.index+'.lock');});
 }else if(args[0]==='committed'&&r.candidate&&rows.some(row=>row[1]===r.candidate&&row[2]===r.branch))store.update(id,d=>{d.commit=r.candidate;d.state='ref-committed';});
}
// Run the configured original at its real location, with Git's arguments,
// index/editor variables and cwd. Nested Git sees the original hooks directory.
// A hook is trusted checkout code, not a sandbox; its own external effects are
// never undone. The final publication guard remains authoritative.
export function hookInvocation(store,id,kind,args,input){
 let r=store.read(id);if(!hooks.includes(kind)||r.gitOwner?.pid!==process.ppid||r.gitOwner.processStartIdentity!==processStartIdentity(process.ppid))fail('git-hook-owner','The hook was invoked outside its registered Git process.');
 if(kind==='pre-commit'||kind==='reference-transaction'&&args[0]==='committed')hookProtocol(store,id,kind,args,input);
 r=store.read(id);const configured=r.material?.hooks,entry=configured?.files[kind];
 if(entry?.mode&0o111){
  const file=path.join(configured.dir,kind);if(!equal(fileMaterial(file),entry))fail('git-review-changed','A configured hook changed after review. Review again.');
  const env={...process.env,GIT_CONFIG_PARAMETERS:['core.fsmonitor=false','core.untrackedCache=false','gc.auto=0','maintenance.auto=false','core.hooksPath='+configured.dir].map(shell).join(' ')};delete env.GIT_CONFIG_COUNT;
  const result=spawnSync(file,args,{cwd:r.root,env,input,stdio:['pipe','inherit','inherit'],timeout:10000,killSignal:'SIGKILL',windowsHide:true});
  store.update(id,d=>{d.hookResults??=[];if(d.hookResults.length>=96)fail('git-limit','Too many configured hook invocations.');d.hookResults.push({kind,phase:kind==='reference-transaction'?args[0]:null,code:result.status,at:new Date().toISOString()});if(result.error||result.status!==0)d.failure={code:result.error?.code==='ETIMEDOUT'?'git-hook-timeout':'git-hook-rejected',message:`Configured ${kind} hook ${result.error?'stopped or timed out':'returned a failure'}. Inspect the retained outcome; its external changes are preserved.`};});
  if(result.error?.code==='ETIMEDOUT'){process.kill(-r.workerOwner.pid,'SIGKILL');return;}
  if(result.error||result.status!==0){if(['pre-commit','prepare-commit-msg','commit-msg'].includes(kind)||kind==='reference-transaction'&&['preparing','prepared'].includes(args[0]))fail('git-hook-rejected',`Configured ${kind} hook refused the commit.`);}
 }
 hookProtocol(store,id,kind,args,input);
}
export async function executeProtocol(store,id){
 let r=store.read(id);r.deadline=Date.now()+60000;assertReview(r);if(Date.now()>r.expiresAt)fail('git-review-expired','This review expired. Review current files again.');
 const script=fileURLToPath(new URL('./git-commit-worker.mjs',import.meta.url)),signerArgs=prepareSigning(store,r,script,shell);
 let prepared=r.before;
 if(r.new.length){const file=path.join(store.job(id),'intent-index');writeFileSync(file,Buffer.from(r.before.bytes,'base64'),{flag:'wx',mode:0o600});run(r,['add','--intent-to-add','--pathspec-from-file=-','--pathspec-file-nul'],{env:{GIT_INDEX_FILE:file},input:Buffer.from(r.new.join('\0')+'\0')});prepared=snapshot(file);}
 store.update(id,d=>{d.prepared=prepared;d.state='preparing';});if(!same(prepared,r.before))casIndex(store,r,r.before,prepared,'prepare');
 r=store.read(id);r.deadline=Date.now()+60000;assertReview(r,{prepared:true});
 const job=store.job(id),wrapper=path.join(job,'hooks');mkdirSync(wrapper,{mode:0o700});
 const envFile=path.join(job,'message');writeFileSync(envFile,r.message,{mode:0o600,flag:'wx'});
 for(const kind of hooks)writeFileSync(path.join(wrapper,kind),'#!/bin/sh\nexec '+shell(process.execPath)+' --max-old-space-size=128 '+shell(script)+' --hook '+shell(r.root)+' '+shell(r.actor.id)+' '+shell(id)+' '+shell(kind)+' "$@"\n',{mode:0o700,flag:'wx'});
 const args=argumentsFor([...signerArgs,'-c','core.hooksPath='+wrapper,'commit','--only','--pathspec-from-file=-','--pathspec-file-nul','--cleanup=verbatim','--file',envFile]);
 await new Promise((resolve,reject)=>{
  const child=spawn(r.binary??'git',args,{cwd:r.root,env:{...gitEnvironment(),GIT_REFLOG_ACTION:'runlist-local:'+id},stdio:['pipe','pipe','pipe'],windowsHide:true});let size=0,finished=false;
  const stop=()=>{if(finished)return;finished=true;store.update(id,d=>{d.failure={code:'git-timeout',message:'Git exceeded its commit time/output limits. Its process group was stopped; inspect the retained outcome.'};});process.kill(-process.pid,'SIGKILL');};
  const timer=setTimeout(stop,60000);const append=chunk=>{size+=chunk.length;if(size>128000)stop();};child.stdout.on('data',append);child.stderr.on('data',append);child.stdin.on('error',()=>{});
  child.on('error',error=>{clearTimeout(timer);if(!finished){finished=true;reject(error);}});
  child.on('close',code=>{clearTimeout(timer);if(finished)return;finished=true;store.update(id,d=>{d.exitCode=code;if(code!==0&&!d.failure)d.failure={code:'git-commit-failed',message:'Git or a configured hook/signer refused the local commit. Inspect the retained outcome before continuing.'};});resolve();});
  store.update(id,d=>{d.state='executing';d.gitOwner={...currentProcessOwner(),pid:child.pid,processStartIdentity:processStartIdentity(child.pid)};});child.stdin.end(Buffer.from(r.paths.join('\0')+'\0'));
 });
 return inspectProtocol(store,id);
}
export function inspectProtocol(store,id){
 let r=store.read(id);r.deadline=Date.now()+10000;if(!r.topology)return r;
 assertTopology(r);
 const oid=r.commit??r.candidate,ref=run(r,['rev-parse','--verify',r.branch],{allow:[0,128]}).text();store.update(id,d=>{d.observedRef=ref;d.observedIndex= snapshot(r.index).hash;});let state;
 if(oid){verifyCommit(r,oid);if(ref===oid){const ready=equal(semantics(r,r.index,{intent:true}),r.expectedReal);state=ready?'committed':'committed-index-recovery';return store.update(id,d=>{d.state=state;d.commit=oid;d.indexReady=ready;});}state=r.commit?'committed-external-ref':ref===r.head?'uncertain-ref-publication':'uncertain-external-ref';}
 else state=ref===r.head?'not-committed':'uncertain-external-ref';
 return store.update(id,d=>{d.state=state;});
}
export function recoverProtocol(store,id){
 let r=inspectProtocol(store,id);if(!['committed','committed-index-recovery','not-committed'].includes(r.state))return store.update(id,d=>{d.recovery='uncertain-outcome-preserved';});
 const lock=r.index+'.lock';if(existsSync(lock)){const owner=r.gitLock??r.cas?.lock??r.cas?.owner;if(!owner||!matches(lock,owner))return store.update(id,d=>{d.recovery='foreign-or-unverified-lock-preserved';});unlinkSync(lock);syncDir(r.gitdir);}
 if(r.commitIndex&&r.tempOwner&&matches(r.commitIndex,r.tempOwner)){unlinkSync(r.commitIndex);syncDir(r.gitdir);}
 if(r.cas){const artifact=path.join(r.gitdir,`.runlist-commit-${r.id}-${r.cas.phase}`);if(matches(artifact,r.cas.owner)){unlinkSync(artifact);syncDir(r.gitdir);}}
 const current=snapshot(r.index),prepared=r.prepared??r.before;
 if(r.state==='committed-index-recovery'){
  if(!same(current,prepared)||!r.published)return store.update(id,d=>{d.recovery='foreign-index-preserved';});
  casIndex(store,r,current,r.published,'recover');return store.update(id,d=>{d.state='committed';d.indexReady=true;d.recovery='published-reviewed-index';d.resolved=true;});
 }
 if(r.state==='not-committed'){
  if(!same(current,prepared)&&!same(current,r.before))return store.update(id,d=>{d.recovery='foreign-index-preserved';});
  if(!same(current,r.before))casIndex(store,r,current,r.before,'recover');
 }
 return store.update(id,d=>{d.recovery=r.state==='not-committed'?'preparation-restored':'no-mutation-needed';d.resolved=true;});
}

export function settleProtocol(store,id){
 const r=inspectProtocol(store,id),request=r.settlementRequest;
 if(!request||!['uncertain-ref-publication','uncertain-external-ref','committed-external-ref'].includes(r.state))fail('git-settlement-unavailable','Only an inspected uncertain or externally moved commit can be acknowledged.');
 if(r.observedRef!==request.expectedRef||r.observedIndex!==request.expectedIndexRevision||existsSync(r.index+'.lock'))fail('git-review-changed','The inspected ref/index changed or a lock remains. Inspect with Git before acknowledging.');
 return store.update(id,d=>{d.resolved=true;d.settlement={by:d.actor,at:new Date().toISOString(),note:request.note,ref:d.observedRef,index:d.observedIndex};d.recovery='acknowledged-without-replay';});
}
