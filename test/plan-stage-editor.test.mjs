import {afterEach, test} from 'node:test';
import {deepStrictEqual, strictEqual, throws} from 'node:assert';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createSourceEditor, sourceRevision} from '../src/source-editor.mjs';
import {createCheckoutService} from '../src/app-service.mjs';
import {resolveConfig} from '../src/config.mjs';
import {readShipsFrontmatter, readPlanStage} from '../src/stages.mjs';
import {extractFrontmatter} from '../src/frontmatter.mjs';
import {readSourceStage, replaceSourceStage, rebaseSourceStage, withoutSourceStage} from '../assets/app/stage-source.mjs';

const source='---\ntype: plan\nstatus: active\ncustom: preserved\n---\n# Plan\n\nOriginal body.\n\n## Version History\n\n- Existing history.\n';
const actor={kind:'human',id:'human:stage-fixture'},temporary=[];
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
afterEach(()=>{for(const root of temporary.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(before=source,milestones=['beta','later']) {
  const root=mkdtempSync(path.join(os.tmpdir(),'runlist-stage-save-'));temporary.push(root);mkdirSync(path.join(root,'docs'));
  const file=path.join(root,'docs/plan.md');writeFileSync(file,before);
  const config={repoRoot:root,docsRoot:path.join(root,'docs'),taxonomy:{milestones}};
  const make=extra=>createSourceEditor({config,authenticate:()=>actor,authorize:()=>({allowed:true}),allowStageEdits:true,...extra});
  return {root,file,before,config,editor:make(),make,request:(after,n=1)=>({path:file,source:after,expectedRevision:sourceRevision(before),operationId:id(n)})};
}

test('stage draft preserves CRLF, body, comments and unrelated metadata',()=>{
  const before=source.replace('custom: preserved','ships: >-\n  first\n\n  customers\n# Keep this comment\ncustom: preserved').replaceAll('\n','\r\n');
  const after=replaceSourceStage(before,'beta');
  strictEqual(withoutSourceStage(before),withoutSourceStage(after));
  strictEqual(after.includes('ships: "beta"\r\n# Keep this comment'),true);
  deepStrictEqual(readSourceStage(before),{word:null,invalid:true});
  strictEqual(readSourceStage(after).word,'beta');
  strictEqual(replaceSourceStage(after,null),withoutSourceStage(before));
});

test('browser stage reader agrees with indexed values for supported scalar forms',()=>{
  for(const field of ['', 'ships:\n', 'ships:\n  # not assigned\n', 'ships: ""\n', 'ships: beta\n','ships: "true"\n','ships: true\n','ships: []\n','ships:\n  - beta\n', 'ships: "phase: #1"\n','ships: >-\n  first\n  customers\n', 'ships: >-\n  first\n\n  customers\n','ships: >+\n  beta\n']) {
    const value=source.replace('custom: preserved\n',field+'custom: preserved\n');
    deepStrictEqual(readSourceStage(value),readPlanStage(readShipsFrontmatter(extractFrontmatter(value).frontmatter)));
  }
});

test('trusted stage saves retain normal source review, retry and undo receipts',()=>{
  const f=fixture(),after=replaceSourceStage(source,'beta').replace('Original body','Reviewed body');
  const request=f.request(after),result=f.editor.save({},request);
  strictEqual(result.state,'committed');strictEqual(readFileSync(f.file,'utf8'),after);
  strictEqual(f.editor.save({},request).replayed,true);
  const undo=f.editor.undo({},{path:f.file,operationId:id(2),expectedRevision:result.revision,undoOf:result.operationId});
  strictEqual(undo.state,'committed');strictEqual(readFileSync(f.file,'utf8'),source);
});

test('stage permission cannot change status, other metadata, history or other document types',()=>{
  const f=fixture(),after=replaceSourceStage(source,'beta');
  for(const candidate of [after.replace('status: active','status: archived'),after.replace('custom: preserved','custom: changed'),after.replace('Existing history.','Rewritten history.'),after.replace('---\ntype:','type:')]) {
    throws(()=>f.editor.save({},f.request(candidate)),e=>e.code==='managed-fields');
  }
  throws(()=>f.make({allowStageEdits:false}).save({},f.request(after)),e=>e.code==='managed-fields');
  const doc=fixture(source.replace('type: plan','type: doc'));
  throws(()=>doc.make({legacyTypes:['doc']}).save({},doc.request(replaceSourceStage(doc.before,'beta'))),e=>e.code==='managed-fields');
  strictEqual(readFileSync(f.file,'utf8'),source);
});

test('unknown or invalid selections cannot save, while undo restores the exact prior unknown value',()=>{
  const f=fixture(replaceSourceStage(source,'old-stage'));
  throws(()=>f.editor.save({},f.request(replaceSourceStage(f.before,'unknown'))),e=>e.code==='invalid-stage');
  throws(()=>f.editor.save({},f.request(f.before.replace('"old-stage"','[beta]'))),e=>e.code==='invalid-stage');
  const result=f.editor.save({},f.request(replaceSourceStage(f.before,'beta')));
  f.editor.undo({},{path:f.file,operationId:id(2),expectedRevision:result.revision,undoOf:result.operationId});
  strictEqual(readFileSync(f.file,'utf8'),f.before);
});

test('stage draft survives disk recovery and refuses an intervening file edit',()=>{
  const f=fixture(),after=replaceSourceStage(source,'later');
  f.editor.putDraft({},{path:f.file,draftId:id(3),expectedDraftRevision:null,baseRevision:sourceRevision(source),baseSource:source,source:after});
  strictEqual(f.make().readDraft({},{path:f.file,draftId:id(3)}).source,after);
  writeFileSync(f.file,source.replace('Original body','Other writer'));
  throws(()=>f.editor.save({},f.request(after)),e=>e.code==='revision-conflict');
});

test('conflict merge applies the drafted stage while retaining newly refreshed metadata',()=>{
  const draft=replaceSourceStage(source,'beta'),current=source.replace('status: active','status: blocked').replace('custom: preserved','custom: refreshed');
  strictEqual(rebaseSourceStage(source,draft,current),replaceSourceStage(current,'beta'));
  strictEqual(rebaseSourceStage(source,source,current),current);
});

test('checkout service saves stage and refreshes Library metadata through the existing route',async()=>{
  const f=fixture();writeFileSync(path.join(f.root,'runlist.config.mjs'),"export const root='docs'; export const taxonomy={milestones:[{word:'beta',meaning:'First customers'},'later']};\n");
  const config=await resolveConfig(f.root),service=createCheckoutService({config,actor});
  try {
    const opened=await service.request({method:'GET'},'/api/document?path=docs/plan.md');
    strictEqual(opened.stageDefinitions[0].meaning,'First customers');
    await service.request({method:'GET'},'/api/library?kind=plans');
    const saved=await service.request({method:'POST'},'/api/save',f.request(replaceSourceStage(source,'beta')));
    strictEqual(saved.state,'committed');
    const library=await service.request({method:'GET'},'/api/library?kind=plans&stage=word:beta');
    strictEqual(library.documents.length,1);strictEqual(library.documents[0].stage,'beta');
  } finally {await service.close();}
});
