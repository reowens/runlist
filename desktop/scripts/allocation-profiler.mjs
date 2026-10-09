// Fixture-only preload. An in-process inspector Session opens no debug port.
// Include collected objects so this profile diagnoses transient allocations,
// rather than treating the heap remaining at exit as total allocation.
import {Session} from 'node:inspector';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
const directory=process.env.RUNLIST_MEMORY_PROFILE_DIRECTORY;
if(!directory)throw new Error('The fixture allocation profile directory is required.');
const session=new Session();session.connect();
session.post('HeapProfiler.startSampling',{samplingInterval:131072,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
const original=Buffer.concat;
let calls=0,bytes=0,peakRSS=0;
Buffer.concat=function(chunks,size){
  calls++;bytes+=size??chunks.reduce((sum,chunk)=>sum+chunk.length,0);
  const value=original(chunks,size);peakRSS=Math.max(peakRSS,process.memoryUsage().rss);return value;
};
process.once('exit',()=>{
  Buffer.concat=original;
  session.post('HeapProfiler.stopSampling',(error,result)=>{
    writeFileSync(path.join(directory,'allocations.json'),JSON.stringify({diagnosticOnly:true,forcedGC:false,samplingIntervalBytes:131072,includeCollectedObjects:true,bufferConcat:{calls,allocatedBytes:bytes,synchronousPeakRSSBytes:peakRSS},error:error?.message??null,profile:result?.profile??null}));
    session.disconnect();
  });
});
