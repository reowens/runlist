import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {resolveConfig} from '../src/config.mjs';
import {createCheckoutService} from '../src/app-service.mjs';
const roots=[],services=[],actor={kind:'human',id:'human:integration-owner'};
afterEach(()=>{for(const service of services.splice(0))service.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture(){
 const root=mkdtempSync(path.join(tmpdir(),'runlist-goal-filing-'));roots.push(root);
 mkdirSync(path.join(root,'docs/plans'),{recursive:true});mkdirSync(path.join(root,'docs/prompts'));
 writeFileSync(path.join(root,'runlist.config.mjs'),"export const root='docs';\nexport const yardstick='docs/goal.md';\nexport const filing=true;\n");
 writeFileSync(path.join(root,'docs/goal.md'),'# Goal\n\nKeep project documents useful.\n');
 writeFileSync(path.join(root,'docs/plans/plan.md'),'---\ntype: plan\nstatus: active\ndelivers: Find useful documents.\n---\n# Plan\n\nPlan body.\n');
 writeFileSync(path.join(root,'docs/hub.md'),'---\ntype: plan\nstatus: active\nexecution_mode: coordination\n---\n# Hub\n\n### Delivery\n\n| Plan | Status |\n|---|---|\n| [Plan](plans/plan.md) | active |\n');
 writeFileSync(path.join(root,'docs/prompts/private.md'),'---\ntype: prompt\nstatus: pending\n---\nSECRET_INTEGRATION_PROMPT\n');
 const service=createCheckoutService({config:await resolveConfig(root),actor,authenticate:req=>req.actor??actor});services.push(service);
 const api=(route,body,who=actor)=>service.request({method:body===undefined?'GET':'POST',actor:who},'/api/'+route,body);
 const scan=async()=>{let result=await api('filing?op=start&refresh=1');while(result.state==='scanning')result=await api('filing?op=advance&scanId='+result.scanId);return result;};
 return {root,api,scan};
}
test('authenticated shared routes record assessment, recover review and invalidate filing after writes',async()=>{
 const f=await fixture();assert.equal((await f.api('filing?op=status')).state,'idle');
 const original=await f.scan();assert.equal(original.complete,true);assert.equal(original.totals.filedDirect,1);
 const doc=await f.api('document?path=docs/plans/plan.md'),info=await f.api('yardstick?path='+doc.path);assert.equal(info.enabled,true);assert.equal(info.comparison.delivers,'Find useful documents.');
 const review=await f.api('yardstick/preview',{path:doc.path,action:'serves',reason:'Owner decision.',expectedRevision:doc.revision,operationId:randomUUID()});
 const retained=await f.api('recovery');assert.ok(retained.items.some(row=>row.kind==='yardstick'&&row.operationId===review.operationId));assert.ok(!JSON.stringify(retained).includes('SECRET_INTEGRATION_PROMPT'));
 const result=await f.api('yardstick/commit',{operationId:review.operationId});assert.equal(result.state,'committed');assert.match(readFileSync(path.join(f.root,doc.path),'utf8'),/yardstick_disposition: "serves"/);
 assert.equal((await f.api('filing?op=status')).state,'idle');assert.equal((await f.api('yardstick/commit',{operationId:review.operationId})).replayed,true);
 const fresh=await f.api('document?path='+doc.path);const report=await f.scan();
 await f.api('save',{path:doc.path,source:fresh.source.replace('Plan body.','New body.'),expectedRevision:fresh.revision,operationId:randomUUID()});
 await assert.rejects(f.api('filing?op=page&scanId='+report.scanId),{code:'filing-scan-stale'});
});
test('retained drafts block assessments until discarded; private and forged routes stay inaccessible',async()=>{
 const f=await fixture(),doc=await f.api('document?path=docs/plans/plan.md');
 const draft=await f.api('draft/write',{path:doc.path,draftId:randomUUID(),baseRevision:doc.revision,baseSource:doc.source,source:doc.source+'Unsaved.',expectedDraftRevision:null});
 const info=await f.api('yardstick?path='+doc.path);assert.equal(info.enabled,false);assert.match(info.reason,/draft/);
 await assert.rejects(f.api('yardstick/preview',{path:doc.path,action:'close',reason:'Done.',expectedRevision:doc.revision,operationId:randomUUID()}),{code:'draft-pending'});
 await f.api('draft/discard',{path:doc.path,draftId:draft.id,expectedDraftRevision:draft.revision});assert.equal((await f.api('yardstick?path='+doc.path)).enabled,true);
 for(const route of ['filing?op=start','yardstick?path='+doc.path])await assert.rejects(f.api(route,undefined,{kind:'human',id:'human:other'}),{code:'forbidden'});
 await assert.rejects(f.api('yardstick/preview',{path:doc.path,actor,action:'serves',expectedRevision:doc.revision,operationId:randomUUID()}),{code:'forbidden'});
 await assert.rejects(f.api('yardstick?path=docs/prompts/private.md'));
});
test('filing details retain observed evidence but mark changed source instead of highlighting stale rows',async()=>{
 const f=await fixture(),scan=await f.scan();writeFileSync(path.join(f.root,'docs/hub.md'),readFileSync(path.join(f.root,'docs/hub.md'),'utf8')+'Changed since report.\n');
 const detail=await f.api('filing?'+new URLSearchParams({op:'detail',scanId:scan.scanId,path:'docs/plans/plan.md'}));
 assert.equal(detail.homes[0].current,'changed');assert.ok(detail.homes[0].line>0);assert.ok(detail.homes[0].revision);
});
test('interrupted yardstick receipts block ordinary editor and lifecycle writes until inspected',async()=>{
 const f=await fixture(),doc=await f.api('document?path=docs/plans/plan.md');
 const review=await f.api('yardstick/preview',{path:doc.path,action:'serves',expectedRevision:doc.revision,operationId:randomUUID()});
 const file=path.join(f.root,'.runlist/editor/yardstick',review.operationId+'.json'),receipt=JSON.parse(readFileSync(file,'utf8'));receipt.state='running';writeFileSync(file,JSON.stringify(receipt));
 for(const [route,body] of [['save',{path:doc.path,source:doc.source+'Changed',expectedRevision:doc.revision,operationId:randomUUID()}],['lifecycle/preview',{path:doc.path,status:'partial',note:'Changed',expectedRevision:doc.revision,operationId:randomUUID()}]])await assert.rejects(f.api(route,body),{code:'yardstick-repair-required'});
 assert.equal(readFileSync(path.join(f.root,doc.path),'utf8'),doc.source);assert.equal((await f.api('yardstick/inspect',{operationId:review.operationId})).state,'running');
});
