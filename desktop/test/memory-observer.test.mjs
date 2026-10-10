import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startObserver} from '../scripts/memory-observer.mjs';
import {parseVmStat,parsePower,assessHost,summarize} from '../scripts/measurement-statistics.mjs';
import {qualification,measurementExitCode} from '../scripts/memory-report.mjs';
import {fixture,measureHelper} from '../scripts/memory-workload.mjs';

const goodPower={source:'AC Power',mode:0,thermalWarning:false,thermalObservationAvailable:true};
const hostSamples=()=>Array.from({length:5},(_,i)=>({monotonicMs:i*1000,cpuBusyPercent:i?5:null,vm:{swapInBytes:0,swapOutBytes:0}}));
test('host admission uses interval CPU and swap deltas; old swap occupancy alone is not a rejection',()=>{
  assert.equal(assessHost(hostSamples(),[goodPower]).eligible,true);
  const busy=hostSamples();busy[2].cpuBusyPercent=95;
  assert.ok(assessHost(busy,[goodPower]).reasons.includes('CPU contention'));
  const swapping=hostSamples();swapping.at(-1).vm.swapInBytes=8*1024**2;
  assert.ok(assessHost(swapping,[goodPower]).reasons.includes('active swapping'));
  assert.equal(assessHost(hostSamples(),[{...goodPower,mode:null}]).eligible,false);
  assert.equal(assessHost(hostSamples(),[{...goodPower,thermalWarning:true}]).eligible,false);
  assert.equal(assessHost(hostSamples(),[goodPower],[{message:'permission denied'}]).eligible,false);
  assert.equal(assessHost(hostSamples().slice(0,2),[goodPower]).eligible,false);
  const reset=hostSamples();reset[0].vm.swapInBytes=100;
  assert.ok(assessHost(reset,[goodPower]).reasons.includes('swap telemetry unavailable'));
});
test('macOS telemetry preserves page size and active power mode without inferring an actual thermal state',()=>{
  const vm=parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\nSwapins: 10.\nSwapouts: 20.\nCompressions: 30.\nDecompressions: 40.\nPages occupied by compressor: 5.\n');
  assert.equal(vm.swapInBytes,163840);assert.equal(vm.compressorBytes,81920);
  assert.throws(()=>parseVmStat('Swapins: 10.'),/page size/);
  const settings='Battery Power:\n powermode 1\nAC Power:\n powermode 2\n';
  const power=parsePower('Note: No thermal warning level has been recorded',"Now drawing from 'AC Power'",settings);
  assert.equal(power.mode,2);assert.equal(power.thermalWarning,false);
  assert.equal(parsePower('CPU_Speed_Limit = 80',"Now drawing from 'AC Power'",settings).thermalWarning,true);
  assert.equal(parsePower('CPU_Speed_Limit = 100',"Now drawing from 'AC Power'",settings).thermalWarning,false);
  assert.equal(parsePower('unavailable','unavailable',settings).thermalObservationAvailable,false);
});
test('nine-observation P95 is marked as the maximum',()=>{
  assert.equal(summarize([1,2,3,4,5,6,7,8,9]).p95IsMaximum,true);
  assert.equal(summarize(Array.from({length:100},(_,i)=>i)).p95IsMaximum,false);
});
function measuredRun(run,n=100) {
  const timings=['library-refresh','flags-refresh','document-open','small-open-immediate-repeat'].flatMap(operation=>Array.from({length:n},(_,i)=>({operation,cycle:i+2,elapsedMs:10,context:'after-refresh'})));
  return {run,mutable:false,largeBytes:null,timings,sampleIntervalMs:250,sampledPeakRSSMiB:100,idleCPUPercent:0,helloMs:100,cleanup:{elapsedMs:50,code:0,signal:null,pending:0,processGone:true,remainingObservedDescendants:[]},samplingError:null,observer:{actualIntervals:{p95Ms:250},processSamples:100,host:{assessment:{eligible:true},preflight:{eligible:true}}}};
}
test('baseline qualification requires a complete fixed series, quiet telemetry, sufficient samples and sampler cadence',()=>{
  const input=()=>({environmentProfile:'baseline',plannedRuns:1,diagnosticOnly:false,workloads:[measuredRun(1)]});
  assert.equal(qualification(input()).componentBudgetsPass,true);
  for(const change of [r=>r.environmentProfile='ordinary-load',r=>r.plannedRuns=2,r=>r.diagnosticOnly=true,r=>r.workloads=[measuredRun(1,9)],r=>r.workloads[0].observer.host.assessment.eligible=false,r=>r.workloads[0].observer.actualIntervals.p95Ms=1000,r=>r.workloads[0].samplingError='sampler denied']) {
    const report=input();change(report);assert.equal(qualification(report).componentBudgetsPass,false);
  }
  const missing=input();missing.workloads[0].timings=missing.workloads[0].timings.filter(t=>t.operation!=='document-open');
  assert.equal(qualification(missing).componentBudgetsPass,false);
  assert.equal(qualification(input()).releaseQualified,false);
  assert.equal(qualification(input()).draftLatencyQualified,false);
  const exceeded=input();exceeded.workloads[0].sampledPeakRSSMiB=270;
  const failed={...exceeded,...qualification(exceeded)};
  assert.equal(failed.measurementStatus,'baseline-target-failure');assert.equal(measurementExitCode(failed),1);
  const unsuitable=input();unsuitable.workloads[0].samplingError='sampler denied';
  const incomplete={...unsuitable,...qualification(unsuitable)};
  assert.equal(incomplete.measurementStatus,'baseline-inconclusive');assert.equal(measurementExitCode(incomplete),2);
  const cold=input();cold.workloads[0].timings.push({operation:'library-cold',cycle:null,elapsedMs:55});
  assert.equal(qualification(cold).summaries['library-cold'].samples,1);
  assert.equal(qualification(cold).summaries['library-cold'].medianMs,55);
});
test('an observer blocked in an external command leaves the timing client able to release it and shuts down',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'runlist-observer-test-'));
  let observer;
  try {
    const script=path.join(dir,'sampler.mjs'),started=path.join(dir,'started'),release=path.join(dir,'release');
    await writeFile(script,`import {writeFile,access} from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';await writeFile(process.argv[2]+'/started','yes');for(;;){try{await access(process.argv[2]+'/release');break;}catch{await delay(10);}}console.log(process.argv[3]+' 1 1000 /fixture/RunlistHelper');`);
    observer=await startObserver({preflightMs:100,hostIntervalMs:100,intervalMs:100,processCommand:[process.execPath,script,dir,String(process.pid)]});
    observer.attach(process.pid);
    const deadline=performance.now()+10000;
    for(;;){try{await readFile(started);break;}catch{if(performance.now()>deadline)throw new Error('Fixture sampler did not start.');await delay(10);}}
    // A synchronous scan on this event loop would hold execution until the child
    // command's timeout and could not supply the release file while it was blocked.
    await writeFile(release,'yes');
    await delay(100);
    const report=await observer.stop();observer=null;
    assert.ok(report.processSamples>0);assert.deepEqual(report.processErrors,[]);
    assert.equal(report.sampledPeakRSSMiB,0.98);
    assert.equal(report.method,'independent-worker-async-process-commands');
    assert.ok(report.host.samples.length>=2);
  }finally{if(observer)await observer.stop();await rm(dir,{recursive:true,force:true});}
});
test('a refused helper request still closes the helper and observer and preserves failure telemetry',async()=>{
  const engine=await mkdtemp(path.join(tmpdir(),'runlist-observer-failure-')),corpus=fixture(100);
  try {
    await mkdir(path.join(engine,'runtime'));await mkdir(path.join(engine,'desktop'));
    await symlink(process.execPath,path.join(engine,'runtime',process.platform==='win32'?'RunlistHelper.exe':'RunlistHelper'));
    await writeFile(path.join(engine,'package.json'),'{"version":"fixture"}');
    await writeFile(path.join(engine,'desktop/helper.mjs'),`import {writeFileSync} from 'node:fs';writeFileSync(process.argv[3]+'/helper-pid',String(process.pid));process.stdin.setEncoding('utf8');process.stdin.on('data',data=>{for(const line of data.trim().split('\\n')){const m=JSON.parse(line);process.stdout.write(JSON.stringify({id:m.id,ok:false,error:{message:'fixture refusal'}})+'\\n');}});process.stdin.on('end',()=>process.exit(0));`);
    await assert.rejects(measureHelper({engine,root:corpus.root,mutable:true,preflightMs:100}),error=>{
      assert.equal(error.message,'fixture refusal');
      assert.equal(error.cleanup.code,0);assert.equal(error.cleanup.processGone,true);
      assert.equal(error.observation.method,'independent-worker-async-process-commands');
      return true;
    });
    const pid=Number(await readFile(path.join(corpus.root,'helper-pid'),'utf8'));
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
  }finally{corpus.close();await rm(engine,{recursive:true,force:true});}
});
test('a failed sampler command preserves exit information and returns an unqualified observation',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'runlist-sampler-failure-'));let observer;
  try {
    const script=path.join(dir,'failed.mjs'),started=path.join(dir,'started');
    await writeFile(script,`import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],'yes');process.exit(42);`);
    observer=await startObserver({preflightMs:100,hostIntervalMs:100,intervalMs:100,processCommand:[process.execPath,script,started]});
    observer.attach(process.pid);
    const deadline=performance.now()+10000;
    for(;;){try{await readFile(started);break;}catch{if(performance.now()>deadline)throw new Error('Fixture sampler did not start.');await delay(10);}}
    const report=await observer.stop();observer=null;
    assert.equal(report.processSamples,0);assert.ok(report.processErrors.length>0);
    assert.equal(report.processErrors[0].code,42);assert.equal(report.processErrors[0].killed,false);
  }finally{if(observer)await observer.stop();await rm(dir,{recursive:true,force:true});}
});
