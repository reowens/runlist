// Trusted child runner: CLI lifecycle behavior, without borrowing agent identity.
import {resolveConfig} from './config.mjs';import {runSet} from './lifecycle.mjs';
import {runYardstick,assertYardstickReviewGuards} from './yardstick-command.mjs';
import {isBundledRunlistRuntime} from './desktop-runtime.mjs';
if (isBundledRunlistRuntime(process.execPath)) process.title='RunlistLifecycle';
process.on('message',async request=>{
 try{if(request.kind==='yardstick')assertYardstickReviewGuards(request.guards);const config=await resolveConfig(request.repoRoot,request.configPath??undefined);const options={dryRun:request.dryRun,note:request.note,guards:request.guards??[],expectedDestination:request.expectedDestination};
  const result=request.kind==='yardstick'?await runYardstick(request.argv,config,{...options,captureGuards:true}):await runSet([request.status,request.file],config,options);
  process.send({ok:true,result,...(request.kind==='yardstick'?{guards:result.preparedGuards}: {})});}
 catch(error){process.send({ok:false,code:error.code??(/changed|appeared|owned|claim/i.test(error.message)?'lifecycle-conflict':'lifecycle-failed'),message:error.message});}
 finally{process.disconnect();}
});
