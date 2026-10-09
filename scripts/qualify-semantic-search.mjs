// Terminal-only, read-only qualification against an explicitly selected external gmax.
// node --expose-gc scripts/qualify-semantic-search.mjs CHECKOUT GMAX_ENTRY [NODE] [CYCLES]
// Does not start a server, daemon, indexer or model. Reports aggregate metrics only.
import {mkdtempSync,writeFileSync,rmSync,realpathSync,readFileSync} from 'node:fs';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {resolveConfig} from '../src/config.mjs';
import {createDocumentLibrary} from '../src/app-library.mjs';
import {createAppSemanticSearch} from '../src/app-semantic-search.mjs';
import {withSemanticClient} from '../src/semantic-search-client.mjs';

if(!process.argv[2]||!process.argv[3])throw new Error('Usage: qualify-semantic-search.mjs CHECKOUT GMAX_ENTRY [NODE] [CYCLES]');
const checkout=realpathSync(process.argv[2]),entryPath=realpathSync(process.argv[3]);
const nodePath=realpathSync(process.argv[4]??process.execPath),cycles=Math.min(5,Math.max(1,Number(process.argv[5])||3));
const temporary=realpathSync(mkdtempSync(path.join(os.tmpdir(),'runlist-semantic-qualification-')));
const guard=path.join(temporary,'read-only.cjs'),children=[],violations=[];
const socket=path.join(os.homedir(),'.gmax/daemon.sock');
writeFileSync(guard,`
const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net');
const deny=name=>(...args)=>{process.stderr.write('RUNLIST_QUALIFICATION_DENIED:'+name+'\\n');throw new Error('qualification guard');};
for(const name of ['spawn','spawnSync','fork','exec','execSync','execFile','execFileSync'])cp[name]=deny(name);
net.Server.prototype.listen=deny('listen');
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){const opts=Array.isArray(args[0])?args[0][0]:args[0];const p=typeof opts==='string'?opts:opts?.path;if(p!==${JSON.stringify(socket)})return deny('non-daemon-network')();return connect.apply(this,args);};
for(const module of ['node:http','node:https']){const m=require(module);m.request=m.get=deny('http');}
global.fetch=deny('fetch');
const writes=['write','writev','writeFile','appendFile','truncate','ftruncate','mkdir','mkdtemp','rename','unlink','rm','rmdir','copyFile','cp','link','symlink','chmod','fchmod','chown','fchown','utimes','futimes'];
for(const name of writes){if(fs[name])fs[name]=deny(name);if(fs[name+'Sync'])fs[name+'Sync']=deny(name);if(fs.promises[name])fs.promises[name]=deny(name);}
fs.createWriteStream=deny('createWriteStream');
const writable=flags=>typeof flags==='string'?/[wa+]/.test(flags):Boolean(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND));
for(const name of ['open','openSync']){const original=fs[name];fs[name]=function(file,flags,...rest){if(writable(flags))return deny(name)();return original.call(this,file,flags,...rest);};}
const open=fs.promises.open;fs.promises.open=async function(file,flags,...rest){if(writable(flags))return deny('open')();return open.call(this,file,flags,...rest);};
require('node:module').syncBuiltinESMExports();
`,{mode:0o600});
const round=n=>Math.round(n*10)/10;
const memory=()=>Object.fromEntries(Object.entries(process.memoryUsage()).map(([key,n])=>[key,round(n/1024/1024)]));
const report=(stage,data={})=>console.log(JSON.stringify({stage,...data,memoryMiB:memory()}));
function residentMiB(pid){
 try{
  if(process.platform==='linux'){const match=readFileSync(`/proc/${pid}/status`,'utf8').match(/^VmRSS:\s+(\d+) kB/m);return match?Number(match[1])/1024:null;}
  if(process.platform==='darwin'){const n=Number(execFileSync('/bin/ps',['-o','rss=','-p',String(pid)],{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:1000}).trim());return n>0?n/1024:null;}
 }catch{}
 return null;
}
let peakBridgeMiB=0,peakParentMiB=0,samples=0;
function sample(){peakParentMiB=Math.max(peakParentMiB,process.memoryUsage().rss/1024/1024);for(const child of children)if(child.exitCode===null&&child.signalCode===null){const n=residentMiB(child.pid);if(n!==null){peakBridgeMiB=Math.max(peakBridgeMiB,n);samples++;}}}
const timer=setInterval(sample,100);timer.unref();
const config=await resolveConfig(checkout),library=createDocumentLibrary(config);
const semantic=createAppSemanticSearch({config,library,settingsFile:path.join(temporary,'settings.json'),connect:(installation,root,signal,work)=>withSemanticClient(installation,root,signal,work,{spawnChild:(command,args,options)=>{
 const child=spawn(command,['--require',guard,...args],options);children.push(child);
 child.stderr.on('data',bytes=>{for(const match of bytes.toString('utf8').matchAll(/RUNLIST_QUALIFICATION_DENIED:([\w-]+)/g))violations.push(match[1]);});
 sample();return child;
}})});
try{
 semantic.saveSettings({nodePath,entryPath});
 report('startup',{runtime:process.version,platform:process.platform,architecture:process.arch,cycles});
 let start=performance.now();await library.refresh();
 const inventory=await library.query(new URLSearchParams({archived:'1'}));
 report('inventory-cold',{elapsedMs:Math.round(performance.now()-start),documents:inventory.inventoryTotal,counts:inventory.counts,stats:library.stats});
 for(let i=0;i<cycles;i++){
  start=performance.now();const job=semantic.start({query:'how are plans and documents organized',archived:true});
  let result=semantic.inspect(job.id);
  while(result.state==='running'){await delay(10);result=semantic.inspect(job.id);}
  // close() awaits owned bridge reaping; this does not stop the shared daemon.
  await semantic.close();sample();
  report('semantic',{cycle:i+1,elapsedMs:Math.round(performance.now()-start),state:result.state,documents:result.documents?.length??0,verifiedSections:result.sections?.length??0,coveragePartial:result.coverage?.partial??null});
  assert.equal(children.filter(child=>child.exitCode===null&&child.signalCode===null).length,0,'bridge must exit before the next cycle');
  assert.deepEqual(violations,[],'provider attempted an operation forbidden by existing-index-only qualification');
  start=performance.now();const exact=await library.query(new URLSearchParams({q:'plan',archived:'1'}));
  report('text-fallback',{cycle:i+1,elapsedMs:Math.round(performance.now()-start),matches:exact.total});
 }
 if(global.gc)global.gc();sample();
 report('settled',{sampledParentPeakMiB:round(peakParentMiB),sampledBridgePeakMiB:samples?round(peakBridgeMiB):null,bridgeRssSamples:samples,bridgesStarted:children.length,bridgesRemaining:0,safetyViolations:violations});
}finally{
 clearInterval(timer);await semantic.close();
 for(const child of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
 rmSync(temporary,{recursive:true,force:true});
}
