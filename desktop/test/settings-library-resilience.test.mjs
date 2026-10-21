import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const assets=process.env.RUNLIST_TEST_ASSETS??path.resolve(import.meta.dirname,'../../assets/app');
const {appSettings}=await import(pathToFileURL(path.join(assets,'settings.mjs')));
const {libraryNavigation}=await import(pathToFileURL(path.join(assets,'library-navigation.mjs')));
const previous=Object.fromEntries(['document','window','localStorage','Option','Event'].map(key=>[key,globalThis[key]]));
afterEach(()=>Object.assign(globalThis,previous));
const event={preventDefault(){}};
function dom(){
 const {document,window}=parseHTML(readFileSync(path.join(assets,'index.html'),'utf8')),$=id=>document.getElementById(id),values=new Map();
 Object.defineProperty(window.HTMLSelectElement.prototype,'value',{configurable:true,get(){return this.querySelector('option[selected]')?.value??this.querySelector('option')?.value??'';},set(value){for(const option of this.querySelectorAll('option'))if(option.value===String(value))option.setAttribute('selected','');else option.removeAttribute('selected');}});
 window.HTMLSelectElement.prototype.add=function(option){this.append(option);};Object.defineProperty(window.HTMLSelectElement.prototype,'options',{configurable:true,get(){return this.querySelectorAll('option');}});
 for(const dialog of document.querySelectorAll('dialog')){Object.defineProperty(dialog,'open',{get(){return this.hasAttribute('open');}});dialog.showModal=()=>dialog.setAttribute('open','');dialog.close=()=>dialog.removeAttribute('open');}
 globalThis.Event=window.Event;globalThis.document=document;globalThis.window=window;globalThis.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};globalThis.Option=function(label,value){const option=document.createElement('option');option.textContent=label;option.value=value;return option;};
 return {$,values};
}
const info={roots:['docs'],exclusions:['node_modules'],statuses:{typeOrder:[],byType:{}},sharing:{Drafts:'Local'}};
const tool={message:'Optional external tool',nodePath:'',entryPath:''};
function settings(ui,api,library={preferences:async()=>{}},checkout=()=>'/fixture'){
 const notices=[];appSettings({$:ui.$,api,library,checkout,notice:message=>notices.push(message)});return notices;
}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('optional tool failure leaves preferences usable, details collapsed and retry isolated',async()=>{
 const ui=dom();ui.$('checkout').textContent='Workspace';let fail=true,applied;
 settings(ui,async route=>{if(route==='semantic/settings'){if(fail)throw Error('Tool offline');return tool;}return info;},{preferences:async prefs=>applied=prefs});
 await ui.$('open-settings').onclick();assert.equal(ui.$('settings-dialog').open,true);assert.equal(ui.$('settings-checkout').textContent,'Workspace');assert.equal(ui.$('settings-advanced').hasAttribute('open'),false);assert.ok(ui.$('settings-semantic-section').closest('#settings-advanced'));assert.match(ui.$('settings-semantic-section').textContent,/Tool offline/);
 ui.$('settings-sort').value='title';await ui.$('settings-preferences').onsubmit(event);assert.equal(applied.sort,'title');assert.match(ui.$('settings-feedback').textContent,/Preferences saved/);
 fail=false;await ui.$('settings-semantic-section').querySelector('button').onclick();assert.equal(ui.$('settings-semantic-node').value,'');assert.equal(ui.$('settings-feedback').textContent,'Preferences saved.');
});

test('Settings opens before either remote read and separately retries failed checkout details',async()=>{
 const ui=dom(),pending=deferred();let first=true;
 settings(ui,async route=>route==='semantic/settings'?pending.promise:first?(first=false,Promise.reject(Error('Checkout unreadable'))):info);
 const opening=ui.$('open-settings').onclick();assert.equal(ui.$('settings-dialog').open,true);assert.ok(ui.$('settings-preferences'));await new Promise(resolve=>setImmediate(resolve));
 assert.match(ui.$('settings-repository-section').textContent,/Checkout unreadable/);await ui.$('settings-repository-section').querySelector('button').onclick();assert.match(ui.$('settings-repository-section').textContent,/docs/);pending.resolve(tool);await opening;
});

test('storage read and write failures appear in the preferences form with actionable details',async()=>{
 const ui=dom(),notices=settings(ui,async route=>route==='settings'?info:tool);localStorage.getItem=()=>{throw Error('Storage blocked');};
 await ui.$('open-settings').onclick();assert.match(ui.$('settings-feedback').textContent,/could not be read: Storage blocked.*Defaults/);
 localStorage.setItem=()=>{throw Error('Storage full');};await ui.$('settings-preferences').onsubmit(event);assert.match(ui.$('settings-feedback').textContent,/could not be saved: Storage full.*Try again/);assert.equal(ui.$('settings-preferences').querySelector('button').disabled,false);assert.deepEqual(notices,[]);
});

test('partial storage success and post-save library failures are reported honestly',async()=>{
 const ui=dom();settings(ui,async route=>route==='settings'?info:tool,{preferences:async()=>{throw Error('Read failed');}});await ui.$('open-settings').onclick();
 const write=localStorage.setItem;localStorage.setItem=(key,value)=>{if(key==='runlist:appearance')throw Error('Appearance blocked');write(key,value);};ui.$('settings-sort').value='path';await ui.$('settings-preferences').onsubmit(event);
 assert.equal(JSON.parse(ui.values.get('runlist:preferences:/fixture')).sort,'path');assert.match(ui.$('settings-feedback').textContent,/Document preferences saved.*Appearance blocked.*Library could not refresh: Read failed/);
});

test('late settings reads and saves cannot replace feedback in a reopened dialog',async()=>{
 const ui=dom(),pendingTool=deferred(),pendingSave=deferred();let first=true;
 settings(ui,async route=>route==='settings'?info:first?(first=false,pendingTool.promise):tool,{preferences:()=>pendingSave.promise});
 const opening=ui.$('open-settings').onclick(),saving=ui.$('settings-preferences').onsubmit(event);ui.$('settings-close').onclick();await ui.$('open-settings').onclick();
 pendingTool.resolve({...tool,nodePath:'/old/node'});pendingSave.resolve();await Promise.all([opening,saving]);assert.equal(ui.$('settings-semantic-node').value,'');assert.equal(ui.$('settings-feedback').textContent,'');
});

function response(title='Existing',extra={}){return {documents:[{path:'docs/a.md',title,kind:'plan',type:'plan',status:'active'}],counts:{all:1,hubs:0,plans:1,documents:0},total:1,offset:0,hasMore:false,facets:{stages:[],statuses:[],types:[],folders:[]},stats:{unavailable:0,discoveryErrors:0},...extra};}
function library(ui,api){const state={mode:'home',plans:[]},notices=[];return {state,notices,controller:libraryNavigation({state,$:ui.$,api,open:async()=>{},showLibrary:async()=>{},checkout:()=>'/fixture',notice:message=>notices.push(message)})};}

test('pending library reads and failed search remove stale rows; inline Retry keeps query and filters',async()=>{
 const ui=dom(),pending=deferred(),calls=[];let next=response();const {state,controller,notices}=library(ui,async route=>{calls.push(route);return next;});await controller.load();assert.equal(ui.$('plans').querySelectorAll('button').length,1);
 ui.$('filter').value='new query';ui.$('library-archived').checked=true;ui.$('library-search-content').checked=true;next=pending.promise;const loading=controller.load({reset:true});assert.equal(ui.$('plans').querySelectorAll('button').length,0);assert.equal(state.plans.length,0);controller.render();assert.doesNotMatch(ui.$('plans').textContent,/Existing/);
 pending.reject(Error('Search timed out'));await assert.rejects(loading,/Search timed out/);assert.match(ui.$('plans').textContent,/Search unavailable: Search timed out/);assert.equal(ui.$('library-next').disabled,true);assert.equal(ui.$('plans').querySelector('button').textContent,'Retry');
 next=response('Fresh result');await ui.$('plans').querySelector('button').onclick();const params=new URLSearchParams(calls.at(-1).split('?')[1]);assert.equal(params.get('q'),'new query');assert.equal(params.get('archived'),'1');assert.equal(params.get('content'),'1');assert.match(ui.$('plans').textContent,/Fresh result/);assert.deepEqual(notices,[]);
});

test('typing hides old results during debounce and semantic mode waits for explicit submit',async()=>{
 const ui=dom(),calls=[];const {controller}=library(ui,async route=>{calls.push(route);return response();});await controller.load();ui.$('filter').value='pending';ui.$('filter').oninput();assert.equal(ui.$('plans').querySelectorAll('button').length,0);
 ui.$('library-search-semantic').checked=true;await ui.$('library-search-semantic').onchange();assert.match(ui.$('plans').textContent,/Press Search/);ui.$('filter').value='another concept';ui.$('filter').oninput();assert.match(ui.$('plans').textContent,/Press Search/);assert.equal(calls.some(route=>route==='semantic/start'),false);ui.$('filter').value='';ui.$('filter').oninput();assert.match(ui.$('plans').textContent,/Enter a search query/);
});

test('late successful and failed search responses cannot displace the current query results',async()=>{
 const ui=dom(),first=deferred(),second=deferred();let next=first.promise;const {controller}=library(ui,async()=>next);
 const old=controller.load();next=second.promise;ui.$('filter').value='current';const current=controller.load({reset:true});second.resolve(response('Current'));await current;first.resolve(response('Stale'));await old;assert.match(ui.$('plans').textContent,/Current/);assert.doesNotMatch(ui.$('plans').textContent,/Stale/);
 const failure=deferred();next=failure.promise;const stale=controller.load();next=response('Newest');await controller.load();failure.reject(Error('Old failure'));await assert.rejects(stale);assert.match(ui.$('plans').textContent,/Newest/);assert.doesNotMatch(ui.$('plans').textContent,/Old failure/);
});

test('semantic Retry reruns the current explicit query, retains relevance, and Cancel prevents late results',async()=>{
 const ui=dom(),calls=[];let fail=true,start;
 const {controller}=library(ui,async(route,body)=>{calls.push({route,body});if(route==='semantic/start'){if(start)return start.promise;if(fail)throw Error('Provider disconnected');return {id:'search'};}if(route.startsWith('semantic/result'))return {documents:[{title:'Ranked',path:'docs/ranked.md',kind:'plan',status:'active'}],message:'Ready'};if(route==='semantic/cancel')return {};return response();});
 ui.$('library-search-semantic').checked=true;ui.$('filter').value='shipping approach';await ui.$('library-semantic-search').onclick();assert.match(ui.$('plans').textContent,/Provider disconnected/);fail=false;await ui.$('plans').querySelector('button').onclick();assert.equal(calls.filter(call=>call.route==='semantic/start').length,2);assert.equal(calls.filter(call=>call.route==='semantic/start').at(-1).body.query,'shipping approach');assert.equal(ui.$('library-sort').value,'relevance');assert.match(ui.$('plans').textContent,/Ranked/);
 start=deferred();const searching=ui.$('library-semantic-search').onclick();await Promise.resolve();await Promise.resolve();await ui.$('library-semantic-cancel').onclick();start.resolve({id:'cancelled'});await searching;assert.equal(ui.$('plans').querySelectorAll('button').length,0);assert.match(ui.$('library-range').textContent,/Press Search/);assert.equal(calls.find(call=>call.route==='semantic/cancel').body.id,'cancelled');
});

test('failed page Retry retains the offset, saved view, stage grouping and filters',async()=>{
 const ui=dom(),calls=[];let fail=false;
 localStorage.setItem('runlist:views:/fixture',JSON.stringify([{id:'stages',name:'Shipping',filters:{'library-kind':'plans','library-stage':'word:Review','library-group':'stage','library-sort':'title',archived:true}}]));
 const {controller}=library(ui,async route=>{calls.push(route);if(fail)throw Error('Page unavailable');const params=new URLSearchParams(route.split('?')[1]);return response('Grouped',{offset:Number(params.get('offset')),total:120,hasMore:true,group:'stage'});});
 controller.restore();await controller.applyView('stages');fail=true;await ui.$('library-next').onclick();assert.match(ui.$('plans').textContent,/Page unavailable/);assert.equal(ui.$('library-view').value,'stages');fail=false;await ui.$('library-retry').onclick();
 const params=new URLSearchParams(calls.at(-1).split('?')[1]);assert.equal(params.get('offset'),'50');assert.equal(params.get('stage'),'word:Review');assert.equal(params.get('group'),'stage');assert.equal(params.get('sort'),'title');assert.equal(ui.$('library-view').value,'stages');assert.equal(ui.$('library-previous').disabled,false);
 ui.$('delete-library-view').onclick();assert.match(ui.$('plans').textContent,/Grouped/);assert.equal(ui.$('library-view').value,'');
});

test('typed semantic refusals show provider guidance beside Retry instead of pretending no matches',async()=>{
 const ui=dom();let unavailable=true;
 const {controller}=library(ui,async route=>route==='semantic/start'?{id:'typed'}:route.startsWith('semantic/result')?unavailable?{state:'tool_missing',message:'Install the optional tool or use exact search.',documents:[]}:{state:'ready',documents:[],message:'Ready'}:response());
 ui.$('library-search-semantic').checked=true;ui.$('filter').value='concept';await ui.$('library-semantic-search').onclick();assert.match(ui.$('plans').textContent,/Install the optional tool or use exact search/);assert.doesNotMatch(ui.$('plans').textContent,/No documents match/);unavailable=false;await ui.$('library-retry').onclick();assert.match(ui.$('library-range').textContent,/0 top semantic matches/);
});
