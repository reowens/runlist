import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {diagnosePromptParents,groupPrompts} from '../src/prompt-handoff.mjs';

test('diagnoses explicit, inferred, missing, archived, ambiguous and invalid links using shared matching rules',()=>{
  const parent={path:'docs/prompts/resume-session.md',status:'pending'},child={path:'docs/prompts/subagent-review.md',status:'pending',parentPrompt:'resume-session'};
  const cases=[
    {...child},
    {...child,path:'docs/prompts/agent-session-old.md',parentPrompt:null},
    {...child,path:'docs/prompts/subagent-missing.md',parentPrompt:'resume-missing'},
    {...child,path:'docs/prompts/subagent-archived.md',parentPrompt:'resume-history'},
    {...child,path:'docs/prompts/subagent-invalid.md',parentPromptInvalid:true},
  ];
  const docs=[parent,{path:'docs/prompts/archived/resume-history.md',status:'archived'},...cases];
  const report=diagnosePromptParents(docs,{archiveDir:'archived'});
  assert.deepEqual(report.links.map(l=>l.state),['linked','inferred','missing','archived','invalid']);
  assert.equal(groupPrompts(docs.filter(d=>d.status!=='archived'))[0].children.length,2);
  assert.equal(diagnosePromptParents([parent,{...parent},child],{archiveDir:'archived'}).links[0].state,'ambiguous');
  assert.equal(report.findings.length,4);
});

test('doctor --prompts reports malformed metadata without exposing bodies or changing a prompt',t=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'runlist-parent-doctor-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(path.join(root,'docs/prompts'),{recursive:true});writeFileSync(path.join(root,'runlist.config.mjs'),"export const root='docs';\n");
  const write=(name,fm)=>{const file=path.join(root,'docs/prompts',name+'.md');writeFileSync(file,'---\ntype: prompt\nstatus: pending\n'+fm+'\n---\nPRIVATE_BODY_MUST_NOT_BE_OUTPUT\n');return file;};
  write('resume-session','');
  const duplicate=write('subagent-duplicate','parent_prompt: resume-session\nparent_prompt: resume-other'),array=write('subagent-array','parent_prompt: [resume-session]');
  const before=[duplicate,array].map(file=>readFileSync(file,'utf8'));
  const result=spawnSync(process.execPath,[path.resolve(import.meta.dirname,'../bin/runlist.mjs'),'doctor','--prompts','--json'],{cwd:root,encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.includes('PRIVATE_BODY'),false);
  const report=JSON.parse(result.stdout);assert.equal(report.counts.invalid,2);
  [duplicate,array].forEach((file,i)=>assert.equal(readFileSync(file,'utf8'),before[i]));
});
