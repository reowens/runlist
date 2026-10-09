import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,symlinkSync,realpathSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {resolveConfig} from '../src/config.mjs';
import {createCheckoutService} from '../src/app-service.mjs';
const roots=[],services=[];afterEach(()=>{for(const s of services.splice(0))s.close();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
const actor={kind:'human',id:'human:semantic-test'};
const bytes='---\r\ntype: plan\r\nstatus: active\r\n---\r\n# Plan\r\n\r\n## Shipping\r\n\r\nShip the documents.\r\n';
const hash=s=>createHash('sha256').update(s).digest('hex');
async function fixture({response,connect,timeoutMs}={}){
 const root=realpathSync(mkdtempSync(path.join(os.tmpdir(),'runlist-semantic-')));roots.push(root);mkdirSync(path.join(root,'docs/prompts'),{recursive:true});mkdirSync(path.join(root,'docs/excluded'));mkdirSync(path.join(root,'tool/dist'),{recursive:true});
 writeFileSync(path.join(root,'runlist.config.mjs'),"export const root='docs';export const excludeDirs=['excluded'];\n");
 const doc=path.join(root,'docs/plan.md');writeFileSync(doc,bytes);writeFileSync(path.join(root,'docs/prompts/private.md'),'secret');writeFileSync(path.join(root,'tool/package.json'),' {"name":"grepmax","version":"fixture"}');const entryPath=path.join(root,'tool/dist/bin.js');writeFileSync(entryPath,'// fixture entry');
 const calls=[];const connector=connect??(async(_installation,checkout,signal,work)=>work({tool:async(name,args)=>{calls.push({name,args});signal.throwIfAborted();if(name==='document_search_status')return {state:'ready',generation:1,project:{root:checkout,store:'fixture',lastIndexed:'2026-10-06'},covered:args.paths.map(path=>({path}))};return response??{state:'ready',generation:1,root:checkout,store:'fixture',matches:[{path:doc,startLine:9,endLine:9,hashAlgorithm:'sha256-bytes',hash:hash(bytes)}]};}}));
 const config=await resolveConfig(root),service=createCheckoutService({config,actor,semanticOptions:{settingsFile:path.join(root,'prefs/tool.json'),connect:connector,...(timeoutMs?{timeoutMs}:{})}});services.push(service);
 const api=(route,body)=>service.request({method:body===undefined?'GET':'POST'},'/api/'+route,body);
 await api('semantic/settings',{nodePath:process.execPath,entryPath});
 return {root,doc,entryPath,service,api,calls,config};
}
async function search(f,body={query:'how do we ship'}){const job=await f.api('semantic/start',body);for(let i=0;i<150;i++){const result=await f.api('semantic/result?id='+job.id);if(result.state!=='running')return result;await new Promise(r=>setTimeout(r,5));}throw new Error('fixture job did not finish');}
test('finding an external tool does not claim readiness or contact its runtime',async()=>{
 const f=await fixture(),settings=await f.api('semantic/settings');assert.equal(settings.available,true);assert.equal(settings.experimental,true);assert.equal(settings.readiness,'not_checked');assert.match(settings.message,/checked only when you search/);assert.match(settings.message,/experimental.*text search remains available/);assert.deepEqual(f.calls,[]);
});
test('semantic results use current authorized files and full-source hash to verify CRLF section jumps',async()=>{
 const f=await fixture();const result=await search(f);assert.equal(result.state,'ready');assert.equal(result.documents[0].title,'Plan');assert.equal(result.documents[0].location,'verified');assert.equal(result.sections[0].title,'Shipping');assert.equal(result.sections[0].line,3);assert.equal(result.sections[0].revision,result.documents[0].revision);assert.equal(result.limited,true);assert.deepEqual(f.calls.map(c=>c.name),['document_search_status','semantic_search']);
});
test('changed locations open the current document without a fabricated section or cached snippets',async()=>{
 const f=await fixture();writeFileSync(f.doc,bytes.replace('Shipping','Revised'));const result=await search(f);assert.equal(result.documents[0].location,'changed');assert.deepEqual(result.sections,[]);assert.equal(result.stale,1);assert.match(result.documents[0].excerpt,/Revised/);
});
test('semantic results reject prompts, excluded/escaped paths, code and symlink replacements',async()=>{
 const f=await fixture();const external=path.join(f.root,'outside.md');writeFileSync(external,'SECRET_EXTERNAL');
 for(const p of ['docs/safe.md','docs/excluded/x.md'])writeFileSync(path.join(f.root,p),'# SECRET\n');
 const c=await f.api('library');assert.ok(c.documents.some(d=>d.path==='docs/safe.md'));writeFileSync(path.join(f.root,'docs/safe.md'),'---\r\ntype: prompt\r\nstatus: pending\r\n---\r\nSECRET_PROMPT\r\n');
 const service=createCheckoutService({config:f.config,actor,semanticOptions:{settingsFile:path.join(f.root,'prefs/tool.json'),connect:async(_i,checkout,_s,work)=>work({tool:async(name,args)=>name==='document_search_status'?{state:'ready',generation:1,project:{root:checkout,store:'fixture'},covered:args.paths.map(path=>({path}))}:{state:'ready',generation:1,root:checkout,store:'fixture',matches:['docs/prompts/private.md','docs/excluded/x.md','docs/safe.md','../outside.md','runlist.config.mjs'].map(p=>({path:path.resolve(f.root,p),startLine:1,endLine:1,text:'SECRET_CACHED'}))}})}});services.push(service);
 const api=(route,body)=>service.request({method:body===undefined?'GET':'POST'},'/api/'+route,body);const result=await search({api});assert.deepEqual(result.documents,[]);assert.equal(JSON.stringify(result).includes('SECRET'),false);
 rmSync(f.doc);symlinkSync(external,f.doc);const result2=await search(f);assert.deepEqual(result2.documents,[]);
});
test('current filters and rank are preserved; the bounded result is not a corpus total',async()=>{
 const f=await fixture();const excluded=await search(f,{query:'ship',status:'complete'});assert.deepEqual(excluded.documents,[]);assert.equal(excluded.limited,true);
 assert.equal((await search(f,{query:'ship',kind:'plans',archived:false})).documents.length,1);
});
test('no matching coverage and typed pressure refusals leave exact search available',async()=>{
 const f=await fixture({connect:async(_i,_c,_s,work)=>work({tool:async()=>({state:'host_pressure',message:'secret diagnostic'})})});const result=await search(f);assert.equal(result.state,'host_pressure');assert.equal(JSON.stringify(result).includes('secret diagnostic'),false);const exact=await f.api('search?q=documents');assert.equal(exact.documents.length,1);
});
test('generation changes between coverage and retrieval cannot yield selectable results',async()=>{
 const f=await fixture({response:{state:'ready',generation:2,matches:[]}});const result=await search(f);assert.equal(result.state,'embedding_mismatch');assert.deepEqual(result.documents,[]);assert.deepEqual(result.sections,[]);
});
test('missing status generation refuses before retrieval and provider partial coverage is preserved',async()=>{
 let calls=0;const f=await fixture({connect:async(_i,checkout,_s,work)=>work({tool:async()=>{calls++;return {state:'ready',project:{root:checkout,store:'fixture'},covered:[]};}})});assert.equal((await search(f)).state,'embedding_mismatch');assert.equal(calls,1);
 const partial=await fixture({connect:async(_i,checkout,_s,work)=>work({tool:async(name,args)=>name==='document_search_status'?{state:'ready',generation:1,project:{root:checkout,store:'fixture'},covered:args.paths.map(path=>({path})),coverage:{partial:true}}:{state:'ready',generation:1,root:checkout,store:'fixture',matches:[]}})});assert.equal((await search(partial)).coverage.partial,true);
});
test('new queries cancel old jobs; cancel/close never wait on the child search',async()=>{
 let starts=0,aborts=0;const f=await fixture({connect:async(_i,_c,signal)=>{starts++;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborts++;reject(new Error('aborted'));},{once:true}));}});
 const first=await f.api('semantic/start',{query:'first'});while(starts<1)await new Promise(r=>setTimeout(r,2));const second=await f.api('semantic/start',{query:'second'});assert.equal((await f.api('semantic/result?id='+first.id)).state,'cancelled');while(starts<2)await new Promise(r=>setTimeout(r,2));await f.api('semantic/cancel',{id:second.id});assert.equal(aborts,2);assert.equal((await f.api('semantic/result?id='+second.id)).state,'cancelled');
});
test('deadline aborts jobs and returns a useful timeout state',async()=>{
 const f=await fixture({timeoutMs:30,connect:async(_i,_c,signal)=>new Promise((_r,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))});assert.equal((await search(f)).state,'timeout');
});
test('changed installations require reselection and malformed filters/authority never reach gmax',async()=>{
 const f=await fixture();writeFileSync(f.entryPath,'// changed');assert.equal((await search(f)).state,'tool_changed');assert.deepEqual(f.calls,[]);
 for(const body of [{query:'q',root:f.root},{query:'a'.repeat(501)},{query:'q',archived:'yes'},{query:'q',stage:true},{query:'q',folder:'x'.repeat(513)}])await assert.rejects(f.api('semantic/start',body),e=>e.code==='invalid-request');
 const blocked=createCheckoutService({config:f.config,actor,authenticate:()=>({kind:'human',id:'other'})});services.push(blocked);await assert.rejects(blocked.request({method:'GET'},'/api/semantic/settings'),e=>e.code==='forbidden');
});
test('ordinary library/text requests do not discover, start or require semantic tools',async()=>{
 const f=await fixture({connect:async()=>{throw new Error('must not execute');}});await f.api('library');await f.api('search?q=shipping');assert.deepEqual(f.calls,[]);const pkg=JSON.parse(readFileSync(new URL('../package.json',import.meta.url)));assert.equal(pkg.dependencies?.grepmax,undefined);assert.equal(pkg.optionalDependencies?.grepmax,undefined);
});
test('a successor waits for predecessor cleanup instead of overlapping external gmax processes',async()=>{
 let concurrent=0,maximum=0,starts=0;
 const f=await fixture({connect:async(_i,_c,signal)=>{starts++;concurrent++;maximum=Math.max(maximum,concurrent);return new Promise((_r,reject)=>signal.addEventListener('abort',()=>setTimeout(()=>{concurrent--;reject(new Error('closed'));},25),{once:true}));}});
 await f.api('semantic/start',{query:'first'});while(starts<1)await new Promise(r=>setTimeout(r,2));await f.api('semantic/start',{query:'second'});assert.equal(starts,1);while(starts<2)await new Promise(r=>setTimeout(r,2));assert.equal(maximum,1);await f.service.close();assert.equal(concurrent,0);
});

test('semantic stage filtering verifies current ships metadata and preserves the unset distinction',async()=>{
 const f=await fixture();writeFileSync(f.doc,bytes.replace('status: active','status: active\r\nships: Later'));
 assert.equal((await search(f,{query:'ship',kind:'plans',stage:'word:Later'})).documents[0].stage,'Later');
 assert.deepEqual((await search(f,{query:'ship',stage:'@unset'})).documents,[]);
 writeFileSync(f.doc,bytes.replace('status: active','status: active\r\nships: []'));
 assert.deepEqual((await search(f,{query:'ship',stage:'@unset'})).documents,[]);
 assert.equal((await search(f,{query:'ship',stage:'@invalid'})).documents[0].stageInvalid,true);
});
