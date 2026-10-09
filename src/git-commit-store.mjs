// Private, actor/checkout-bound Git receipts. No renderer-controlled locations.
import {existsSync,lstatSync,mkdirSync,readdirSync,readFileSync,realpathSync,openSync,writeFileSync,closeSync,fsyncSync,renameSync,unlinkSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {stateDir} from './naming.mjs';
import {withPathLocks} from './atomic-mutation.mjs';
import {SourceEditError} from './source-editor.mjs';
export const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export const fail=(code,message)=>{throw new SourceEditError(code,message);};
export function syncDir(dir){const fd=openSync(dir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
export function safeFile(file,max=16*1024*1024){const st=lstatSync(file);if(!st.isFile()||st.isSymbolicLink()||st.size>max)fail('git-state-corrupt','Git operation storage is unsafe or exceeds its limit.');return st;}
export function atomicJson(file,value){const bytes=Buffer.from(JSON.stringify(value)+'\n');if(bytes.length>16*1024*1024)fail('git-limit','Git receipt exceeds its private storage limit.');const temp=file+'.tmp-'+randomUUID();const fd=openSync(temp,'wx',0o600);try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}try{renameSync(temp,file);syncDir(path.dirname(file));}finally{if(existsSync(temp))unlinkSync(temp);}}
export function commitStore(root,actor){
  root=realpathSync(root);const directory=path.join(stateDir(root),'editor','git-commits');
  function safe(file){if(path.relative(root,file).startsWith('..')||path.isAbsolute(path.relative(root,file)))fail('git-state-corrupt','Git storage escaped the checkout.');let here=root;for(const part of path.relative(root,file).split(path.sep)){here=path.join(here,part);if(existsSync(here)&&lstatSync(here).isSymbolicLink())fail('git-state-corrupt','Git operation storage may not traverse symlinks.');}return file;}
  function job(id){if(!uuid.test(id??''))fail('invalid-id','Use a UUID v4 Git operation ID.');return safe(path.join(directory,id));}
  const location=id=>path.join(job(id),'receipt.json');
  function ensure(){safe(directory);const missing=[];let here=directory;while(!existsSync(here)){missing.push(here);here=path.dirname(here);}for(const dir of missing.reverse()){mkdirSync(dir,{mode:0o700});syncDir(path.dirname(dir));}if(!lstatSync(directory).isDirectory()||(lstatSync(directory).mode&0o077))fail('git-state-corrupt','Git receipt storage must be a private directory.');}
  function read(id){const file=location(id);if(!existsSync(file))return null;const st=safeFile(file);if(st.mode&0o077)fail('git-state-corrupt','Git receipts must remain private.');let value;try{value=JSON.parse(readFileSync(file,'utf8'));}catch{fail('git-state-corrupt','Git receipt is unreadable. Keep it for manual inspection.');}if(value.schema!==1||value.id!==id||value.root!==root||!Array.isArray(value.paths)||value.paths.length>200||!value.actor||typeof value.state!=='string')fail('git-state-corrupt','Git receipt does not match this checkout.');if(value.actor.kind!=='human'||value.actor.id!==actor.id)fail('forbidden','This Git operation belongs to another human.');const {integrity,...payload}=value;if(integrity!==hash(JSON.stringify(payload)))fail('git-state-corrupt','The Git receipt generation is corrupt. Keep it for manual inspection.');if(!value.paths.length||value.paths.some(p=>typeof p!=='string'||!p.endsWith('.md')||p.includes('\0')||p.includes('\\')||path.posix.isAbsolute(p)||path.posix.normalize(p)!==p||p.split('/').some(part=>['..','.git','.runlist','.dotmd','prompts'].includes(part))))fail('git-state-corrupt','Git receipt paths are invalid.');return value;}
  function write(value){const file=location(value.id);safe(file);if(existsSync(file))safeFile(file);delete value.integrity;value.integrity=hash(JSON.stringify(value));atomicJson(file,value);return value;}
  function update(id,fn){return withPathLocks([location(id)],{repoRoot:root,timeoutMs:2000},()=>{const value=read(id);if(!value)fail('git-operation-missing','This Git operation is unavailable.');fn(value);return write(value);});}
  function all(){safe(directory);if(!existsSync(directory))return [];const dirs=readdirSync(directory).filter(id=>uuid.test(id));if(dirs.length>500)fail('git-limit','There are more than 500 retained Git operations. Archive completed private receipts with your local tools before continuing.');return dirs.map(id=>read(id));}
  function create(value){ensure();if(all().length>=500)fail('git-limit','Private Git receipt storage is full. Keep unfinished receipts; archive completed ones with your local tools.');mkdirSync(job(value.id),{mode:0o700});syncDir(directory);return write(value);}
  return {root,directory,job,location,ensure,create,read,write,update,all,safe,exclusive:fn=>withPathLocks([directory],{repoRoot:root,timeoutMs:2000},fn)};
}
