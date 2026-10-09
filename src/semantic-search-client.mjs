import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import path from 'node:path';

export class SemanticSearchError extends Error {
  constructor(code){super(code);this.code=code;}
}
export function semanticEnvironment(nodePath,base=process.env){
  const env={};for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME'])if(base[key])env[key]=base[key];
  env.PATH=path.dirname(nodePath);env.GMAX_NO_AUTOSTART='1';env.GMAX_NO_STALE_HINT='1';return env;
}
// Small stdio MCP client: no SDK, gmax library, index or model dependency in Runlist.
export async function withSemanticClient(installation,checkout,signal,work,{spawnChild=spawn}={}){
  signal.throwIfAborted();
  const child=spawnChild(installation.nodePath,[installation.entryPath,'mcp','--existing-index-only'],{cwd:checkout,env:semanticEnvironment(installation.nodePath),stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
  const pending=new Map(),decoder=new StringDecoder('utf8');let nextId=1,carry='',frameBytes=0,ended=false,outputBytes=0;
  const fail=code=>{if(ended)return;ended=true;for(const entry of pending.values())entry.reject(new SemanticSearchError(code));pending.clear();child.kill();};
  child.on('error',()=>fail('tool_unavailable'));child.on('exit',()=>fail('tool_unavailable'));
  child.stdin.on('error',()=>fail('tool_unavailable'));
  // Drain diagnostics without retaining paths, queries, snippets or stderr in UI/logs.
  child.stderr.on('data',()=>{});
  child.stdout.on('data',chunk=>{
    outputBytes+=chunk.length;frameBytes+=chunk.length;
    if(outputBytes>4*1024*1024||frameBytes>1024*1024){fail('response_too_large');return;}
    carry+=decoder.write(chunk);
    for(;;){const nl=carry.indexOf('\n');if(nl<0)break;const line=carry.slice(0,nl);carry=carry.slice(nl+1);frameBytes=Buffer.byteLength(carry);let message;
      try{message=JSON.parse(line);}catch{fail('invalid_response');return;}
      if(!message||message.jsonrpc!=='2.0'){fail('invalid_response');return;}
      if(message.id!==undefined){const entry=pending.get(message.id);if(!entry){fail('invalid_response');return;}pending.delete(message.id);if(message.error)entry.reject(new SemanticSearchError('unsupported_tool'));else entry.resolve(message.result);}
      else if(message.method&&!message.method.startsWith('notifications/')){fail('invalid_response');return;}
    }
  });
  function call(method,params){if(ended||signal.aborted)return Promise.reject(new SemanticSearchError('cancelled'));const id=nextId++,wire=JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n';if(Buffer.byteLength(wire)>1024*1024)return Promise.reject(new SemanticSearchError('response_too_large'));return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});child.stdin.write(wire);});}
  const abort=()=>{for(const id of pending.keys())if(child.stdin.writable)child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:id,reason:'Cancelled'}})+'\n');fail('cancelled');};
  signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted)abort();
  try{
    const hello=await call('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'Runlist',version:'1'}});
    if(hello?.protocolVersion!=='2025-06-18'||hello.serverInfo?.name!=='gmax-document-search')throw new SemanticSearchError('unsupported_tool');
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
    const tool=async(name,args)=>{const reply=await call('tools/call',{name,arguments:args});const data=reply?.structuredContent;
      if(reply?.isError||!data||data.contractVersion!==1||data.capabilities?.existingIndexOnly!==1||data.capabilities.queryLogging!==false||data.capabilities.watch!==false||data.capabilities.runtimeStartup!==false)throw new SemanticSearchError('unsupported_tool');
      if(data.state==='ready'&&(!Number.isSafeInteger(data.generation)||data.generation<1))throw new SemanticSearchError('embedding_mismatch');
      return data;
    };
    return await work({tool});
  }finally{
    signal.removeEventListener('abort',abort);ended=true;for(const entry of pending.values())entry.reject(new SemanticSearchError('cancelled'));pending.clear();
    child.stdin.end();child.kill();
    // Reap only this owned bridge. The shared daemon/embedding runtime is untouched.
    if(child.exitCode===null&&child.signalCode===null)await new Promise(resolve=>{
      const kill=setTimeout(()=>child.kill('SIGKILL'),500),deadline=setTimeout(done,1000);
      function done(){clearTimeout(kill);clearTimeout(deadline);child.removeListener('exit',done);resolve();}
      child.once('exit',done);
      if(child.exitCode!==null||child.signalCode!==null)done();
    });
  }
}
