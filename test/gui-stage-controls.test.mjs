import {test} from 'node:test';
import assert from 'node:assert/strict';
import {libraryNavigation} from '../assets/app/library-navigation.mjs';
import {documentStages} from '../assets/app/document-stages.mjs';

class Element {
  constructor(tag='div'){this.tag=tag;this.children=[];this.value='';this.checked=false;this.hidden=false;this.disabled=false;this.attributes={};this.className='';this.textContent='';}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  add(child){this.append(child);}
  get options(){return this.children;}
  setAttribute(key,value){this.attributes[key]=value;}
  showModal(){this.hidden=false;}
  close(){this.hidden=true;}
  focus(){}
}
function environment(){
 const prior=Object.fromEntries(['document','Option','localStorage'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)])),elements=new Map(),storage=new Map();
 const $=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 globalThis.document={createElement:tag=>new Element(tag),createTextNode:text=>({textContent:text})};
 globalThis.Option=class extends Element{constructor(label,value){super('option');this.textContent=label;this.value=value;}};
 globalThis.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)};
 return {$,storage,restore(){for(const [key,value]of Object.entries(prior))if(value===undefined)delete globalThis[key];else Object.defineProperty(globalThis,key,value);}};
}
const doc=stage=>({path:`docs/${stage??'unset'}.md`,title:stage??'No stage',kind:'plan',type:'plan',status:'active',stage,stageInvalid:false});
const result={documents:[doc('First'),doc('Later'),doc(null)],group:'stage',stageDefinitions:[{word:'First',meaning:'Small first delivery'},{word:'Later',meaning:'After the first release'}],total:3,counts:{all:3,hubs:0,plans:3,documents:0},offset:0,hasMore:false,stats:{},facets:{statuses:[],types:[],folders:[],stages:[{value:'word:First',label:'First',count:1},{value:'word:Later',label:'Later',count:1},{value:'@unset',label:'Unset',count:1}]}};

test('Library saved views preserve stage filters/grouping while older views keep their defaults',async()=>{
 const env=environment();try{
  const {$,storage}=env,state={mode:'home',plans:[],doc:null},requests=[];
  $('library-kind').value='plans';$('library-sort').value='title';$('library-stage').value='word:Later';$('library-group').value='stage';
  const library=libraryNavigation({state,$,checkout:()=>'/checkout',api:async route=>{requests.push(route);return result;},open:async()=>{},showLibrary:async()=>{},notice:()=>{}});
  await library.load();let params=new URLSearchParams(requests.at(-1).split('?')[1]);assert.equal(params.get('stage'),'word:Later');assert.equal(params.get('group'),'stage');
  assert.deepEqual($('plans').children.filter(c=>c.className==='library-stage-heading').map(c=>c.children[0].textContent),['First','Later','Unset · no stage']);
  assert.equal($('plans').children[0].children[1].textContent,'Small first delivery');
  $('filter-name').value='Later delivery';$('filter-form').onsubmit({preventDefault(){}});
  const view=JSON.parse(storage.get('runlist:views:/checkout'))[0];assert.equal(view.filters['library-stage'],'word:Later');assert.equal(view.filters['library-group'],'stage');
  $('library-stage').value='';$('library-group').value='';await library.applyView(view.id);params=new URLSearchParams(requests.at(-1).split('?')[1]);assert.equal(params.get('stage'),'word:Later');assert.equal(params.get('group'),'stage');
  storage.set('runlist:views:/checkout',JSON.stringify([{id:'old',name:'Old view',filters:{'library-kind':'plans','library-status':'active'}}]));library.restore();await library.applyView('old');params=new URLSearchParams(requests.at(-1).split('?')[1]);assert.equal(params.get('stage'),'');assert.equal(params.get('group'),'');assert.equal($('library-sort').value,'updated');
  $('library-documents').onclick();await new Promise(resolve=>setImmediate(resolve));assert.equal($('library-stage-field').hidden,true);assert.equal(new URLSearchParams(requests.at(-1).split('?')[1]).get('stage'),'');
 }finally{env.restore();}
});

test('Stage selector reads draft metadata and sends only a draft choice, respecting pending and nonplan views',()=>{
 const env=environment();try{
  const {$}=env,state={doc:{kind:'plan',editable:true,stageDefinitions:result.stageDefinitions},busy:false,pending:null},choices=[];
  const stages=documentStages({state,$,changed:word=>choices.push(word)});
  stages.update('---\ntype: plan\nships: First\n---\n# Plan\n');assert.equal($('document-stage').value,'word:First');assert.equal($('document-stage-meaning').textContent,'Small first delivery');
  $('document-stage').value='word:Later';$('document-stage').onchange();assert.deepEqual(choices,['Later']);
  stages.update('---\ntype: plan\nships: Later\n---\n# Plan\n');assert.equal($('document-stage').value,'word:Later');
  state.pending={operationId:'pending'};stages.update('---\ntype: plan\n---\n');assert.equal($('document-stage').disabled,true);
  state.pending=null;stages.update('---\ntype: plan\nships: Unknown\n---\n');assert.equal($('document-stage').value,'word:Unknown');assert.equal($('document-stage').options.at(-1).disabled,true);
  stages.update('---\ntype: plan\nships: []\n---\n');assert.equal($('document-stage').value,'@invalid');assert.match($('document-stage-meaning').textContent,/unsupported metadata/);
  state.doc.kind='document';stages.update('# Doc\n');assert.equal($('document-stage-fields').hidden,true);
 }finally{env.restore();}
});
