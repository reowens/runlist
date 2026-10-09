import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync,existsSync,symlinkSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import path from 'node:path';import os from 'node:os';
import {resolveConfig} from '../src/config.mjs';
import {createCheckoutService} from '../src/app-service.mjs';
import {parseNativeRecord} from '../src/native-record.mjs';
import {parseDocFile} from '../src/index.mjs';
import {nativeFixture,nativeSource,recordId} from './native-fixtures.mjs';
const roots=[],services=[],actor={kind:'human',id:'human:creation-test',label:'Creator'};
afterEach(async()=>{for(const s of services.splice(0))await s.close();for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
async function fixture(extra=''){
 const root=mkdtempSync(path.join(os.tmpdir(),'rl-record-create-'));roots.push(root);mkdirSync(path.join(root,'docs/excluded'),{recursive:true});mkdirSync(path.join(root,'docs/prompts'));
 writeFileSync(path.join(root,'runlist.config.mjs'),"export const root='docs';export const excludeDirs=['excluded'];\n"+extra);
 const config=await resolveConfig(root),service=createCheckoutService({config,actor});services.push(service);
 const api=(route,body)=>service.request({method:body===undefined?'GET':'POST'},'/api/'+route,body);
 return {root,config,api};
}
const alternatives=()=>[{label:'Blue',description:'Uses the current shelf.',consequences:[{kind:'benefit',text:'Already available.'}]},{label:'Red',description:'Needs another shelf.',consequences:[{kind:'cost',text:'Additional space.'}]}];
const request=(type='flag')=>({operationId:randomUUID(),template:type,title:type==='flag'?'The shelf is missing "labels" 🧭':'Which shelf should we use?',status:'open',folder:`docs/records/${type==='flag'?'flags':'decisions'}`,filename:randomUUID()+'.md',body:'Context retained without changing existing documents.\n',...(type==='flag'?{severity:'warn'}:{options:alternatives()})});
const receipt=(f,id)=>path.join(f.root,'.runlist/editor/creations',id+'.json');
test('flags and decisions preview canonical metadata, commit once and share persisted repository identity',async()=>{
 const f=await fixture(),catalog=await f.api('create');assert.ok(catalog.templates.some(t=>t.name==='flag'));assert.equal(catalog.records.needsSetup,true);assert.equal(existsSync(path.join(f.root,'runlist.records.json')),false);
 let repositoryId;
 for(const type of ['flag','decision']){
  const req=request(type),before=await f.api('create/preview',req),parsed=parseNativeRecord(before.source);assert.equal(parsed.ok,true,JSON.stringify(parsed.diagnostics));assert.equal(before.record.record_data.created_by.id,actor.id);assert.equal(before.record.status,'open');assert.equal(existsSync(path.join(f.root,before.path)),false);
  assert.deepEqual(await f.api('create/preview',req),before); // IDs/timestamp survive acknowledgement loss.
  if(type==='flag'){assert.equal(before.record.record_data.triage.disposition,'unreviewed');assert.equal(before.record.record_data.source.kind,'manual');assert.deepEqual(before.record.record_data.evidence,[]);assert.ok(before.setup);}
  else{assert.equal(before.setup,null);assert.equal(before.record.record_data.options.length,2);assert.deepEqual(before.record.record_data.rulings,[]);}
  const committed=await f.api('create/commit',{operationId:req.operationId});assert.equal(committed.state,'committed');assert.equal(readFileSync(path.join(f.root,before.path),'utf8'),before.source);assert.equal((await f.api('create/commit',{operationId:req.operationId})).replayed,true);
  const metadata=JSON.parse(readFileSync(path.join(f.root,'runlist.records.json'),'utf8'));repositoryId??=metadata.repositoryId;assert.equal(metadata.repositoryId,repositoryId);assert.equal(parsed.record.record_data.repository_id,repositoryId);
  const opened=await f.api('document?path='+encodeURIComponent(before.path));assert.equal(opened.title,req.title);assert.equal(opened.editable,true);
  assert.equal(parseDocFile(path.join(f.root,before.path),f.config).errors.length,0);
  const detail=await f.api('records?'+new URLSearchParams({kind:type==='flag'?'flags':'decisions',key:before.record.id}));assert.equal(detail.editable,true);assert.equal(detail.title,req.title);
 }
 assert.equal((await f.api('create')).records.needsSetup,false);
});
test('new decision accepts later reviewed ruling through the shared native writer',async()=>{
 const f=await fixture(),req=request('decision'),review=await f.api('create/preview',req);await f.api('create/commit',{operationId:req.operationId});
 const action={path:review.path,operationId:randomUUID(),expectedRevision:review.revision,action:'ruled',note:'Fits the existing shelf.',optionId:review.record.record_data.options[0].id};
 const prepared=await f.api('native/preview',action);await f.api('native/action',prepared.request);
 const parsed=parseNativeRecord(readFileSync(path.join(f.root,review.path),'utf8'));assert.equal(parsed.ok,true);assert.equal(parsed.record.status,'ruled');assert.equal(parsed.record.record_data.rulings[0].by.id,actor.id);
});
test('record input cannot forge identity, authority, resolved status, raw source or options',async()=>{
 const f=await fixture();
 for(const mutation of [{actor:{kind:'human',id:'other'}},{repositoryId:recordId('repo',8)},{source:'forged'},{status:'resolved'},{severity:'critical'},{options:[]}])await assert.rejects(f.api('create/preview',{...request(),...mutation}));
 for(const options of [[],[alternatives()[0]],alternatives().map(o=>({...o,label:'same'})),[{...alternatives()[0],id:recordId('option',4)},alternatives()[1]],[{...alternatives()[0],consequences:[{kind:'fake',text:'invented'}]},alternatives()[1]]])await assert.rejects(f.api('create/preview',{...request('decision'),options}));
 assert.equal(existsSync(path.join(f.root,'runlist.records.json')),false);assert.equal(existsSync(path.join(f.root,'docs/records')),false);
});
test('folder escapes, excluded roots and symlink record settings are refused',async()=>{
 const f=await fixture();for(const folder of ['docs/prompts','docs/excluded','../outside','docs/other'])await assert.rejects(f.api('create/preview',{...request(),folder}));
 const outside=path.join(f.root,'outside.json');writeFileSync(outside,'{}');symlinkSync(outside,path.join(f.root,'runlist.records.json'));
 const catalog=await f.api('create');assert.ok(catalog.recordError);assert.ok(catalog.templates.some(t=>t.name==='doc'));assert.ok(!catalog.templates.some(t=>t.name==='flag'));await assert.rejects(f.api('create/preview',request()));assert.equal(readFileSync(outside,'utf8'),'{}');
});
test('conflicts and changed record configuration never publish or overwrite reviewed files',async()=>{
 const f=await fixture(),req=request(),review=await f.api('create/preview',req);mkdirSync(path.dirname(path.join(f.root,review.path)),{recursive:true});writeFileSync(path.join(f.root,review.path),'External collision.');await assert.rejects(f.api('create/commit',{operationId:req.operationId}),e=>e.code==='creation-conflict');assert.equal(existsSync(path.join(f.root,'runlist.records.json')),false);
 const second=request(),next=await f.api('create/preview',second);writeFileSync(path.join(f.root,'runlist.records.json'),JSON.stringify({schema:1,repositoryId:recordId('repo',99),root:'docs/records',shared:false}));await assert.rejects(f.api('create/commit',{operationId:second.operationId}),e=>e.code==='creation-review-stale');assert.equal(existsSync(path.join(f.root,next.path)),false);assert.equal(readFileSync(path.join(f.root,review.path),'utf8'),'External collision.');
});
test('prepared first-record recovery finishes only its matching setup and retains source identity',async()=>{
 const f=await fixture(),req=request(),review=await f.api('create/preview',req),file=receipt(f,req.operationId),state=JSON.parse(readFileSync(file,'utf8'));state.state='prepared';writeFileSync(file,JSON.stringify(state));writeFileSync(path.join(f.root,'runlist.records.json'),review.setup.source);
 const inspected=await f.api('create/inspect',{operationId:req.operationId});assert.equal(inspected.state,'prepared');assert.equal(existsSync(path.join(f.root,review.path)),false);assert.equal((await f.api('recovery')).items[0].operationId,req.operationId);
 const committed=await f.api('create/commit',{operationId:req.operationId});assert.equal(committed.record.id,review.record.id);assert.equal(readFileSync(path.join(f.root,review.path),'utf8'),review.source);
});
test('committed retries preserve later source edits and actor ownership; discard creates neither file',async()=>{
 const f=await fixture(),req=request(),review=await f.api('create/preview',req);await f.api('create/commit',{operationId:req.operationId});writeFileSync(path.join(f.root,review.path),review.source+'Later context.\n');await f.api('create/commit',{operationId:req.operationId});assert.match(readFileSync(path.join(f.root,review.path),'utf8'),/Later context/);
 const other=createCheckoutService({config:f.config,actor:{kind:'human',id:'other'}});services.push(other);await assert.rejects(other.request({method:'POST'},'/api/create/inspect',{operationId:req.operationId}),e=>e.code==='forbidden');
 const fresh=await fixture(),cancel=request();await fresh.api('create/preview',cancel);await fresh.api('create/discard',{operationId:cancel.operationId});assert.equal(existsSync(path.join(fresh.root,'runlist.records.json')),false);assert.equal(existsSync(path.join(fresh.root,cancel.folder)),false);
});
test('configured shared roots obey Git ignore policy, including changes after preview',async()=>{
 const f=await fixture(`export const records={schema:1,repositoryId:'${recordId('repo',10)}',root:'docs/records',shared:true};\n`);
 const git=(...args)=>execFileSync('git',['-C',f.root,...args],{stdio:'ignore'});git('init','-q');writeFileSync(path.join(f.root,'.gitignore'),'.runlist/\ndocs/records/\n');await assert.rejects(f.api('create/preview',request()),e=>e.code==='record-configuration');
 writeFileSync(path.join(f.root,'.gitignore'),'.runlist/\n');const req=request(),review=await f.api('create/preview',req);assert.equal(review.setup,null);assert.equal(review.record.record_data.repository_id,recordId('repo',10));writeFileSync(path.join(f.root,'.gitignore'),'.runlist/\ndocs/records/\n');await assert.rejects(f.api('create/commit',{operationId:req.operationId}),e=>e.code==='record-configuration');assert.equal(existsSync(path.join(f.root,review.path)),false);
});
test('bootstrap adopts an existing native repository ID; mixed identities require explicit selection',async()=>{
 const f=await fixture();writeFileSync(path.join(f.root,'docs/existing.md'),nativeSource(nativeFixture()));
 const review=await f.api('create/preview',request());assert.equal(review.record.record_data.repository_id,recordId('repo',1));
 const fresh=await fixture(),one=nativeFixture(),two=nativeFixture('flag');two.record_data.repository_id=recordId('repo',2);writeFileSync(path.join(fresh.root,'docs/one.md'),nativeSource(one));writeFileSync(path.join(fresh.root,'docs/two.md'),nativeSource(two));const catalog=await fresh.api('create');assert.match(catalog.recordError,/multiple repository identities/);assert.ok(catalog.templates.some(t=>t.name==='doc'));
});
