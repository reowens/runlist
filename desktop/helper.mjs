import {checkoutTrust} from './trust.mjs';
import {resolveConfig} from '../src/config.mjs';
import {createCheckoutService,localActor,appError} from '../src/app-service.mjs';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {SourceEditError} from '../src/source-editor.mjs';
import {createLineFramer} from './line-framer.mjs';
export const PROTOCOL=1;
process.title='RunlistHelper';
const version=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const MAX=32*1024*1024;
const fail=(code,message)=>{throw new SourceEditError(code,message);};
const root=process.argv[3];
if(process.argv[2]==='--probe') {
  try{process.stdout.write(JSON.stringify(checkoutTrust(root))+'\n');}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
} else if(process.argv[2]==='--serve') {
  // Reserve stdout for protocol frames, including while user configuration loads.
  const output=process.stdout.write.bind(process.stdout);
  // Normal checkout logging must not become an unexpected protocol frame.
  // Rust drains stderr without retaining private checkout diagnostics.
  process.stdout.write=(...args)=>process.stderr.write(...args);
  console.log=console.info=console.debug=()=>{};
  const actor=localActor();let service,handle;const expected=process.argv[4];let closing=false,chain=Promise.resolve(),queued=0;
  const frame=value=>{const wire=JSON.stringify(value);if(Buffer.byteLength(wire)>MAX)throw new SourceEditError('response-too-large','The response exceeds the desktop protocol limit.');output(wire+'\n');};
  async function execute(message) {
    if(!message||message.protocol!==PROTOCOL||message.version!==version||typeof message.id!=='string'||!/^[a-f0-9-]{36}$/.test(message.id))fail('protocol-mismatch','The app and helper protocol versions must match.');
    if(message.op==='hello') {
      if(service)fail('invalid-request','This helper is already connected.');
      if(typeof message.handle!=='string'||!/^[a-f0-9-]{36}$/.test(message.handle))fail('invalid-handle','A native checkout handle is required.');
      const trust=checkoutTrust(root);if(trust.fingerprint!==expected||trust.root!==root)fail('trust-changed','The checkout configuration changed. Open and trust the folder again.');
      const config=await resolveConfig(root,trust.config??path.join(root,'.runlist-desktop-no-config'));
      if(config.repoRoot!==root)fail('checkout-mismatch','The configuration resolved a different checkout.');
      service=createCheckoutService({config,actor});handle=message.handle;
      return {protocol:PROTOCOL,version,actor,checkoutPath:root};
    }
    if(!service||message.handle!==handle)fail('forbidden','This checkout handle is inactive.');
    if(message.op==='metrics')return process.memoryUsage();
    if(message.op==='shutdown'){await service.close();closing=true;return {closed:true};}
    if(message.op!=='request')fail('invalid-request','Unsupported desktop operation.');
    if(checkoutTrust(root).fingerprint!==expected)fail('trust-changed','The checkout configuration changed. Close and trust the folder again.');
    if('actor'in message||message.body&&('actor'in message.body||'checkout'in message.body||'repoRoot'in message.body))fail('forbidden','Identity and checkout authority belong to the native app.');
    if(typeof message.route!=='string'||!/^\/[a-z]/.test(message.route)||message.route.length>8192)fail('invalid-request','Invalid operation route.');
    const value=await service.request({method:message.body===undefined?'GET':'POST'},message.route,message.body);
    if(message.route==='/api/settings')value.sharing.preferences='This computer · Runlist desktop';
    return value;
  }
  function queue(line) {
    if(++queued>64){queued--;process.stdin.destroy();closing=true;return false;}
    chain=chain.then(async()=>{let message;try{message=JSON.parse(line);const value=await execute(message);frame({protocol:PROTOCOL,id:message.id,ok:true,value});}catch(error){try{frame({protocol:PROTOCOL,id:message?.id??null,ok:false,error:appError(error)});}catch{closing=true;}}finally{queued--;}});
  }
  const input=createLineFramer({maximum:MAX,onFrame:queue,onOverflow:()=>{closing=true;process.stdin.destroy();}});
  process.stdin.on('data',chunk=>input.write(chunk));
  process.on('exit',()=>service?.close());
  process.once('SIGTERM',()=>{Promise.resolve(service?.close()).finally(()=>process.exit(0));});
  process.stdin.on('end',()=>{input.discard();closing=true;chain.finally(async()=>{await service?.close();process.exit(0);});});
  process.stdin.on('error',()=>{input.discard();closing=true;chain.finally(async()=>{await service?.close();process.exit(1);});});
  const timer=setInterval(()=>{if(closing&&queued===0){clearInterval(timer);process.exit(0);}},50);timer.unref();
} else {process.stderr.write('Runlist Helper requires a native checkout session.\n');process.exitCode=1;}
