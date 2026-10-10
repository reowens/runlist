import {it,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,renameSync,unlinkSync,symlinkSync,existsSync,chmodSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {resolveConfig} from '../src/config.mjs';
import {createCheckoutService} from '../src/app-service.mjs';
import {startApp} from '../src/app.mjs';

const roots=[],apps=[];
afterEach(async()=>{for(const app of apps.splice(0))await app.close();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const source=(title,type='doc')=>`---\ntype: ${type}\nstatus: active\n---\n# ${title}\n\nOriginal text.\n`;
function git(root,...args){const p=spawnSync('git',['-c','commit.gpgsign=false','-C',root,...args],{encoding:'utf8',env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:path.join(root,'hooks','empty-git-config'),LANG:'C',LC_ALL:'C'}});assert.equal(p.status,0,p.stderr);return p.stdout;}
async function fixture({initialized=true}={}) {
  const root=mkdtempSync(path.join(os.tmpdir(),'runlist-git-api-'));roots.push(root);
  for(const folder of ['docs/plans','docs/hubs','docs/prompts','docs/evidence','src','hooks'])mkdirSync(path.join(root,folder),{recursive:true});
  writeFileSync(path.join(root,'hooks','empty-git-config'),'');
  writeFileSync(path.join(root,'runlist.config.mjs'),"export const root=['docs/plans','docs']; export const excludeDirs=['evidence'];\n");
  const write=(name,content)=>writeFileSync(path.join(root,name),content);
  write('.gitignore','.runlist/\n.dotmd/\ndocs/local.md\n');write('docs/plans/plan.md',source('Plan','plan'));write('docs/hubs/hub.md',source('Hub','plan'));write('docs/reference.md',source('Reference'));write('docs/remove.md',source('Deleted'));write('docs/rename.md',source('Renamed'));write('docs/prompts/private.md',source('PRIVATE PROMPT','prompt'));write('docs/forged.md',source('FORGED PROMPT','prompt'));write('docs/evidence/private.md',source('EXCLUDED'));write('src/code.mjs','original code\n');
  if(initialized){git(root,'init','-q','-b','main','--template='+path.join(root,'hooks'));git(root,'config','user.name','Runlist Test');git(root,'config','user.email','fixture@invalid.example');git(root,'add','--','.gitignore','runlist.config.mjs','docs','src');git(root,'commit','-qm','fixture');}
  const config=await resolveConfig(root),actor={kind:'human',id:'human:git-fixture'},service=createCheckoutService({config,actor});
  const call=(route,body)=>service.request({method:body===undefined?'GET':'POST'},'/api/'+route,body);
  return {root,write,config,actor,call};
}
it('lists/diffs plans, hubs, docs, deletions and renames without changing HEAD or staging',async()=>{
  const f=await fixture();f.write('src/code.mjs','staged code\n');git(f.root,'add','--','src/code.mjs');f.write('src/code.mjs','unstaged code\n');f.write('docs/plans/plan.md',source('Plan','plan').replace('Original','Saved'));f.write('docs/hubs/hub.md',source('Hub','plan').replace('Original','Saved'));f.write('docs/reference.md',source('Reference').replace('Original','Saved'));f.write('docs/new.md',source('New'));f.write('docs/local.md',source('Private local'));unlinkSync(path.join(f.root,'docs/remove.md'));git(f.root,'mv','--','docs/rename.md','docs/moved.md');unlinkSync(path.join(f.root,'docs/forged.md'));f.write('docs/prompts/private.md','PRIVATE UPDATED');f.write('docs/evidence/private.md','EXCLUDED UPDATED');
  const index=readFileSync(path.join(f.root,'.git/index')),head=git(f.root,'rev-parse','HEAD'),status=await f.call('git/status');
  assert.equal(status.available,true);assert.equal(status.commitEnabled,false);assert.equal(status.unrelatedStaged,1);
  assert.equal(status.changes.find(r=>r.path==='docs/local.md').eligible,false);
  assert.ok(!JSON.stringify(status).includes('FORGED PROMPT'));assert.ok(!status.changes.some(r=>r.path.includes('prompts')||r.path.includes('evidence')||r.path==='docs/forged.md'));
  const rename=status.changes.find(r=>r.path==='docs/moved.md');assert.equal(rename.original,'docs/rename.md');assert.equal(rename.kind,'Renamed');
  for(const row of status.changes){const diff=await f.call('git/diff?'+new URLSearchParams({path:row.path}));assert.equal(diff.commitEnabled,false);assert.equal(diff.change.path,row.path);assert.ok(!diff.before.includes('PRIVATE PROMPT'));}
  assert.deepEqual(readFileSync(path.join(f.root,'.git/index')),index);assert.equal(git(f.root,'rev-parse','HEAD'),head);assert.equal(readFileSync(path.join(f.root,'src/code.mjs'),'utf8'),'unstaged code\n');
});
it('blocks partially staged selections and treats staged saved files as whole-file candidates',async()=>{
  const f=await fixture();f.write('docs/plans/plan.md',source('Staged','plan'));git(f.root,'add','--','docs/plans/plan.md');f.write('docs/plans/plan.md',source('Saved later','plan'));
  const before=readFileSync(path.join(f.root,'.git/index')),row=(await f.call('git/status')).changes.find(r=>r.path==='docs/plans/plan.md');assert.equal(row.partial,true);assert.equal(row.eligible,false);assert.match(row.blockedReason,/partial staging/);
  const diff=await f.call('git/diff?path=docs/plans/plan.md');assert.match(diff.after,/Saved later/);assert.match(diff.before,/# Plan/);assert.deepEqual(readFileSync(path.join(f.root,'.git/index')),before);
});
it('reauthorizes arbitrary diff paths, rename sources, symlinks and historical prompt types',async()=>{
  const f=await fixture();unlinkSync(path.join(f.root,'docs/forged.md'));symlinkSync(path.join(f.root,'src/code.mjs'),path.join(f.root,'docs/link.md'));git(f.root,'mv','--','docs/prompts/private.md','docs/disguised.md');
  for(const file of ['../outside.md','src/code.mjs','docs/prompts/private.md','docs/evidence/private.md','docs/link.md','docs/forged.md','docs/disguised.md','.runlist/receipt.md'])await assert.rejects(f.call('git/diff?'+new URLSearchParams({path:file})),e=>['forbidden','git-review-changed'].includes(e.code));
  const service=createCheckoutService({config:f.config,actor:f.actor,authenticate:()=>({kind:'agent',id:f.actor.id})});await assert.rejects(service.request({method:'GET'},'/api/git/status'),{code:'forbidden'});
  await assert.rejects(f.call('git/status',{actor:f.actor}),{code:'forbidden'});await assert.rejects(f.call('git/commit',{paths:['docs/plans/plan.md']}),{code:'not-found'});
});
it('never runs configured clean filters, fsmonitor, external diff or hooks during inspection',async()=>{
  const f=await fixture();f.write('hooks/trap','#!/bin/sh\ntouch EXECUTED\nexit 1\n');chmodSync(path.join(f.root,'hooks/trap'),0o755);
  git(f.root,'config','core.fsmonitor',path.join(f.root,'hooks/trap'));git(f.root,'config','diff.external',path.join(f.root,'hooks/trap'));git(f.root,'config','core.hooksPath',path.join(f.root,'hooks'));f.write('hooks/pre-commit','#!/bin/sh\ntouch EXECUTED\n');f.write('docs/plans/plan.md',source('Saved','plan'));
  const status=await f.call('git/status');assert.equal(status.available,true);await f.call('git/diff?path=docs/plans/plan.md');assert.equal(existsSync(path.join(f.root,'EXECUTED')),false);
  git(f.root,'config','filter.unrelated.clean','touch EXECUTED');f.write('.gitattributes','src/* filter=unrelated\n');f.write('src/code.mjs','changed code\n');assert.equal((await f.call('git/status')).available,true);assert.equal(existsSync(path.join(f.root,'EXECUTED')),false);
  git(f.root,'config','filter.trap.clean','touch EXECUTED');git(f.root,'config','filter.trap.required','true');f.write('.gitattributes','*.md filter=trap\n');
  const blocked=await f.call('git/status');assert.equal(blocked.available,true);assert.equal(blocked.changes.find(r=>r.path==='docs/plans/plan.md').filterReviewRequired,true);await f.call('git/diff?path=docs/plans/plan.md');assert.equal(existsSync(path.join(f.root,'EXECUTED')),false);
});
it('handles non-Git folders, unborn/detached branches and in-progress operations without repair',async()=>{
  const plain=await fixture({initialized:false});assert.equal((await plain.call('git/status')).code,'not-git');
  git(plain.root,'init','-q','-b','main');const unborn=await plain.call('git/status');assert.match(unborn.reason,/first commit/);assert.ok(unborn.changes.every(r=>!r.eligible));
  const f=await fixture();f.write('docs/reference.md',source('Saved'));git(f.root,'checkout','--detach');const detached=await f.call('git/status');assert.match(detached.reason,/detached/);assert.equal(detached.changes[0].eligible,false);
  git(f.root,'checkout','main');f.write('.git/MERGE_HEAD',git(f.root,'rev-parse','HEAD'));assert.match((await f.call('git/status')).reason,/Finish the current/);
});
it('pages a large corpus and transports literal names without glob selection',async()=>{
  const f=await fixture();for(let i=0;i<230;i++)f.write(`docs/new-${String(i).padStart(3,'0')}.md`,source('New '+i));
  const names=['docs/[a].md','docs/日本語.md'];if(process.platform!=='win32')names.push('docs/:(glob)*.md','docs/new\nline.md');for(const name of names)f.write(name,source(name));
  const first=await f.call('git/status'),second=await f.call('git/status?offset=100');assert.equal(first.changes.length,100);assert.equal(second.changes.length,100);assert.equal(first.total,230+names.length);assert.ok(!second.changes.some(r=>first.changes.some(p=>p.path===r.path)));
  for(const name of names){const diff=await f.call('git/diff?'+new URLSearchParams({path:name}));assert.equal(diff.change.path,name);assert.equal(diff.before,'');}
});
it('isolates linked-worktree indexes and discards inherited Git authority overrides',async()=>{
  const f=await fixture(),work=path.join(f.root,'linked');git(f.root,'worktree','add','-qb','docs-work',work);writeFileSync(path.join(work,'docs/reference.md'),source('Worktree saved'));
  const config=await resolveConfig(work),service=createCheckoutService({config,actor:f.actor}),original=process.env.GIT_DIR;process.env.GIT_DIR=path.join(f.root,'.git');
  try{const result=await service.request({method:'GET'},'/api/git/status');assert.equal(result.branch,'docs-work');assert.equal(result.changes[0].path,'docs/reference.md');}finally{if(original===undefined)delete process.env.GIT_DIR;else process.env.GIT_DIR=original;}
});
it('bounds a 5,000-document status response without retaining document bodies',async()=>{
  const f=await fixture();for(let i=0;i<5000;i++)f.write(`docs/scale-${String(i).padStart(4,'0')}.md`,source('Document '+i)+'PRIVATE BODY MUST NOT BE LISTED\n');
  const response=await f.call('git/status');assert.equal(response.total,5000);assert.equal(response.changes.length,100);assert.ok(!JSON.stringify(response).includes('PRIVATE BODY'));assert.ok(Buffer.byteLength(JSON.stringify(response))<100_000);
});
it('bounds inline diff bytes and lines before returning text to the renderer',async()=>{
  const f=await fixture(),before=readFileSync(path.join(f.root,'.git/index'));
  f.write('docs/reference.md',source('Reference')+'x'.repeat(1024*1024));await assert.rejects(f.call('git/diff?path=docs/reference.md'),{code:'git-limit'});
  f.write('docs/reference.md',source('Reference')+'\n'.repeat(20_001));await assert.rejects(f.call('git/diff?path=docs/reference.md'),{code:'git-limit'});
  assert.deepEqual(readFileSync(path.join(f.root,'.git/index')),before);
});
it('uses authenticated browser routes and serves the same Changes module',async()=>{
  const f=await fixture(),app=await startApp({config:f.config,actor:f.actor,port:0});apps.push(app);
  assert.equal((await fetch(app.origin+'/api/git/status')).status,401);assert.equal((await fetch(app.origin+'/git-changes.mjs')).status,200);
  const token=new URLSearchParams(new URL(app.launchUrl).hash.slice(1)).get('connect'),session=await fetch(app.origin+'/api/session',{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({token})}),cookie=session.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(app.origin+'/api/git/status',{headers:{Cookie:cookie}})).status,200);assert.equal((await fetch(app.origin+'/api/git/status',{headers:{Cookie:cookie,Origin:'https://foreign.invalid'}})).status,403);
});
