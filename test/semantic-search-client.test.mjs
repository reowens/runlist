import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {withSemanticClient,semanticEnvironment} from '../src/semantic-search-client.mjs';
const dirs=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
function fixture(behavior='normal'){
 const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'runlist-semantic-wire-')));dirs.push(root);const entryPath=path.join(root,'fixture.cjs');
 writeFileSync(entryPath,`const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const req=JSON.parse(line);if(req.id===undefined)return;if(${JSON.stringify(behavior)}==='hang'&&req.method!=='initialize')return;if(${JSON.stringify(behavior)}==='oversize'&&req.method!=='initialize'){process.stdout.write('x'.repeat(1048577));return;}const result=req.method==='initialize'?{protocolVersion:'2025-06-18',serverInfo:{name:${JSON.stringify(behavior==='old'?'gmax':'gmax-document-search')}}}:{structuredContent:{contractVersion:1,capabilities:{existingIndexOnly:1,queryLogging:${behavior==='logging'?'true':'false'},watch:false,runtimeStartup:false},state:'ready',generation:${behavior==='missing-generation'?'undefined':behavior==='bad-generation'?'"1"':'1'},seenArgs:process.argv.slice(2),env:Object.keys(process.env)}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');});`);
 return {root,nodePath:process.execPath,entryPath};
}
test('external stdio uses explicit mode, sanitized environment and versioned structured results',async()=>{
 const f=fixture();const result=await withSemanticClient(f,f.root,AbortSignal.timeout(5000),client=>client.tool('document_search_status',{paths:[]}));assert.deepEqual(result.seenArgs,['mcp','--existing-index-only']);assert.equal(result.env.includes('NODE_OPTIONS'),false);assert.equal(result.env.includes('GMAX_RERANK'),false);
 const env=semanticEnvironment('/tools/node',{HOME:'/home',NODE_OPTIONS:'evil',GMAX_HOME:'/other',GMAX_RERANK:'1',PATH:'/bad',API_KEY:'secret'});assert.equal(env.HOME,'/home');assert.equal(env.PATH,'/tools');assert.equal(env.NODE_OPTIONS,undefined);assert.equal(env.GMAX_HOME,undefined);assert.equal(env.API_KEY,undefined);
});
for(const behavior of ['old','logging'])test(`unsupported ${behavior} contract is rejected before any unsafe fallback`,async()=>{
 const f=fixture(behavior);await assert.rejects(withSemanticClient(f,f.root,AbortSignal.timeout(5000),client=>client.tool('semantic_search',{query:'q',prefixes:[f.root]})),e=>e.code==='unsupported_tool');
});
for(const behavior of ['missing-generation','bad-generation'])test(`${behavior} is rejected without returning ready results`,async()=>{
 const f=fixture(behavior);await assert.rejects(withSemanticClient(f,f.root,AbortSignal.timeout(5000),c=>c.tool('document_search_status',{paths:[]})),e=>e.code==='embedding_mismatch');
});
test('oversized frames fail boundedly and cancellation reaps only the owned bridge',async()=>{
 const f=fixture('oversize');await assert.rejects(withSemanticClient(f,f.root,AbortSignal.timeout(5000),c=>c.tool('semantic_search',{})),e=>e.code==='response_too_large');
 const hanging=fixture('hang');let child;const controller=new AbortController();const pending=withSemanticClient(hanging,hanging.root,controller.signal,async c=>{controller.abort();return c.tool('semantic_search',{});},{spawnChild:(...args)=>(child=spawn(...args))});await assert.rejects(pending,e=>e.code==='cancelled');
 for(let i=0;i<50&&child.exitCode===null&&child.signalCode===null;i++)await new Promise(r=>setTimeout(r,10));assert.ok(child.exitCode!==null||child.signalCode!==null);
});
