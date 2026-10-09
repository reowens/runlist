// Terminal-only measurement; exact packaged helper, no native app/window/provider.
import {writeFileSync,readFileSync,realpathSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {fixture,measureHelper,sha256} from './memory-workload.mjs';
import {startObserver} from './memory-observer.mjs';
import {qualification,measurementExitCode} from './memory-report.mjs';
const options={};
for(let i=2;i<process.argv.length;i+=2) {
  const key=process.argv[i],value=process.argv[i+1];
  if(!['--engine','--checkout','--synthetic','--cycles','--runs','--output','--old-space','--semi-space','--workers','--profile-dir','--environment'].includes(key)||!value||options[key]!==undefined)throw new Error('Invalid measurement argument: '+key);
  options[key]=value;
}
if(!options['--engine']||!options['--output']||(!options['--checkout']&&!options['--synthetic']))throw new Error('Choose an exact engine, output, and checkout or synthetic corpus.');
const cycles=Number(options['--cycles']??10),count=Number(options['--synthetic']??5000),runs=Number(options['--runs']??1),environmentProfile=options['--environment']??'diagnostic';
if(!Number.isInteger(cycles)||cycles<3||cycles>20||!Number.isInteger(count)||count<100||count>5000||!Number.isInteger(runs)||runs<1||runs>6)throw new Error('Cycles must be 3–20; runs 1–6; synthetic corpus 100–5000.');
if(!['diagnostic','baseline','ordinary-load'].includes(environmentProfile))throw new Error('Environment must be diagnostic, baseline, or ordinary-load.');
if(options['--checkout']&&options['--synthetic'])throw new Error('Measure a read-only checkout or synthetic corpus separately.');
const oldSpaceMiB=Number(options['--old-space']??256),semiSpaceMiB=Number(options['--semi-space']??4);
if(![64,128,256].includes(oldSpaceMiB)||![1,2,4].includes(semiSpaceMiB))throw new Error('Use a bounded helper heap selection.');
if(options['--workers']!==undefined&&(options['--workers']!=='1'||!options['--synthetic']))throw new Error('Worker measurement is only available with an isolated synthetic corpus.');
if(options['--profile-dir']&&(!options['--synthetic']||environmentProfile==='baseline'))throw new Error('Allocation profiling is limited to diagnostic isolated synthetic corpora.');
const engine=realpathSync.native(options['--engine']),output=path.resolve(options['--output']);
const identityFiles=['package.json','desktop/helper.mjs','src/app-service.mjs','src/source-editor.mjs','runtime/RunlistHelper'];
try{readFileSync(path.join(engine,'desktop/line-framer.mjs'));identityFiles.push('desktop/line-framer.mjs');}catch(error){if(error.code!=='ENOENT')throw error;}
const report={schemaVersion:2,startedAt:new Date().toISOString(),engine,engineVersion:JSON.parse(readFileSync(path.join(engine,'package.json'),'utf8')).version,environmentProfile,plannedRuns:runs,cyclesPerRun:cycles,harnessIdentity:Object.fromEntries(['measure-memory.mjs','memory-workload.mjs','memory-observer.mjs','measurement-statistics.mjs','memory-report.mjs'].map(name=>[name,sha256(path.join(import.meta.dirname,name))])),identity:Object.fromEntries(identityFiles.map(name=>[name,sha256(path.join(engine,name))])),host:{platform:process.platform,architecture:process.arch,osRelease:os.release(),macOS:process.platform==='darwin'?execFileSync('/usr/bin/sw_vers',['-productVersion'],{encoding:'utf8'}).trim():null,physicalMemoryGiB:os.totalmem()/1024**3,cpu:os.cpus()[0]?.model,logicalCPUs:os.cpus().length,measurementNode:process.version},diagnosticOnly:Boolean(options['--profile-dir']),workloads:[],wholeAppQualified:false,releaseQualified:false};
const progress=value=>console.log(JSON.stringify(value));
// Reserve a fresh evidence path before starting an observer, fixture or helper.
writeFileSync(output,'',{flag:'wx',mode:0o600});
const save=()=>writeFileSync(output,JSON.stringify(report,null,2)+'\n');
try {
  if(environmentProfile==='baseline') {
    // Refuse before creating a corpus or spawning a helper on a contended host.
    const observer=await startObserver();report.preflight=await observer.stop();save();
  }
  if(!report.preflight||report.preflight.host.assessment.eligible) {
    for(let run=1;run<=runs;run++) {
      progress({stage:'run-start',run,plannedRuns:runs,environmentProfile});
      const corpus=options['--synthetic']?fixture(count):null;
      try {
        const result=await measureHelper({engine,root:corpus?.root??options['--checkout'],cycles,large:corpus?.large??null,mutable:Boolean(corpus),oldSpaceMiB,semiSpaceMiB,environmentProfile,workers:options['--workers']==='1',allocationProfileDirectory:options['--profile-dir']?path.join(options['--profile-dir'],'run-'+run):null,onStage:progress});
        report.workloads.push({name:corpus?'synthetic-edit-refresh-switch':'platform-read-only',run,...result});
        if(!result.skipped&&corpus&&result.documents!==corpus.documents)throw new Error('Synthetic document count differs from the fixture.');
        save();
        if(result.skipped)break; // Preserve the interrupted series; never retry until a pass.
      }finally{corpus?.close();}
    }
  }
  report.completedAt=new Date().toISOString();
  // The observer's outer report embeds host admission under host.assessment.
  if(report.preflight)report.preflight.assessment=report.preflight.host.assessment;
  Object.assign(report,qualification(report));save();
  progress({stage:'complete',output,completedRuns:report.completedRuns,componentBudgetsPass:report.componentBudgetsPass,targetChecksPass:report.targetChecksPass,qualificationReasons:report.qualificationReasons,wholeAppQualified:false});
  process.exitCode=measurementExitCode(report);
}catch(error){report.error={name:error.name,code:error.code??null,message:error.message};if(error.observation)report.failedWorkloadObservation=error.observation;if(error.cleanup)report.failedWorkloadCleanup=error.cleanup;save();throw error;}
