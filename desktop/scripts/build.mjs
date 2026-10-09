import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {finalizeLinuxAppImage} from './appimage-runtime.mjs';
const desktop=path.resolve(import.meta.dirname,'..'),args=process.argv.slice(2);
const index=args.indexOf('--target');
if(index>=0&&!args[index+1])throw new Error('--target requires a Rust target triple.');
const target=index>=0?args[index+1]:args.find(a=>a.startsWith('--target='))?.slice(9)??process.env.RUNLIST_TARGET;
const buildArgs=target&&index<0&&!args.some(a=>a.startsWith('--target='))?[...args,'--target',target]:args;
const env=privateBuildEnvironment(path.resolve(desktop,'..'),{...process.env,...(target?{RUNLIST_TARGET:target}:{})});
const buildStarted=Date.now();
for(const argv of [[path.join(desktop,'scripts/prepare.mjs')],[path.join(desktop,'node_modules/@tauri-apps/cli/tauri.js'),'build',...buildArgs]]) {
 const result=spawnSync(process.execPath,argv,{cwd:desktop,env,stdio:'inherit',windowsHide:true});
 if(result.error)throw result.error;
 if(result.status!==0){process.exitCode=result.status??1;break;}
}

if(!process.exitCode)finalizeLinuxAppImage({target,notBefore:buildStarted});
