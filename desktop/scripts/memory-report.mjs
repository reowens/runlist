import {summarize,baselinePolicy} from './measurement-statistics.mjs';
// Existing numeric targets are unchanged. New repeat-open scenarios use the same
// size-specific targets; draft latency is exposed without inventing a calibrated gate.
export const latencyTargets={
  'library-refresh':2000,'flags-refresh':15000,'document-open':250,'large-open':1500,
  'small-open-immediate-repeat':250,'large-open-immediate-repeat':1500,'small-save':1000,'large-save':3000
};
export function summarizeSeries(workloads) {
  const completed=workloads.filter(w=>!w.skipped),timings=completed.flatMap(w=>(w.timings??[]).map(t=>({...t,run:w.run}))),summaries={},scenarios={};
  for(const op of new Set(timings.map(t=>t.operation)))summaries[op]=summarize(timings.filter(t=>t.operation===op&&(t.cycle===null||t.cycle>1)).map(t=>t.elapsedMs));
  for(const key of new Set(timings.filter(t=>t.context).map(t=>t.operation+':'+t.context)))scenarios[key]=summarize(timings.filter(t=>t.operation+':'+t.context===key&&t.cycle>1).map(t=>t.elapsedMs));
  const checks=[];
  const peak=(metric,values,maximum)=>{const actual=values.length?Math.max(...values):null;checks.push({metric,actual,maximum,pass:Number.isFinite(actual)&&actual<=maximum});};
  peak('helper peak RSS',completed.map(w=>w.sampledPeakRSSMiB),256);
  peak('idle CPU',completed.map(w=>w.idleCPUPercent),1);
  peak('helper hello',completed.map(w=>w.helloMs),2000);
  peak('cleanup',completed.map(w=>w.cleanup?.elapsedMs),2000);
  const expectedLarge=completed.some(w=>w.largeBytes),expectedMutable=completed.some(w=>w.mutable);
  for(const [operation,maximum] of Object.entries(latencyTargets)) {
    if(operation.startsWith('large-')&&!expectedLarge||operation.endsWith('save')&&!expectedMutable)continue;
    const stats=summaries[operation],actual=stats?.p95Ms??null;
    checks.push({metric:operation,actual,maximum,samples:stats?.samples??0,pass:Number.isFinite(actual)&&actual<=maximum});
  }
  checks.push({metric:'clean helper exit',pass:completed.length>0&&completed.every(w=>w.cleanup?.code===0&&w.cleanup.signal===null&&w.cleanup.pending===0&&w.cleanup.processGone&&w.cleanup.remainingObservedDescendants.length===0)});
  checks.push({metric:'sampling succeeded',pass:completed.length>0&&completed.every(w=>w.samplingError===null)});
  const withWorkers=completed.filter(w=>w.ownedTree);
  if(withWorkers.length){
    peak('owned helper/worker RSS',withWorkers.map(w=>w.ownedTree.sampledPeakSummedRSSMiB),512);
    checks.push({metric:'lifecycle/Git workers observed',pass:withWorkers.every(w=>['lifecycle-worker','git-review-wait','git-commit-wait'].every(phase=>w.ownedTree.descendants.some(item=>item.ppid===w.cleanup.pid&&item.phases.includes(phase)&&(phase==='lifecycle-worker'?['RunlistLifecycle','RunlistHelper']:['RunlistGit']).includes(item.name.replace(/^\(|\)$/g,'')))))});
  }
  const sampleCoverage=checks.filter(c=>'samples'in c).map(c=>({metric:c.metric,samples:c.samples,minimum:baselinePolicy.minimumWarmSamples,sufficient:c.samples>=baselinePolicy.minimumWarmSamples}));
  return {completedRuns:completed.length,summaries,scenarioSummaries:scenarios,checks,targetChecksPass:checks.every(c=>c.pass),sampleCoverage,sufficientWarmSamples:sampleCoverage.length>0&&sampleCoverage.every(c=>c.sufficient)};
}
export function qualification(report) {
  const series=summarizeSeries(report.workloads),reasons=[];
  if(report.environmentProfile!=='baseline')reasons.push('not a controlled baseline profile');
  if(report.diagnosticOnly)reasons.push('allocation profiling enabled');
  if(series.completedRuns!==report.plannedRuns)reasons.push('planned series incomplete');
  if(!series.sufficientWarmSamples)reasons.push('insufficient warm timing samples');
  if(report.preflight&&!report.preflight.assessment.eligible)reasons.push('preflight host not quiet');
  const completed=report.workloads.filter(w=>!w.skipped);
  if(!completed.length||completed.some(w=>!w.observer?.host.assessment.eligible||!w.observer.host.preflight.eligible))reasons.push('host conditions not established or contended');
  if(completed.some(w=>w.observer.actualIntervals.p95Ms>w.sampleIntervalMs*2||w.observer.processSamples===0))reasons.push('process sampler cadence insufficient');
  if(completed.some(w=>w.samplingError!==null))reasons.push('process sampling incomplete');
  if(!series.targetChecksPass)reasons.push(!completed.length||series.checks.some(c=>c.actual===null)?'component checks incomplete':'component targets exceeded or checks failed');
  const inconclusive=reasons.some(r=>r.includes('host')||r.includes('samples')||r.includes('incomplete')||r.includes('cadence'));
  const measurementStatus=report.environmentProfile==='baseline'?(reasons.length===0?'qualified-component-baseline':inconclusive?'baseline-inconclusive':'baseline-target-failure'):report.environmentProfile+'-completed';
  return {...series,baselinePolicy,measurementStatus,qualificationReasons:reasons,componentBudgetsPass:reasons.length===0,draftLatencyQualified:false,draftLatencyTargets:{status:'uncalibrated; inspect small/large preservation and discard separately',smallMs:null,largeMs:null},wholeAppQualified:false,releaseQualified:false};
}
export function measurementExitCode(report) {
  if(report.environmentProfile==='baseline'&&!report.componentBudgetsPass)return report.qualificationReasons.some(r=>r.includes('host')||r.includes('samples')||r.includes('incomplete')||r.includes('cadence'))?2:1;
  return report.targetChecksPass?0:1;
}
