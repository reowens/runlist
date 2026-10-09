// Optional cross-repository qualification of a built gmax provider. No installed daemon/index is touched.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,realpathSync,readdirSync,existsSync} from 'node:fs';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {checkoutTrust} from '../trust.mjs';
import {helperEnvironment} from './helper-environment.mjs';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {withSemanticClient} from '../../src/semantic-search-client.mjs';
const entryPath=process.env.RUNLIST_GMAX_QUALIFICATION_ENTRY;
const providerRuntime=process.env.RUNLIST_GMAX_QUALIFICATION_NODE??process.execPath;
if(process.env.RUNLIST_REQUIRE_GMAX_QUALIFICATION==='1'&&!entryPath)throw new Error('Required actual-provider qualification needs RUNLIST_GMAX_QUALIFICATION_ENTRY.');
test('built gmax existing-index-only MCP interoperates with Runlist without watchers, store opening, downloads or model startup',{skip:!entryPath},async()=>{
 const dir=realpathSync(mkdtempSync(path.join(os.tmpdir(),'rl-gmax-wire-'))),home=path.join(dir,'.gmax'),checkout=path.join(dir,'checkout');mkdirSync(home);mkdirSync(checkout);mkdirSync(path.join(checkout,'.git'));mkdirSync(path.join(checkout,'docs'));
 const file=path.join(checkout,'docs/plan-λ.md'),source='---\ntype: plan\nstatus: active\n---\n# Plan\n\n## Shipping\n\nShip locally.\n',hash=createHash('sha256').update(source).digest('hex');writeFileSync(file,source);
 writeFileSync(path.join(home,'projects.json'),JSON.stringify([{root:checkout,name:'fixture',status:'indexed',chunkCount:1,modelTier:'small',vectorDim:384,embedMode:'cpu',lastIndexed:'2026-10-06'}]));writeFileSync(path.join(home,'config.json'),JSON.stringify({modelTier:'small',vectorDim:384,embedMode:'cpu',queryLog:true}));
 const socket=path.join(home,'daemon.sock'),requests=[],children=[];let cancelController,cancelClosed=false,mode='ready';
 const server=createServer(conn=>{let carry='';conn.on('data',chunk=>{carry+=chunk;const newline=carry.indexOf('\n');if(newline<0)return;const cmd=JSON.parse(carry.slice(0,newline));requests.push(cmd);let result;if(cmd.cmd==='documents.search'&&cmd.query==='cancel request'){conn.once('close',()=>{cancelClosed=true;});cancelController.abort();return;}
 if(mode==='oversized'){conn.end('x'.repeat(1024*1024+1)+'\n');return;}
 if(mode==='cold'&&cmd.cmd==='documents.search')result={ok:false,state:'embedding_unavailable'};
 else if(mode==='unsupported'&&cmd.cmd==='ping')result={ok:true,ready:true,capabilities:{existingIndexOnlySearch:0}};
 else if(mode==='missing'&&cmd.cmd==='ping')result={ok:false,state:'daemon_unavailable'};
 else if(cmd.cmd==='ping')result={ok:true,ready:true,resourceGeneration:1,capabilities:{existingIndexOnlySearch:1}};
 else if(cmd.cmd==='documents.status')result={ok:true,root:checkout,store:path.join(home,'lancedb'),embeddingReady:true,queryState:'ready',generation:1,lastIndexed:'2026-10-07T22:00:00Z',indexState:{indexing:false},covered:cmd.paths.filter(existsSync).map(path=>({path,hash,hashAlgorithm:'sha256-bytes',indexedMtimeMs:1}))};
 else if(cmd.cmd==='documents.search')result={ok:true,root:checkout,store:path.join(home,'lancedb'),generation:1,matches:[{path:file,hash,hashAlgorithm:'sha256-bytes',startLine:9,endLine:9,score:0.8,text:'CACHED_TEXT_MUST_NOT_APPEAR'}]};
 else result={ok:false,error:'unexpected mutation'};
 if(mode==='generation'&&cmd.cmd!=='ping')result.generation=2;
 if(mode==='missing-ping-generation'&&cmd.cmd==='ping')delete result.resourceGeneration;
 if(mode==='bad-ping-generation'&&cmd.cmd==='ping')result.resourceGeneration='1';
 if(mode==='missing-result-generation'&&cmd.cmd!=='ping')delete result.generation;
 if(mode==='bad-result-generation'&&cmd.cmd!=='ping')result.generation=0;
 if(mode==='metadata'&&cmd.cmd!=='ping'){result.indexState={indexing:false,pendingFiles:-1,diagnostic:'PRIVATE_METADATA_CANARY',queue:{body:'PRIVATE_METADATA_CANARY'}};result.queryState='PRIVATE_METADATA_CANARY';result.coverage={requested:'PRIVATE_METADATA_CANARY',partial:false};result.lastIndexed='PRIVATE_METADATA_CANARY';for(const row of result.covered??[])row.indexedMtimeMs='PRIVATE_METADATA_CANARY';}
 const wire=Buffer.from(JSON.stringify(result)+'\n');if(mode==='utf8'){const split=wire.indexOf(Buffer.from('λ'))+1;conn.write(wire.subarray(0,split));setImmediate(()=>conn.end(wire.subarray(split)));}else conn.end(wire);});});
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});
 const guard=path.join(dir,'guard.cjs');writeFileSync(guard,`const cp=require('node:child_process');cp.spawn=cp.fork=()=>{throw new Error('Background spawn forbidden');};const net=require('node:net');net.Server.prototype.listen=()=>{throw new Error('Server listen forbidden');};const connect=net.Socket.prototype.connect;net.Socket.prototype.connect=function(...args){const opts=Array.isArray(args[0])?args[0][0]:args[0];const p=typeof opts==='string'?opts:opts?.path;if(p!==${JSON.stringify(socket)})throw new Error('Only fixture daemon IPC allowed');return connect.apply(this,args);};require('node:http').request=()=>{throw new Error('Network/model request forbidden');};require('node:https').request=()=>{throw new Error('Network/model request forbidden');};require('node:fs').mkdirSync=()=>{throw new Error('Directory creation forbidden');};
 const Module=require('node:module'),load=Module._load;Module._load=function(request,parent,...rest){const resolved=Module._resolveFilename(request,parent);if(resolved===${JSON.stringify(path.resolve(path.dirname(entryPath),'index.js'))}||/[\\/]dist[\\/](?:commands|lib[\\/](?:workers|search|store))[\\/]/.test(resolved)||/^(?:onnxruntime-node|@huggingface\\/transformers|@lancedb\\/)/.test(request))throw new Error('Heavy CLI/native dependency forbidden');return load.call(this,request,parent,...rest);};Module.syncBuiltinESMExports();`);
 try{
  const result=await withSemanticClient({nodePath:providerRuntime,entryPath},checkout,AbortSignal.timeout(15000),async client=>{
   const status=await client.tool('document_search_status',{paths:[file]});assert.equal(status.state,'ready');assert.equal(status.capabilities.queryLogging,false);assert.equal(status.generation,1);assert.equal(status.project.lastIndexed,'2026-10-07T22:00:00Z');assert.equal(status.covered[0].indexedMtimeMs,1);
   return client.tool('semantic_search',{query:'how does shipping work',prefixes:[path.dirname(file)]});
  },{spawnChild:(cmd,args,options)=>{const child=spawn(cmd,['--require',guard,...args],{...options,env:{...options.env,HOME:dir,GMAX_HOME:home}});children.push(child);return child;}});
  assert.equal(result.state,'ready');assert.deepEqual(result.matches,[{path:file,startLine:9,endLine:9,score:0.8,hash,hashAlgorithm:'sha256-bytes'}]);assert.equal(JSON.stringify(result).includes('CACHED_TEXT'),false);
  assert.ok(requests.every(cmd=>['ping','documents.status','documents.search'].includes(cmd.cmd)));assert.equal(requests.find(cmd=>cmd.cmd==='documents.search').contractVersion,1);assert.equal(requests.find(cmd=>cmd.cmd==='documents.search').generation,1);
  // Exercise the actual desktop private helper -> current service -> bridge path.
  // This synthetic checkout is intentionally not a Git repository.
  rmSync(path.join(checkout,'.git'),{recursive:true,force:true});
  writeFileSync(path.join(checkout,'runlist.config.mjs'),"export const root='docs';\n");
  mkdirSync(path.join(checkout,'docs/prompts'));writeFileSync(path.join(checkout,'docs/prompts/private.md'),'PRIVATE PROMPT CANARY');
  const helper=spawn(process.env.RUNLIST_TEST_RUNTIME??process.execPath,[process.env.RUNLIST_TEST_HELPER??path.resolve(import.meta.dirname,'../helper.mjs'),'--serve',checkout,checkoutTrust(checkout).fingerprint],{env:helperEnvironment({HOME:dir,XDG_CONFIG_HOME:path.join(dir,'config')}),stdio:['pipe','pipe','pipe']});children.push(helper);helper.stderr.resume();
  const pending=new Map(),handle=randomUUID(),version=JSON.parse(await import('node:fs').then(fs=>fs.readFileSync(new URL('../../package.json',import.meta.url),'utf8'))).version;let carry='';
  helper.stdout.on('data',chunk=>{carry+=chunk;let nl;while((nl=carry.indexOf('\n'))>=0){const reply=JSON.parse(carry.slice(0,nl));carry=carry.slice(nl+1);pending.get(reply.id)?.(reply);pending.delete(reply.id);}});
  const request=(op,route,body,extra={})=>new Promise((resolve,reject)=>{const id=randomUUID(),timer=setTimeout(()=>reject(new Error('private fixture deadline')),10000);pending.set(id,reply=>{clearTimeout(timer);resolve(reply);});helper.stdin.write(JSON.stringify({protocol:1,version,id,handle,op,...(route?{route:'/api/'+route}:{}),...(body?{body}:{}),...extra})+'\n');});
  assert.equal((await request('hello')).ok,true);
  const settingsReply=await request('request','semantic/settings',{nodePath:providerRuntime,entryPath});assert.equal(settingsReply.ok,true,JSON.stringify(settingsReply));
  const start=await request('request','semantic/start',{query:'how does shipping work'});assert.equal(start.ok,true,JSON.stringify(start));
  let completed;for(let i=0;i<200;i++){completed=await request('request','semantic/result?id='+start.value.id);if(completed.value.state!=='running')break;await new Promise(resolve=>setTimeout(resolve,10));}
  assert.equal(completed.value.state,'ready',JSON.stringify(completed));assert.equal(completed.value.documents[0].path,'docs/plan-λ.md');assert.equal(completed.value.sections[0].title,'Shipping');assert.equal(JSON.stringify(completed).includes('PRIVATE PROMPT'),false);
  const priorRequests=requests.length;assert.equal((await request('request','semantic/start',{query:'forged handle'},{handle:randomUUID()})).error.code,'forbidden');assert.equal(requests.length,priorRequests);
  const helperExit=once(helper,'exit');helper.stdin.end();await helperExit;
  const probe=(name,args)=>withSemanticClient({nodePath:providerRuntime,entryPath},checkout,AbortSignal.timeout(15000),client=>client.tool(name,args),{spawnChild:(cmd,argv,options)=>{const child=spawn(cmd,['--require',guard,...argv],{...options,env:{...options.env,HOME:dir,GMAX_HOME:home}});children.push(child);return child;}});
  for(const [scenario,state] of [['cold','embedding_unavailable'],['unsupported','unsupported_daemon'],['missing','daemon_unavailable'],['generation','embedding_mismatch'],['missing-ping-generation','embedding_mismatch'],['bad-ping-generation','embedding_mismatch'],['missing-result-generation','embedding_mismatch'],['bad-result-generation','embedding_mismatch'],['oversized','search_unavailable']]){
   mode=scenario;const reply=await probe('semantic_search',{query:'PRIVATE_QUERY_CANARY',prefixes:[path.dirname(file)]});assert.equal(reply.state,state,scenario);assert.equal(JSON.stringify(reply).includes('PRIVATE_QUERY_CANARY'),false);
  }
  mode='metadata';const metadata=await probe('document_search_status',{paths:[file]});assert.equal(metadata.state,'ready');assert.equal(JSON.stringify(metadata).includes('PRIVATE_METADATA_CANARY'),false);assert.equal(metadata.queryState,'embedding_unavailable');assert.deepEqual(metadata.coverage,{requested:1,indexed:1,partial:true});
  mode='ready';const vanished=path.join(checkout,'docs/deleted.md');const partial=await probe('document_search_status',{paths:[file,vanished]});assert.equal(partial.state,'ready');assert.deepEqual(partial.coverage,{requested:2,indexed:1,partial:true});
  mode='utf8';assert.equal((await probe('semantic_search',{query:'unicode path',prefixes:[path.dirname(file)]})).state,'ready');
  mode='ready';
  assert.equal((await probe('semantic_search',{query:'test scope',prefixes:[dir]})).state,'no_coverage');
  await assert.rejects(probe('semantic_search',{query:'x'.repeat(501),prefixes:[checkout]}),error=>error.code==='unsupported_tool');
  writeFileSync(path.join(home,'projects.json'),'[]');assert.equal((await probe('document_search_status',{paths:[file]})).state,'no_index');
  // Registry aliases must map back to canonical paths, including ancestor roots.
  writeFileSync(path.join(home,'projects.json'),JSON.stringify([{root:dir,status:'indexed'},{root:checkout,status:'indexed'}]));
  assert.equal((await probe('document_search_status',{paths:[file]})).state,'ready');
  cancelController=new AbortController();
  await assert.rejects(withSemanticClient({nodePath:providerRuntime,entryPath},checkout,cancelController.signal,client=>client.tool('semantic_search',{query:'cancel request',prefixes:[path.dirname(file)]}),{spawnChild:(cmd,args,options)=>{const child=spawn(cmd,['--require',guard,...args],{...options,env:{...options.env,HOME:dir,GMAX_HOME:home}});children.push(child);return child;}}),error=>error.code==='cancelled');
  for(let i=0;i<50&&!cancelClosed;i++)await new Promise(r=>setTimeout(r,10));assert.equal(cancelClosed,true);
  for(const name of ['lancedb','cache','watch-leases.json','logs','models'])assert.equal(existsSync(path.join(home,name)),false,name);
  assert.deepEqual(readdirSync(home).sort(),['config.json','daemon.sock','projects.json']);
  for(const child of children){for(let i=0;i<50&&child.exitCode===null&&child.signalCode===null;i++)await new Promise(r=>setTimeout(r,10));assert.ok(child.exitCode!==null||child.signalCode!==null);}
 }finally{for(const child of children)child.kill('SIGKILL');await new Promise(resolve=>server.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
