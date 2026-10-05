import { afterEach, describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import { buildAgentContext, boundedCollection, DEFAULT_AGENT_CONTEXT_BYTES, parseAgentContextOptions } from '../src/agent-context.mjs';
const BIN = path.resolve(import.meta.dirname, '..', 'bin/runlist.mjs');

let repo;

async function configFor(source = `export const root = 'docs';\n`) {
  repo = mkdtempSync(path.join(os.tmpdir(), 'dotmd-agent-context-'));
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  writeFileSync(path.join(repo, 'dotmd.config.mjs'), source);
  return resolveConfig(repo);
}

function doc(pathName, type, status, extra = {}) {
  return { path: pathName, type, status, title: path.basename(pathName), blockers: [], ...extra };
}

afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

describe('agent context v1', () => {

  it('bounds a 5,000-document Unicode fixture while retaining the next prompt and first action', async () => {
    const config = await configFor();
    const plans = Array.from({length:4999},(_,i)=>doc(`docs/p-${String(i).padStart(5,'0')}.md`,'plan','active',{
      title:'A long plan '+ '🧭'.repeat(160), nextStep:'First action '+ '先'.repeat(300),
      blockers:['阻'.repeat(160),'碍'.repeat(160),'物'.repeat(160)], isStale:true, daysSinceUpdate:100,
    }));
    const prompt=doc('docs/resume.md','prompt','pending',{created:'2026-01-01',nextStep:'Resume the first action'});
    const index={docs:[prompt,...plans],countsByStatus:{active:4999,pending:1},countsByType:{plan:{active:4999},prompt:{pending:1}},errors:[],warnings:Array.from({length:80},(_,i)=>({path:`docs/p-${i}.md`,message:'警'.repeat(300)}))};
    const before=JSON.stringify(index);
    const context=buildAgentContext(index,config);
    const bytes=Buffer.byteLength(JSON.stringify(context,null,2)+'\n');
    ok(bytes<=DEFAULT_AGENT_CONTEXT_BYTES,`${bytes} bytes`);
    strictEqual(context.budget.bytes,bytes);
    strictEqual(context.budget.truncated,true);
    strictEqual(context.counts.documents,5000);
    strictEqual(context.prompts.next.path,'docs/resume.md');
    strictEqual(context.plans.focus.items[0].path,'docs/p-00000.md');
    ok(context.plans.focus.items[0].nextStep.startsWith('First action'));
    strictEqual(context.plans.focus.total,4999);
    strictEqual(context.plans.focus.shown,context.plans.focus.items.length);
    strictEqual(context.plans.focus.truncated,true);
    strictEqual(JSON.stringify(index),before);
  });

  it('selects sections and reports a too-small budget rather than dropping protected information', async () => {
    const config=await configFor();
    const index={docs:[doc('docs/p.md','plan','active',{owner:'human',nextStep:'Do the next thing'})],countsByStatus:{active:1},countsByType:{plan:{active:1}},errors:[],warnings:[]};
    const options=parseAgentContextOptions(['--sections','plans,counts','--max-bytes','4096']);
    const context=buildAgentContext(index,config,options);
    deepStrictEqual(context.scope.sections,['plans','counts']);
    strictEqual(context.prompts,undefined);
    strictEqual(context.statusVocabulary,undefined);
    strictEqual(context.plans.focus.items[0].owner,'human');
    ok(context.budget.bytes<=4096);
    throws(()=>parseAgentContextOptions(['--sections','unknown']),/--sections/);
    throws(()=>parseAgentContextOptions(['--max-bytes','100']),/at least 2048/);
    const oversized={...index,countsByStatus:{['x'.repeat(3000)]:1}};
    throws(()=>buildAgentContext(oversized,config,{sections:['counts'],maxBytes:2048}),/increase --max-bytes/);
  });

  it('CLI section selection and context alias share the same byte budget without passive writes', async () => {
    await configFor("export const root = 'docs';\nexport const journal = true;\n");
    writeFileSync(path.join(repo,'docs/p.md'),'---\ntype: plan\nstatus: active\nupdated: 2026-10-05\nnext_step: Do the first thing\n---\n# Plan\n');
    const run=args=>spawnSync('node',[BIN,...args],{cwd:repo,encoding:'utf8',env:{...process.env,NO_COLOR:'1'}});
    for(const args of [['agent-context'],['context','--json','--compact']]) {
      const result=run([...args,'--sections','plans,prompts,counts','--max-bytes','4096']);
      strictEqual(result.status,0,result.stderr);
      const context=JSON.parse(result.stdout);
      ok(Buffer.byteLength(result.stdout)<=4096);
      strictEqual(context.budget.bytes,Buffer.byteLength(result.stdout));
      deepStrictEqual(context.scope.sections,['plans','prompts','counts']);
    }
    strictEqual(run(['agent-context','--sections','nope']).status,1);
    ok(!existsSync(path.join(repo,'.runlist/journal.jsonl')));
  });

  it('retains a real session claim while reducing other plan items to the byte budget', async () => {
    const config=await configFor();
    const plan=path.join(repo,'docs/owned.md');
    writeFileSync(plan,'---\ntype: plan\nstatus: active\nupdated: 2026-10-05\nnext_step: Finish owned work\n---\n# Owned\n');
    const result=spawnSync('node',[BIN,'use','docs/owned.md'],{cwd:repo,encoding:'utf8',env:{...process.env,RUNLIST_SESSION_ID:'context-claim-test',NO_COLOR:'1'}});
    strictEqual(result.status,0,result.stderr);
    const docs=[doc('docs/owned.md','plan','in-session',{nextStep:'Finish owned work'}),...Array.from({length:50},(_,i)=>doc(`docs/p-${i}.md`,'plan','active',{title:'Long title '.repeat(30),nextStep:'Other action '.repeat(30)}))];
    const index={docs,countsByStatus:{'in-session':1,active:50},countsByType:{plan:{'in-session':1,active:50}},errors:[],warnings:[]};
    const context=buildAgentContext(index,config,{sections:['plans','counts'],maxBytes:4096});
    const owned=context.plans.focus.items.find(item=>item.path==='docs/owned.md');
    ok(owned,'claim must remain visible');
    strictEqual(owned.claim.state,'owned');
    strictEqual(owned.claim.sessionId,'context-claim-test');
    strictEqual(owned.nextStep,'Finish owned work');
    ok(context.budget.bytes<=4096);
  });
  it('is type-correct, includes configured partial focus, and leaves input unchanged', async () => {
    const config = await configFor();
    const index = {
      docs: [
        doc('docs/partial.md', 'plan', 'partial'),
        doc('docs/awaiting-doc.md', 'doc', 'awaiting'),
        doc('docs/blocked-prompt.md', 'prompt', 'blocked'),
      ],
      countsByStatus: { partial: 1, awaiting: 1, blocked: 1 },
      countsByType: { plan: { partial: 1 }, doc: { awaiting: 1 }, prompt: { blocked: 1 } },
      errors: [], warnings: [],
    };
    const before = JSON.stringify(index);
    const context = buildAgentContext(index, config, { generatedAt: '2026-01-01T00:00:00.000Z' });
    strictEqual(context.schema.name, 'dotmd.agent-context');
    strictEqual(context.schema.version, 1);
    deepStrictEqual(context.plans.focus.items.map(item => item.path), ['docs/partial.md']);
    ok(!JSON.stringify(context.plans).includes('awaiting-doc'));
    ok(!JSON.stringify(context.plans).includes('blocked-prompt'));
    strictEqual(JSON.stringify(index), before, 'builder must not mutate its index');
  });

  it('reports total, shown, truncated, and items for every bounded collection', async () => {
    const config = await configFor();
    const plans = Array.from({ length: 13 }, (_, i) => doc(`docs/p-${String(i).padStart(2, '0')}.md`, 'plan', 'active'));
    const index = { docs: plans, countsByStatus: { active: 13 }, countsByType: { plan: { active: 13 } }, errors: [], warnings: [] };
    const context = buildAgentContext(index, config);
    strictEqual(context.plans.focus.total, 13);
    strictEqual(context.plans.focus.shown, 12);
    strictEqual(context.plans.focus.truncated, true);
    const collections = [
      ...Object.values(context.statusVocabulary),
      context.prompts.actionable,
      ...Object.values(context.plans),
      ...Object.values(context.issues),
    ];
    for (const collection of collections) {
      deepStrictEqual(Object.keys(collection), ['total', 'shown', 'truncated', 'items']);
    }
    deepStrictEqual(Object.keys(context.plans.focus.items[0].blockers), ['total', 'shown', 'truncated', 'items']);
    deepStrictEqual(boundedCollection([], 2), { total: 0, shown: 0, truncated: false, items: [] });
  });

  it('uses deterministic status/date/path ordering and explicit scope', async () => {
    const config = await configFor();
    const index = {
      docs: [doc('docs/z.md', 'plan', 'partial'), doc('docs/b.md', 'plan', 'active'), doc('docs/a.md', 'plan', 'active')],
      countsByStatus: { partial: 1, active: 2 }, countsByType: { plan: { partial: 1, active: 2 } }, errors: [], warnings: [],
    };
    const context = buildAgentContext(index, config, { roots: ['docs'], types: ['plan'] });
    deepStrictEqual(context.plans.focus.items.map(item => item.path), ['docs/a.md', 'docs/b.md', 'docs/z.md']);
    deepStrictEqual(context.scope, { roots: ['docs'], types: ['plan'] });
    deepStrictEqual(Object.keys(context.statusVocabulary), ['plan']);
  });
});
