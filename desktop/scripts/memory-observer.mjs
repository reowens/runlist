// The observer never receives source bodies and never loads app/provider modules.
// Process commands execute asynchronously in a separate Worker, away from reply timing.
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import os from 'node:os';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {MiB,round,summarize,cpuMilliseconds,ownedProcesses,parseVmStat,parsePower,assessHost} from './measurement-statistics.mjs';
const exec=promisify(execFile);
const command=async(file,args)=> (await exec(file,args,{encoding:'utf8',timeout:5000,maxBuffer:4*MiB,windowsHide:true})).stdout;

export async function startObserver({intervalMs=250,hostIntervalMs=1000,preflightMs=5000,...options}={}) {
  const worker=new Worker(new URL(import.meta.url),{workerData:{intervalMs,hostIntervalMs,preflightMs,...options},resourceLimits:{maxOldGenerationSizeMb:32,maxYoungGenerationSizeMb:4}});
  let resolveReady,rejectReady,resolveDone,rejectDone,done=false,nextId=0;
  const pending=new Map(),descendants=new Map();
  const ready=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject;});
  const finished=new Promise((resolve,reject)=>{resolveDone=resolve;rejectDone=reject;});
  // A startup failure must not leave an unhandled second rejection.
  finished.catch(()=>{});
  worker.on('message',message=>{
    if(message.type==='ready')resolveReady(message.preflight);
    if(message.type==='done'){done=true;resolveDone(message.report);}
    if(message.type==='descendant')descendants.set(message.value.pid,message.value);
    if(message.type==='cpu'){const item=pending.get(message.id);if(item){pending.delete(message.id);message.error?item.reject(new Error(message.error)):item.resolve(message.value);}}
  });
  worker.on('error',error=>{rejectReady(error);rejectDone(error);for(const item of pending.values())item.reject(error);pending.clear();});
  worker.on('exit',code=>{if(!done){const error=new Error('Memory observer exited without a report: '+code);rejectReady(error);rejectDone(error);for(const item of pending.values())item.reject(error);pending.clear();}});
  try {
    const preflight=await ready;
    return {preflight,descendants,attach:pid=>worker.postMessage({type:'attach',pid}),phase:value=>worker.postMessage({type:'phase',value}),cpu:()=>new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});worker.postMessage({type:'cpu',id});}),async stop(){worker.postMessage({type:'stop'});const report=await finished;await new Promise(resolve=>{if(worker.threadId===-1)resolve();else worker.once('exit',resolve);});return report;}};
  }catch(error){await worker.terminate();throw error;}
}

if(!isMainThread)await observe();
async function observe() {
  const {intervalMs,hostIntervalMs,preflightMs,processCommand}=workerData;
  let pid=null,phase=null,stopping=false,attachedAt=null,peakRSS=0,peakTreeRSS=0,lastProcessStart=null,previousCPU=null,hostPhase='preflight';
  const observed=new Map(),durations=[],gaps=[],hostSamples=[],powerSamples=[],errors=[],processErrors=[];
  let processSamples=0,preflight;
  parentPort.on('message',message=>{
    if(message.type==='attach'){pid=message.pid;attachedAt=performance.now();hostPhase='workload';}
    if(message.type==='phase')phase=message.value;
    if(message.type==='stop')stopping=true;
    if(message.type==='cpu') {
      command('/bin/ps',['-o','time=','-p',String(pid)]).then(raw=>parentPort.postMessage({type:'cpu',id:message.id,value:{cpuMs:cpuMilliseconds(raw),monotonicMs:performance.now()}})).catch(error=>parentPort.postMessage({type:'cpu',id:message.id,error:error.message}));
    }
  });
  async function hostSample() {
    const start=performance.now(),cpu=os.cpus().map(c=>c.times),total=cpu.reduce((n,c)=>n+Object.values(c).reduce((a,b)=>a+b,0),0),idle=cpu.reduce((n,c)=>n+c.idle,0);
    const delta=previousCPU?total-previousCPU.total:0;
    const value={at:new Date().toISOString(),monotonicMs:round(start),phase:hostPhase,cpuBusyPercent:delta>0?round((1-(idle-previousCPU.idle)/delta)*100):null,loadAverage:os.loadavg().map(round),freeMemoryMiB:round(os.freemem()/MiB)};
    previousCPU={total,idle};
    try {
      if(os.platform()==='darwin') {
        const [vm,swap]=await Promise.all([command('/usr/bin/vm_stat',[]),command('/usr/sbin/sysctl',['vm.swapusage'])]);
        value.vm=parseVmStat(vm);value.swapUsedMiB=Number(swap.match(/used = ([\d.]+)M/)?.[1]??NaN);
      }else if(os.platform()==='linux') {
        const [vm,mem]=await Promise.all([readFile('/proc/vmstat','utf8'),readFile('/proc/meminfo','utf8')]);
        const fields=Object.fromEntries(vm.trim().split('\n').map(line=>line.split(/\s+/)));
        // Linux exposes swap counters in pages; obtain the actual host page size.
        const pageBytes=Number((await command('/usr/bin/getconf',['PAGESIZE'])).trim());
        if(!pageBytes||fields.pswpin===undefined||fields.pswpout===undefined)throw new Error('Unknown Linux swap counters/page size.');
        value.vm={pageBytes,swapInBytes:Number(fields.pswpin)*pageBytes,swapOutBytes:Number(fields.pswpout)*pageBytes};
        value.swapUsedMiB=(Number(mem.match(/^SwapTotal:\s+(\d+)/m)?.[1])-Number(mem.match(/^SwapFree:\s+(\d+)/m)?.[1]))/1024;
      }else throw new Error('Host swap telemetry unsupported on this platform.');
    }catch(error){errors.push({phase:hostPhase,message:error.message});value.vm=null;}
    value.observerCostMs=round(performance.now()-start);
    if(hostSamples.length>=10000)throw new Error('Host observation exceeded its bounded sample storage.');
    hostSamples.push(value);
  }
  async function powerSample() {
    try {
      if(os.platform()!=='darwin')throw new Error('Power/thermal baseline admission currently supports macOS only.');
      const [thermal,battery,settings]=await Promise.all([command('/usr/bin/pmset',['-g','therm']),command('/usr/bin/pmset',['-g','batt']),command('/usr/bin/pmset',['-g','custom'])]);
      powerSamples.push({at:new Date().toISOString(),phase:hostPhase,...parsePower(thermal,battery,settings)});
    }catch(error){errors.push({phase:hostPhase,message:error.message});}
  }
  await Promise.all([hostSample(),powerSample()]);
  const preflightStart=performance.now();
  while(performance.now()-preflightStart<preflightMs){await delay(Math.min(hostIntervalMs,Math.max(1,preflightMs-(performance.now()-preflightStart))));await hostSample();}
  preflight=assessHost(hostSamples,powerSamples,errors);
  parentPort.postMessage({type:'ready',preflight});
  const hostLoop=(async()=>{
    let ticks=0;
    while(!stopping){await delay(hostIntervalMs);if(stopping)break;await hostSample();if(++ticks%5===0)await powerSample();}
  })();
  while(!stopping) {
    const start=performance.now();
    if(pid!==null) {
      const samplePhase=phase;
      if(lastProcessStart!==null)gaps.push(start-lastProcessStart);
      lastProcessStart=start;
      try {
        const [file,...args]=processCommand??['/bin/ps','-axo','pid=,ppid=,rss=,comm='];
        const table=await command(file,args),tree=ownedProcesses(table,pid);
        if(!tree.some(p=>p.pid===pid)) {
          // Normal quit races the final sample; an absent live root is still an error.
          try{process.kill(pid,0);processErrors.push({code:'root-missing',message:'Live helper absent from process table.',at:new Date().toISOString()});}catch(error){if(error.code!=='ESRCH')throw error;}
        }else {
          processSamples++;peakTreeRSS=Math.max(peakTreeRSS,tree.reduce((sum,p)=>sum+p.rssBytes,0));
          for(const item of tree)if(item.pid===pid)peakRSS=Math.max(peakRSS,item.rssBytes);else {
            const prior=observed.get(item.pid);
            const value={pid:item.pid,ppid:item.ppid,name:item.name.startsWith('(')&&prior?prior.name:item.name,phases:[...new Set([...(prior?.phases??[]),samplePhase].filter(Boolean))],sampledPeakRSSMiB:round(Math.max(item.rssBytes/MiB,prior?.sampledPeakRSSMiB??0))};
            observed.set(item.pid,value);
            if(!prior)parentPort.postMessage({type:'descendant',value});
          }
        }
      }catch(error){processErrors.push({message:error.message,code:error.code??null,signal:error.signal??null,killed:error.killed??false,at:new Date().toISOString()});}
      durations.push(performance.now()-start);
      if(durations.length>=100000)throw new Error('Process observation exceeded its bounded sample storage.');
    }
    // No overlapping ps invocations or catch-up storm when the host is slow.
    await delay(Math.max(1,intervalMs-(performance.now()-start)));
  }
  await hostLoop;
  await Promise.all([hostSample(),powerSample()]);
  const hostAssessment=assessHost(hostSamples,powerSamples,errors);
  parentPort.postMessage({type:'done',report:{method:'independent-worker-async-process-commands',attachedAt,intervalMs,actualIntervals:summarize(gaps),processCommandCost:summarize(durations),overIntervalSamples:durations.filter(v=>v>intervalMs).length,processSamples,sampledPeakRSSMiB:round(peakRSS/MiB),sampledPeakSummedRSSMiB:round(peakTreeRSS/MiB),descendants:[...observed.values()],processErrors,host:{intervalMs:hostIntervalMs,samples:hostSamples,power:powerSamples,errors,preflight,assessment:hostAssessment},limitations:['Observer commands still consume host resources; they never run on the timing event loop.','Sampling is non-overlapping and best effort; reported intervals expose missed/late peaks.','Host CPU includes the measured workload and observer.','No reported thermal warning does not establish the actual ProcessInfo thermal state.']}});
  parentPort.close();
}
