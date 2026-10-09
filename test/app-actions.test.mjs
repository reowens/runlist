import {it,afterEach} from 'node:test';
import {strictEqual,ok,match,deepStrictEqual} from 'node:assert';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,symlinkSync,readdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';import {spawnSync} from 'node:child_process';import os from 'node:os';import path from 'node:path';
import {startApp} from '../src/app.mjs';import {resolveConfig} from '../src/config.mjs';import {sourceRevision} from '../src/source-editor.mjs';import {parseNativeRecord} from '../src/native-record.mjs';
import {preparePlanClaim} from '../src/pickup.mjs';import {mutateFileSet} from '../src/atomic-mutation.mjs';
import {nativeFixture,nativeSource,owner,recordId} from './native-fixtures.mjs';
import {createAppLifecycle} from '../src/app-lifecycle.mjs';
import {setTimeout as pause} from 'node:timers/promises';
const dirs=[],apps=[],bin=path.resolve(import.meta.dirname,'../bin/runlist.mjs');
afterEach(async()=>{for(const app of apps.splice(0))await app.close();for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const plan='---\ntype: plan\nstatus: active\nupdated: 2026-10-05T00:00:00Z\ncustom: retained\n---\n# Fixture plan\n\n## Work\n\nOriginal context.\n\n## Version History\n\n- Earlier entry.\n';
async function fixture(configSource="export const root='docs';\n"){
  const repo=mkdtempSync(path.join(os.tmpdir(),'runlist-app-actions-'));dirs.push(repo);for(const dir of ['docs/plans','docs/decisions','docs/flags','docs/prompts'])mkdirSync(path.join(repo,dir),{recursive:true});
  const file=path.join(repo,'docs/plans/fixture.md');writeFileSync(file,plan);writeFileSync(path.join(repo,'runlist.config.mjs'),configSource);writeFileSync(path.join(repo,'docs/plans/hub.md'),'---\ntype: plan\nstatus: active\nexecution_mode: coordination\nrunlist: [fixture.md]\n---\n# Hub\n\n[Work](fixture.md)\n');
  writeFileSync(path.join(repo,'docs/decisions/native.md'),nativeSource());writeFileSync(path.join(repo,'docs/flags/native.md'),nativeSource(nativeFixture('flag')));writeFileSync(path.join(repo,'docs/prompts/private.md'),'---\ntype: prompt\nstatus: pending\n---\nPRIVATE CONTENT\n');
  const config=await resolveConfig(repo),app=await startApp({config,port:0,actor:owner});apps.push(app);const token=new URLSearchParams(new URL(app.launchUrl).hash.slice(1)).get('connect');
  const response=await fetch(app.origin+'/api/session',{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({token})}),cookie=response.headers.get('set-cookie').split(';')[0],session=await response.json();
  const call=async(route,body,headers={})=>{const res=await fetch(app.origin+'/api/'+route,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'application/json','X-Runlist-CSRF':session.csrf,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:res.status,value:await res.json()};};
  const review=async(status='blocked',extra={})=>call('lifecycle/preview',{path:'docs/plans/fixture.md',expectedRevision:sourceRevision(plan),operationId:randomUUID(),status,note:'Need more evidence.',...extra});
  return {repo,file,config,app,call,review};
}
it('reviews native actions without writes and commits exact human-attributed source with retry-safe history',async()=>{
  const f=await fixture(),file=path.join(f.repo,'docs/decisions/native.md'),before=readFileSync(file,'utf8');
  const req={path:'docs/decisions/native.md',expectedRevision:sourceRevision(before),operationId:randomUUID(),action:'ruled',optionId:recordId('option',4),note:'Fits the shelf.',actor:{kind:'agent',id:'forged'}};
  strictEqual((await f.call('native/preview',req,{'X-Runlist-CSRF':''})).status,403);strictEqual((await f.call('native/preview',req)).status,403);strictEqual(readFileSync(file,'utf8'),before);delete req.actor;const preview=await f.call('native/preview',req);strictEqual(preview.status,200,JSON.stringify(preview));strictEqual(readFileSync(file,'utf8'),before);
  strictEqual((await f.call('native/action',{...preview.value.request,source:preview.value.request.source+'Tampered.'})).value.code,'review-conflict');
  const saved=await f.call('native/action',preview.value.request);strictEqual(saved.status,200,JSON.stringify(saved));strictEqual((await f.call('native/action',preview.value.request)).value.replayed,true);
  const record=parseNativeRecord(readFileSync(file,'utf8'));strictEqual(record.ok,true);strictEqual(record.record.record_data.rulings.length,1);strictEqual(record.record.record_data.rulings[0].by.id,owner.id);
  const rows=(await f.call('records?kind=decisions&status=ruled')).value.records;strictEqual(rows[0].key,record.record.id);strictEqual((await f.call('native/preview',{...req,operationId:randomUUID()})).value.code,'revision-conflict');
  const cli=spawnSync(process.execPath,[bin,'show','docs/decisions/native.md','--json'],{cwd:f.repo,encoding:'utf8'});strictEqual(cli.status,0,cli.stderr);ok(cli.stdout.includes('ruled'));
});
it('lists duplicate native identities separately and explains their read-only state',async()=>{
  const f=await fixture();writeFileSync(path.join(f.repo,'docs/decisions/duplicate.md'),nativeSource());const rows=(await f.call('records?kind=decisions&refresh=1')).value.records;strictEqual(rows.length,2);ok(rows[0].key!==rows[1].key);
  for(const row of rows){const detail=(await f.call('records?'+new URLSearchParams({kind:'decisions',key:row.key}))).value;strictEqual(detail.editable,false);match(detail.readOnlyReason,/multiple documents/);}
});
it('shares native CLI preparation, dry-run and actor authority without altering legacy registers',async()=>{
  const f=await fixture(),file=path.join(f.repo,'docs/decisions/native.md'),before=readFileSync(file,'utf8'),env={...process.env};for(const key of Object.keys(env))if(/SESSION|^CODEX_|^OPENCODE_/.test(key))delete env[key];
  const args=['record','docs/decisions/native.md','ruled','--option',recordId('option',5),'--note','Fits the work.'];
  const dry=spawnSync(process.execPath,[bin,...args,'--dry-run'],{cwd:f.repo,env,encoding:'utf8'});strictEqual(dry.status,0,dry.stderr);strictEqual(parseNativeRecord(dry.stdout).record.status,'ruled');strictEqual(readFileSync(file,'utf8'),before);strictEqual(existsSync(path.join(f.repo,'.runlist/editor')),false);
  const agent=spawnSync(process.execPath,[bin,...args],{cwd:f.repo,env:{...env,RUNLIST_SESSION_ID:'fixture-agent'},encoding:'utf8'});ok(agent.status!==0);match(agent.stderr,/human/);
  const saved=spawnSync(process.execPath,[bin,...args,'--json'],{cwd:f.repo,env,encoding:'utf8'});strictEqual(saved.status,0,saved.stderr);strictEqual(JSON.parse(saved.stdout).actor.kind,'human');strictEqual(parseNativeRecord(readFileSync(file,'utf8')).record.record_data.rulings[0].option_id,recordId('option',5));
});
it('reviews configured lifecycle rules and commits through the CLI engine without borrowed session identity',async()=>{
  const f=await fixture(),info=await f.call('lifecycle?path=docs/plans/fixture.md');strictEqual(info.value.enabled,true);ok(info.value.statuses.includes('blocked'));ok(!info.value.statuses.includes('in-session'));
  const review=await f.review();strictEqual(review.status,200,JSON.stringify(review));strictEqual(readFileSync(f.file,'utf8'),plan);strictEqual(review.value.state,'reviewed');
  const request={operationId:review.value.operationId};strictEqual((await f.call('lifecycle/commit',{...request,actor:{kind:'agent',id:'forged'}})).status,403);strictEqual(readFileSync(f.file,'utf8'),plan);const saved=await f.call('lifecycle/commit',request);strictEqual(saved.status,200,JSON.stringify(saved));strictEqual(saved.value.state,'committed');
  const source=readFileSync(f.file,'utf8');match(source,/status: blocked/);ok(source.includes('Fixture owner (human)'));ok(source.includes('Earlier entry.'));ok(source.includes('custom: retained'));
  strictEqual((await f.call('lifecycle/commit',request)).value.replayed,true);strictEqual(readFileSync(f.file,'utf8'),source);strictEqual((await f.call('lifecycle/inspect',request)).value.current.status,'blocked');
});
it('chooses lifecycle status rules from the deepest document root without matching a sibling prefix',async()=>{
  const f=await fixture("export const root=['docs','docs/team','docs-other'];\nexport const statuses={rootStatuses:{'docs/team':['team-ready'],'docs-other':['other-ready']}};\n");
  for(const directory of ['docs/team','docs-other'])mkdirSync(path.join(f.repo,directory),{recursive:true});
  for(const file of ['docs/team/fixture.md','docs-other/fixture.md'])writeFileSync(path.join(f.repo,file),plan);
  // Exercise per-root fallback without the configured type-specific statuses,
  // which intentionally take precedence over root settings.
  const config={...f.config,typeStatuses:new Map()};
  const read=(_,input)=>({path:input,type:'plan',editable:true,status:'active'});
  const lifecycle=createAppLifecycle({config,read,actor:()=>owner});
  const team=lifecycle.information({},'docs/team/fixture.md');
  const other=lifecycle.information({},'docs-other/fixture.md');
  const primary=lifecycle.information({},'docs/plans/fixture.md');
  ok(team.statuses.includes('team-ready'));ok(!team.statuses.includes('other-ready'));
  ok(other.statuses.includes('other-ready'));ok(!other.statuses.includes('team-ready'));
  ok(!primary.statuses.includes('team-ready'));ok(!primary.statuses.includes('other-ready'));
});
it('archives and restores documents with reviewed destination, repaired references and retained history',async()=>{
  const f=await fixture(),review=await f.review('archived');strictEqual(review.status,200,JSON.stringify(review));ok(review.value.newPath.includes('archived'));
  const saved=await f.call('lifecycle/commit',{operationId:review.value.operationId});strictEqual(saved.status,200,JSON.stringify(saved));strictEqual(existsSync(f.file),false);
  const moved=path.join(f.repo,saved.value.newPath),source=readFileSync(moved,'utf8'),hub=readFileSync(path.join(f.repo,'docs/plans/hub.md'),'utf8');match(source,/status: archived/);ok(!hub.includes('[Work](fixture.md)'));ok(!hub.includes('runlist: [fixture.md]'));
  const back=await f.review('active',{path:saved.value.newPath,expectedRevision:sourceRevision(source)});strictEqual(back.status,200,JSON.stringify(back));strictEqual(back.value.newPath,'docs/fixture.md');strictEqual((await f.call('lifecycle/commit',{operationId:back.value.operationId})).status,200);ok(readFileSync(path.join(f.repo,back.value.newPath),'utf8').includes('Earlier entry.'));strictEqual((await f.call('lifecycle/commit',{operationId:review.value.operationId})).value.replayed,true);
});
it('refuses stale source, changed config, claimed sources, prompts and unreviewed or unsupported lifecycle actions',async()=>{
  const f=await fixture();strictEqual((await f.review('in-session')).value.code,'invalid-status');strictEqual((await f.review('bogus')).value.code,'invalid-status');strictEqual((await f.call('lifecycle/commit',{operationId:randomUUID()})).value.code,'operation-missing');strictEqual((await f.review('blocked',{path:'docs/prompts/private.md'})).status,400);strictEqual((await f.review('blocked',{path:'docs/decisions/native.md'})).value.code,'lifecycle-unavailable');
  const stale=await f.review();writeFileSync(f.file,plan+'\nExternal edit.\n');strictEqual((await f.call('lifecycle/commit',{operationId:stale.value.operationId})).value.code,'revision-conflict');strictEqual((await f.call('lifecycle/inspect',{operationId:stale.value.operationId})).value.state,'reviewed');
  writeFileSync(f.file,plan);const configReview=await f.review();writeFileSync(path.join(f.repo,'runlist.config.mjs'),"export const root='docs';\n// changed configuration\n");const result=await f.call('lifecycle/commit',{operationId:configReview.value.operationId});ok(result.status!==200,JSON.stringify(result));strictEqual(readFileSync(f.file,'utf8'),plan);strictEqual((await f.call('lifecycle/inspect',{operationId:configReview.value.operationId})).value.state,'failed');
  const claimed=await f.review(),claim=preparePlanClaim({filePath:f.file,sourceContent:plan,renderedContent:null,ownership:null,sessionId:'fixture-agent',now:'2026-10-05T00:00:00Z',config:f.config});mutateFileSet(claim,{repoRoot:f.repo});strictEqual((await f.call('lifecycle/commit',{operationId:claimed.value.operationId})).value.code,'claim-conflict');strictEqual((await f.call('lifecycle?path=docs/plans/fixture.md')).value.enabled,false);strictEqual(readFileSync(f.file,'utf8'),plan);
});
it('refuses destination drift and retains uncertain operations without replaying or starting another change',async()=>{
  const f=await fixture(),review=await f.review('archived');mkdirSync(path.dirname(path.join(f.repo,review.value.newPath)),{recursive:true});writeFileSync(path.join(f.repo,review.value.newPath),'Existing destination');
  const result=await f.call('lifecycle/commit',{operationId:review.value.operationId});ok(result.status!==200,JSON.stringify(result));strictEqual(readFileSync(f.file,'utf8'),plan);strictEqual(readFileSync(path.join(f.repo,review.value.newPath),'utf8'),'Existing destination');
  const pending=await f.review();strictEqual(pending.status,200);const receipt=path.join(f.repo,'.runlist/editor/lifecycle',pending.value.operationId+'.json'),job=JSON.parse(readFileSync(receipt,'utf8'));job.state='running';writeFileSync(receipt,JSON.stringify(job));
  strictEqual((await f.call('lifecycle/commit',{operationId:job.id})).value.code,'lifecycle-repair-required');strictEqual((await f.review()).value.code,'lifecycle-repair-required');strictEqual((await f.call('lifecycle/inspect',{operationId:job.id})).value.state,'running');strictEqual(readFileSync(f.file,'utf8'),plan);
  strictEqual((await f.call('lifecycle/settle',{operationId:job.id,expectedRevision:'sha256:'+'0'.repeat(64),note:'Inspected source.'})).value.code,'revision-conflict');
  const settlement={operationId:job.id,expectedRevision:sourceRevision(plan),note:'Inspected the unchanged source and found no retained CLI transactions.'};strictEqual((await f.call('lifecycle/settle',{...settlement,actor:{kind:'agent',id:'forged'}})).status,403);strictEqual((await f.call('lifecycle/inspect',{operationId:job.id})).value.state,'running');const settled=await f.call('lifecycle/settle',settlement);strictEqual(settled.status,200,JSON.stringify(settled));strictEqual(settled.value.state,'settled-unknown');strictEqual(settled.value.settlement.by.id,owner.id);strictEqual(readFileSync(f.file,'utf8'),plan);
  strictEqual((await f.call('lifecycle/commit',{operationId:job.id})).value.code,'lifecycle-settled');strictEqual((await f.review()).status,200);
});
it('protects private lifecycle receipts and shows effective checkout settings without prompt content',async()=>{
  const f=await fixture("export const root='docs';\nexport const types={plan:{statuses:{active:{context:'expanded'},parked:{context:'listed'},archived:{archive:true,terminal:true}}}};\n");
  const settings=await f.call('settings');strictEqual(settings.status,200);deepStrictEqual(settings.value.roots,['docs']);deepStrictEqual(settings.value.statuses.byType.plan.map(s=>s.name),['active','parked','archived']);strictEqual(settings.value.statuses.byType.plan[2].archive,true);ok(!JSON.stringify(settings.value).includes('PRIVATE CONTENT'));strictEqual((await f.call('lifecycle?path=docs/plans/fixture.md')).value.statuses.includes('blocked'),false);
  const review=await f.review('parked');strictEqual(review.status,200,JSON.stringify(review));const receipt=path.join(f.repo,'.runlist/editor/lifecycle',review.value.operationId+'.json');writeFileSync(receipt,'corrupt');strictEqual((await f.call('lifecycle/commit',{operationId:review.value.operationId})).value.code,'state-corrupt');strictEqual(readFileSync(f.file,'utf8'),plan);
  const outside=mkdtempSync(path.join(os.tmpdir(),'runlist-lifecycle-outside-'));dirs.push(outside);rmSync(path.join(f.repo,'.runlist/editor/lifecycle'),{recursive:true});symlinkSync(outside,path.join(f.repo,'.runlist/editor/lifecycle'));strictEqual((await f.review('parked')).status,400);strictEqual(readdirSync(outside).length,0);
});
it('cannot acknowledge a lifecycle runner while its configured hook is still active',async()=>{
  const f=await fixture("import {writeFileSync,existsSync} from 'node:fs';\nexport const root='docs';\nexport function onStatusChange(){writeFileSync(new URL('runner-active',import.meta.url),'active');const until=Date.now()+10000;while(!existsSync(new URL('runner-release',import.meta.url))&&Date.now()<until)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,25);}\n");
  const review=await f.review(),committing=f.call('lifecycle/commit',{operationId:review.value.operationId});
  try {
  for(let i=0;i<500&&!existsSync(path.join(f.repo,'runner-active'));i++)await pause(10);
  ok(existsSync(path.join(f.repo,'runner-active')),'The configured hook started.');
  const inspected=await f.call('lifecycle/inspect',{operationId:review.value.operationId});strictEqual(inspected.value.state,'running');strictEqual(inspected.value.canAcknowledge,false);
  strictEqual((await f.call('lifecycle/settle',{operationId:review.value.operationId,expectedRevision:inspected.value.current.revision,note:'The runner is still active.'})).value.code,'operation-running');
  } finally {writeFileSync(path.join(f.repo,'runner-release'),'done');strictEqual((await committing).status,200);}
  strictEqual((await f.call('lifecycle/inspect',{operationId:review.value.operationId})).value.state,'committed');
});
