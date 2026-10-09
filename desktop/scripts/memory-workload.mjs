// Terminal-only component measurements. Never starts Tauri, a WebView or gmax.
import {spawn, execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync,openSync,readSync,closeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {checkoutTrust} from '../trust.mjs';

import {MiB,round,summarize,cpuMilliseconds,percentile,ownedProcesses} from './measurement-statistics.mjs';
import {startObserver} from './memory-observer.mjs';
export {MiB,round,cpuMilliseconds,percentile,ownedProcesses};
export function fixture(count=5000) {
  const root=realpathSync.native(mkdtempSync(path.join(tmpdir(),'runlist-memory-corpus-')));
  try {
    mkdirSync(path.join(root,'docs/plans'),{recursive:true});
    mkdirSync(path.join(root,'.runlist'),{recursive:true});
    writeFileSync(path.join(root,'runlist.config.mjs'),"export const root='docs';\n");
    const flags=[];
    for(let i=0;i<count;i++) {
      const name=`docs/plans/item-${String(i).padStart(5,'0')}.md`,archived=i%10===0;
      const hub=i%50===1, type=i%10===2?'doc':'plan';
      writeFileSync(path.join(root,name),`---\ntype: ${type}\nstatus: ${archived?'archived':'active'}\n${hub?'execution_mode: coordination\nrunlist: [item-00003.md]\n':''}---\n# Corpus item ${i}\n\n`+
        'A fixture paragraph with **formatting**, [a local link](item-00003.md), and Unicode 先 🧭.\n\n'.repeat(12)+
        '## Decisions\n\n### D1 Which bin?\nDisposition: OPEN.\n\nQuestion: Which bin?\nAlternatives: Red or blue.\n\n## Work\n\n- [ ] Wait for D1.\n');
      if(i%10===3)flags.push({event:'add',id:`F${flags.length+1}`,at:'2026-10-07T00:00:00Z',file:name,line:7,quote:`# Corpus item ${i}`,text:`Review fixture ${i}`,severity:'warn',by:{kind:'check',name:'memory-fixture'}});
    }
    writeFileSync(path.join(root,'.runlist/flags.jsonl'),flags.map(value=>JSON.stringify(value)).join('\n')+'\n');
    const large='docs/plans/large.md';
    writeFileSync(path.join(root,large),'---\ntype: plan\nstatus: active\n---\n# Large Unicode document\n\n'+('A large Unicode narrative 先 🧭 with **formatting**. '.repeat(120)+'\n\n').repeat(320));
    return {root,large,documents:count+1,close:()=>rmSync(root,{recursive:true,force:true})};
  } catch(error) {rmSync(root,{recursive:true,force:true});throw error;}
}
export function helperEnvironment() {
  const env={};
  for(const key of ['HOME','USER','LOGNAME','TMPDIR','LANG','LC_ALL','USERPROFILE','USERNAME','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA','ProgramData','SystemRoot','WINDIR','TEMP','TMP','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','GNUPGHOME'])if(process.env[key]!==undefined)env[key]=process.env[key];
  env.PATH=process.platform==='darwin'?'/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin':'/usr/local/bin:/usr/bin:/bin';
  return env;
}
export async function measureHelper({engine,root,cycles=10,mutable=false,large=null,idleMs=15000,environmentProfile='diagnostic',preflightMs=5000,oldSpaceMiB=256,semiSpaceMiB=4,workers=false,allocationProfileDirectory=null,onStage=()=>{}}) {
  if(workers&&!mutable)throw new Error('Worker measurement requires an isolated mutable fixture.');
  if(allocationProfileDirectory&&!mutable)throw new Error('Allocation profiles require an isolated mutable fixture.');
  if(allocationProfileDirectory){allocationProfileDirectory=path.resolve(allocationProfileDirectory);mkdirSync(allocationProfileDirectory,{recursive:true});}
  root=checkoutTrust(root).root;
  const trust=checkoutTrust(root),version=JSON.parse(readFileSync(path.join(engine,'package.json'),'utf8')).version;
  const runtime=path.join(engine,'runtime',process.platform==='win32'?'RunlistHelper.exe':'RunlistHelper');
  const environment=helperEnvironment();
  if(allocationProfileDirectory)environment.RUNLIST_MEMORY_PROFILE_DIRECTORY=allocationProfileDirectory;
  if(workers){environment.HOME=path.join(root,'.memory-home');mkdirSync(environment.HOME,{recursive:true});}
  const observer=await startObserver({intervalMs:workers?50:250,preflightMs});
  if(environmentProfile==='baseline'&&!observer.preflight.eligible)return {skipped:true,reason:'host-not-quiet',observer:await observer.stop()};
  const started=performance.now(),child=spawn(runtime,[`--max-old-space-size=${oldSpaceMiB}`,`--max-semi-space-size=${semiSpaceMiB}`,...(allocationProfileDirectory?['--import',path.join(import.meta.dirname,'allocation-profiler.mjs')]:[]),path.join(engine,'desktop/helper.mjs'),'--serve',root,trust.fingerprint],{env:environment,stdio:['pipe','pipe','pipe'],windowsHide:true});
  const handle=randomUUID(),pending=new Map(),timings=[],samples=[];
  observer.attach(child.pid);
  let buffer='',diagnostics='',peakRSS=0,libraryInvalidated=false;
  const observed=observer.descendants;
  const phase=value=>observer.phase(value);
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  exited.catch(()=>{});
  child.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-2000);});
  const rejectPending=error=>{for(const value of pending.values()){clearTimeout(value.timer);value.reject(error);}pending.clear();};
  child.once('error',rejectPending);
  child.stdin.on('error',rejectPending);
  child.once('close',()=>rejectPending(new Error('Helper exited before responding.')));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    buffer+=chunk;
    let end;
    try {
      while((end=buffer.indexOf('\n'))>=0) {
        const reply=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
        const item=pending.get(reply.id);if(!item)continue;
        pending.delete(reply.id);clearTimeout(item.timer);
        reply.ok?item.resolve(reply.value):item.reject(Object.assign(new Error(reply.error.message),reply.error));
      }
      if(Buffer.byteLength(buffer)>32*MiB)throw new Error('Oversized helper frame.');
    }catch(error){rejectPending(error);child.kill('SIGTERM');}
  });
  function call(op,route,body) {
    if(body!==undefined&&!mutable)throw new Error('Read-only measurement refuses mutations.');
    return new Promise((resolve,reject)=>{
      const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);reject(new Error('Helper deadline exceeded.'));},75000);
      pending.set(id,{resolve,reject,timer});
      child.stdin.write(JSON.stringify({id,protocol:1,version,handle,op,...(route?{route:'/api/'+route}:{}),...(body===undefined?{}:{body})})+'\n');
    });
  }
  async function metrics(stage) {
    const value=await call('metrics');peakRSS=Math.max(peakRSS,value.rss);
    samples.push({stage,...Object.fromEntries(Object.entries(value).map(([key,bytes])=>[key,round(bytes/MiB)]))});
    onStage({stage,memoryMiB:samples.at(-1)});
  }
  async function request(operation,route,body,cycle=null,context=null) {
    const start=performance.now();phase(operation);
    try {
      const value=await call('request',route,body);
      timings.push({operation,cycle,context,elapsedMs:round(performance.now()-start)});
      if(route==='save')libraryInvalidated=true;
      else if(route.startsWith('document?')||route.startsWith('library'))libraryInvalidated=false;
      return value;
    }finally{phase(null);}
  }
  let result,error,cleanup;
  try {
    await call('hello');const helloMs=round(performance.now()-started);await metrics('startup');
    const inventory=await request('library-cold','library?archived=1&limit=100');let visibleCounts;
    if(inventory.stats?.unavailable||inventory.stats?.discoveryErrors)throw new Error('Document discovery was incomplete.');
    if(large&&!inventory.documents.some(doc=>doc.path===large)) {
      // Large source can lie beyond the first page; its document request verifies scope.
      await request('large-cold','document?'+new URLSearchParams({path:large}));
    }
    const paths=inventory.documents.slice(0,3).map(doc=>doc.path);
    if(large&&!paths.includes(large))paths.push(large);
    if(!paths.length)throw new Error('No documents available for the switching workload.');
    for(let cycle=1;cycle<=cycles;cycle++) {
      visibleCounts=(await request('library-refresh','library?refresh=1',undefined,cycle)).counts;
      const flags=await request('flags-refresh','records?kind=flags&refresh=1',undefined,cycle);
      const decisions=await request('decisions-query','records?kind=decisions&status=',undefined,cycle);
      if(flags.unavailable||decisions.unavailable)throw new Error('Record discovery was incomplete.');
      await request('metadata-search','library?q=plan&limit=100',undefined,cycle);
      for(const documentPath of paths) {
        const openContext=libraryInvalidated?'after-save-invalidation':'after-refresh';
        let doc=await request(documentPath===large?'large-open':'document-open','document?'+new URLSearchParams({path:documentPath}),undefined,cycle,openContext);
        const repeated=await request(documentPath===large?'large-open-immediate-repeat':'small-open-immediate-repeat','document?'+new URLSearchParams({path:documentPath}),undefined,cycle,'immediate-repeat');
        if(repeated.source!==doc.source||repeated.revision!==doc.revision)throw new Error('Repeated fixture open changed source/revision.');
        if(mutable&&doc.editable) {
          const before=doc.source,source=before+'\nMemory qualification edit '+cycle+'.\n',draftId=randomUUID();
          if(before!==readFileSync(path.join(root,doc.path),'utf8'))throw new Error('Opened fixture bytes did not round-trip.');
          const draft=await request(documentPath===large?'large-draft-write':'small-draft-write','draft/write',{path:doc.path,draftId,expectedDraftRevision:null,baseSource:before,baseRevision:doc.revision,source},cycle);
          await request(documentPath===large?'large-draft-discard':'small-draft-discard','draft/discard',{path:doc.path,draftId,expectedDraftRevision:draft.revision},cycle);
          await request(documentPath===large?'large-save':'small-save','save',{path:doc.path,operationId:randomUUID(),expectedRevision:doc.revision,source},cycle);
          doc=await request(documentPath===large?'large-saved-open':'small-saved-open','document?'+new URLSearchParams({path:documentPath}),undefined,cycle,'after-save-invalidation');
          if(doc.source!==source)throw new Error('Edited bytes did not round-trip.');
          await request(documentPath===large?'large-save-restore':'small-save-restore','save',{path:doc.path,operationId:randomUUID(),expectedRevision:doc.revision,source:before},cycle);
          if(readFileSync(path.join(root,doc.path),'utf8')!==before)throw new Error('Fixture restore failed.');
        }
      }
      await metrics('cycle-'+cycle);
      onStage({stage:'cycle-complete',cycle,documents:inventory.inventoryTotal,flags:flags.total,decisions:decisions.total});
    }
    let workerOperations=null;
    if(workers) {
      const documentPath='docs/plans/item-00003.md';
      const doc=await request('worker-document','document?'+new URLSearchParams({path:documentPath}));
      const lifecycleId=randomUUID();
      await request('lifecycle-preview','lifecycle/preview',{path:doc.path,status:'planned',note:'Isolated memory qualification',expectedRevision:doc.revision,operationId:lifecycleId});
      const lifecycle=await request('lifecycle-worker','lifecycle/commit',{operationId:lifecycleId});
      if(lifecycle.state!=='committed')throw new Error('Fixture lifecycle did not commit.');
      const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',env:{...environment,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdio:['ignore','pipe','pipe']}).trim();
      writeFileSync(path.join(root,'.gitignore'),'.runlist/\n.memory-home/\n');
      git('init','-q','-b','main');git('config','user.name','Memory Fixture');git('config','user.email','memory@invalid.example');git('config','commit.gpgSign','false');git('config','core.hooksPath',path.join(root,'.memory-home/no-hooks'));
      git('add','--',documentPath,'.gitignore','runlist.config.mjs');git('commit','-qm','Isolated fixture baseline');
      const before=git('rev-parse','HEAD');
      writeFileSync(path.join(root,documentPath),readFileSync(path.join(root,documentPath),'utf8')+'\nIsolated Git memory edit.\n');
      const id=randomUUID();
      const settle=async phaseLabel=>{
        const deadline=performance.now()+75000;
        phase(phaseLabel);
        try {
          while(performance.now()<deadline){const value=await call('request','git/operation?id='+id);if(!value.running)return value;await delay(25);}
          throw new Error('Fixture Git worker deadline exceeded.');
        }finally{phase(null);}
      };
      await request('git-preview-start','git/commit/preview',{operationId:id,paths:[documentPath],message:'Isolated memory qualification'});
      const review=await settle('git-review-wait');if(review.state!=='reviewed'||!review.canCommit)throw new Error('Fixture Git review refused: '+(review.failure?.code??review.state));
      await request('git-commit-start','git/commit/start',{operationId:id});
      const commit=await settle('git-commit-wait');if(commit.state!=='committed')throw new Error('Fixture Git commit refused: '+(commit.failure?.code??commit.state));
      if(git('diff-tree','--no-commit-id','--name-only','-r',before,commit.commitId)!==documentPath)throw new Error('Fixture Git commit widened its paths.');
      workerOperations={lifecycle:lifecycle.state,gitPreview:review.state,gitCommit:commit.state};
      await metrics('after-workers');
    }
    await metrics('before-idle');phase('idle');const cpuStart=await observer.cpu();
    await delay(idleMs);const cpuEnd=await observer.cpu(),idleElapsedMs=cpuEnd.monotonicMs-cpuStart.monotonicMs;phase(null);
    await metrics('idle');
    const summaries={};
    for(const operation of new Set(timings.map(item=>item.operation))) {
      const values=timings.filter(item=>item.operation===operation&&(item.cycle===null||item.cycle>1)).map(item=>item.elapsedMs);
      summaries[operation]=summarize(values);
    }
    const scenarioSummaries={};
    for(const key of new Set(timings.filter(t=>t.context).map(t=>t.operation+':'+t.context)))scenarioSummaries[key]=summarize(timings.filter(t=>t.operation+':'+t.context===key&&t.cycle>1).map(t=>t.elapsedMs));
    const first=samples.find(item=>item.stage==='cycle-2'),last=samples.find(item=>item.stage==='cycle-'+cycles);
    result={version,node:execFileSync(runtime,['--version'],{encoding:'utf8',env:helperEnvironment()}).trim(),heapLimits:{oldSpaceMiB,semiSpaceMiB},allocationProfile:allocationProfileDirectory?{diagnosticOnly:true,directory:allocationProfileDirectory,profilerSHA256:sha256(path.join(import.meta.dirname,'allocation-profiler.mjs'))}:null,helloMs,documents:inventory.inventoryTotal,countsIncludingArchived:inventory.counts,visibleCounts,cycles,mutable,largeBytes:large?Buffer.byteLength(readFileSync(path.join(root,large))):null,forcedGC:false,sampleIntervalMs:workers?50:250,sampledPeakRSSMiB:round(peakRSS/MiB),settledRSSMiB:samples.find(s=>s.stage==='idle')?.rss,workerOperations,idleCPUPercent:round((cpuEnd.cpuMs-cpuStart.cpuMs)/idleElapsedMs*100),idleElapsedMs:round(idleElapsedMs),retainedHeapGrowthMiB:first&&last?round(last.heapUsed-first.heapUsed):null,samples,timings,summaries,scenarioSummaries,limitations:['Native core and WebView are absent; summed process RSS double-counts shared pages and is not macOS footprint.','Sampled peaks may miss short allocations; CPU time is quantized by ps.', 'Immediate-repeat opens express cache intent; the unmodified helper does not expose internal refresh timing/generation with document replies.','No forced GC; retained heap delta is diagnostic, not a proof of a leak.','No semantic request or external daemon/model is exercised.',...(allocationProfileDirectory?['Allocation profiling adds overhead; this diagnostic run does not qualify release budgets.']:[]),...(workers?[]:['Git and lifecycle workers were not exercised.'])]};
  }catch(cause){error=cause;}
  finally {
    const start=performance.now();child.stdin.end();
    const deadline=setTimeout(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');},5000);
    try {
      const exit=await exited;
      cleanup={...exit,elapsedMs:round(performance.now()-start),pid:child.pid,pending:pending.size,processGone:Number.isInteger(child.pid)&&!processExists(child.pid),remainingObservedDescendants:[...observed.values()].filter(item=>processExists(item.pid))};
      if(result)result.cleanup=cleanup;
      if(exit.code!==0&&!error)error=new Error('Helper cleanup failed: '+JSON.stringify(exit));
    }catch(cause){error??=cause;}
    finally{clearTimeout(deadline);rejectPending(new Error('Measurement closed.'));}
  }
  let observation;
  try{observation=await observer.stop();}catch(cause){cause.cleanup=cleanup;throw cause;}
  if(result){result.observer=observation;result.sampledPeakRSSMiB=Math.max(result.sampledPeakRSSMiB,observation.sampledPeakRSSMiB);result.samplingError=observation.processErrors.length?observation.processErrors.map(e=>e.message??e).join('; '):observation.processSamples===0?'No process samples collected.':null;result.ownedTree=workers?{sampledPeakSummedRSSMiB:observation.sampledPeakSummedRSSMiB,descendants:observation.descendants}:null;}
  if(error){error.observation=observation;error.cleanup=cleanup;throw error;}
  return result;
}
function processExists(pid) {try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
export function sha256(file) {
  const fd=openSync(file,'r'),buffer=Buffer.alloc(64*1024),hash=createHash('sha256');
  try {let count;while((count=readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,count));return hash.digest('hex');}
  finally{closeSync(fd);}
}
