// Trusted isolated worker and invocation-scoped Git guards; never an API shell.
import {readFileSync} from 'node:fs';
import {commitStore} from './git-commit-store.mjs';
import {previewProtocol,executeProtocol,inspectProtocol,recoverProtocol,settleProtocol,hookInvocation} from './git-commit-protocol.mjs';
import {currentProcessOwner,processOwnerLiveness} from './atomic-mutation.mjs';
import {signingInvocation} from './git-commit-signing.mjs';
process.title='RunlistGit';
if(process.argv[2]==='--hook'){
 try{const [, , ,root,actorId,id,kind,...args]=process.argv;hookInvocation(commitStore(root,{kind:'human',id:actorId}),id,kind,args,kind==='reference-transaction'?readFileSync(0):Buffer.alloc(0));}
 catch(error){process.stderr.write(`Runlist commit guard: ${error.code??'git-guard-failed'}\n`);process.exitCode=1;}
}else if(process.argv[2]==='--sign'){
 try{const [, , ,root,actorId,id,...args]=process.argv;signingInvocation(commitStore(root,{kind:'human',id:actorId}),id,args);}
 catch(error){process.stderr.write(`Runlist signer: ${error.code??'git-signing-failed'}\n`);process.exitCode=1;}
}else{
 const guard=setTimeout(()=>process.exit(1),5000);process.once('message',async request=>{
  clearTimeout(guard);const store=commitStore(request.root,request.actor);let timer;
  try{
   const r=store.read(request.id);if(r.launchToken!==request.token||r.action!==request.action||r.workerOwner?.pid!==process.pid||r.workerOwner?.processStartIdentity!==currentProcessOwner().processStartIdentity)throw new Error('Worker ownership was not registered.');
   // Parent loss is safe: the accepted bounded job keeps its durable receipt.
   timer=setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL');}catch{process.exit(1);}},65000);
   if(request.action==='preview')previewProtocol(store,request.id);
   else if(request.action==='execute')await executeProtocol(store,request.id);
   else if(request.action==='recover')recoverProtocol(store,request.id);
   else if(request.action==='inspect')inspectProtocol(store,request.id);
   else if(request.action==='settle')settleProtocol(store,request.id);
   else throw new Error('Unknown Git job.');
  }catch(error){
   try{store.update(request.id,d=>{d.failure={code:error.code??'git-job-failed',message:error.code?error.message:'The Git job stopped. Inspect the retained operation before continuing.'};if(request.action==='preview')d.state='failed';});if(request.action==='execute'){const retained=store.read(request.id);if(!retained.gitOwner||processOwnerLiveness(retained.gitOwner)==='dead')inspectProtocol(store,request.id);}}
   catch{/* Leave the last durable state; inspection must not replay execution. */}
  }finally{clearTimeout(timer);try{store.update(request.id,d=>{d.finishedAt=new Date().toISOString();});}catch{}if(process.connected)process.disconnect();}
 });
}
