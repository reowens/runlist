// Trusted child runner: CLI lifecycle behavior, without borrowing agent identity.
import {resolveConfig} from './config.mjs';import {runSet} from './lifecycle.mjs';
import {isBundledRunlistRuntime} from './desktop-runtime.mjs';
if (isBundledRunlistRuntime(process.execPath)) process.title='RunlistLifecycle';
process.on('message',async request=>{
 try{const config=await resolveConfig(request.repoRoot,request.configPath??undefined);const result=await runSet([request.status,request.file],config,{dryRun:request.dryRun,note:request.note,guards:request.guards??[],expectedDestination:request.expectedDestination});process.send({ok:true,result});}
 catch(error){process.send({ok:false,code:error.code??(/changed|appeared|owned|claim/i.test(error.message)?'lifecycle-conflict':'lifecycle-failed'),message:error.message});}
 finally{process.disconnect();}
});
