import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveConfig } from '../src/config.mjs';
import { runSetup } from '../src/setup.mjs';
import { applySetupCarry, planSetupCarry } from '../src/setup-carry.mjs';
import { listPendingHandoffs } from '../src/handoff-record.mjs';
import { availableSessionId, readPlanOwnership } from '../src/pickup.mjs';
import { moveFileAtomic, recoverAbandonedTransactions, inspectTransactions, resolveTransactions } from '../src/atomic-mutation.mjs';
import { resolveRefPath } from '../src/util.mjs';
import { CONFIG_FILENAMES } from '../src/naming.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/runlist.mjs');
let repo, savedExit;
beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'runlist-setup-carry-'));
  savedExit = process.exitCode;
  process.exitCode = 0;
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
});
afterEach(() => { process.exitCode = savedExit; rmSync(repo, { recursive: true, force: true }); });
function put(file, content) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), content);
}
const read = file => readFileSync(path.join(repo, file), 'utf8');
const has = file => existsSync(path.join(repo, file));
function cli(args, session = 'carry-a') {
  return spawnSync(process.execPath, [bin, ...args], { cwd: repo, encoding: 'utf8', timeout: 20000,
    env: { ...process.env, RUNLIST_SESSION_ID: session, RUNLIST_JOURNAL: '0', DOTMD_JOURNAL: '0',
      HOME: repo, USERPROFILE: repo, NO_COLOR: '1', FORCE_COLOR: '0', RUNLIST_ERROR_LOG_DIR: path.join(repo, 'logs') } });
}
function okCli(args, session) {
  const result = cli(args, session);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
}
async function setup(args = [], opts = {}) {
  let output = '';
  const report = await runSetup(args, await resolveConfig(repo), { cwd: repo, out: { write(chunk) { output += chunk; } }, ...opts });
  return { report, output };
}
function saved(slug = 'fresh', flags = []) {
  put('draft', '# Resume\n\nInspect the synthetic exporter.\n');
  return okCli(['baton', slug, '@draft', ...flags]);
}
function snapshot(directory = repo) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? [[file, 'directory'], ...snapshot(file)] : [[file, entry.isSymbolicLink() ? `symlink:${readlinkSync(file)}` : readFileSync(file).toString('base64')]];
  }).sort(([a], [b]) => a.localeCompare(b));
}
const moves = report => report.actions.filter(action => action.id.startsWith('carry:'));
const prompt = (status = 'pending', extra = '') => `---\ntype: prompt\nstatus: ${status}\ncreated: 2026-10-01\nupdated: 2026-10-01\n${extra}---\n# Resume\n\nInspect the synthetic exporter.\n`;

describe('setup carries runlist artifacts written before configuration', () => {
  it('keeps a baton discoverable and consumable by another session; counts the move', async () => {
    saved();
    assert.match(okCli(['prompts']).stdout, /resume-fresh/);
    const { report, output } = await setup(['--yes']);
    assert.equal(report.status, 'completed', JSON.stringify(report.failed));
    assert.equal(report.completed.length, 3);
    assert.equal(report.outstanding.length, 0);
    assert.match(output, /move prompts\/resume-fresh.md → docs\/prompts\/resume-fresh.md/);
    assert.ok(!has('prompts'));
    assert.match(okCli(['prompts']).stdout, /resume-fresh/);
    const used = okCli(['use', 'resume-fresh'], 'carry-b');
    assert.match(used.stdout, /Inspect the synthetic exporter/);
    assert.ok(has('docs/prompts/archived/resume-fresh.md'));
  });

  for (const args of [[], ['--yes', '--dry-run']]) it(`CLI preview leaves every byte and folder unchanged (${args.join(' ') || 'default'})`, () => {
    saved();
    const before = snapshot();
    const result = okCli(['setup', ...args]);
    assert.match(result.stdout, /Carry over prompts and plans saved before setup/);
    assert.match(result.stdout, /move prompts\/resume-fresh.md → docs\/prompts\/resume-fresh.md/);
    assert.doesNotMatch(result.stdout, /skip\s+docs\/prompts/);
    assert.deepEqual(snapshot(), before);
  });

  it('leaves foreign Markdown, invalid statuses and other file types untouched, with the outside-roots notice', async () => {
    saved();
    const foreign = '# Library\n\nA user-authored prompt library.\n';
    put('prompts/library.md', foreign);
    put('prompts/invalid.md', prompt('draft'));
    put('prompts/reference.md', '---\ntype: doc\nstatus: active\n---\n# Reference\n');
    put('prompts/notes.txt', 'User notes\n');
    const preview = await setup();
    assert.match(preview.output, /found at repo root: prompts\/ \(3 .md files\)/);
    assert.doesNotMatch(preview.output, /skip\s+docs\/prompts/);
    const applied = await setup(['--yes']);
    assert.equal(applied.report.status, 'completed');
    assert.match(applied.output, /outside the configured roots/);
    assert.match(applied.output, /prompts\/library.md/);
    assert.equal(read('prompts/library.md'), foreign);
    assert.equal(read('prompts/invalid.md'), prompt('draft'));
    assert.equal(read('prompts/notes.txt'), 'User notes\n');
    assert.ok(has('prompts/reference.md'));
    assert.ok(has('docs/prompts/resume-fresh.md'));
  });

  it('moves an already consumed prompt into the configured archive and removes empty old folders', async () => {
    saved();
    okCli(['use', 'resume-fresh'], 'carry-b');
    assert.ok(has('prompts/archived/resume-fresh.md'));
    const { report } = await setup(['--yes']);
    assert.equal(report.status, 'completed', JSON.stringify(report.failed));
    assert.ok(has('docs/prompts/archived/resume-fresh.md'));
    assert.ok(!has('prompts'));
    assert.equal(moves(report)[0].to, 'docs/prompts/archived/resume-fresh.md');
    assert.match(okCli(['prompts', '--status', 'archived']).stdout, /resume-fresh/);
  });

  it('refuses a destination collision for only that file and carries the others', async () => {
    saved();
    saved('second');
    put('docs/prompts/resume-fresh.md', prompt().replace('synthetic exporter', 'destination copy'));
    const source = read('prompts/resume-fresh.md'), target = read('docs/prompts/resume-fresh.md');
    const { report, output } = await setup(['--yes']);
    assert.equal(report.status, 'completed', JSON.stringify(report.failed));
    assert.match(output, /Carry-over collision: prompts\/resume-fresh.md/);
    assert.equal(read('prompts/resume-fresh.md'), source);
    assert.equal(read('docs/prompts/resume-fresh.md'), target);
    assert.ok(has('docs/prompts/resume-second.md'));
    assert.ok(!has('prompts/resume-second.md'));
  });

  it('includes moves in JSON previews and completed reports without leaking source bodies', () => {
    saved();
    const before = snapshot();
    const preview = JSON.parse(okCli(['setup', '--json']).stdout);
    assert.equal(preview.mode, 'preview');
    assert.deepEqual(moves(preview).map(({ from, to, type }) => ({ from, to, type })), [{ from: 'prompts/resume-fresh.md', to: 'docs/prompts/resume-fresh.md', type: 'prompt' }]);
    assert.deepEqual(snapshot(), before);
    const applied = JSON.parse(okCli(['setup', '--yes', '--json']).stdout);
    assert.equal(applied.completed.filter(action => action.id.startsWith('carry:')).length, 1);
    assert.equal(applied.status, 'completed');
    assert.doesNotMatch(JSON.stringify(applied), /Inspect the synthetic exporter/);
  });

  it('carries by default after interactive confirmation', async () => {
    saved();
    const answers = ['', '', '', '', '', '', 'yes'];
    const { report } = await setup([], { interactive: true, ask: async () => answers.shift() ?? assert.fail('Unexpected question') });
    assert.equal(report.status, 'completed', JSON.stringify(report.failed));
    assert.equal(report.choices.carryPrompts, true);
    assert.ok(has('docs/prompts/resume-fresh.md'));
  });

  it('supports an explicit opt-out and never carries files on an already configured rerun', async () => {
    saved();
    const original = read('prompts/resume-fresh.md');
    const first = await setup(['--yes', '--no-carry-prompts']);
    assert.equal(first.report.status, 'completed');
    assert.match(first.output, /prompts\/resume-fresh.md/);
    assert.doesNotMatch(first.output, /Before applying|rerun runlist setup without --no-carry-prompts/);
    assert.match(first.output, /After a config is written, rerunning setup does not carry/);
    assert.equal(moves(first.report).length, 0);
    const rerun = await setup(['--yes']);
    assert.equal(moves(rerun.report).length, 0);
    assert.equal(read('prompts/resume-fresh.md'), original);
    assert.ok(!has('docs/prompts/resume-fresh.md'));
  });

  it('names opted-out prompts and plans in previews and results and explains the configured rerun limit', async () => {
    saved();
    put('plans/sample.md', '---\ntype: plan\nstatus: active\n---\n# Sample\n');
    const before = snapshot();
    const preview = await setup(['--no-carry-prompts']);
    assert.deepEqual(snapshot(), before);
    const applied = await setup(['--yes', '--no-carry-prompts']);
    for (const { report, output } of [preview, applied]) {
      assert.equal(moves(report).length, 0);
      assert.match(output, /outside the configured roots/);
      assert.match(output, /prompts\/resume-fresh.md/);
      assert.match(output, /plans\/sample.md/);
      if (report.mode === 'preview') assert.match(output, /Before applying, rerun runlist setup without --no-carry-prompts/);
      else assert.doesNotMatch(output, /Before applying|rerun runlist setup without --no-carry-prompts/);
      assert.match(output, /After a config is written, rerunning setup does not carry/);
      assert.match(output, /include their folders in the config root export/);
    }
    assert.match(okCli(['prompts']).stdout, /No prompts/);
    assert.equal(moves((await setup(['--yes'])).report).length, 0);
  });

  for (const flags of [[], ['--no-carry-prompts']]) it(`preserves pre-existing empty source folders when nothing is carried (${flags.join(' ') || 'default'})`, async () => {
    for (const directory of ['prompts/archived', 'archived']) mkdirSync(path.join(repo, directory), { recursive: true });
    const { report } = await setup(['--yes', ...flags]);
    assert.equal(report.status, 'completed', JSON.stringify(report.failed));
    for (const directory of ['prompts', 'prompts/archived', 'archived']) assert.deepEqual(readdirSync(path.join(repo, directory)), directory === 'prompts' ? ['archived'] : []);
  });

  it('cleans only moved-source parents while preserving unrelated empty folders', async () => {
    saved();
    for (const directory of ['prompts/archived', 'archived']) mkdirSync(path.join(repo, directory), { recursive: true });
    const { report } = await setup(['--yes']);
    assert.equal(report.status, 'completed', JSON.stringify(report.failed));
    assert.deepEqual(readdirSync(path.join(repo, 'prompts')), ['archived']);
    assert.deepEqual(readdirSync(path.join(repo, 'archived')), []);
  });

  it('accepts the carry opt-out through the CLI registry', () => {
    saved();
    const original = read('prompts/resume-fresh.md');
    const report = JSON.parse(okCli(['setup', '--no-carry-prompts', '--yes', '--json']).stdout);
    assert.equal(report.status, 'completed');
    assert.equal(report.choices.carryPrompts, false);
    assert.equal(moves(report).length, 0);
    assert.equal(read('prompts/resume-fresh.md'), original);
    assert.ok(!has('docs/prompts/resume-fresh.md'));
  });

  it('refuses the later case-folded destination duplicate while planning other moves', async () => {
    put('prompts/example.md', prompt('archived'));
    put('prompts/archived/EXAMPLE.md', prompt('archived'));
    put('prompts/archived/other.md', prompt('archived'));
    const before = await resolveConfig(repo);
    const docsRoot = path.join(repo, 'docs');
    const plan = planSetupCarry(before, { ...before, docsRoot, docsRoots: [docsRoot] });
    assert.deepEqual(plan.moves.map(move => move.from), ['prompts/example.md', 'prompts/archived/other.md']);
    assert.equal(plan.outstanding.length, 1);
    assert.match(plan.outstanding[0].description, /Carry-over collision.*EXAMPLE.md.*collides with another file being carried/);
    assert.doesNotMatch(plan.outstanding[0].description, /destination exists/);
    assert.deepEqual(plan.remaining, [path.join(repo, 'prompts/archived/EXAMPLE.md')]);
  });

  it('compares planned carry destinations with Unicode normalization and case folding', async () => {
    put('prompts/caf\u00e9.md', prompt('archived'));
    put('prompts/archived/CAFE\u0301.md', prompt('archived'));
    const before = await resolveConfig(repo);
    const docsRoot = path.join(repo, 'docs');
    const plan = planSetupCarry(before, { ...before, docsRoot, docsRoots: [docsRoot] });
    assert.equal(plan.moves.length, 1);
    assert.equal(plan.outstanding.length, 1);
    assert.match(plan.outstanding[0].description, /collides with another file being carried/);
    assert.equal(plan.remaining.length, 1);
  });

  it('routes to a selected docs root and preserves a nonempty source folder', async () => {
    saved();
    put('prompts/.gitkeep', '');
    const { report } = await setup(['--yes', '--docs-root', 'notes']);
    assert.equal(report.status, 'completed');
    assert.ok(has('notes/prompts/resume-fresh.md'));
    assert.ok(has('prompts/.gitkeep'));
    assert.ok(!has('docs'));
  });

  it('carries pre-setup plans, prompt-to-plan links, inbound references and handoff state', async () => {
    put('draft', '# Synthetic work\n\nInspect the exporter.\n');
    okCli(['new', 'plan', 'sample', '@draft']);
    okCli(['use', 'sample']);
    saved('sample');
    const beforeConfig = await resolveConfig(repo);
    assert.equal(listPendingHandoffs(beforeConfig)[0].prompt, 'prompts/resume-sample.md');
    put('docs/related.md', '---\ntype: doc\nstatus: active\nupdated: 2026-10-01\nrelated_plans:\n  - plans/sample.md\n---\n# Reference\n\n[Resume](../prompts/resume-sample.md)\n');
    const { report } = await setup(['--yes']);
    assert.equal(report.status, 'completed', JSON.stringify(report.failed));
    assert.ok(has('docs/plans/sample.md'));
    const config = await resolveConfig(repo);
    const handoff = listPendingHandoffs(config)[0];
    assert.equal(handoff.prompt, 'docs/prompts/resume-sample.md');
    assert.equal(handoff.plan, 'docs/plans/sample.md');
    assert.equal(readPlanOwnership('docs/plans/sample.md', config).state, 'released');
    const ref = read('docs/related.md').match(/  - (.+)/)[1];
    assert.equal(resolveRefPath(ref, path.join(repo, 'docs'), repo), path.join(repo, 'docs/plans/sample.md'));
    assert.match(read('docs/related.md'), /\]\(prompts\/resume-sample.md\)/);
    const used = okCli(['use', 'resume-sample'], 'carry-b');
    assert.match(used.stderr + used.stdout, /Claimed: docs\/plans\/sample.md/);
  });

  it('keeps tracked prompts staged under their new paths', async () => {
    saved();
    const staged = spawnSync('git', ['add', '--', 'prompts/resume-fresh.md'], { cwd: repo, encoding: 'utf8' });
    assert.equal(staged.status, 0, staged.stderr);
    const { report } = await setup(['--yes']);
    assert.equal(report.status, 'completed', JSON.stringify(report.failed));
    const files = spawnSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' });
    assert.equal(files.stdout.trim(), 'docs/prompts/resume-fresh.md');
  });

  it('carries plans archived before setup from the shared default archive', async () => {
    put('draft', '# Synthetic plan\n\nInspect the exporter.\n');
    okCli(['new', 'plan', 'sample', '@draft']);
    okCli(['archive', 'sample']);
    assert.ok(has('archived/sample.md'));
    const { report } = await setup(['--yes']);
    assert.equal(report.status, 'completed', JSON.stringify(report.failed));
    assert.ok(has('docs/archived/sample.md'));
    assert.ok(!has('archived'));
  });

  it('leaves an active plan in the generic root archive and names it in the outside-roots notice', async () => {
    const content = '---\ntype: plan\nstatus: active\n---\n# Synthetic library\n';
    put('archived/library.md', content);
    const { report, output } = await setup(['--yes']);
    assert.equal(report.status, 'completed');
    assert.equal(moves(report).length, 0);
    assert.equal(read('archived/library.md'), content);
    assert.ok(!has('docs/archived/library.md'));
    assert.match(output, /outside the configured roots/);
    assert.match(output, /archived\/library.md/);
  });

  it('prints the setup hint for unconfigured baton/new prompt and keeps baton JSON clean', async () => {
    const first = saved();
    assert.equal((first.stdout + first.stderr).match(/it carries this prompt over/g)?.length, 1);
    assert.doesNotMatch(first.stdout + first.stderr, /runlist init/);
    assert.match(okCli(['new', 'prompt', 'other', '@draft']).stdout, /run `runlist setup`; it carries this prompt over/);
    assert.equal(JSON.parse(saved('third', ['--json']).stdout).prompt, 'prompts/resume-third.md');
    await setup(['--yes']);
    assert.doesNotMatch(saved('configured').stdout + saved('configured-second').stderr, /No runlist config here yet/);
  });
});

describe('carry-over transaction safety', () => {
  function assertNoTransactions() {
    assert.deepEqual(readdirSync(path.join(repo, '.runlist/transactions')), []);
  }

  function killCarry(moves, phase, { direct = false, updates = [] } = {}) {
    const script = `
      import { resolveConfig } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../src/config.mjs')).href)};
      import { applySetupCarry } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../src/setup-carry.mjs')).href)};
      import { moveFileAtomic } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../src/atomic-mutation.mjs')).href)};
      const config = await resolveConfig(process.argv[1]);
      const moves = JSON.parse(process.argv[2]);
      const updates = ${JSON.stringify(updates)};
      const testHooks = { afterTransactionPhase(phase) { if (phase === ${JSON.stringify(phase)}) process.kill(process.pid, 'SIGKILL'); } };
      ${direct ? 'moveFileAtomic(moves[0].source, moves[0].target, moves[0].expectedSource, { repoRoot: config.repoRoot, config, updates, testHooks });' : 'applySetupCarry(moves, config, { testHooks });'}
    `;
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script, repo, JSON.stringify(moves)], { cwd: repo, encoding: 'utf8', timeout: 10000 });
    assert.notEqual(killed.status, 0, killed.stdout + killed.stderr);
    return readdirSync(path.join(repo, '.runlist/transactions')).map(name => JSON.parse(read(`.runlist/transactions/${name}/manifest.json`)));
  }

  async function planned() {
    const config = await resolveConfig(repo);
    const docsRoot = path.join(repo, 'docs');
    const after = { ...config, docsRoot, docsRoots: [docsRoot] };
    const plan = planSetupCarry(config, after);
    return { config, moves: plan.moves.map(move => ({ ...move, expectedSource: readFileSync(move.source, 'utf8') })) };
  }

  it('refuses a source changed after preview before moving any file', async () => {
    saved();
    const { config, moves } = await planned();
    put('prompts/resume-fresh.md', prompt('archived'));
    const before = snapshot();
    assert.match(applySetupCarry(moves, config).error, /changed after preview/);
    assert.deepEqual(snapshot(), before);
  });

  for (const filename of CONFIG_FILENAMES) it(`refuses carry when ${filename} appears after preview`, async () => {
    saved();
    const { config, moves } = await planned();
    put(filename, "export const root = 'docs';\n");
    const before = snapshot();
    assert.match(applySetupCarry(moves, config).error, /A config appeared/);
    assert.deepEqual(snapshot(), before);
  });

  it('rechecks legacy config discovery under the move lock', async () => {
    saved();
    const { config, moves } = await planned();
    const result = applySetupCarry(moves, config, { testHooks: { beforeMoveSnapshot() { put('dotmd.config.mjs', "export const root = 'docs';\n"); } } });
    assert.match(result.error, /A config appeared/);
    assert.ok(has('prompts/resume-fresh.md'));
    assert.ok(!has('docs/prompts/resume-fresh.md'));
  });

  it('refuses an artifact retagged during interactive confirmation before publishing a config', async () => {
    saved();
    const answers = ['', '', '', '', '', ''];
    const { report } = await setup([], { interactive: true, ask: async () => {
      if (answers.length) return answers.shift();
      put('prompts/resume-fresh.md', '# User library\n');
      return 'yes';
    } });
    assert.equal(report.status, 'failed');
    assert.match(report.failed[0].description, /Setup sources changed during review/);
    assert.ok(!has('runlist.config.mjs'));
    assert.ok(!has('docs/prompts/resume-fresh.md'));
    assert.equal(read('prompts/resume-fresh.md'), '# User library\n');
  });

  it('rolls a prompt, its references and its handoff record back together on publication failure', async () => {
    saved();
    put('.runlist/handoffs/sample.json', JSON.stringify({ prompt: 'prompts/resume-fresh.md', plan: 'plans/sample.md' }));
    put('reference.md', '---\ntype: doc\nstatus: active\n---\n# Reference\n\n[Resume](prompts/resume-fresh.md)\n');
    const { config, moves } = await planned();
    const original = read('prompts/resume-fresh.md'), handoff = read('.runlist/handoffs/sample.json'), reference = read('reference.md');
    const result = applySetupCarry(moves, config, { testHooks: { afterMovePublish() { throw new Error('Synthetic publication failure'); } } });
    assert.match(result.error, /Synthetic publication failure/);
    assert.equal(result.completed.length, 0);
    assert.equal(read('prompts/resume-fresh.md'), original);
    assert.equal(read('.runlist/handoffs/sample.json'), handoff);
    assert.equal(read('reference.md'), reference);
    assert.ok(!has('docs/prompts/resume-fresh.md'));
    assert.ok(!has('docs'));
    assert.doesNotThrow(() => recoverAbandonedTransactions(repo, { config }));
  });

  for (const existing of [false, true]) it(`keeps ${existing ? 'pre-existing' : 'new nonempty'} scaffold folders after a failed carry`, async () => {
    saved();
    if (existing) mkdirSync(path.join(repo, 'docs/prompts'), { recursive: true });
    const { config, moves } = await planned();
    const result = applySetupCarry(moves, config, { testHooks: { afterMovePublish() {
      if (!existing) put('docs/prompts/keep.txt', 'User content');
      throw new Error('Synthetic failure');
    } } });
    assert.match(result.error, /Synthetic failure/);
    assert.ok(has('docs/prompts'));
    if (!existing) assert.equal(read('docs/prompts/keep.txt'), 'User content');
    assert.ok(!has('runlist.config.mjs'));
  });

  it('refuses generated handoff participants outside the dedicated handoff directory', async () => {
    saved();
    put('other.json', '{}');
    const config = await resolveConfig(repo);
    assert.throws(() => moveFileAtomic(path.join(repo, 'prompts/resume-fresh.md'), path.join(repo, 'prompts/renamed.md'), prompt(), {
      repoRoot: repo, config, updates: [{ path: path.join(repo, 'other.json'), content: '{"changed":true}', label: 'handoff' }],
    }), /outside handoff state/);
    assert.equal(read('other.json'), '{}');
    assert.ok(has('prompts/resume-fresh.md'));
  });

  for (const phase of ['target-publication', 'canonical-commit', 'backup-deletion', 'manifest-completion', 'cleanup']) it(`finishes setup and consumes a prompt after a kill at ${phase}, with no moves left to plan`, async () => {
    saved();
    const { moves } = await planned();
    const manifests = killCarry(moves, phase);
    assert.deepEqual(manifests[0].createdDirectories, []);
    const before = snapshot();
    const preview = await setup();
    assert.match(preview.output, /Outstanding transaction.*pre-config recovery/);
    assert.deepEqual(snapshot(), before);
    const report = JSON.parse(okCli(['setup', '--yes', '--json']).stdout);
    assert.equal(report.status, 'completed', JSON.stringify(report.failed));
    assert.equal(report.outstanding.length, 0);
    assert.ok(!has('prompts'));
    assertNoTransactions();
    okCli(['use', 'resume-fresh'], 'carry-b');
    assert.ok(has('docs/prompts/archived/resume-fresh.md'));
    assertNoTransactions();
  });

  for (const flags of [[], ['--no-carry-prompts']]) it(`blocks config publication for a legacy carry manifest with retained directories (${flags.join(' ') || 'default'})`, async () => {
    saved();
    const { moves } = await planned();
    const manifests = killCarry(moves, 'target-publication', { direct: true });
    assert.equal(manifests[0].createdDirectories.length, 2);
    const before = snapshot();
    const preview = await setup();
    assert.match(preview.output, /Outstanding transaction/);
    assert.deepEqual(snapshot(), before);
    const { report } = await setup(['--yes', ...flags]);
    assert.equal(report.failed.length, 1);
    assert.match(report.failed[0].description, /Pre-config transaction recovery failed.*doctor --transactions --apply/s);
    assert.ok(!has('runlist.config.mjs'));
    assert.ok(has(`.runlist/transactions/${manifests[0].id}/manifest.json`));
    assert.equal((await resolveConfig(repo)).configFound, false);
    const doctor = JSON.parse(okCli(['doctor', '--transactions', '--apply', '--json']).stdout);
    assert.equal(doctor.cleared.length, 1);
    assert.ok(has('docs/prompts/resume-fresh.md'));
    assert.ok(!existsSync(manifests[0].createdDirectories[0].marker));
    assertNoTransactions();
    okCli(['setup', '--yes', ...flags]);
    assert.ok(has('prompts')); // Doctor retired the source evidence before this setup run.
    assert.ok(has('runlist.config.mjs'));
  });

  it('clears the other-verb archive shape with doctor, then setup completes', async () => {
    put('plans/beta.md', '---\ntype: plan\nstatus: archived\n---\n# Beta\n');
    const config = await resolveConfig(repo);
    const move = { source: path.join(repo, 'plans/beta.md'), target: path.join(repo, 'plans/archived/beta.md'), expectedSource: read('plans/beta.md') };
    const [manifest] = killCarry([move], 'target-publication', { direct: true });
    const failed = await setup(['--yes']);
    assert.match(failed.report.failed[0].description, /doctor --transactions --apply/);
    assert.doesNotMatch(failed.output, /Manually inspect/);
    assert.equal(inspectTransactions(repo, { config })[0].status, 'complete');
    const doctor = JSON.parse(okCli(['doctor', '--transactions', '--apply', '--json']).stdout);
    assert.deepEqual(doctor.cleared, [{ id: manifest.id, generation: 'new' }]);
    assert.equal(read('plans/archived/beta.md'), move.expectedSource);
    assert.deepEqual(readdirSync(path.join(repo, 'plans/archived')), ['beta.md']);
    okCli(['setup', '--yes']);
    assert.ok(has('runlist.config.mjs'));
    assert.equal(read('plans/archived/beta.md'), move.expectedSource);
    assert.ok(has('plans')); // Never remove a source directory holding content.
    assertNoTransactions();
  });

  it('can resume doctor clearing after a stop between marker deletion and manifest cleanup', async () => {
    saved();
    const { config, moves } = await planned();
    killCarry(moves, 'target-publication', { direct: true });
    recoverAbandonedTransactions(repo, { config });
    assert.throws(() => resolveTransactions(repo, { config, testHooks: { beforeDirectoryFsync(phase) {
      if (phase === 'transaction-directory-marker-delete') throw new Error('Synthetic doctor stop');
    } } }), /Synthetic doctor stop/);
    assert.ok(has('docs/prompts/resume-fresh.md'));
    const doctor = JSON.parse(okCli(['doctor', '--transactions', '--apply', '--json']).stdout);
    assert.equal(doctor.cleared.length, 1);
    assert.deepEqual(readdirSync(path.join(repo, 'docs/prompts')), ['resume-fresh.md']);
    assertNoTransactions();
  });

  for (const change of ['consume', 'edit-referrer', 'edit-target', 'delete-referrer', 'delete-target', 'mode', 'recreate-source']) it(`clears a complete move after ${change} without restoring participants`, async () => {
    saved();
    put('reference.md', '---\ntype: doc\nstatus: active\n---\n# Reference\n\n[Resume](prompts/resume-fresh.md)\n');
    const { config, moves } = await planned();
    const updates = [{ path: path.join(repo, 'reference.md'), content: read('reference.md').replace('prompts/', 'docs/prompts/') }];
    killCarry(moves, 'referrer-publication', { direct: true, updates });
    recoverAbandonedTransactions(repo, { config });
    if (change === 'consume') okCli(['use', 'docs/prompts/resume-fresh.md'], 'carry-b');
    if (change === 'edit-referrer') put('reference.md', read('reference.md') + '\r\nUser edit: café.\r\n');
    if (change === 'edit-target') put('docs/prompts/resume-fresh.md', read('docs/prompts/resume-fresh.md') + '\nUser edit\n');
    if (change === 'delete-referrer') rmSync(path.join(repo, 'reference.md'));
    if (change === 'delete-target') rmSync(moves[0].target);
    if (change === 'mode') chmodSync(moves[0].target, 0o600);
    if (change === 'recreate-source') put('prompts/resume-fresh.md', prompt());
    const contentBefore = snapshot().filter(([file]) => !file.includes(`${path.sep}.runlist${path.sep}`) && !path.basename(file).startsWith('.runlist-transaction-'));
    const referrer = has('reference.md') ? readFileSync(path.join(repo, 'reference.md')) : null;
    const doctor = JSON.parse(okCli(['doctor', '--transactions', '--apply', '--json']).stdout);
    assert.equal(doctor.cleared.length, 1);
    assertNoTransactions();
    // Only now-empty transaction-created folders can disappear; every document
    // and every later user edit must survive byte for byte.
    assert.deepEqual(snapshot().filter(([file, content]) => content !== 'directory' && !file.includes(`${path.sep}.runlist${path.sep}`)), contentBefore.filter(([, content]) => content !== 'directory'));
    okCli(['setup', '--yes']);
    if (referrer) assert.deepEqual(readFileSync(path.join(repo, 'reference.md')), referrer);
    if (change === 'consume') {
      assert.ok(!has('docs/prompts/resume-fresh.md'));
      assert.ok(has('archived/resume-fresh.md'));
      assert.match(read('archived/resume-fresh.md'), /status: archived/);
    }
  });

  for (const phase of ['source-move', 'target-publication']) it(`clears a rolled-back move and removes marker-only folders (${phase})`, async () => {
    saved();
    put('reference.md', '---\ntype: doc\nstatus: active\n---\n# Reference\n\n[Resume](prompts/resume-fresh.md)\n');
    const { config, moves } = await planned();
    const source = read('prompts/resume-fresh.md');
    const updates = [{ path: path.join(repo, 'reference.md'), content: read('reference.md').replace('prompts/', 'docs/prompts/') }];
    const [manifest] = killCarry(moves, phase, { direct: true, updates });
    assert.equal(recoverAbandonedTransactions(repo, { config })[0].result, 'rolled-back');
    const doctor = JSON.parse(okCli(['doctor', '--transactions', '--apply', '--json']).stdout);
    assert.equal(doctor.cleared.length, 1);
    for (const directory of manifest.createdDirectories) {
      assert.ok(!existsSync(directory.marker));
      assert.ok(!existsSync(directory.path));
    }
    assert.equal(read('prompts/resume-fresh.md'), source);
    assertNoTransactions();
    okCli(['setup', '--yes']);
  });

  for (const mismatch of ['other-artifact', 'artifact-directory', 'marker', 'marker-missing', 'marker-symlink', 'marker-directory', 'directory-file', 'directory-symlink', 'directory-replaced', 'target-symlink', 'git-retained', 'git-prepared', 'active', 'failed-manual', 'older-schema']) it(`retains transaction evidence needing manual review (${mismatch})`, async () => {
    saved();
    const { config, moves } = await planned();
    const [original] = killCarry(moves, 'target-publication', { direct: true });
    recoverAbandonedTransactions(repo, { config });
    const manifestFile = `.runlist/transactions/${original.id}/manifest.json`;
    const manifest = JSON.parse(read(manifestFile));
    const directory = manifest.createdDirectories.at(-1);
    if (mismatch === 'other-artifact') put(`.runlist/transactions/${manifest.id}/unverified-index`, 'evidence');
    if (mismatch === 'artifact-directory') {
      rmSync(manifest.participants[0].old.artifact);
      mkdirSync(manifest.participants[0].old.artifact);
    }
    if (mismatch === 'marker') writeFileSync(directory.marker, 'foreign marker');
    if (['marker-missing', 'marker-symlink', 'marker-directory'].includes(mismatch)) {
      rmSync(directory.marker);
      if (mismatch === 'marker-symlink') {
        put('token', `${directory.token}\n`);
        symlinkSync(path.join(repo, 'token'), directory.marker);
      }
      if (mismatch === 'marker-directory') mkdirSync(directory.marker);
    }
    if (['directory-file', 'directory-symlink', 'directory-replaced'].includes(mismatch)) {
      renameSync(directory.path, path.join(repo, 'aside'));
      if (mismatch === 'directory-file') writeFileSync(directory.path, 'foreign file');
      if (mismatch === 'directory-symlink') symlinkSync(path.join(repo, 'aside'), directory.path, process.platform === 'win32' ? 'junction' : 'dir');
      if (mismatch === 'directory-replaced') mkdirSync(directory.path);
    }
    if (mismatch === 'target-symlink') {
      renameSync(moves[0].target, path.join(repo, 'docs/real.md'));
      symlinkSync('../real.md', moves[0].target);
    }
    if (['git-retained', 'git-prepared'].includes(mismatch)) {
      const file = path.join(repo, '.git/.runlist-index-unverified');
      writeFileSync(file, 'unverified');
      if (mismatch === 'git-retained') manifest.gitIndex.retainedPaths.push(file);
      else manifest.gitIndex.prepared = { state: 'prepared', tempPath: file, generation: null };
    }
    if (['active', 'failed-manual'].includes(mismatch)) manifest.status = manifest.phase = manifest.result = mismatch;
    if (mismatch === 'older-schema') manifest.schema = 1;
    put(manifestFile, JSON.stringify(manifest));
    const before = snapshot();
    const doctor = JSON.parse(okCli(['doctor', '--transactions', '--apply', '--json']).stdout);
    assert.equal(doctor.transactions[0].resolvable, false);
    assert.deepEqual(doctor.cleared, []);
    assert.deepEqual(snapshot(), before);
    assert.ok(has(manifestFile));
    if (manifest.status === 'complete') assert.doesNotMatch((await setup()).output, /restore one complete generation/);
  });

  for (const invalid of [false, true]) it(`names the manual step when doctor cannot clear ${invalid ? 'an older-schema manifest' : 'failed-manual index evidence'}`, async () => {
    saved();
    const { config, moves } = await planned();
    const [manifest] = killCarry(moves, 'target-publication', { direct: true });
    recoverAbandonedTransactions(repo, { config });
    const retained = JSON.parse(read(`.runlist/transactions/${manifest.id}/manifest.json`));
    retained.status = retained.phase = retained.result = 'failed-manual';
    if (invalid) retained.schema = 1;
    else {
      const indexFile = path.join(repo, '.git/.runlist-index-unverified');
      writeFileSync(indexFile, 'unverified');
      retained.gitIndex.retainedPaths.push(indexFile);
    }
    put(`.runlist/transactions/${manifest.id}/manifest.json`, JSON.stringify(retained));
    const verdict = inspectTransactions(repo, { config })[0];
    const preview = await setup();
    const applied = await setup(['--yes']);
    for (const text of [preview.output, applied.report.failed[0].description]) {
      assert.ok(text.includes(verdict.reason), text);
      assert.ok(text.includes(verdict.directory), text);
      assert.match(text, /Manually inspect.*restore one complete generation.*remove that transaction directory/s);
      assert.doesNotMatch(text, /Run runlist doctor --transactions --apply|repair\.\./);
    }
    assert.ok(!has('runlist.config.mjs'));
    assert.ok(has(`.runlist/transactions/${manifest.id}/manifest.json`));
  });

  for (const phase of ['staging', 'target-publication']) for (const unknownOwner of [false, true]) it(`waits for a live move at ${phase} (${unknownOwner ? 'lock-held owner unverifiable' : 'live owner'})`, async () => {
    saved();
    const { moves } = await planned();
    const ready = path.join(repo, 'paused.ready');
    const script = `
      import { writeFileSync } from 'node:fs';
      import { resolveConfig } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../src/config.mjs')).href)};
      import { moveFileAtomic } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../src/atomic-mutation.mjs')).href)};
      const config = await resolveConfig(process.argv[1]);
      const move = JSON.parse(process.argv[2]);
      moveFileAtomic(move.source, move.target, move.expectedSource, { repoRoot: config.repoRoot, config,
        testHooks: { afterTransactionPhase(phase) { if (phase === ${JSON.stringify(phase)}) {
          writeFileSync(process.argv[3], 'ready');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000);
        } } } });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, repo, JSON.stringify(moves[0]), ready], { cwd: repo, stdio: 'ignore' });
    const exited = new Promise(resolve => child.once('close', resolve));
    try {
      const deadline = Date.now() + 10000;
      while (!existsSync(ready) && Date.now() < deadline && child.exitCode === null) await new Promise(resolve => setTimeout(resolve, 10));
      assert.ok(existsSync(ready), 'child reached the requested transaction phase');
      const transaction = inspectTransactions(repo)[0];
      if (unknownOwner) {
        const manifest = JSON.parse(readFileSync(transaction.manifestPath, 'utf8'));
        manifest.owner.hostname = 'another-host.invalid';
        writeFileSync(transaction.manifestPath, JSON.stringify(manifest));
      }
      const verdict = inspectTransactions(repo)[0];
      assert.equal(verdict.lockHeld, true);
      assert.equal(verdict.ownerLiveness, unknownOwner ? 'unverifiable' : 'live');
      assert.equal(verdict.resolvable, false);
      const before = snapshot();
      const preview = await setup();
      const applied = await setup(['--yes']);
      for (const text of [preview.output, applied.output]) {
        assert.match(text, /Another runlist process is mid-move; rerun setup once it finishes/);
        assert.doesNotMatch(text, /Run runlist doctor|Manually inspect|remove that transaction directory/);
      }
      const doctor = okCli(['doctor', '--transactions', '--apply']).stdout;
      assert.match(doctor, /in progress.*rerun later/s);
      assert.doesNotMatch(doctor, /need manual review|resolvable/);
      assert.deepEqual(snapshot(), before);
      assert.ok(!has('runlist.config.mjs'));
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  });

  it('blocks config publication for failed-manual carry evidence until doctor resolves it', async () => {
    saved();
    const { config, moves } = await planned();
    const [manifest] = killCarry(moves, 'backup-deletion');
    manifest.status = manifest.phase = manifest.result = 'failed-manual';
    put(`.runlist/transactions/${manifest.id}/manifest.json`, JSON.stringify(manifest));
    const { report } = await setup(['--yes']);
    assert.equal(report.failed.length, 1);
    assert.match(report.failed[0].description, /doctor --transactions --apply/);
    assert.equal(report.checks.project, null);
    assert.ok(!has('runlist.config.mjs'));
    okCli(['doctor', '--transactions', '--apply']);
    assertNoTransactions();
    okCli(['setup', '--yes']);
    okCli(['use', 'resume-fresh'], 'carry-b');
    assertNoTransactions();
  });

  it('requests a fresh preview when recovery rolls back a partially published handoff', async () => {
    saved();
    put('.runlist/handoffs/sample.json', JSON.stringify({ prompt: 'prompts/resume-fresh.md' }));
    const { moves } = await planned();
    killCarry(moves, 'target-publication');
    const { report } = await setup(['--yes']);
    assert.equal(report.failed.length, 1);
    assert.match(report.failed[0].description, /recovery changed.*rerun setup/);
    assert.ok(!has('runlist.config.mjs'));
    assert.ok(has('prompts/resume-fresh.md'));
    assertNoTransactions();
    okCli(['setup', '--yes']);
    okCli(['use', 'resume-fresh'], 'carry-b');
    assertNoTransactions();
  });

  it('recovers a killed carry transaction with an updated handoff participant before setup', async () => {
    saved();
    put('.runlist/handoffs/sample.json', JSON.stringify({ prompt: 'prompts/resume-fresh.md' }));
    const { config, moves } = await planned();
    killCarry(moves, 'canonical-commit');
    const recovered = recoverAbandonedTransactions(repo, { config });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].result, 'rolled-forward');
    assert.deepEqual(recovered[0].retainedDirectories, []);
    assertNoTransactions();
    assert.ok(has('docs/prompts/resume-fresh.md'));
    assert.equal(JSON.parse(read('.runlist/handoffs/sample.json')).prompt, 'docs/prompts/resume-fresh.md');
    const { report } = await setup(['--yes']);
    assert.equal(report.status, 'completed', JSON.stringify(report.failed));
    okCli(['use', 'resume-fresh'], 'carry-b');
    assertNoTransactions();
  });

  for (const phase of ['ownership-publication', 'canonical-commit']) it(`recovers a carried plan and its ownership after a kill at ${phase}`, async () => {
    put('draft', '# Synthetic plan\n\nInspect the exporter.\n');
    okCli(['new', 'plan', 'sample', '@draft']);
    const session = availableSessionId();
    okCli(['use', 'sample'], session);
    const { config, moves } = await planned();
    assert.equal(moves.length, 1);
    const manifests = killCarry(moves, phase);
    assert.deepEqual(manifests[0].createdDirectories, []);
    const recovered = recoverAbandonedTransactions(repo, { config });
    assert.equal(recovered[0].result, phase === 'canonical-commit' ? 'rolled-forward' : 'rolled-back');
    assert.deepEqual(recovered[0].retainedDirectories, []);
    assertNoTransactions();
    okCli(['setup', '--yes'], session);
    const after = await resolveConfig(repo);
    assert.equal(readPlanOwnership('docs/plans/sample.md', after).state, 'owned');
    assert.equal(has('plans'), phase === 'canonical-commit'); // External recovery retired the source evidence in that case.
    okCli(['set', 'active', 'sample'], session);
    okCli(['archive', 'sample'], session);
    assert.ok(has('docs/archived/sample.md'));
    assertNoTransactions();
  });

  it('refuses a symlinked pre-config folder before writes', async () => {
    put('library/example.md', prompt());
    symlinkSync(path.join(repo, 'library'), path.join(repo, 'prompts'), process.platform === 'win32' ? 'junction' : 'dir');
    const { report } = await setup(['--yes']);
    assert.equal(report.status, 'failed');
    assert.ok(!has('runlist.config.mjs'));
    assert.equal(read('library/example.md'), prompt());
  });
});
