// Real presentation controllers + shared checkout engine in a DOM, without a browser or OS input.
import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {resolveConfig} from '../../src/config.mjs';
import {createCheckoutService} from '../../src/app-service.mjs';

const assets=process.env.RUNLIST_TEST_ASSETS??path.resolve(import.meta.dirname,'../../assets/app');
const {documentCreation}=await import(pathToFileURL(path.join(assets,'document-create.mjs')));
const {quickNavigation}=await import(pathToFileURL(path.join(assets,'quick-navigation.mjs')));
const {recoveryCenter}=await import(pathToFileURL(path.join(assets,'recovery-center.mjs')));
const {libraryNavigation}=await import(pathToFileURL(path.join(assets,'library-navigation.mjs')));
const {gitChanges}=await import(pathToFileURL(path.join(assets,'git-changes.mjs')));
const {gitCommit}=await import(pathToFileURL(path.join(assets,'git-commit.mjs')));
const {recordNavigation}=await import(pathToFileURL(path.join(assets,'record-navigation.mjs')));
const {documentYardstick}=await import(pathToFileURL(path.join(assets,'document-yardstick.mjs')));
const {filingNavigation}=await import(pathToFileURL(path.join(assets,'filing-navigation.mjs')));
const {documentLifecycle}=await import(pathToFileURL(path.join(assets,'document-lifecycle.mjs')));
const previous=Object.fromEntries(['document','window','localStorage','Option','location','history'].map(key=>[key,globalThis[key]]));
const roots=[];
afterEach(()=>{Object.assign(globalThis,previous);for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function storage(){const values=new Map();return {get length(){return values.size;},key:i=>[...values.keys()][i],getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};}
function dom(){
  const {document,window}=parseHTML(readFileSync(path.join(assets,'index.html'),'utf8'));
  const $=id=>document.getElementById(id);let focused;
  window.HTMLElement.prototype.scrollIntoView=function(){};
  window.HTMLElement.prototype.focus=function(){focused=this.id;};
  window.HTMLElement.prototype.showModal=function(){this.setAttribute('open','');};
  window.HTMLElement.prototype.close=function(){this.removeAttribute('open');};
  Object.defineProperty(window.HTMLElement.prototype,'open',{configurable:true,get(){return this.hasAttribute('open');}});
  window.HTMLSelectElement.prototype.add=function(option){this.append(option);};
  Object.defineProperty(window.HTMLSelectElement.prototype,'options',{configurable:true,get(){return this.querySelectorAll('option');}});
  for(const node of document.querySelectorAll('*'))node.focus=()=>{focused=node.id;};
  for(const dialog of document.querySelectorAll('dialog')){Object.defineProperty(dialog,'open',{get(){return this.hasAttribute('open');}});dialog.showModal=()=>dialog.setAttribute('open','');dialog.close=()=>dialog.removeAttribute('open');}
  // Linkedom has no form interaction model; adapt only those browser primitives.
  Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},set(value){for(const option of this.querySelectorAll('option'))if(option.value===String(value))option.setAttribute('selected','');else option.removeAttribute('selected');}});
  for(const select of document.querySelectorAll('select'))Object.defineProperty(select,'value',{get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},set(value){for(const option of this.querySelectorAll('option'))if(option.value===String(value))option.setAttribute('selected','');else option.removeAttribute('selected');}});
  for(const form of document.querySelectorAll('form'))form.reset=()=>{for(const field of form.querySelectorAll('input,textarea'))field.value='';};
  globalThis.document=document;globalThis.window=window;globalThis.localStorage=storage();globalThis.Option=function(label,value){const option=document.createElement('option');option.textContent=label;option.value=value;return option;};
  globalThis.location={href:'http://local.invalid/',pathname:'/',search:'',hash:''};globalThis.history={replaceState(){}};
  return {document,window,$,focused:()=>focused};
}
async function engine(extra=''){
  const root=mkdtempSync(path.join(os.tmpdir(),'runlist-workspace-dom-'));roots.push(root);mkdirSync(path.join(root,'docs/plans'),{recursive:true});writeFileSync(path.join(root,'runlist.config.mjs'),"export const root='docs';\n"+extra);
  writeFileSync(path.join(root,'docs/plans/existing.md'),'---\ntype: plan\nstatus: active\n---\n# Existing\n\nA searchable needle_dom.\n\n## Needle section\n\nMore content.\n');
  const service=createCheckoutService({config:await resolveConfig(root),actor:{kind:'human',id:'human:dom-test'}});
  const calls=[],api=async(route,body)=>{calls.push({route,body});return service.request({method:body===undefined?'GET':'POST'},'/api/'+route,body);};return {root,api,calls};
}
const event={preventDefault(){}};

test('unsupported lifecycle shows an explanation without an empty action form and keeps retained inspection',async()=>{
 const ui=dom(),state={doc:{path:'docs/structured.md',title:'Structured plan'},busy:false,dirty:false,pending:null},calls=[];
 const reason='Status changes for structured plans are not available yet. You can continue editing this plan’s text; its current status and history are kept.';
 const api=async(route,body)=>{calls.push({route,body});return route.startsWith('lifecycle?')?{enabled:false,current:'active',statuses:[],reason}:{state:'reviewed',report:'Retained review'};};
 documentLifecycle({state,$:ui.$,api,checkout:()=>'/fixture',open:async()=>{},library:{},notice(){}});
 await ui.$('lifecycle-open').onclick();assert.equal(ui.$('lifecycle-form').hidden,true);assert.equal(ui.$('lifecycle-unavailable').textContent,reason);assert.equal(ui.$('lifecycle-unavailable').getAttribute('role'),'status');assert.equal(ui.$('lifecycle-review-button').disabled,true);
 await ui.$('lifecycle-form').onsubmit(event);assert.equal(calls.some(c=>c.body!==undefined),false);assert.equal(localStorage.length,0);
 localStorage.setItem('runlist:lifecycle:/fixture:'+encodeURIComponent(state.doc.path),JSON.stringify({path:state.doc.path,newPath:state.doc.path,operationId:'retained',status:'partial',report:'Retained review'}));
 ui.$('lifecycle-close').onclick();await ui.$('lifecycle-open').onclick();assert.equal(ui.$('lifecycle-confirm').disabled,true);assert.equal(ui.$('lifecycle-inspect').disabled,false);
 await ui.$('lifecycle-confirm').onclick();assert.equal(calls.some(c=>c.route==='lifecycle/commit'),false);await ui.$('lifecycle-inspect').onclick();assert.equal(ui.$('lifecycle-feedback').textContent,'Operation is reviewed.');assert.equal(localStorage.length,1);
});

test('unsupported Git keeps selection and diff review but explains and disables local commits',async()=>{
 const ui=dom(),state={mode:'home'},calls=[];let supported=false;
 const reason='Local commits are not available with this Git version yet. You can still review and edit documents, then commit with your Git client.';
 const api=async(route,body)=>{calls.push({route,body});return {available:true,changes:[{path:'docs/a.md',title:'A',kind:'Modified',eligible:true}],total:1,changedDocuments:1,localOnly:0,offset:0,commitSupport:{available:supported,reason:supported?null:reason}};};
 const controller=gitChanges({$:ui.$,state,api,checkout:()=>'/fixture',showLibrary:async()=>controller.deactivate(),open:async()=>{},notice(){}});
 await controller.show();const check=ui.$('changes-list').querySelector('input');check.checked=true;check.onchange();assert.equal(ui.$('changes-selected').textContent,'1 selected');assert.equal(ui.$('changes-commit').disabled,true);assert.equal(ui.$('changes-commit').title,reason);assert.match(ui.$('changes-feedback').textContent,/Git client/);
 supported=true;await ui.$('changes-refresh').onclick();assert.equal(ui.$('changes-selected').textContent,'1 selected');assert.equal(ui.$('changes-commit').disabled,false);assert.ok(calls.every(c=>c.body===undefined));
});

test('Changes uses real scoped Git reads, keeps selection on refresh and never stages or commits',async()=>{
  const ui=dom(),f=await engine();
  const emptyConfig=path.join(f.root,'empty-git-config');writeFileSync(emptyConfig,'');
  const git=(...args)=>{const result=spawnSync('git',['-c','commit.gpgsign=false','-C',f.root,...args],{encoding:'utf8',env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:emptyConfig}});assert.equal(result.status,0,result.stderr);return result.stdout;};
  git('init','-q','-b','main');git('config','user.name','Fixture');git('config','user.email','fixture@invalid.example');git('add','--','docs');git('commit','-qm','base');
  const file=path.join(f.root,'docs/plans/existing.md'),base=readFileSync(file,'utf8');writeFileSync(file,base+'\nSaved change <script>literal</script>.\n');
  const index=readFileSync(path.join(f.root,'.git/index')),head=git('rev-parse','HEAD'),state={mode:'home',doc:{path:'docs/plans/existing.md'},dirty:true};let preserved=0,returned=0;
  const controller=gitChanges({$:ui.$,state,api:f.api,checkout:()=>f.root,showLibrary:async()=>{preserved++;controller.deactivate();},open:async()=>{},returnToDraft:async()=>returned++,notice(){}});
  await controller.show();assert.equal(preserved,1);assert.equal(ui.$('changes-home').hidden,false);assert.equal(ui.$('changes-draft').hidden,false);assert.equal(ui.$('library-changes').getAttribute('aria-pressed'),'true');assert.equal(ui.$('changes-list').querySelectorAll('input:checked').length,0);
  const check=ui.$('changes-list').querySelector('input');check.checked=true;check.onchange();assert.equal(ui.$('changes-selected').textContent,'1 selected');
  await ui.$('changes-list').querySelector('button').onclick();assert.match(ui.$('changes-review').textContent,/Saved change <script>literal<\/script>/);assert.equal(ui.$('changes-review').querySelector('script'),null);
  await ui.$('changes-refresh').onclick();assert.equal(ui.$('changes-selected').textContent,'1 selected');assert.equal(ui.$('changes-list').querySelector('input').checked,true);
  await ui.$('changes-return-draft').onclick();assert.equal(returned,1);assert.equal(state.dirty,true);assert.ok(f.calls.every(c=>c.body===undefined));assert.deepEqual(readFileSync(path.join(f.root,'.git/index')),index);assert.equal(git('rev-parse','HEAD'),head);
  writeFileSync(file,base);await ui.$('changes-refresh').onclick();assert.equal(ui.$('changes-selected').textContent,'0 selected');assert.equal(ui.$('changes-list').querySelector('input'),null);
});

test('Changes suppresses late replies after navigation and isolates selection by checkout',async()=>{
  const ui=dom(),state={mode:'home'},reply={available:true,changes:[{path:'docs/a.md',title:'A',kind:'Added',eligible:true}],total:1,changedDocuments:1,localOnly:0,offset:0},calls=[];let owner='first',pending;
  const api=async route=>{calls.push(route);return pending?await new Promise(resolve=>pending=resolve):structuredClone(reply);};
  const controller=gitChanges({$:ui.$,state,api,checkout:()=>owner,showLibrary:async()=>controller.deactivate(),open:async()=>{},notice(){}});
  await controller.show();const check=ui.$('changes-list').querySelector('input');check.checked=true;check.onchange();assert.equal(ui.$('changes-selected').textContent,'1 selected');
  owner='second';await controller.show();assert.equal(ui.$('changes-selected').textContent,'0 selected');
  pending=true;const refreshing=ui.$('changes-refresh').onclick();await new Promise(resolve=>setImmediate(resolve));controller.deactivate();state.mode='home';pending({...reply,changes:[{path:'docs/stale.md',title:'STALE',kind:'Added',eligible:true}]});await refreshing;
  assert.equal(ui.$('changes-home').hidden,true);assert.ok(!ui.$('changes-list').textContent.includes('STALE'));assert.ok(calls.every(route=>route.startsWith('git/status?')));
});

test('Changes makes unavailable and partial-staging states usable without mutation controls',async()=>{
  const ui=dom(),state={mode:'home'};let available=true;
  const api=async()=>available?{available:true,changes:[{path:'docs/partial.md',kind:'Modified',eligible:false,partial:true,blockedReason:'Partial staging is retained.'}],total:1,changedDocuments:1,localOnly:0,offset:0}:{available:false,changes:[],total:0,reason:'Git is unavailable.'};
  const controller=gitChanges({$:ui.$,api,state,checkout:()=>'',showLibrary:async()=>controller.deactivate(),open:async()=>{},notice(){}});
  await controller.show();assert.equal(ui.$('changes-list').querySelector('input').disabled,true);assert.match(ui.$('changes-list').textContent,/Partial staging/);assert.equal(ui.$('changes-home').querySelector('[data-commit]'),null);
  available=false;await ui.$('changes-refresh').onclick();assert.equal(ui.$('changes-feedback').textContent,'Git is unavailable.');assert.match(ui.$('changes-review').textContent,/editor remain available/);assert.equal(ui.$('changes-refresh').disabled,false);
});

test('New dialog creates reviewed template Markdown exactly once and opens the resulting document',async()=>{
  const ui=dom(),f=await engine(),state={busy:false};let opened;
  const controller=documentCreation({$:ui.$,api:f.api,checkout:()=>f.root,state,beforeNavigate:async()=>{},open:async path=>opened=await f.api('document?path='+encodeURIComponent(path)),library:{load:async()=>{}},notice(){}});
  await controller.show();assert.equal(ui.$('create-dialog').open,true);assert.equal(ui.focused(),'create-name');
  ui.$('create-template').value='hub';ui.$('create-template').onchange();ui.$('create-name').value='Shipping hub';ui.$('create-name').oninput();assert.equal(ui.$('create-filename').value,'shipping-hub.md');
  ui.$('create-body').value='Coordinate the shipping work.';await ui.$('create-form').onsubmit(event);
  assert.equal(ui.$('create-form').hidden,true);assert.match(ui.$('create-preview').textContent,/Shipping hub/);assert.equal(f.calls.filter(c=>c.route==='create/commit').length,0);
  const reviewed=ui.$('create-source').textContent;await Promise.all([ui.$('create-confirm').onclick(),ui.$('create-confirm').onclick()]);
  assert.equal(f.calls.filter(c=>c.route==='create/commit').length,1);assert.equal(opened.source,reviewed);assert.equal(opened.kind,'hub');assert.equal(ui.$('create-dialog').open,false);
});
test('New dialog retains form/review across closing and reports collision without losing the draft',async()=>{
  const ui=dom(),f=await engine(),controller=documentCreation({$:ui.$,api:f.api,checkout:()=>f.root,state:{busy:false},beforeNavigate:async()=>{},open:async()=>{},library:{load:async()=>{}},notice(){}});
  await controller.show();ui.$('create-name').value='Retained title';ui.$('create-name').oninput();ui.$('create-filename').value='manual-name.md';ui.$('create-filename').oninput();ui.$('create-name').value='Renamed title';ui.$('create-name').oninput();assert.equal(ui.$('create-filename').value,'manual-name.md');
  await ui.$('create-form').onsubmit(event);ui.$('create-close').onclick();await controller.show();assert.equal(ui.$('create-name').value,'Renamed title');assert.equal(ui.$('create-review').hidden,false);
  writeFileSync(path.join(f.root,'docs/manual-name.md'),'External collision.');await ui.$('create-confirm').onclick();assert.match(ui.$('create-feedback').textContent,/Another file/);assert.equal(readFileSync(path.join(f.root,'docs/manual-name.md'),'utf8'),'External collision.');assert.equal(ui.$('create-dialog').open,true);
});
test('native flag and decision forms show canonical review fields and open a record only after explicit confirmation',async()=>{
 const ui=dom(),f=await engine(),state={busy:false};let created;
 const controller=documentCreation({$:ui.$,api:f.api,checkout:()=>f.root,state,beforeNavigate:async()=>{},open:async()=>{throw new Error('native creation should open its record');},createdRecord:async record=>{created=await f.api('records?'+new URLSearchParams({kind:record.type==='flag'?'flags':'decisions',key:record.id}));},library:{load:async()=>{}},notice(){}});
 await controller.show({template:'flag'});assert.equal(ui.focused(),'create-name');assert.equal(ui.$('create-title').textContent,'New flag');assert.equal(ui.$('create-folder').readOnly,true);assert.equal(ui.$('create-decision-fields').hidden,true);
 ui.$('create-name').value='Missing labels <script>literal</script>';ui.$('create-name').oninput();ui.$('create-severity').value='problem';ui.$('create-body').value='Observed during a manual review.';
 await ui.$('create-form').onsubmit(event);assert.equal(created,undefined);assert.equal(ui.$('create-confirm').textContent,'Create flag');assert.equal(ui.$('create-setup').hidden,false);assert.equal(ui.$('create-preview').querySelector('script'),null);assert.match(ui.$('create-preview').textContent,/Missing labels <script>literal<\/script>/);
 await Promise.all([ui.$('create-confirm').onclick(),ui.$('create-confirm').onclick()]);assert.equal(f.calls.filter(c=>c.route==='create/commit').length,1);assert.equal(created.status,'open');assert.equal(created.severity,'problem');assert.equal(created.editable,true);
 await controller.show({template:'decision'});assert.equal(ui.$('create-name-label').textContent,'Question');assert.equal(ui.$('create-flag-fields').hidden,true);assert.equal(ui.$('create-options').children.length,2);assert.equal(ui.$('create-options').querySelector('[data-remove]').disabled,true);
 ui.$('create-name').value='Which shelf?';for(const [i,row] of [...ui.$('create-options').children].entries()){row.querySelector('[data-label]').value=i?'Red':'Blue';row.querySelector('[data-description]').value=i?'Needs a shelf.':'Uses the shelf.';}ui.$('create-options').children[0].querySelector('[data-consequence="risk"]').value='May fill quickly.';
 ui.$('create-option-add').onclick();assert.equal(ui.$('create-options').children.length,3);ui.$('create-options').children[2].querySelector('[data-remove]').onclick();assert.equal(ui.$('create-options').children.length,2);
 await ui.$('create-form').onsubmit(event);assert.match(ui.$('create-preview').textContent,/May fill quickly/);assert.equal(ui.$('create-setup').hidden,true);assert.equal(ui.$('create-confirm').textContent,'Create decision');await ui.$('create-confirm').onclick();assert.equal(created.status,'open');assert.equal(created.data.options.length,2);assert.deepEqual(created.data.rulings,[]);
});
test('native creation retains alternatives and resumes a server review without silently publishing',async()=>{
 const ui=dom(),f=await engine(),controller=documentCreation({$:ui.$,api:f.api,checkout:()=>f.root,state:{busy:false},beforeNavigate:async()=>{},open:async()=>{},library:{load:async()=>{}},notice(){}});
 await controller.show({template:'decision'});ui.$('create-name').value='Retained question';for(const [i,row] of [...ui.$('create-options').children].entries()){row.querySelector('[data-label]').value=i?'Second':'First';row.querySelector('[data-description]').value='Retained description.';}ui.$('create-options').children[0].querySelector('[data-consequence="benefit"]').value='Retained benefit.';
 await ui.$('create-form').onsubmit(event);const reviewSource=ui.$('create-source').textContent,id=f.calls.find(c=>c.route==='create/preview').body.operationId;ui.$('create-close').onclick();await controller.show({template:'flag'});assert.equal(ui.$('create-template').value,'decision');assert.match(ui.$('create-feedback').textContent,/retained creation draft/);assert.match(ui.$('create-options').textContent,/Retained/);
 ui.$('create-close').onclick();localStorage.removeItem(`runlist:create:${f.root}`);await controller.show({operationId:id});assert.equal(ui.$('create-source').textContent,reviewSource);assert.equal(ui.$('create-template').value,'decision');assert.equal(ui.$('create-name').value,'Retained question');assert.equal(f.calls.filter(c=>c.route==='create/commit').length,0);await ui.$('create-back').onclick();assert.equal(ui.$('create-options').children[0].querySelector('[data-label]').value,'First');assert.equal(ui.$('create-form').hidden,false);
});
test('record lists provide New flag and New decision without issuing a mutation',async()=>{
 const ui=dom(),state={busy:false},kinds=[],calls=[];
 const controller=recordNavigation({$:ui.$,state,api:async route=>{calls.push(route);return {records:[],total:0,offset:0,hasMore:false,unavailable:0,scopes:[],counts:{flags:0,decisions:0}};},open:async()=>{},showLibrary:async()=>{},checkout:()=>'/fixture',create:async type=>kinds.push(type),notice(){}});
 for(const [kind,label] of [['flags','New flag'],['decisions','New decision']]){await controller.show(kind);assert.equal(ui.$('records-new').textContent,label);await ui.$('records-new').onclick();}assert.deepEqual(kinds,['flag','decision']);assert.ok(calls.every(c=>c.startsWith('records?')));
});
test('creation suppresses late checkout replies and retains a pending record review under its original checkout',async()=>{
 const ui=dom(),f=await engine();let owner=f.root,pending;
 const controller=documentCreation({$:ui.$,api:async(route,body)=>route==='create/preview'?new Promise(resolve=>{pending=()=>f.api(route,body).then(resolve);}):f.api(route,body),checkout:()=>owner,state:{busy:false},beforeNavigate:async()=>{},open:async()=>{},library:{load:async()=>{}},notice(){}});
 await controller.show({template:'flag'});ui.$('create-name').value='Original checkout finding';const preview=ui.$('create-form').onsubmit(event);owner='another-checkout';await pending();await preview;
 assert.equal(ui.$('create-dialog').open,false);assert.equal(ui.$('create-review').hidden,true);assert.ok(localStorage.getItem(`runlist:create:${f.root}`));assert.equal(localStorage.getItem('runlist:create:another-checkout'),null);assert.equal(f.calls.filter(c=>c.route==='create/commit').length,0);
});
test('Quick navigation renders content/section results, supports keyboard selection and only opens on explicit activation',async()=>{
  const ui=dom(),f=await engine();ui.$('workspace').hidden=false;let opened,jumped;
  const controller=quickNavigation({$:ui.$,api:f.api,state:{busy:false},library:{quickDocuments:()=>[]},open:async path=>{opened=path;},jump:section=>{jumped=section;},actions:()=>[{title:'New document',run:async()=>{}}],notice(){}});
  await controller.show();ui.$('quick-query').value='needle';await controller.search();assert.equal(opened,undefined);assert.ok(ui.$('quick-results').children.length>=2);assert.equal(ui.$('quick-query').getAttribute('aria-activedescendant'),'quick-result-0');
  ui.$('quick-query').onkeydown({key:'End',preventDefault(){}});assert.equal(ui.$('quick-query').getAttribute('aria-activedescendant'),'quick-result-1');
  await ui.$('quick-results').children[1].onclick();assert.equal(opened,'docs/plans/existing.md');assert.equal(jumped.title,'Needle section');assert.equal(ui.$('quick-dialog').open,false);
});
test('Quick navigation suppresses stale replies and shows failed searches without keeping stale selectable documents',async()=>{
  const ui=dom();ui.$('workspace').hidden=false;let resolve,opened;
  const controller=quickNavigation({$:ui.$,api:async()=>new Promise(r=>resolve=r),state:{busy:false},library:{quickDocuments:()=>[]},open:async path=>opened=path,jump(){},actions:()=>[],notice(){}});
  await controller.show();ui.$('quick-query').value='old';const pending=controller.search();ui.$('quick-query').value='new';ui.$('quick-query').oninput();ui.$('quick-close').onclick();resolve({documents:[{path:'docs/old.md',title:'Stale'}],sections:[],total:1});await pending;assert.equal(ui.$('quick-results').children.length,0);assert.equal(opened,undefined);
});
test('Recovery combines disk/local work, isolates checkout state, and opening it never publishes or retries anything',async()=>{
  const ui=dom(),f=await engine(),path='docs/plans/existing.md',doc=await f.api('document?path='+path),draftId=randomUUID();let resumed;
  await f.api('draft/write',{path,draftId,expectedDraftRevision:null,baseSource:doc.source,baseRevision:doc.revision,source:doc.source.replace('searchable','preserved')});
  localStorage.setItem(`runlist:recovery:${f.root}:${encodeURIComponent(path)}:client`,JSON.stringify({path,source:'Locally preserved text',baseSource:doc.source,draft:{id:draftId},at:Date.now()}));
  localStorage.setItem('runlist:recovery:other-checkout:private:client',JSON.stringify({path:'Never show this',source:'secret',baseSource:'old',at:Date.now()}));
  const controller=recoveryCenter({$:ui.$,api:f.api,checkout:()=>f.root,beforeNavigate:async()=>{},resume:async row=>{resumed=row;},notice(){}});const before=f.calls.length;
  await controller.show();assert.equal(ui.$('recovery-items').children.length,1);assert.match(ui.$('recovery-items').textContent,/Draft preserved locally/);assert.ok(!ui.$('recovery-items').textContent.includes('Never show'));
  assert.deepEqual(f.calls.slice(before).map(c=>c.route),['recovery?offset=0&limit=50']);assert.equal(resumed,undefined);
  await ui.$('recovery-items').querySelector('button').onclick();assert.equal(resumed.location.startsWith('runlist:recovery:'),true);assert.equal(ui.$('recovery-dialog').open,false);
});
test('Saved library views preserve all filters and restore them without publishing source changes',async()=>{
  const ui=dom(),f=await engine(),state={mode:'home',plans:[]};ui.$('library-kind').value='all';
  const navigation=libraryNavigation({state,$:ui.$,api:f.api,open:async()=>{},showLibrary:async()=>{},checkout:()=>f.root,notice(){}});navigation.restore();await navigation.load();
  ui.$('filter').value='needle_dom';ui.$('library-kind').value='plans';ui.$('library-status').value='active';ui.$('library-search-content').checked=true;
  ui.$('save-library-view').onclick();ui.$('filter-name').value='Work with needles';ui.$('filter-form').onsubmit(event);const selected=ui.$('library-view').value;
  ui.$('filter').value='';ui.$('library-search-content').checked=false;await navigation.applyView(selected);assert.equal(ui.$('filter').value,'needle_dom');assert.equal(ui.$('library-search-content').checked,true);assert.equal(state.plans.length,1);
  assert.equal(ui.$('delete-library-view').hidden,false);ui.$('delete-library-view').onclick();assert.equal(navigation.savedViews().length,0);
});

test('Recovery lists disk drafts even when renderer storage cannot be read',async()=>{
  const ui=dom(),f=await engine(),path='docs/plans/existing.md',doc=await f.api('document?path='+path),draftId=randomUUID();
  await f.api('draft/write',{path,draftId,expectedDraftRevision:null,baseSource:doc.source,baseRevision:doc.revision,source:doc.source+'\nDisk-only draft.\n'});
  Object.defineProperty(globalThis.localStorage,'length',{get(){throw new Error('Renderer storage unavailable');}});
  const controller=recoveryCenter({$:ui.$,api:f.api,checkout:()=>f.root,beforeNavigate:async()=>{},resume:async()=>{},notice(){}});
  await controller.show();assert.match(ui.$('recovery-items').textContent,/Draft preserved locally/);assert.match(ui.$('recovery-status').textContent,/1 entries need manual inspection/);
});


test('Local commit requires an exact review of every file, preserves message input and ignores double clicks',async()=>{
 const ui=dom(),calls=[],id=randomUUID();let commits=0,changed=0;
 const reviewed={operationId:id,state:'reviewed',running:false,paths:['docs/a.md','docs/b.md'],branch:'main',head:'a'.repeat(40),tree:'b'.repeat(40),message:'Reviewed message\n',execution:{hooks:['pre-commit','commit-msg'],signing:'ssh',filters:['docs']},review:[{path:'docs/a.md',before:'old a\n',after:'new a <script>literal</script>\n'},{path:'docs/b.md',before:'old b\n',after:'new b\n'}],canCommit:true,expiresAt:Date.now()+60000};
 const api=async(route,body)=>{calls.push({route,body});if(route==='git/commit/preview')return structuredClone(reviewed);if(route==='git/commit/start'){commits++;await new Promise(resolve=>setImmediate(resolve));return {...reviewed,state:'committed',review:[],canCommit:false,commitId:'c'.repeat(40),indexReady:true};}return structuredClone(reviewed);};
 const controller=gitCommit({$:ui.$,api,checkout:()=>'/fixture',selection:()=>['docs/a.md','docs/b.md'],changed:()=>changed++,notice(){}});
 await controller.show();ui.$('git-commit-message').value='Reviewed message';ui.$('git-commit-message').oninput();await ui.$('git-commit-form').onsubmit(event);
 assert.match(ui.$('git-commit-summary').textContent,/Hooks: pre-commit, commit-msg · Signing: ssh · Clean filters: docs/);assert.equal(ui.$('git-commit-reviewed').textContent,'1 of 2 files reviewed');assert.equal(ui.$('git-commit-confirm').disabled,true);assert.equal(commits,0);assert.equal(ui.$('git-commit-diff').querySelector('script'),null);assert.match(ui.$('git-commit-diff').textContent,/<script>literal<\/script>/);
 ui.$('git-commit-files').children[1].onclick();assert.equal(ui.$('git-commit-confirm').disabled,false);await Promise.all([ui.$('git-commit-confirm').onclick(),ui.$('git-commit-confirm').onclick()]);assert.equal(commits,1);assert.equal(changed,1);assert.match(ui.$('git-commit-feedback').textContent,/Local commit complete/);controller.close();assert.equal(ui.$('git-commit-message').value,'Reviewed message');
 await controller.show({operationId:id});assert.equal(commits,1);assert.equal(calls.filter(c=>c.route==='git/commit/start').length,1);controller.close();
});
test('Local commit suppresses a late preview after closing and resumes disk evidence without replay',async()=>{
 const ui=dom(),id=randomUUID(),calls=[];let pending,owner='one';const retained={operationId:id,state:'uncertain-ref-publication',running:false,paths:['docs/a.md'],branch:'main',head:'a'.repeat(40),message:'kept\n',review:[],canCommit:false,canRecover:true};
 const api=async(route,body)=>{calls.push({route,body});if(route==='git/commit/preview')return new Promise(resolve=>pending=resolve);return retained;};
 const controller=gitCommit({$:ui.$,api,checkout:()=>owner,selection:()=>['docs/a.md'],changed(){},notice(){}});await controller.show();ui.$('git-commit-message').value='kept';const preview=ui.$('git-commit-form').onsubmit(event);controller.close();owner='two';pending(retained);await preview;assert.equal(ui.$('git-commit-dialog').open,false);
 await controller.show({operationId:id});assert.match(ui.$('git-commit-feedback').textContent,/will not be repeated/);assert.equal(ui.$('git-commit-confirm').hidden,true);assert.ok(!calls.some(c=>c.route==='git/commit/start'||c.route==='git/operation/recover'));controller.close();
});

test('Local commit isolates message drafts and suppresses a retained reply from another checkout',async()=>{
 const ui=dom(),id=randomUUID();let owner='first',reply;
 const controller=gitCommit({$:ui.$,api:async()=>new Promise(resolve=>reply=resolve),checkout:()=>owner,selection:()=>['docs/a.md'],changed(){},notice(){}});
 await controller.show();ui.$('git-commit-message').value='First checkout message';controller.close();const pending=controller.show({operationId:id});assert.equal(ui.$('git-commit-form').hidden,true);controller.close();owner='second';await controller.show();assert.equal(ui.$('git-commit-message').value,'');
 reply({operationId:id,state:'reviewed',running:false,paths:['docs/old.md'],branch:'main',head:'a'.repeat(40),message:'OLD CHECKOUT',review:[],canCommit:true,expiresAt:Date.now()+60000});await pending;
 assert.equal(ui.$('git-commit-form').hidden,false);assert.ok(!ui.$('git-commit-dialog').textContent.includes('OLD CHECKOUT'));controller.close();owner='first';await controller.show();assert.equal(ui.$('git-commit-message').value,'First checkout message');controller.close();
});

test('Semantic quick navigation submits explicitly, retains text search and opens only verified sections',async()=>{
 const ui=dom(),f=await engine(),state={busy:false};ui.$('workspace').hidden=false;let opened,jumped;const calls=[];
 const api=async(route,body)=>{calls.push({route,body});if(route==='semantic/start')return {id:'fixture-job',state:'running'};if(route.startsWith('semantic/result'))return {state:'ready',documents:[{title:'Semantic plan',path:'docs/plans/existing.md',excerpt:'Current excerpt',location:'verified'}],sections:[{title:'Verified heading',path:'docs/plans/existing.md',line:7,revision:'current'}],coverage:{partial:true},stale:0};return f.api(route,body);};
 const controller=quickNavigation({$:ui.$,api,state,library:{quickDocuments:()=>[]},open:async path=>{opened=path;state.doc={revision:'current'};},jump:section=>jumped=section,actions:()=>[],notice(){}});
 await controller.show();ui.$('quick-mode').value='semantic';ui.$('quick-mode').onchange();ui.$('quick-query').value='find shipping approach';ui.$('quick-query').oninput();assert.equal(calls.some(c=>c.route==='semantic/start'),false);assert.match(ui.$('quick-status').textContent,/Press Enter/);assert.match(ui.$('quick-hint').textContent,/Experimental semantic search.*Text search is available/);assert.match(ui.$('quick-mode').querySelector('[value=semantic]').textContent,/experimental/);
 await ui.$('quick-search').onclick();assert.equal(calls.filter(c=>c.route==='semantic/start').length,1);assert.match(ui.$('quick-results').textContent,/Semantic plan/);assert.match(ui.$('quick-status').textContent,/top semantic matches.*coverage is incomplete/);assert.equal(opened,undefined);
 ui.$('quick-query').onkeydown({key:'ArrowDown',preventDefault(){}});await ui.$('quick-results').children[1].onclick();assert.equal(opened,'docs/plans/existing.md');assert.equal(jumped.line,7);
});
test('Semantic input changes and closing cancel late jobs and cannot restore selectable results',async()=>{
 const ui=dom();ui.$('workspace').hidden=false;let resolveStart;const calls=[];
 const api=async(route,body)=>{calls.push({route,body});if(route==='semantic/start')return new Promise(resolve=>resolveStart=resolve);if(route==='semantic/cancel')return {state:'cancelled'};throw new Error('unexpected query');};
 const controller=quickNavigation({$:ui.$,api,state:{busy:false},library:{quickDocuments:()=>[]},open:async()=>{},jump(){},actions:()=>[],notice(){}});
 await controller.show();ui.$('quick-mode').value='semantic';ui.$('quick-mode').onchange();ui.$('quick-query').value='old';const pending=controller.search();ui.$('quick-query').value='new';ui.$('quick-query').oninput();ui.$('quick-close').onclick();resolveStart({id:'late-job',state:'running'});await pending;
 assert.equal(calls.filter(c=>c.route==='semantic/start').length,1);assert.equal(calls.find(c=>c.route==='semantic/cancel').body.id,'late-job');assert.equal(ui.$('quick-results').children.length,0);
});
test('Semantic section activation rechecks the opened revision and unavailable tools preserve text mode',async()=>{
 const ui=dom(),f=await engine(),state={busy:false};ui.$('workspace').hidden=false;let jumped=false,message='',ready=false;
 const api=async(route,body)=>route==='semantic/start'?{id:'j'}:route.startsWith('semantic/result')?ready?{state:'ready',documents:[],sections:[{title:'Old section',path:'docs/plans/existing.md',line:3,revision:'old'}],coverage:{partial:false},stale:0}:{state:'unsupported_tool',message:'Update gmax externally. Exact search is available.'}:f.api(route,body);
 const controller=quickNavigation({$:ui.$,api,state,library:{quickDocuments:()=>[]},open:async()=>{state.doc={revision:'new'};},jump(){jumped=true;},actions:()=>[],notice:text=>message=text});
 await controller.show();ui.$('quick-mode').value='semantic';ui.$('quick-mode').onchange();ui.$('quick-query').value='Needle';await controller.search();assert.match(ui.$('quick-status').textContent,/Update gmax/);assert.equal(ui.$('quick-query').value,'Needle');
 ready=true;await controller.search();await ui.$('quick-results').children[0].onclick();assert.equal(jumped,false);assert.match(message,/document changed/);
 await controller.show();ui.$('quick-query').value='needle_dom';await controller.search();assert.match(ui.$('quick-results').textContent,/Existing/);
});
test('Library Semantic uses explicit submission, current filters and relevance without offset pagination',async()=>{
 const ui=dom(),f=await engine(),state={mode:'home',plans:[]},calls=[];
 const api=async(route,body)=>{calls.push({route,body});if(route==='semantic/start')return {id:'library-job'};if(route.startsWith('semantic/result'))return {state:'ready',documents:[{title:'Ranked result',path:'docs/plans/existing.md',kind:'plan',type:'plan',status:'active',excerpt:'Current semantic excerpt'}],sections:[],coverage:{partial:true},message:'Top semantic matches.'};return f.api(route,body);};
 const navigation=libraryNavigation({state,$:ui.$,api,open:async()=>{},showLibrary:async()=>{},checkout:()=>f.root,notice(){}});await navigation.load();ui.$('library-search-semantic').checked=true;ui.$('filter').value='how do we ship';ui.$('library-status').value='active';await navigation.load();assert.equal(calls.some(c=>c.route==='semantic/start'),false);assert.match(ui.$('library-range').textContent,/Press Search/);assert.equal(ui.$('library-sort').value,'relevance');assert.equal(ui.$('library-sort').disabled,true);
 await ui.$('library-semantic-search').onclick();assert.equal(calls.find(c=>c.route==='semantic/start').body.status,'active');assert.match(ui.$('library-range').textContent,/1 top semantic matches/);assert.equal(ui.$('library-next').disabled,true);assert.match(ui.$('library-scan-note').textContent,/coverage is incomplete/);assert.equal(state.plans[0].title,'Ranked result');
 ui.$('library-search-semantic').checked=false;await navigation.load();assert.equal(ui.$('library-sort').disabled,false);assert.equal(ui.$('library-sort').value,'updated');assert.equal(calls.filter(c=>c.route==='semantic/start').length,1);
});

test('yardstick UI reviews and applies human assessment through shared engine, then blocks draft actions',async()=>{
 const ui=dom(),f=await engine("export const yardstick='docs/goal.md';\n");writeFileSync(path.join(f.root,'docs/goal.md'),'# Goal\n\nKeep documents useful.\n');
 const state={doc:await f.api('document?path=docs/plans/existing.md'),busy:false,dirty:false,pending:null},notices=[],moves=[];
 const controller=documentYardstick({state,$:ui.$,api:f.api,checkout:()=>f.root,open:async path=>{state.doc=await f.api('document?path='+path);await controller.opened();},library:{relocated:(...args)=>moves.push(args),load:async()=>{}},notice:(...args)=>notices.push(args)});
 assert.equal(f.calls.some(c=>c.route.startsWith('yardstick')),false);await controller.opened();assert.equal(ui.$('yardstick-panel').hidden,false);
 const serves=ui.$('yardstick-panel').querySelector('[data-yardstick-action="serves"]');await serves.onclick();assert.equal(ui.$('yardstick-dialog').open,true);assert.throws(()=>controller.beforeLeave(),/Close/);
 const form=ui.$('yardstick-dialog').querySelector('form');form.querySelector('textarea').value='Owner chooses this.';await form.onsubmit(event);
 assert.match(ui.$('yardstick-dialog-title').textContent,/serves/i);assert.match(ui.$('yardstick-dialog').querySelector('pre').textContent,/Owner chooses this/);assert.equal(f.calls.some(c=>c.route==='yardstick/commit'),false);
 assert.equal(ui.$('yardstick-dialog').querySelector('[data-yardstick-apply]').disabled,false);await ui.$('yardstick-dialog').querySelector('[data-yardstick-apply]').onclick();
 assert.equal(ui.$('yardstick-dialog').open,false);assert.equal(moves.length,1);assert.match(readFileSync(path.join(f.root,'docs/plans/existing.md'),'utf8'),/yardstick_disposition: "serves"/);assert.equal(state.doc.status,'active');assert.equal(localStorage.length,0);assert.ok(notices.some(([message])=>/assessment saved/i.test(message)));
 state.dirty=true;controller.update();assert.equal(ui.$('yardstick-panel').querySelector('[data-yardstick-action="close"]').disabled,true);assert.match(ui.$('yardstick-panel').querySelector('.yardstick-availability').textContent,/draft/);
});
test('filing UI scans only after opening and navigates exact current hub row without mutation',async()=>{
 const ui=dom(),f=await engine('export const filing=true;\n');
 writeFileSync(path.join(f.root,'docs/hub.md'),'---\ntype: plan\nstatus: active\nexecution_mode: coordination\n---\n# Hub\n\n### Delivery\n\n| Plan | Status |\n|---|---|\n| [Existing](plans/existing.md) | active |\n');
 const state={mode:'home'},opened=[];let controller;
 controller=filingNavigation({state,$:ui.$,api:f.api,checkout:()=>f.root,showLibrary:async()=>controller.deactivate(),open:async(...args)=>opened.push(args),notice:message=>assert.fail(message)});
 assert.equal(f.calls.some(c=>c.route.startsWith('filing')),false);await controller.show();assert.equal(state.mode,'filing');assert.equal(ui.$('library-filing').getAttribute('aria-pressed'),'true');assert.match(ui.$('filing-feedback').textContent,/1 live plans checked/);
 await ui.$('filing-list').querySelector('[data-path]').onclick();assert.match(ui.$('filing-detail').textContent,/Delivery/);
 const rowButton=[...ui.$('filing-detail').querySelectorAll('button')].find(button=>button.textContent==='Open hub row');assert.ok(rowButton);await rowButton.onclick();assert.equal(opened[0][0],'docs/hub.md');assert.ok(opened[0][1].line>1);assert.match(opened[0][1].expectedRevision,/^sha256:/);
 controller.invalidate();assert.match(ui.$('filing-feedback').textContent,/Refresh/);assert.equal(f.calls.some(c=>c.body!==undefined),false);controller.deactivate();assert.equal(ui.$('filing-home').hidden,true);
});
test('Recovery recognizes local and disk yardstick reviews and only inspects on activation',async()=>{
 const ui=dom(),resumed=[],calls=[];localStorage.setItem('runlist:yardstick:/fixture:docs%2Fplan.md',JSON.stringify({path:'docs/plan.md',operationId:'review-a',state:'reviewed'}));
 const controller=recoveryCenter({$:ui.$,checkout:()=>'/fixture',api:async route=>{calls.push(route);return {items:[{kind:'yardstick',operationId:'review-a',path:'docs/plan.md',state:'reviewed',available:true}],offset:0,hasMore:false,unavailable:0};},beforeNavigate:async()=>{},resume:async row=>resumed.push(row),notice(){}});
 await controller.show();assert.equal(ui.$('recovery-items').children.length,1);assert.match(ui.$('recovery-items').textContent,/Product goal assessment/);assert.equal(resumed.length,0);await ui.$('recovery-items').querySelector('button').onclick();assert.equal(resumed[0].kind,'yardstick');assert.equal(calls.length,1);
});
