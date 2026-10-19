import {processOwnerLiveness} from './atomic-mutation.mjs';
import {fail} from './git-commit-store.mjs';

// A failed signal is never evidence that a worker or its process group stopped.
// Keep the receipt and let the caller inspect liveness again after the request.
export function requestCommitCancellation(store,id,{ownerLiveness=processOwnerLiveness,signal=(pid,value)=>process.kill(pid,value)}={}){
 const r=store.read(id);
 if(ownerLiveness(r.workerOwner)!=='live')fail('git-owner-unverified','The worker identity cannot be verified. Keep its receipt and inspect with Git.');
 store.update(id,d=>{d.cancelRequestedAt=new Date().toISOString();});
 try{signal(-r.workerOwner.pid,'SIGKILL');}
 catch(error){if(error.code!=='ESRCH')fail('git-cancel-failed','The Git process group could not be stopped. Keep its receipt and inspect the operation before continuing.');}
}
