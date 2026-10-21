import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {resolveConfig} from '../../src/config.mjs';
import {createCheckoutService} from '../../src/app-service.mjs';
import {parseNativeRecord} from '../../src/native-record.mjs';
import {nativeSource,nativeFixture,recordId} from '../../test/native-fixtures.mjs';

const assets=process.env.RUNLIST_TEST_ASSETS??path.resolve(import.meta.dirname,'../../assets/app');
const {recordNavigation}=await import(pathToFileURL(path.join(assets,'record-navigation.mjs')));
const {recoveryCenter}=await import(pathToFileURL(path.join(assets,'recovery-center.mjs')));
const original=Object.fromEntries(['document','window','localStorage','location','history','Option'].map(k=>[k,globalThis[k]])),roots=[];
afterEach(()=>{Object.assign(globalThis,original);for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const submit={preventDefault(){}};
function storage(){const values=new Map();return {failWrite:false,failRead:false,failRemove:false,get length(){return values.size;},key:i=>[...values.keys()][i],getItem(key){if(this.failRead)throw Error('storage unavailable');return values.get(key)??null;},setItem(key,value){if(this.failWrite)throw Error('storage full');values.set(key,String(value));},removeItem(key){if(this.failRemove)throw Error('storage unavailable');values.delete(key);}};}
function dom(store=storage()){
 const {document,window}=parseHTML(readFileSync(path.join(assets,'index.html'),'utf8')),$=id=>document.getElementById(id);window.scrollTo=()=>{};
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},set(value){for(const option of this.querySelectorAll('option'))option.toggleAttribute('selected',option.value===String(value));}});
 for(const dialog of document.querySelectorAll('dialog')){dialog.showModal=()=>dialog.setAttribute('open','');dialog.close=()=>dialog.removeAttribute('open');}
 globalThis.document=document;globalThis.window=window;globalThis.localStorage=store;globalThis.location={href:'http://local.invalid/'};globalThis.history={replaceState(){}};globalThis.Option=function(label,value){const option=document.createElement('option');option.textContent=label;option.value=value;return option;};return {$,window,store};
}
function row(kind='flags',key='one',native=false){return {key,id:key,title:key,path:`docs/${key}.md`,status:'open',revision:'original',editable:true,native,body:'Question: Which answer?',connections:[],original:{file:'src/a.mjs',quote:'original'},current:{status:'unchanged',quote:'current'},history:[],data:{options:[{id:'blue',label:'Blue'},{id:'red',label:'Red'}]}};}
function fixture({store=storage(),kind='flags',native=false}={}){
 const ui=dom(store),state={mode:'home',busy:false},notices=[],calls=[],records=new Map();let checkout='/one';
 const get=(k=kind,key='one')=>{const id=`${checkout}:${k}:${key}`;if(!records.has(id))records.set(id,row(k,key,native));return records.get(id);};
 const api=async(route,body)=>{calls.push({route,body});if(route.startsWith('records?')){const p=new URLSearchParams(route.slice(8));if(p.has('key'))return structuredClone(get(p.get('kind'),p.get('key')));return {records:[get(p.get('kind'))],counts:{flags:1,decisions:1},total:1,offset:0,scopes:[],hasMore:false};}if(route==='native/preview')return {request:{...body,source:'after'},before:'before'};if(route==='decisions/preview')return {path:get().path,source:'after',before:'before',expectedRevision:body.expectedRevision};return {};};
 const options={state,$:ui.$,api,checkout:()=>checkout,open:async()=>{controller.beforeLeave();state.mode='read';ui.$('records-home').hidden=true;},showLibrary:async()=>{},notice:(message,error)=>notices.push({message,error})};let controller=recordNavigation(options);
 return {...ui,state,notices,calls,get,api,options,get controller(){return controller;},setCheckout(value){checkout=value;},reload(){const next=dom(store);options.$=next.$;controller=recordNavigation(options);return next;}};
}
function fill(ui,{action='reject',note='Keep this unfinished explanation.',choice=''}={}){ui.$('record-action').value=action;ui.$('record-action').onchange();ui.$('record-note').value=note;ui.$('record-note').oninput();ui.$('record-choice').value=choice;ui.$('record-choice').oninput();}
function assertForm(ui,form){assert.equal(ui.$('record-action').value,form.action);assert.equal(ui.$('record-note').value,form.note);assert.equal(ui.$('record-choice').value,form.choice);}
const draftKey=(checkout='/one',kind='flags',key='one')=>`runlist:record-draft:${checkout}:${kind}:${key}`;
const reviewKey=(checkout='/one',kind='flags',key='one')=>`runlist:record-action:${checkout}:${kind}:${key}`;

test('flag input survives Back, connected navigation and a fresh renderer without routine ready notices',async()=>{
 const f=fixture(),form={action:'resolve',note:'Manual verification is still unfinished.',choice:''};await f.controller.show('flags','one');fill(f,form);await f.$('records-back').onclick();await f.$('record-results').querySelector('button').onclick();assertForm(f,form);
 f.get().connections=[{path:'docs/plan.md',title:'Plan'}];await f.$('record-reload').onclick();await f.$('records-home').querySelector('[data-connection]').onclick();await f.controller.show('flags','one');assertForm(f,form);
 const ui=f.reload();await f.controller.show('flags','one');assertForm(ui,form);assert.equal(f.calls.some(c=>c.body),false);assert.equal(f.notices.length,0);assert.equal(ui.$('record-draft-status').textContent,'Draft');
});

test('native and legacy decision drafts preserve disposition, chosen alternative and reason through reload',async()=>{
 for(const native of [false,true]){const f=fixture({kind:'decisions',native}),form={action:'ruled',note:'The shelf needs this answer.',choice:native?'blue':'Blue bin'};await f.controller.show('decisions','one');fill(f,form);const ui=f.reload();await f.controller.show('decisions','one');assertForm(ui,form);assert.equal(ui.$('record-choice-label').hidden,false);assert.equal(ui.$('record-review').hidden,true);assert.equal(f.calls.filter(c=>c.body).length,0);}
});

test('drafts are isolated by checkout, record kind and record key',async()=>{
 const f=fixture();await f.controller.show('flags','one');fill(f,{note:'Flag in first checkout'});await f.controller.show('flags','two');assert.equal(f.$('record-note').value,'');fill(f,{note:'Other flag'});await f.controller.show('decisions','one');assert.equal(f.$('record-note').value,'');fill(f,{action:'held',note:'Decision'});f.controller.beforeLeave();f.setCheckout('/two');await f.controller.show('flags','one');assert.equal(f.$('record-note').value,'');fill(f,{note:'Second checkout'});f.setCheckout('/one');await f.controller.show('flags','one');assert.equal(f.$('record-note').value,'Flag in first checkout');assert.equal(JSON.parse(f.store.getItem(draftKey('/two'))).form.note,'Second checkout');
});

test('storage failure keeps visible fields, blocks leaving and warns on renderer unload until retry succeeds',async()=>{
 const f=fixture();await f.controller.show('flags','one');f.store.failWrite=true;fill(f,{note:'Cannot lose this text.'});assert.match(f.$('record-draft-status').textContent,/not stored/);assert.throws(()=>f.controller.beforeLeave(),/not stored/);await f.$('records-back').onclick();assert.ok(f.$('record-note'));assert.equal(f.$('record-note').value,'Cannot lose this text.');
 const unload=new f.window.Event('beforeunload',{cancelable:true});f.window.dispatchEvent(unload);assert.equal(unload.defaultPrevented,true);await f.$('record-action-form').onsubmit(submit);assert.equal(f.$('record-confirm'),null);assert.equal(f.calls.filter(c=>c.body).length,0);
 f.store.failWrite=false;f.controller.beforeLeave();assert.equal(JSON.parse(f.store.getItem(draftKey())).form.note,'Cannot lose this text.');await f.$('records-back').onclick();assert.ok(f.$('record-results'));
});

test('stale restored input requires inspecting the changed record before creating a new review',async()=>{
 const f=fixture({kind:'decisions',native:true}),form={action:'ruled',note:'Original reasoning.',choice:'blue'};await f.controller.show('decisions','one');fill(f,form);f.get().revision='changed';const ui=f.reload();await f.controller.show('decisions','one');assertForm(ui,form);assert.match(ui.$('record-draft-status').textContent,/Record changed/);await ui.$('record-action-form').onsubmit(submit);assert.equal(f.calls.filter(c=>c.body).length,0);assert.equal(JSON.parse(f.store.getItem(draftKey('/one','decisions'))).revision,'original');await ui.$('record-draft-current').onclick();await ui.$('record-action-form').onsubmit(submit);assert.equal(f.calls.find(c=>c.route==='native/preview').body.expectedRevision,'changed');assert.ok(ui.$('record-confirm'));
});

test('unavailable native choices and read-only source changes preserve the original draft without silently applying it',async()=>{
 const f=fixture({kind:'decisions',native:true});await f.controller.show('decisions','one');fill(f,{action:'ruled',note:'Reason for Blue.',choice:'blue'});f.get().data.options=[{id:'red',label:'Red'}];f.get().revision='changed';const ui=f.reload();await f.controller.show('decisions','one');assert.equal(ui.$('record-choice').value,'blue');await ui.$('record-draft-current').onclick();await ui.$('record-action-form').onsubmit(submit);assert.equal(f.calls.filter(c=>c.body).length,0);assert.match(f.notices.at(-1).message,/available alternative/);
 f.get().editable=false;await ui.$('record-reload').onclick();assert.match(ui.$('records-home').textContent,/Reason for Blue/);assert.ok(f.store.getItem(draftKey('/one','decisions')));await ui.$('record-draft-discard').onclick();assert.equal(f.store.getItem(draftKey('/one','decisions')),null);
});

test('explicit discard removes the form draft and failed discard keeps the input',async()=>{
 const f=fixture();await f.controller.show('flags','one');fill(f,{note:'Do not clear until discard succeeds.'});f.store.failRemove=true;await f.$('record-draft-discard').onclick();assert.equal(f.$('record-note').value,'Do not clear until discard succeeds.');assert.ok(f.store.getItem(draftKey()));f.store.failRemove=false;await f.$('record-draft-discard').onclick();assert.equal(f.$('record-note').value,'');assert.equal(f.store.getItem(draftKey()),null);
});

test('Back to form retains the original reviewed revision, and failed local deletion keeps the exact review',async()=>{
 const f=fixture();await f.controller.show('flags','one');fill(f);await f.$('record-action-form').onsubmit(submit);const reviewed=JSON.parse(f.store.getItem(reviewKey()));f.get().revision='changed';const ui=f.reload();await f.controller.show('flags','one');f.store.failRemove=true;await ui.$('record-change').onclick();assert.deepEqual(JSON.parse(f.store.getItem(reviewKey())),reviewed);assert.equal(ui.$('record-action-form').hidden,true);f.store.failRemove=false;await ui.$('record-change').onclick();assert.equal(ui.$('record-note').value,reviewed.form.note);assert.equal(f.store.getItem(reviewKey()),null);assert.equal(JSON.parse(f.store.getItem(draftKey())).revision,'original');await ui.$('record-action-form').onsubmit(submit);assert.equal(ui.$('record-review').hidden,true);assert.match(f.notices.at(-1).message,/changed record/);
});

test('Recovery shows unreviewed record drafts once, respects checkout boundaries and prefers exact reviewed operations',async()=>{
 const f=fixture();await f.controller.show('flags','one');fill(f);f.store.setItem(draftKey('/private'),JSON.stringify({form:{note:'Private'},path:'Private record',at:Date.now()}));let resumed;const recover=recoveryCenter({$:f.$,api:async()=>({items:[],offset:0,hasMore:false,unavailable:0}),checkout:()=>'/one',beforeNavigate:async()=>{},resume:async row=>resumed=row,notice(){}});await recover.show();assert.equal(f.$('recovery-items').children.length,1);assert.match(f.$('recovery-items').textContent,/Flag draft/);assert.equal(f.$('recovery-items').textContent.includes('Private'),false);await f.$('recovery-items').querySelector('button').onclick();assert.equal(resumed.kind,'record');assert.equal(resumed.state,'draft');assert.equal(resumed.recordKey,'one');await f.$('record-action-form').onsubmit(submit);await recover.show();assert.equal(f.$('recovery-items').children.length,1);assert.match(f.$('recovery-items').textContent,/Flag review/);assert.match(f.$('recovery-items').textContent,/Resume review/);
});

test('failed storage reads preserve unreadable entries and prevent replacing them with a fresh review',async()=>{
 const f=fixture();f.store.setItem(reviewKey(),'{broken');await f.controller.show('flags','one');fill(f,{note:'New input stays visible.'});await f.$('record-action-form').onsubmit(submit);assert.equal(f.store.getItem(reviewKey()),'{broken');assert.equal(f.calls.filter(c=>c.body).length,0);assert.equal(f.$('record-note').value,'New input stays visible.');assert.match(f.$('record-draft-status').textContent,/not stored/);
});

for(const variant of ['legacy flag','legacy decision','native decision'])test(`${variant}: interrupted confirmed action replays only the exact reviewed request after reload`,async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'runlist-record-drafts-'));roots.push(root);for(const dir of ['docs/plans','docs/decisions','src','.runlist'])mkdirSync(path.join(root,dir),{recursive:true});writeFileSync(path.join(root,'runlist.config.mjs'),"export const root='docs';\n");
 const plan='---\ntype: plan\nstatus: active\n---\n# Plan\n\n## Decisions\n\n### D1 Which bin?\nDisposition: OPEN.\n\nQuestion: Which bin should carry the work?\nAlternatives: Blue or red.\nConsequences: Blue fits the existing shelf; red needs a replacement.\n';writeFileSync(path.join(root,'docs/plans/fixture.md'),plan);writeFileSync(path.join(root,'src/a.mjs'),'const observed = true;\n');
 writeFileSync(path.join(root,'.runlist/flags.jsonl'),JSON.stringify({event:'add',id:'F1',file:'src/a.mjs',line:1,quote:'const observed = true;',text:'Verify the original observation.',severity:'problem',at:'2026-10-05T00:00:00Z',by:{kind:'check',name:'fixture'}})+'\n');writeFileSync(path.join(root,'docs/decisions/native.md'),nativeSource(nativeFixture('decision')));
 const kind=variant==='legacy flag'?'flags':'decisions',service=createCheckoutService({config:await resolveConfig(root),actor:{kind:'human',id:'human:record-test',label:'Record tester'}}),calls=[];let loseReply=true;
 const api=async(route,body)=>{calls.push({route,body:structuredClone(body)});const result=await service.request({method:body===undefined?'GET':'POST'},'/api/'+route,body);if(body&&['flags/triage','native/action','save'].includes(route)&&loseReply){loseReply=false;throw new Error('Reply lost after commit');}return result;};
 const records=await api(`records?kind=${kind}&status=`),selected=records.records.find(r=>variant==='native decision'?r.native:!r.native);assert.ok(selected);
 const store=storage(),ui=dom(store),state={mode:'home',busy:false},options={state,$:ui.$,api,checkout:()=>root,open:async()=>{},showLibrary:async()=>{},notice(){}};let controller=recordNavigation(options);await controller.show(kind,selected.key);
 fill(ui,{action:kind==='flags'?'accept':'ruled',note:'Retain this exact explanation.',choice:variant==='native decision'?recordId('option',4):kind==='decisions'?'Blue bin':''});await ui.$('record-action-form').onsubmit(submit);
 const key=reviewKey(root,kind,selected.key),formKey=draftKey(root,kind,selected.key),reviewed=JSON.parse(store.getItem(key));assert.equal(calls.filter(c=>['flags/triage','native/action','save'].includes(c.route)).length,0);assert.ok(store.getItem(formKey));await ui.$('record-confirm').onclick();assert.match(ui.$('record-action-feedback').textContent,/retained/);assert.deepEqual(JSON.parse(store.getItem(key)),reviewed);
 const reloaded=dom(store);options.$=reloaded.$;controller=recordNavigation(options);await controller.show(kind,selected.key);assert.ok(reloaded.$('record-confirm'));assert.equal(calls.filter(c=>['flags/triage','native/action','save'].includes(c.route)).length,1);await reloaded.$('record-confirm').onclick();
 const writes=calls.filter(c=>['flags/triage','native/action','save'].includes(c.route));assert.equal(writes.length,2);assert.deepEqual(writes[0].body,reviewed.request);assert.deepEqual(writes[1].body,reviewed.request);assert.equal(store.getItem(key),null);assert.equal(store.getItem(formKey),null);
 if(variant==='native decision')assert.equal(parseNativeRecord(readFileSync(path.join(root,'docs/decisions/native.md'),'utf8')).record.record_data.rulings.length,1);else if(variant==='legacy decision')assert.equal((readFileSync(path.join(root,'docs/plans/fixture.md'),'utf8').match(/Disposition: RULED/g)??[]).length,1);else assert.equal(readFileSync(path.join(root,'.runlist/flags.jsonl'),'utf8').trim().split('\n').filter(line=>JSON.parse(line).event==='accept').length,1);
});

test('a late native preview cannot replace a different record or cross a checkout boundary',async()=>{
 const f=fixture({kind:'decisions',native:true});let resolvePreview;const api=async(route,body)=>route==='native/preview'?await new Promise(resolve=>resolvePreview=resolve):f.api(route,body),ui=dom(f.store),options={...f.options,$:ui.$,api},controller=recordNavigation(options);await controller.show('decisions','one');fill(ui,{action:'ruled',note:'Do not attach this to another record.',choice:'blue'});const reviewing=ui.$('record-action-form').onsubmit(submit);await controller.show('decisions','two');f.setCheckout('/two');resolvePreview({request:{source:'before',operationId:'late',expectedRevision:'original'},before:'before'});await reviewing;assert.equal(ui.$('record-confirm'),null);assert.equal(f.store.getItem(reviewKey('/one','decisions')),null);assert.equal(f.store.getItem(reviewKey('/two','decisions','two')),null);assert.match(f.store.getItem(draftKey('/one','decisions')),/Do not attach/);
});
