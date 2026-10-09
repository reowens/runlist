// macOS process-set measurement. Supply app, checkout helper and every WebKit
// service belonging to that app. Never infer attribution from process names.
import {execFileSync} from 'node:child_process';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {setTimeout} from 'node:timers/promises';
const pids=process.argv.slice(2);
if(process.platform!=='darwin'||!pids.length||pids.some(pid=>!/^\d+$/.test(pid)))throw new Error('Usage on macOS: node measure-processes.mjs <app-pid> <helper-pid> <webkit-pid> ...');
const dir=mkdtempSync(path.join(tmpdir(),'runlist-footprint-')),file=path.join(dir,'sample.json');
let peak=0,min=Infinity,last;
try {
 for(let sample=0;sample<40;sample++){
  execFileSync('/usr/bin/footprint',[...pids.flatMap(pid=>['-p',pid]),'--noCategories','-j',file],{stdio:'ignore'});
  last=JSON.parse(readFileSync(file,'utf8'));
  if(last.errors?.length||last.processes.length!==pids.length)throw new Error('A requested process exited or could not be measured. Establish the process set again.');
  peak=Math.max(peak,last['total footprint']);min=Math.min(min,last['total footprint']);
  if(sample<39)await setTimeout(250);
 }
 const mib=bytes=>Math.round(bytes/104857.6)/10;
 console.log(JSON.stringify({pids,architecture:process.arch,macOS:execFileSync('/usr/bin/sw_vers',['-productVersion'],{encoding:'utf8'}).trim(),samples:40,sampleIntervalMs:250,minFootprintMiB:mib(min),sampledPeakFootprintMiB:mib(peak),lastFootprintMiB:mib(last['total footprint']),sumIndividualLifetimePeaksMiB:mib(last.processes.reduce((sum,p)=>sum+p.auxiliary.phys_footprint_peak,0)),peakCaveat:'Individual lifetime peaks form an upper bound, not a simultaneous whole-app peak.',forcedGC:false,processes:last.processes.map(p=>({pid:p.pid,name:p.name,footprintMiB:mib(p.footprint)}))},null,2));
}finally{rmSync(dir,{recursive:true,force:true});}
