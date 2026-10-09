import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync,symlinkSync,existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolveConfig} from '../src/config.mjs';
import {createCheckoutService} from '../src/app-service.mjs';
import {createSourceEditor,sourceRevision} from '../src/source-editor.mjs';
import {saveTemplate} from '../src/template-store.mjs';
import {appTemplates} from '../src/new.mjs';
import {documentOutline} from '../assets/app/outline.mjs';
import {nativeFixture,nativeSource,recordId} from './native-fixtures.mjs';

const roots=[];
const actor={kind:'human',id:'human:workspace-test',label:'Workspace owner'};
const original='---\r\ntype: plan\r\nstatus: active\r\n---\r\n# Existing plan\r\n\r\nOriginal paragraph.\r\n';
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture(extra=''){
  const root=mkdtempSync(path.join(os.tmpdir(),'runlist-workspace-'));roots.push(root);
  mkdirSync(path.join(root,'docs/plans'),{recursive:true});mkdirSync(path.join(root,'docs/prompts'));mkdirSync(path.join(root,'docs/excluded'));
  writeFileSync(path.join(root,'runlist.config.mjs'),"export const root='docs';\nexport const excludeDirs=['excluded'];\n"+extra);
  writeFileSync(path.join(root,'docs/plans/existing.md'),original);
  writeFileSync(path.join(root,'docs/prompts/private.md'),'---\ntype: prompt\nstatus: pending\n---\n# Secret\n\nNEVER_DISCLOSE_WORKSPACE\n');
  writeFileSync(path.join(root,'docs/excluded/private.md'),'---\ntype: doc\nstatus: active\n---\n# Excluded\n\nNEVER_DISCLOSE_WORKSPACE\n');
  const config=await resolveConfig(root),service=createCheckoutService({config,actor});
  const api=(route,body)=>service.request({method:body===undefined?'GET':'POST'},'/api/'+route,body);
  return {root,config,api};
}
const request=(template='plan',folder='docs/plans')=>({template,folder,filename:randomUUID()+'.md',title:'A new document',status:template==='doc'?'active':'planned',body:'Initial authored paragraph.',operationId:randomUUID()});

test('valid structured plans retain narrative editing and explain unavailable lifecycle actions',async()=>{
 const f=await fixture(),record=nativeFixture();record.type='plan';record.id=recordId('plan',8);record.status='active';delete record.question;
 const data=record.record_data;record.record_data=Object.fromEntries(['repository_id','created_by','aliases','evidence','relations','history','extensions'].map(key=>[key,data[key]]));
 const source=nativeSource(record,'# Structured plan\n\nAuthored text.\n');writeFileSync(path.join(f.root,'docs/plans/structured.md'),source);
 const opened=await f.api('document?path=docs/plans/structured.md');assert.equal(opened.editable,true);
 const info=await f.api('lifecycle?path='+opened.path);assert.equal(info.enabled,false);assert.match(info.reason,/structured plans.*continue editing/);
 await assert.rejects(f.api('lifecycle/preview',{path:opened.path,status:'partial',note:'Review',operationId:randomUUID(),expectedRevision:opened.revision}),{code:'lifecycle-unavailable'});
 await f.api('save',{path:opened.path,source:source.replace('Authored text.','Edited text.'),expectedRevision:opened.revision,operationId:randomUUID()});assert.equal((await f.api('document?path='+opened.path)).status,'active');
});

test('save and undo update library metadata and document reads without a full inventory scan',async()=>{
 const f=await fixture();for(let i=0;i<100;i++)writeFileSync(path.join(f.root,'docs/plans',`other-${i}.md`),original.replace('Existing plan','Other '+i));
 const before=await f.api('library?archived=1'),doc=await f.api('document?path=docs/plans/existing.md');
 const saved=await f.api('save',{path:doc.path,expectedRevision:doc.revision,operationId:randomUUID(),source:doc.source.replace('Existing plan','Saved heading')});
 const current=await f.api('document?path='+doc.path);assert.equal(current.title,'Saved heading');assert.equal(current.revision,saved.revision);
 const after=await f.api('library?archived=1&q=Saved heading');assert.equal(after.documents[0].title,'Saved heading');assert.equal(after.stats.fullScans,before.stats.fullScans);assert.equal(after.stats.checkedFiles,1);
 await f.api('undo',{path:doc.path,expectedRevision:saved.revision,operationId:randomUUID(),undoOf:saved.operationId});
 assert.equal((await f.api('document?path='+doc.path)).title,'Existing plan');
 const restored=await f.api('library?archived=1');assert.equal(restored.stats.fullScans,before.stats.fullScans);assert.equal(restored.stats.incrementalRefreshes,2);assert.equal(readFileSync(path.join(f.root,doc.path),'utf8'),original);
});

test('optimized editor routes retain scope and stable UTF-8 checks before changing recovery state',async()=>{
 const f=await fixture(),doc=await f.api('document?path=docs/plans/existing.md'),id=randomUUID();
 const draft=await f.api('draft/write',{path:doc.path,draftId:id,baseRevision:doc.revision,baseSource:doc.source,source:doc.source+'Draft text.',expectedDraftRevision:null});
 for(const route of ['save','draft/read','draft/write','draft/discard'])await assert.rejects(f.api(route,{path:'docs/prompts/private.md',draftId:id,operationId:randomUUID(),expectedRevision:doc.revision}),error=>['forbidden','unsupported-source'].includes(error.code));
 writeFileSync(path.join(f.root,doc.path),Buffer.from([0xf0,0x9f,0x8c]));
 await assert.rejects(f.api('draft/read',{path:doc.path,draftId:randomUUID()}),{code:'invalid-source'});
 await assert.rejects(f.api('draft/discard',{path:doc.path,draftId:id,expectedDraftRevision:draft.revision}),{code:'invalid-source'});
 writeFileSync(path.join(f.root,doc.path),original);assert.equal((await f.api('draft/read',{path:doc.path,draftId:id})).source,draft.source);
});

test('creation previews and validates plan/doc/hub Markdown, publishes exclusively and immediately indexes it',async()=>{
  const f=await fixture();
  for(const template of ['plan','doc','hub']) {
    const input=request(template,template==='doc'?'docs/reference':'docs/plans'),review=await f.api('create/preview',input);
    assert.equal(existsSync(path.join(f.root,review.path)),false);
    assert.match(review.source,/Initial authored paragraph\./);assert.equal(review.state,'reviewed');
    const committed=await f.api('create/commit',{operationId:review.operationId});
    assert.equal(committed.state,'committed');assert.equal(readFileSync(path.join(f.root,review.path),'utf8'),review.source);
    const doc=await f.api('document?path='+encodeURIComponent(review.path));assert.equal(doc.editable,true);assert.equal(doc.kind,template==='hub'?'hub':template==='doc'?'document':'plan');
    assert.ok((await f.api('library?archived=1')).documents.some(row=>row.path===review.path));
  }
});
test('saved Markdown templates are used and browsing/creation never executes JavaScript template functions',async()=>{
  const f=await fixture("export const templates={plan:{body(){throw new Error('MUST_NOT_EXECUTE_TEMPLATE')}}};\n");
  assert.match((await f.api('create')).templates.find(t=>t.name==='plan').note,/built-in/);
  const source=appTemplates(f.config).templates.find(t=>t.name==='plan').source.replace('## Problem','## Repository-specific problem');
  saveTemplate(f.config,{name:'plan',source,expectedRevision:null});
  const review=await f.api('create/preview',request());assert.match(review.source,/Repository-specific problem/);
  assert.equal((await f.api('create')).templates.find(t=>t.name==='plan').note,null);
});
test('creation rejects private paths, symlink escapes, invalid status/metadata and forged authority',async()=>{
  const f=await fixture();const outside=mkdtempSync(path.join(os.tmpdir(),'runlist-outside-'));roots.push(outside);symlinkSync(outside,path.join(f.root,'docs/escape'));
  for(const folder of ['../outside','docs/prompts','docs/excluded','docs/escape','/tmp','docs\\escape'])await assert.rejects(f.api('create/preview',{...request(),folder}));
  await assert.rejects(f.api('create/preview',{...request(),status:'in-session'}),{code:'invalid-status'});
  await assert.rejects(f.api('create/preview',{...request(),title:'Injected\ntype: prompt'}),{code:'invalid-request'});
  await assert.rejects(f.api('create/preview',{...request(),actor:{kind:'agent',id:'forged'}}),{code:'forbidden'});
  assert.equal(readdirSync(outside).length,0);
});
test('creation collisions and changed templates stop publication without changing existing files',async()=>{
  const f=await fixture(),input=request(),review=await f.api('create/preview',input);
  writeFileSync(path.join(f.root,review.path),'External creator owns this file.');
  await assert.rejects(f.api('create/commit',{operationId:review.operationId}),{code:'creation-conflict'});
  assert.equal(readFileSync(path.join(f.root,review.path),'utf8'),'External creator owns this file.');
  const second=await f.api('create/preview',request());
  const source=appTemplates(f.config).templates.find(t=>t.name==='plan').source.replace('## Problem','## Changed problem');saveTemplate(f.config,{name:'plan',source,expectedRevision:null});
  await assert.rejects(f.api('create/commit',{operationId:second.operationId}),{code:'creation-review-stale'});assert.equal(existsSync(path.join(f.root,second.path)),false);
});
test('creation retries preserve the original review and cannot overwrite later edits',async()=>{
  const f=await fixture(),input=request(),first=await f.api('create/preview',input),repeated=await f.api('create/preview',input);assert.equal(repeated.source,first.source);
  const result=await f.api('create/commit',{operationId:first.operationId});writeFileSync(path.join(f.root,first.path),result.source+'\nExternal follow-up.\n');
  const again=await f.api('create/commit',{operationId:first.operationId});assert.equal(again.replayed,true);assert.match(readFileSync(path.join(f.root,first.path),'utf8'),/External follow-up/);
  await assert.rejects(f.api('create/preview',{...input,title:'Different request'}));
});
test('document creation resumes a retained review from before native record forms were added',async()=>{
  const f=await fixture(),input=request(),review=await f.api('create/preview',input);
  const file=path.join(f.root,'.runlist/editor/creations',review.operationId+'.json'),stored=JSON.parse(readFileSync(file));
  stored.requestHash=createHash('sha256').update(JSON.stringify([input.template,input.title,input.filename,input.folder,input.status,input.body])).digest('hex');
  writeFileSync(file,JSON.stringify(stored));
  assert.deepEqual(await f.api('create/preview',input),review);
  assert.equal(existsSync(path.join(f.root,review.path)),false);
  assert.equal((await f.api('create/commit',{operationId:review.operationId})).state,'committed');
});
test('prepared creation recovery inspects without publishing and refuses a mismatched destination',async()=>{
  const f=await fixture(),review=await f.api('create/preview',request());
  const file=path.join(f.root,'.runlist/editor/creations',review.operationId+'.json'),value=JSON.parse(readFileSync(file));value.state='prepared';writeFileSync(file,JSON.stringify(value));
  const listed=await f.api('recovery');assert.equal(listed.items.find(i=>i.operationId===review.operationId).state,'prepared');assert.equal(existsSync(path.join(f.root,review.path)),false);
  writeFileSync(path.join(f.root,review.path),'Competing content.');await assert.rejects(f.api('create/commit',{operationId:review.operationId}),{code:'creation-uncertain'});
  writeFileSync(path.join(f.root,review.path),review.source);assert.equal((await f.api('create/commit',{operationId:review.operationId})).state,'committed');
});
test('search finds body content beyond header/chunk boundaries and headings, without exposing prompts or code-fence headings',async()=>{
  const f=await fixture();let body='# Search fixture\n\n'+('Unrelated text.\n'.repeat(10000))+'\n## Deep navigation target#\n\nThe needle_workspace appears here.\n\n```md\n## False navigation target\n```\n';
  const file='docs/search.md';writeFileSync(path.join(f.root,file),'---\ntype: doc\nstatus: active\n---\n'+body);
  const result=await f.api('search?q=needle_workspace');assert.equal(result.documents.length,1);assert.equal(result.documents[0].path,file);assert.ok(result.documents[0].excerpt.length<=240);assert.ok(!('source' in result.documents[0]));
  const section=(await f.api('search?q=deep%20navigation')).sections.find(s=>s.path===file);assert.equal(section.line,documentOutline(body).find(s=>s.title===section.title).line);
  assert.equal((await f.api('search?q=false%20navigation')).sections.length,0);
  assert.equal((await f.api('search?q=NEVER_DISCLOSE_WORKSPACE&archived=1')).total,0);
  const library=await f.api('library?q=needle_workspace&content=1');assert.equal(library.total,1);assert.equal(library.documents[0].path,file);
});
test('content search rechecks prompt metadata after the library cache was populated and paginates matches',async()=>{
  const f=await fixture();for(let i=0;i<58;i++)writeFileSync(path.join(f.root,`docs/content-${String(i).padStart(2,'0')}.md`),'---\ntype: doc\nstatus: active\n---\n# Content\n\nshared-search-term\n');
  await f.api('library');writeFileSync(path.join(f.root,'docs/content-00.md'),'---\ntype: prompt\nstatus: pending\n---\n# Content\n\nshared-search-term PRIVATE_AFTER_CACHE\n');
  const first=await f.api('search?q=shared-search-term&limit=50'),last=await f.api('search?q=shared-search-term&limit=50&offset=50');assert.equal(first.total,57);assert.equal(first.hasMore,true);assert.equal(last.documents.length,7);assert.equal(last.hasMore,false);assert.ok(!first.documents.some(d=>d.path.endsWith('content-00.md')));
  assert.equal((await f.api('search?q=PRIVATE_AFTER_CACHE')).total,0);
});
test('recovery discovers own disk drafts after renderer loss, preserves original pending IDs and marks stale/missing files',async()=>{
  const f=await fixture(),doc=await f.api('document?path=docs/plans/existing.md'),operationId=randomUUID(),draftId=randomUUID();
  await f.api('draft/write',{path:doc.path,draftId,expectedDraftRevision:null,baseSource:doc.source,baseRevision:doc.revision,source:doc.source.replace('Original','Preserved draft'),pendingOperation:{operationId,kind:'save',expectedRevision:doc.revision}});
  const before=readFileSync(path.join(f.root,doc.path),'utf8'),listed=await f.api('recovery');assert.equal(listed.items.length,1);assert.equal(listed.items[0].draftId,draftId);assert.equal(listed.items[0].pendingOperation.operationId,operationId);assert.ok(!JSON.stringify(listed).includes('Preserved draft'));assert.equal(readFileSync(path.join(f.root,doc.path),'utf8'),before);
  writeFileSync(path.join(f.root,doc.path),before.replace('Original','External edit'));assert.equal((await f.api('recovery')).items[0].stale,true);
  rmSync(path.join(f.root,doc.path));assert.equal((await f.api('recovery')).items[0].available,false);
});
test('recovery excludes other actors and corrupt state is retained for inspection',async()=>{
  const f=await fixture(),file=path.join(f.root,'docs/plans/existing.md'),foreign={kind:'human',id:'human:other'};
  const editor=createSourceEditor({config:f.config,authenticate:()=>foreign,authorize:()=>({allowed:true})});editor.putDraft({}, {path:file,draftId:randomUUID(),expectedDraftRevision:null,baseSource:original,baseRevision:sourceRevision(original),source:original.replace('Original','Other human draft')});
  assert.equal((await f.api('recovery')).items.length,0);
  const own=await f.api('draft/write',{path:'docs/plans/existing.md',draftId:randomUUID(),expectedDraftRevision:null,baseSource:original,baseRevision:sourceRevision(original),source:original.replace('Original','Own draft')});
  const dirs=readdirSync(path.join(f.root,'.runlist/editor/drafts'));const draftFile=dirs.map(dir=>path.join(f.root,'.runlist/editor/drafts',dir,own.id+'.json')).find(existsSync);writeFileSync(draftFile,'{bad json');
  const result=await f.api('recovery');assert.equal(result.unavailable,1);assert.equal(readFileSync(draftFile,'utf8'),'{bad json');
});
test('creation preserves the Git private-state guard and never changes ignore/index rules',async()=>{
  const f=await fixture();execFileSync('git',['init','-q',f.root]);await assert.rejects(f.api('create/preview',request()),{code:'unsafe-local-state'});
  assert.equal(existsSync(path.join(f.root,'.gitignore')),false);writeFileSync(path.join(f.root,'.gitignore'),'.runlist/\n');const review=await f.api('create/preview',request());await f.api('create/commit',{operationId:review.operationId});assert.equal(execFileSync('git',['-C',f.root,'ls-files'],{encoding:'utf8'}),'');
});
