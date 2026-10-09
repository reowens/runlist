// Shared by the timing client and its independent observer. No app/provider imports.
export const MiB=1024*1024;
export const round=value=>Math.round(value*100)/100;
export function percentile(values,fraction) {
  if(!values.length)return null;
  return round([...values].sort((a,b)=>a-b)[Math.ceil(values.length*fraction)-1]);
}
export function summarize(values) {
  return {samples:values.length,medianMs:percentile(values,.5),p95Ms:percentile(values,.95),maxMs:values.length?round(Math.max(...values)):null,p95IsMaximum:values.length>0&&Math.ceil(values.length*.95)===values.length};
}
export function cpuMilliseconds(value) {
  const match=value.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/);
  if(!match)throw new Error('Unrecognized process CPU time: '+value);
  return ((Number(match[1]??0)*86400)+(Number(match[2]??0)*3600)+Number(match[3])*60+Number(match[4]))*1000;
}
export function ownedProcesses(table,rootPid) {
  const all=table.trim().split('\n').flatMap(line=>{
    const match=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    return match?[{pid:Number(match[1]),ppid:Number(match[2]),rssBytes:Number(match[3])*1024,name:match[4].split('/').at(-1)}]:[];
  });
  const owned=new Set([rootPid]);
  for(let changed=true;changed;) {
    changed=false;
    for(const item of all)if(owned.has(item.ppid)&&!owned.has(item.pid)){owned.add(item.pid);changed=true;}
  }
  return all.filter(item=>owned.has(item.pid));
}
export function parseVmStat(raw) {
  const pageBytes=Number(raw.match(/page size of (\d+) bytes/)?.[1]);
  if(!pageBytes)throw new Error('Unknown vm_stat page size.');
  const pages=Object.fromEntries([...raw.matchAll(/^([^:\n]+):\s+(\d+)\./gm)].map(([,name,value])=>[name.trim(),Number(value)]));
  for(const name of ['Swapins','Swapouts','Compressions','Decompressions'])if(!Number.isFinite(pages[name]))throw new Error('Missing vm_stat counter: '+name);
  return {pageBytes,swapInBytes:pages.Swapins*pageBytes,swapOutBytes:pages.Swapouts*pageBytes,compressions:pages.Compressions,decompressions:pages.Decompressions,compressorBytes:(pages['Pages occupied by compressor']??0)*pageBytes};
}
export function parsePower(thermal,battery,settings) {
  const source=battery.match(/Now drawing from '([^']+)'/)?.[1]??null;
  const section=source==='AC Power'?'AC Power':source==='Battery Power'?'Battery Power':null;
  const mode=section?settings.split(section+':')[1]?.split(/\n\S[^\n]*:/)[0]?.match(/\bpowermode\s+(\d+)/)?.[1]:null;
  const warning=/warning level:\s*[1-9]|CPU_(?:Speed|Scheduler)_Limit\s*=\s*(?:[0-9]|[1-9][0-9])\b/i.test(thermal);
  const observed=/No thermal warning level has been recorded|thermal warning level:/i.test(thermal);
  return {source,mode:mode===undefined||mode===null?null:Number(mode),thermalWarning:warning,thermalObservationAvailable:observed,thermalObservation:'pmset reported warnings; not ProcessInfo.thermalState',thermalText:thermal.trim()};
}
export const baselinePolicy={version:1,cpuBusyP95MaximumPercent:20,swapTrafficMaximumMiBPerSecond:1,minimumHostIntervals:3,minimumWarmSamples:100,requiresACPower:true,requiresStablePowerMode:true,requiresNoReportedThermalWarning:true,scope:'Provisional measurement admission policy, not a vendor standard or a production requirement.'};
export function assessHost(samples,power,errors=[],policy=baselinePolicy) {
  const reasons=[];
  if(errors.length)reasons.push('host telemetry incomplete');
  const intervals=samples.filter(s=>Number.isFinite(s.cpuBusyPercent));
  if(intervals.length<policy.minimumHostIntervals)reasons.push('insufficient host intervals');
  const cpuBusyP95Percent=percentile(intervals.map(s=>s.cpuBusyPercent),.95);
  if(cpuBusyP95Percent!==null&&cpuBusyP95Percent>policy.cpuBusyP95MaximumPercent)reasons.push('CPU contention');
  const first=samples[0],last=samples.at(-1),elapsedSeconds=first&&last?(last.monotonicMs-first.monotonicMs)/1000:0;
  const countersAvailable=samples.length>=2&&samples.every(s=>s.vm&&Number.isFinite(s.vm.swapInBytes)&&Number.isFinite(s.vm.swapOutBytes));
  const validCounters=countersAvailable&&samples.every((s,i)=>i===0||s.vm.swapInBytes>=samples[i-1].vm.swapInBytes&&s.vm.swapOutBytes>=samples[i-1].vm.swapOutBytes);
  const swappedBytes=validCounters?last.vm.swapInBytes-first.vm.swapInBytes+last.vm.swapOutBytes-first.vm.swapOutBytes:null;
  const swapTrafficMiBPerSecond=swappedBytes!==null&&elapsedSeconds>0&&swappedBytes>=0?round(swappedBytes/MiB/elapsedSeconds):null;
  if(swapTrafficMiBPerSecond===null)reasons.push('swap telemetry unavailable');
  else if(swapTrafficMiBPerSecond>policy.swapTrafficMaximumMiBPerSecond)reasons.push('active swapping');
  if(!power.length||power.some(p=>!p.thermalObservationAvailable))reasons.push('thermal warning telemetry unavailable');
  if(power.some(p=>p.thermalWarning))reasons.push('thermal/performance warning');
  if(policy.requiresACPower&&(!power.length||power.some(p=>p.source!=='AC Power')))reasons.push('AC power not established');
  if(policy.requiresStablePowerMode&&(!power.length||power.some(p=>p.mode===null||p.mode!==power[0].mode)))reasons.push('power mode not established or changed');
  return {eligible:reasons.length===0,reasons,cpuBusyP95Percent,swapTrafficMiBPerSecond,elapsedSeconds:round(elapsedSeconds),hostIntervals:intervals.length,policy};
}
