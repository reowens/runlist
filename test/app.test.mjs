import { afterEach, describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { startApp } from '../src/app.mjs';
import { resolveConfig } from '../src/config.mjs';
import { sourceRevision } from '../src/source-editor.mjs';
import { appTemplates } from '../src/new.mjs';
import { symlinkSync } from 'node:fs';
import { editedSource, lineDiff, markdownHtml, splitSource } from '../assets/app/shared.mjs';
import { mutateFileSet } from '../src/atomic-mutation.mjs';
import { preparePlanClaim } from '../src/pickup.mjs';

const bin = path.resolve(import.meta.dirname,'../bin/runlist.mjs');
const packageVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const raw = '---\ntype: plan\nstatus: active\nupdated: 2026-10-05T00:00:00Z\ncustom: preserved\n---\n# Existing fixture plan\n\nOriginal paragraph.\n\nRelated flag F1 and `src/fixture.mjs`.\n\n| A | B |\n| --- | --- |\n| one | two |\n\n```js\nconst example = "**literal**";\n```\n\n<!-- unknown block -->\n\n## Version History\n\n- Existing history.\n';
const dirs = [], apps = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });
async function fixture(source = raw) {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(),'runlist-app-')); dirs.push(repoRoot);
  mkdirSync(path.join(repoRoot,'docs/plans'),{recursive:true}); mkdirSync(path.join(repoRoot,'docs/prompts')); mkdirSync(path.join(repoRoot,'src')); mkdirSync(path.join(repoRoot,'.runlist'));
  writeFileSync(path.join(repoRoot,'runlist.config.mjs'),"export const root='docs';\n");
  writeFileSync(path.join(repoRoot,'docs/plans/existing.md'),source);
  writeFileSync(path.join(repoRoot,'docs/prompts/private.md'),'---\ntype: prompt\nstatus: pending\n---\nPRIVATE PROMPT BODY\n');
  writeFileSync(path.join(repoRoot,'src/fixture.mjs'),'const observed = false;\nconst observed = true;\n');
  writeFileSync(path.join(repoRoot,'.runlist/flags.jsonl'),JSON.stringify({event:'add',id:'F1',at:'2026-10-05T00:00:00Z',file:'src/fixture.mjs',line:1,quote:'const observed = true;',text:'The original observation is retained.',severity:'warn',by:{kind:'check',name:'fixture'}})+'\n');
  const config = await resolveConfig(repoRoot);
  const app = await startApp({config,port:0,initialPath:'docs/plans/existing.md',actor:{kind:'human',id:'human:fixture',label:'Fixture owner'}}); apps.push(app);
  const token = new URLSearchParams(new URL(app.launchUrl).hash.slice(1)).get('connect');
  const handshake = await fetch(`${app.origin}/api/session`,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({token})});
  strictEqual(handshake.status,200);
  const cookie = handshake.headers.get('set-cookie').split(';')[0], session = await handshake.json();
  const call = async (route, body, overrides = {}) => {
    const response = await fetch(`${app.origin}/api/${route}`,{method:body === undefined ? 'GET':'POST',headers:{Cookie:cookie,Origin:app.origin,'Content-Type':'application/json','X-Runlist-CSRF':session.csrf,...overrides},...(body === undefined ? {}:{body:JSON.stringify(body)})});
    return {status:response.status,value:await response.json()};
  };
  return {repoRoot,config,app,call,cookie,session,file:path.join(repoRoot,'docs/plans/existing.md')};
}

describe('local plan application',()=>{
  it('serves authenticated plan navigation, canonical source and separately retained original/current evidence',async()=>{
    const f=await fixture();
    const response=await fetch(f.app.origin); strictEqual(response.status,200); match(response.headers.get('content-security-policy'),/script-src 'self'/);
    const plans=await f.call('plans'); strictEqual(plans.status,200); strictEqual(plans.value.plans.length,1); strictEqual(plans.value.plans[0].title,'Existing fixture plan');
    ok(!JSON.stringify(plans.value).includes('PRIVATE PROMPT BODY'));
    const document=await f.call('document?path=docs/plans/existing.md'); strictEqual(document.value.source,raw); strictEqual(document.value.revision,sourceRevision(raw));
    strictEqual(document.value.flags[0].original.quote,'const observed = true;'); strictEqual(document.value.flags[0].original.line,1); strictEqual(document.value.flags[0].original.revision,null);
    strictEqual(document.value.flags[0].current.status,'moved'); strictEqual(document.value.flags[0].current.line,2);
    writeFileSync(path.join(f.repoRoot,'src/fixture.mjs'),'const observed = false;\nconst observed = true;\nconst observed = true;\n');
    strictEqual((await f.call('document?path=docs/plans/existing.md')).value.flags[0].current.status,'ambiguous');
  });

  it('rejects missing credentials, foreign origins, missing CSRF, forged identities and non-plan operations',async()=>{
    const f=await fixture();
    strictEqual((await fetch(`${f.app.origin}/api/plans`)).status,401);
    strictEqual((await f.call('plans',undefined,{Origin:'http://untrusted.test'})).status,403);
    const request={path:'docs/plans/existing.md',operationId:randomUUID(),expectedRevision:sourceRevision(raw),source:raw.replace('Original','Saved'),actor:{kind:'agent',id:'forged',session_id:'forged'}};
    strictEqual((await f.call('save',request,{'X-Runlist-CSRF':''})).status,403);
    strictEqual((await f.call('save',request,{Origin:'http://untrusted.test'})).status,403);
    strictEqual((await f.call('save',request)).status,403);
    const {actor:forged,...localRequest}=request;
    strictEqual((await f.call('save',{...localRequest,path:'docs/prompts/private.md'})).status,400);
    strictEqual((await f.call('save',{...localRequest,path:'../escape.md'})).status,400);
    strictEqual((await f.call('save',localRequest)).value.actor.kind,'human');
    strictEqual((await f.call('logout',{})).status,200); strictEqual((await f.call('plans')).status,401);
  });

  it('saves exact reviewed CRLF source, is read by the ordinary CLI, retries idempotently and undoes safely',async()=>{
    const base=raw.replaceAll('\n','\r\n'),f=await fixture(base),source=editedSource(base,splitSource(base).body.replaceAll('\r\n','\n').replace('Original paragraph.','Browser save is visible through the CLI.'));
    const request={path:'docs/plans/existing.md',operationId:randomUUID(),expectedRevision:sourceRevision(base),source};
    const saved=await f.call('save',request); strictEqual(saved.status,200); strictEqual(readFileSync(f.file,'utf8'),source);
    const cli=spawnSync(process.execPath,[bin,'grep','Browser save is visible through the CLI','--body','--json','--all'],{cwd:f.repoRoot,encoding:'utf8'});
    strictEqual(cli.status,0,cli.stderr); ok(cli.stdout.includes('docs/plans/existing.md'),cli.stdout);
    strictEqual((await f.call('save',request)).value.replayed,true);
    const undo=await f.call('undo',{path:request.path,operationId:randomUUID(),undoOf:request.operationId,expectedRevision:saved.value.revision}); strictEqual(undo.status,200); strictEqual(readFileSync(f.file,'utf8'),base);
  });

  it('retains drafts across browser session reconnection and refuses stale file or draft revisions',async()=>{
    const f=await fixture(),document=(await f.call('document?path=docs/plans/existing.md')).value;
    const draft={path:document.path,draftId:randomUUID(),expectedDraftRevision:null,baseSource:document.source,baseRevision:document.revision,source:raw.replace('Original','Draft')};
    const stored=await f.call('draft/write',draft); strictEqual(stored.status,200); strictEqual(readFileSync(f.file,'utf8'),raw);
    strictEqual((await f.call('draft/write',{...draft,source:raw.replace('Original','Stale tab')})).status,409);
    const token=new URLSearchParams(new URL(f.app.launchUrl).hash.slice(1)).get('connect');
    const connection=await fetch(`${f.app.origin}/api/session`,{method:'POST',headers:{Origin:f.app.origin,'Content-Type':'application/json'},body:JSON.stringify({token})});
    const newSession=await connection.json(),newCookie=connection.headers.get('set-cookie').split(';')[0];
    writeFileSync(f.file,raw.replace('Original','Agent edit'));
    const restored=await f.call('draft/read',{path:document.path,draftId:draft.draftId},{Cookie:newCookie,'X-Runlist-CSRF':newSession.csrf}); strictEqual(restored.value.source,draft.source); strictEqual(restored.value.stale,true);
    const conflict=await f.call('save',{path:document.path,operationId:randomUUID(),expectedRevision:document.revision,source:draft.source}); strictEqual(conflict.status,409); strictEqual(conflict.value.code,'revision-conflict'); ok(conflict.value.details.currentSource.includes('Agent edit'));
    strictEqual(readFileSync(f.file,'utf8'),raw.replace('Original','Agent edit'));
  });

  it('shows a claim and rejects a human save without borrowing the launching session',async()=>{
    const f=await fixture(raw.replace('status: active','status: in-session')),source=readFileSync(f.file,'utf8');
    const prepared=preparePlanClaim({filePath:f.file,sourceContent:source,renderedContent:null,ownership:null,sessionId:'fixture-agent-owner',now:'2026-10-05T00:00:00Z',config:f.config}); mutateFileSet(prepared,{repoRoot:f.repoRoot});
    const opened=await f.call('document?path=docs/plans/existing.md'); strictEqual(opened.value.claim.sessionId,'fixture-agent-owner');
    const result=await f.call('save',{path:opened.value.path,operationId:randomUUID(),expectedRevision:opened.value.revision,source:source.replace('Original','Human')}); strictEqual(result.status,409); strictEqual(result.value.code,'claim-conflict'); strictEqual(readFileSync(f.file,'utf8'),source);
  });

  it('homes hubs and documents, follows off-page links and saves configured narratives while keeping untyped sources read-only',async()=>{
    const f=await fixture();mkdirSync(path.join(f.repoRoot,'docs/modules'));const docPath='docs/modules/reference.md',doc='---\ntype: doc\nstatus: active\ncustom: retained\n---\n# Reference document\n\nOriginal reference.\n\n## Version History\n\n- Existing.\n';writeFileSync(path.join(f.repoRoot,docPath),doc);
    writeFileSync(path.join(f.repoRoot,'docs/plans/library-runlist.md'),'---\ntype: plan\nstatus: active\nexecution_mode: coordination\nrunlist: [existing.md]\nrelated_docs: [../modules/reference.md]\n---\n# Library hub\n');writeFileSync(path.join(f.repoRoot,'docs/modules/untyped.md'),'# Untyped source\n\nKeep this readable.\n');
    const result=await f.call('library?refresh=1');strictEqual(result.value.counts.hubs,1);strictEqual(result.value.counts.documents,2);
    const hubs=await f.call('library?kind=hubs');strictEqual(hubs.value.total,1);strictEqual(hubs.value.documents[0].kind,'hub');const hub=(await f.call('document?path=docs/plans/library-runlist.md')).value;strictEqual(hub.relationships.find(r=>r.label==='Related documents').target.path,docPath);strictEqual(hub.relationships.find(r=>r.label==='Hub members').target.path,'docs/plans/existing.md');
    const opened=(await f.call(`document?path=${docPath}`)).value;strictEqual(opened.editable,true);const source=doc.replace('Original reference.','Browser-edited reference.');const saved=await f.call('save',{path:docPath,source,expectedRevision:opened.revision,operationId:randomUUID()});strictEqual(saved.status,200);strictEqual(readFileSync(path.join(f.repoRoot,docPath),'utf8'),source);
    strictEqual((await f.call('link?ref=../modules/reference.md&from=docs/plans/library-runlist.md')).value.path,docPath);const unknown=(await f.call('document?path=docs/modules/untyped.md')).value;strictEqual(unknown.editable,false);strictEqual((await f.call('save',{path:'docs/modules/untyped.md',source:unknown.source+'Changed',expectedRevision:unknown.revision,operationId:randomUUID()})).status,400);
    writeFileSync(path.join(f.repoRoot,'docs/prompts/forged.md'),'---\ntype: plan\nstatus: active\n---\n# Private forged plan\n');strictEqual((await f.call('document?path=docs/prompts/forged.md')).status,403);
  });

  it('edits real templates with CSRF/CAS, uses them in new documents, and resets without changing existing files',async()=>{
    const f=await fixture(),catalog=(await f.call('templates')).value;
    strictEqual(catalog.templates.length,3);strictEqual(catalog.revision,null);
    const plan=catalog.templates.find(t=>t.name==='plan'),source=plan.source.replace('## Goals','## Custom goals');
    strictEqual((await f.call('templates/save',{name:'plan',source,expectedRevision:null},{'X-Runlist-CSRF':''})).status,403);
    strictEqual((await f.call('templates/save',{name:'plan',source:source.replace('{{body}}',''),expectedRevision:null})).status,400);
    const saved=await f.call('templates/save',{name:'plan',source,expectedRevision:null});strictEqual(saved.status,200);
    strictEqual((await f.call('templates/save',{name:'doc',source:catalog.templates[0].source,expectedRevision:null})).status,409);
    strictEqual(readFileSync(f.file,'utf8'),raw);
    const cli=spawnSync(process.execPath,[bin,'new','plan','template-check','--body','Authored body $& must survive.'],{cwd:f.repoRoot,encoding:'utf8'});
    strictEqual(cli.status,0,cli.stderr);const created=readFileSync(path.join(f.repoRoot,'docs/plans/template-check.md'),'utf8');match(created,/## Custom goals/);match(created,/Authored body \$& must survive\./);ok(!created.includes('{{'));
    const authored=spawnSync(process.execPath,[bin,'new','plan','authored-check','--body','## Authored section\n\nWhole document.'],{cwd:f.repoRoot,encoding:'utf8'});strictEqual(authored.status,0,authored.stderr);ok(!readFileSync(path.join(f.repoRoot,'docs/plans/authored-check.md'),'utf8').includes('Custom goals'));
    strictEqual((await f.call('templates/save',{name:'plan',reset:true,expectedRevision:saved.value.revision})).status,200);strictEqual((await f.call('templates')).value.templates.find(t=>t.name==='plan').source,plan.source);
    let revision=(await f.call('templates')).value.revision;
    for(const name of ['doc','prompt']) {
      const source=catalog.templates.find(t=>t.name===name).source.replace('{{body}}','Template-added text. {{body}}');
      const result=await f.call('templates/save',{name,source,expectedRevision:revision});strictEqual(result.status,200);revision=result.value.revision;
      const created=spawnSync(process.execPath,[bin,'new',name,`template-${name}`,'--body','Provided content.'],{cwd:f.repoRoot,encoding:'utf8'});strictEqual(created.status,0,created.stderr);
      const output=readFileSync(path.join(f.repoRoot,name==='prompt'?'docs/prompts/template-prompt.md':'docs/template-doc.md'),'utf8');match(output,/Template-added text\. Provided content\./);ok(!output.includes('{{'));if(name==='prompt')ok(output.split(/\r?\n/).includes(`runlist_version: ${packageVersion}`));
    }

  });

  it('shows repository template code without executing it and rejects unsafe template paths',async()=>{
    const f=await fixture();f.config.raw.templates={plan:{body:()=>{throw new Error('Must not execute during browsing');}},custom:{description:'Custom',body:()=>{throw new Error('Must not execute');}}};
    const catalog=appTemplates(f.config);match(catalog.templates.find(t=>t.name==='plan').configuredSource,/Must not execute/);strictEqual(catalog.templates.find(t=>t.name==='custom').editable,false);
    const target=path.join(f.repoRoot,'outside.json');writeFileSync(target,'{}');symlinkSync(target,path.join(f.repoRoot,'runlist.templates.json'));
    strictEqual((await f.call('templates')).status,400);strictEqual(readFileSync(target,'utf8'),'{}');
  });

  it('advertises app grammar and previews startup without starting a listener',async()=>{
    const f=await fixture();
    const help=spawnSync(process.execPath,[bin,'app','--help'],{cwd:f.repoRoot,encoding:'utf8'}); strictEqual(help.status,0); match(help.stdout,/exact revision check/);
    const preview=spawnSync(process.execPath,[bin,'app','docs/plans/existing.md','--port','5333','--dry-run'],{cwd:f.repoRoot,encoding:'utf8'}); strictEqual(preview.status,0,preview.stderr); match(preview.stdout,/Would open.*127\.0\.0\.1:5333/);
  });
});

describe('app rendering and source fidelity',()=>{
  it('renders headings, lists, tasks, tables and fenced code without executing authored HTML or unsafe links',()=>{
    const html=markdownHtml(raw+'\n- [ ] A task with [a link](https://example.test)\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert)\n[quoted](https://example.test/\"onmouseover=\"x)\n');
    match(html,/<h1>Existing fixture plan<\/h1>/); match(html,/<table>/); match(html,/<pre><code>const example/); match(html,/aria-label="Incomplete"/);
    ok(!html.includes('<script>')); ok(!html.includes('href="javascript:')); ok(!html.includes(' onmouseover=')); match(html,/&lt;script&gt;/); match(html,/\*\*literal\*\*/);
  });
  it('preserves mixed line endings, empty bodies and final-newline changes while changing only edited lines',()=>{
    const base='---\r\ntype: plan\nstatus: active\r\n---\r\nA\r\nB\nC\r\n';
    strictEqual(editedSource(base,'A\nB\nC\n'),base);
    strictEqual(editedSource(base,'A\nEdited\nC\n'),base.replace('B\n','Edited\r\n'));
    strictEqual(editedSource(base,'A\nB\nC'),base.replace(/\r\n$/,''));
    strictEqual(editedSource(base,'A\nB\nC\nExtra\n'),base+'Extra\r\n');
    const empty='---\ntype: plan\n---\n'; strictEqual(editedSource(empty,''),empty);
    const diff=lineDiff('one\ntwo\nthree\n','one\nTWO\nthree\n'); deepStrictEqual(diff.filter(r=>r.kind!=='same').map(r=>[r.kind,r.text]),[['remove','two'],['add','TWO']]);
  });
});
