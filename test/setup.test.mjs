import { beforeEach, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, readlinkSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { resolveConfig } from '../src/config.mjs';
import { runSetup } from '../src/setup.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/runlist.mjs');
const authored = ['--first-plan', 'bootstrap', '--current-state', 'The project has no document workflow yet.', '--next-step', 'Write a specification for the first release.'];
let fixture, repo, savedEnv, savedExit;
beforeEach(() => {
  fixture = mkdtempSync(path.join(os.tmpdir(), 'runlist-setup-test-'));
  repo = path.join(fixture, 'project');
  mkdirSync(repo);
  const home = path.join(fixture, 'home');
  mkdirSync(home);
  savedEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  savedExit = process.exitCode;
  process.exitCode = 0;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const git = spawnSync('git', ['init', '-q'], { cwd: repo, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
});
afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  process.exitCode = savedExit;
  rmSync(fixture, { recursive: true, force: true });
});

function snapshot(directory = repo, prefix = '') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const rel = path.join(prefix, entry.name);
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [[rel, `symlink:${readlinkSync(file)}`]];
    if (entry.isDirectory()) return [[rel, 'directory'], ...snapshot(file, rel)];
    return [[rel, readFileSync(file).toString('base64')]];
  }).sort(([a], [b]) => a.localeCompare(b));
}
function put(file, content) {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), content);
}
async function setup(argv = [], options = {}) {
  let output = '';
  const config = options.config ?? await resolveConfig(repo);
  const report = await runSetup(argv, config, { cwd: repo, out: { write(chunk) { output += chunk; } }, ...options });
  return { report, output };
}
function cli(args, cwd = repo, extraEnv = {}) {
  return spawnSync(process.execPath, ['--import', path.resolve(import.meta.dirname, 'setup-env.mjs'), bin, ...args], {
    cwd, encoding: 'utf8', timeout: 10000, input: '',
    env: { ...process.env, ...extraEnv, RUNLIST_JOURNAL: '0', DOTMD_JOURNAL: '0', NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

describe('guided setup previews and apply', () => {
  it('previews noninteractive setup without --yes, using docs rather than resolver root dot', async () => {
    put('README.md', '# Existing repository\n');
    const before = snapshot();
    const { report, output } = await setup(['--json']);
    assert.equal(report.mode, 'preview');
    assert.equal(report.status, 'preview');
    assert.equal(report.choices.docsRoot, 'docs');
    assert.equal(report.choices.promptTracking, 'untracked');
    assert.deepEqual(report.completed, []);
    assert.match(output, /docs[\\/]plans[\\/]\.gitkeep/);
    assert.deepEqual(snapshot(), before);
  });

  it('global dry-run overrides --yes and every requested side effect', async () => {
    put('notes/reference.md', '# Existing note\n');
    const before = snapshot();
    let hostCalls = 0;
    const { report } = await setup(['--yes', '--docs-root', 'notes', '--prompt-tracking', 'local', '--gitignore', '--adopt', 'notes/reference.md', '--host', 'codex', ...authored], {
      dryRun: true,
      hostRunner({ dryRun }) { hostCalls++; assert.equal(dryRun, true); return { status: 0, available: true, stdout: 'Would install selected host\n' }; },
    });
    assert.equal(hostCalls, 1);
    assert.equal(report.status, 'preview');
    assert.match(report.actions.find(item => item.id === 'init').preview, /\/notes\/prompts\/\*\.md/);
    assert.equal(report.actions.find(item => item.id === 'plan').path, path.join(repo, 'notes/plans/bootstrap.md'));
    assert.deepEqual(snapshot(), before);
    assert.equal(process.exitCode, 0);
  });

  it('creates selected folders, explicit ignore rules and a validated user-authored first plan', async () => {
    const { report } = await setup(['--yes', '--docs-root', "team's-notes", '--prompt-tracking', 'tracked', '--gitignore', ...authored]);
    assert.equal(report.status, 'completed', JSON.stringify(report.failed));
    assert.equal(report.mode, 'apply');
    assert.equal(report.checks.firstPlan.status, 'passed');
    assert.deepEqual(report.checks.project.errors, []);
    assert.ok(!existsSync(path.join(repo, 'docs')));
    assert.ok(existsSync(path.join(repo, "team's-notes/plans/.gitkeep")));
    assert.ok(!existsSync(path.join(repo, "team's-notes/plans/example-plan.md")));
    const plan = readFileSync(path.join(repo, "team's-notes/plans/bootstrap.md"), 'utf8');
    assert.match(plan, /current_state: The project has no document workflow yet\./);
    assert.match(plan, /next_step: Write a specification for the first release\./);
    const config = await resolveConfig(repo);
    assert.equal(config.docsRoot, path.join(repo, "team's-notes"));
    assert.equal(config.promptTracking, 'tracked');
    assert.equal(readFileSync(path.join(repo, '.gitignore'), 'utf8'), '.runlist/\n.dotmd/\n');
    assert.ok(!report.outstanding.some(item => /example sample/.test(item.description)));
  });

  it('adopts only selected exact files and reports pre-existing errors separately', async () => {
    const source = `export const root = 'notes';\nexport const promptTracking = 'tracked';\nexport function validate() { throw new Error('Do not execute custom validation during setup'); }\n`;
    put('runlist.config.mjs', source);
    put('notes/selected.md', '# Selected note\n');
    put('notes/untouched.md', '# Untouched note\n');
    const { report, output } = await setup(['--yes', '--adopt', 'notes/selected.md']);
    assert.equal(report.status, 'attention');
    assert.equal(process.exitCode, 1);
    assert.deepEqual(report.failed, []);
    assert.equal(readFileSync(path.join(repo, 'runlist.config.mjs'), 'utf8'), source);
    assert.match(readFileSync(path.join(repo, 'notes/selected.md'), 'utf8'), /type: doc\nstatus: draft/);
    assert.equal(readFileSync(path.join(repo, 'notes/untouched.md'), 'utf8'), '# Untouched note\n');
    assert.ok(report.checks.project.errors.length > 0);
    assert.match(output, /Custom validate hooks were not executed.*runlist check/);
    assert.equal(report.choices.promptTracking, 'tracked');
  });

  it('uses a fresh config after a narrow policy edit and preserves hooks and configured layouts', async () => {
    const source = `export const root = ['notes/plans', 'notes/prompts'];\nexport const promptTracking = 'tracked';\nexport function onNew() {}\n`;
    put('runlist.config.mjs', source);
    mkdirSync(path.join(repo, 'notes/plans'), { recursive: true });
    mkdirSync(path.join(repo, 'notes/prompts'));
    const { report } = await setup(['--yes', '--prompt-tracking', 'local', '--gitignore']);
    assert.equal(report.status, 'completed', JSON.stringify(report.failed));
    assert.equal(readFileSync(path.join(repo, 'runlist.config.mjs'), 'utf8'), source.replace("'tracked'", "'local'"));
    assert.match(readFileSync(path.join(repo, '.gitignore'), 'utf8'), /\/notes\/prompts\/\*\.md/);
    assert.ok(!existsSync(path.join(repo, 'notes/plans/plans')));
    assert.ok(!existsSync(path.join(repo, 'docs')));
  });

  it('preserves an explicit config selected outside cwd in every child step', async () => {
    put('custom.mjs', `export const root = 'notes';\nexport const promptTracking = 'local';\n`);
    put('notes/picked.md', '---\nupdated: 2026-10-28\nsummary: Existing authored note.\n---\n# Selected note\n');
    mkdirSync(path.join(repo, 'subdir'));
    const config = await resolveConfig(path.join(repo, 'subdir'), path.join(repo, 'custom.mjs'));
    const { report } = await setup(['--yes', '--prompt-tracking', 'tracked', '--adopt', 'notes/picked.md'], { config });
    assert.equal(report.status, 'completed', JSON.stringify(report.failed));
    assert.match(readFileSync(path.join(repo, 'custom.mjs'), 'utf8'), /promptTracking = 'tracked'/);
    assert.ok(!existsSync(path.join(repo, 'runlist.config.mjs')));
    assert.ok(!existsSync(path.join(repo, 'subdir/docs')));
  });

  it('previews required adoption metadata and validates selected source before any writes', async () => {
    put('docs/selected.md', '# Selected note\n');
    const before = snapshot();
    const preview = await setup(['--adopt', 'docs/selected.md']);
    const action = preview.report.actions.find(item => item.id.startsWith('adopt:'));
    assert.match(action.preview, /Frontmatter before:\n\(none\)/);
    assert.match(action.preview, /updated: \d{4}-\d{2}-\d{2}/);
    assert.deepEqual(action.checks.errors, []);
    assert.deepEqual(snapshot(), before);
    const { report } = await setup(['--yes', '--adopt', 'docs/selected.md']);
    assert.equal(report.status, 'completed', JSON.stringify(report.failed));
    assert.deepEqual(report.checks.project.errors, []);
    assert.match(readFileSync(path.join(repo, 'docs/selected.md'), 'utf8'), new RegExp(`updated: ${new Date().toISOString().slice(0, 10)}`));
  });

  it('leaves a pre-existing example sample unchanged and explains its presence', async () => {
    const sample = '---\ntype: plan\nstatus: planned\nupdated: 2026-10-28\nsummary: Existing sample.\ncurrent_state: This existing example is already present.\nnext_step: Decide whether the sample is still useful.\n---\n# Example Plan\n';
    put('docs/plans/example-plan.md', sample);
    const { report } = await setup(['--yes', ...authored]);
    assert.equal(report.status, 'completed', JSON.stringify(report.failed));
    assert.equal(readFileSync(path.join(repo, 'docs/plans/example-plan.md'), 'utf8'), sample);
    assert.ok(report.outstanding.some(item => /existing example sample is preserved unchanged/.test(item.description)));
  });

  it('human apply output describes completed actions without replaying preview text', async () => {
    const { report, output } = await setup(['--yes', ...authored]);
    assert.equal(report.status, 'completed');
    assert.match(output, /Completed:/);
    assert.match(output, /bootstrap.md/);
    assert.doesNotMatch(output, /\[dry-run\]|Ready to initialize|Frontmatter before:/);
  });

  it('explains the legacy local policy without describing it as an explicit user choice', async () => {
    put('runlist.config.mjs', "export const root = 'notes';\n");
    const { report, output } = await setup([]);
    assert.equal(report.status, 'preview');
    assert.match(output, /legacy compatibility default preserved; choose --prompt-tracking explicitly/);
    assert.match(output, /local — the guard denies prompt Git operations/);
    assert.doesNotMatch(output, /Leave pending prompts untracked to reduce commit churn/);
  });
});

describe('setup validates the whole selection before writes', () => {
  for (const [name, args] of [
    ['missing state', ['--first-plan', 'bootstrap', '--next-step', 'Write a project specification.']],
    ['placeholder state', ['--first-plan', 'bootstrap', '--current-state', 'placeholder', '--next-step', 'Write a project specification.']],
    ['oversized state', ['--first-plan', 'bootstrap', '--current-state', 'a'.repeat(1501), '--next-step', 'Write a project specification.']],
    ['oversized next step', ['--first-plan', 'bootstrap', '--current-state', 'No workflow is configured yet.', '--next-step', 'a'.repeat(801)]],
    ['state without a plan', ['--current-state', 'No workflow is configured yet.']],
    ['bad slug', ['--first-plan', '../bootstrap', ...authored.slice(2)]],
    ['root traversal', ['--docs-root', '../notes']],
    ['invalid policy', ['--prompt-tracking', 'invalid']],
    ['invalid host', ['--host', 'desktop']],
    ['unknown option', ['--silent']],
    ['glob adoption', ['--adopt', 'docs/*.md']],
    ['missing adoption', ['--adopt', 'docs/missing.md']],
    ['directory adoption', ['--adopt', 'docs']],
  ]) it(`rejects ${name} before config, ignore, or scaffolding writes`, async () => {
    const before = snapshot();
    const { report } = await setup(['--yes', '--gitignore', ...args]);
    assert.equal(report.status, 'failed');
    assert.equal(process.exitCode, 1);
    assert.deepEqual(report.completed, []);
    assert.deepEqual(snapshot(), before);
  });

  it('refuses a different root for existing config, preserving config and all files', async () => {
    put('runlist.config.mjs', `export const root = 'notes';\n`);
    const before = snapshot();
    const { report } = await setup(['--yes', '--docs-root', 'other', '--gitignore']);
    assert.match(report.failed[0].description, /Edit the root export manually/);
    assert.deepEqual(snapshot(), before);
  });

  it('does not redirect an explicitly selected missing config to a different file', async () => {
    const config = await resolveConfig(repo, path.join(repo, 'missing-config.mjs'));
    const before = snapshot();
    const { report } = await setup(['--yes'], { config });
    assert.equal(report.status, 'failed');
    assert.match(report.failed[0].description, /selected config does not exist/);
    assert.deepEqual(snapshot(), before);
  });

  it('refuses a computed policy edit before scaffolding or ignore changes', async () => {
    put('runlist.config.mjs', `export const root = 'notes';\nexport const promptTracking = ['tracked'][0];\n`);
    const before = snapshot();
    const { report } = await setup(['--yes', '--prompt-tracking', 'untracked', '--gitignore']);
    assert.equal(report.status, 'failed');
    assert.match(report.failed[0].description, /manually/);
    assert.deepEqual(snapshot(), before);
  });

  it('refuses plan collisions before an otherwise valid policy edit and adoption', async () => {
    put('runlist.config.mjs', `export const root = 'docs';\nexport const promptTracking = 'tracked';\n`);
    put('docs/plans/bootstrap.md', '# Existing plan\n');
    put('docs/picked.md', '# Existing note\n');
    const before = snapshot();
    const { report } = await setup(['--yes', '--gitignore', '--prompt-tracking', 'local', '--adopt', 'docs/picked.md', ...authored]);
    assert.match(report.failed[0].description, /already exists/);
    assert.deepEqual(snapshot(), before);
  });

  it('can explicitly create the example-plan slug without adding another sample', async () => {
    const { report } = await setup(['--yes', '--first-plan', 'example-plan', ...authored.slice(2)]);
    assert.equal(report.status, 'completed', JSON.stringify(report.failed));
    assert.match(readFileSync(path.join(repo, 'docs/plans/example-plan.md'), 'utf8'), /The project has no document workflow yet/);
  });

  it('refuses outside adoption and direct or escaping symlinks before writes', async t => {
    if (process.platform === 'win32') return t.skip('Symlink creation requires Windows privileges.');
    put('outside.md', '# Outside the managed docs\n');
    mkdirSync(path.join(repo, 'docs'));
    symlinkSync(path.join(repo, 'outside.md'), path.join(repo, 'docs/alias.md'));
    symlinkSync(fixture, path.join(repo, 'docs/escape'), 'dir');
    writeFileSync(path.join(fixture, 'external.md'), '# Outside project\n');
    for (const file of ['outside.md', 'docs/alias.md', 'docs/escape/external.md']) {
      const before = snapshot();
      const { report } = await setup(['--yes', '--gitignore', '--adopt', file]);
      assert.equal(report.status, 'failed');
      assert.deepEqual(snapshot(), before);
    }
  });

  it('refuses a symlinked .gitignore before any other effect', async t => {
    if (process.platform === 'win32') return t.skip('Symlink creation requires Windows privileges.');
    writeFileSync(path.join(fixture, 'ignore'), '# Keep this\n');
    symlinkSync(path.join(fixture, 'ignore'), path.join(repo, '.gitignore'));
    const before = snapshot();
    const { report } = await setup(['--yes', '--gitignore', ...authored]);
    assert.equal(report.status, 'failed');
    assert.deepEqual(snapshot(), before);
    assert.equal(readFileSync(path.join(fixture, 'ignore'), 'utf8'), '# Keep this\n');
  });

  it('does not execute custom template JavaScript to validate a first-plan preview', async () => {
    put('runlist.config.mjs', `export const root = 'docs';\nexport const templates = {plan: {body() { throw new Error('unexpected template execution'); }}};\n`);
    const before = snapshot();
    const { report } = await setup(['--yes', ...authored]);
    assert.equal(report.status, 'failed');
    assert.match(report.failed[0].description, /custom plan template/);
    assert.deepEqual(snapshot(), before);
  });

  it('refuses selected document validation errors before any policy, ignore or scaffold changes', async () => {
    put('runlist.config.mjs', "export const root = 'notes';\nexport const promptTracking = 'tracked';\n");
    put('notes/selected.md', '---\ntype: doc\nstatus: draft\nupdated: 2026-10-28\nrelated_docs:\n  - missing.md\n---\n# Selected note\n');
    const before = snapshot();
    const { report } = await setup(['--yes', '--gitignore', '--prompt-tracking', 'local', '--adopt', 'notes/selected.md']);
    assert.equal(report.status, 'failed');
    assert.match(report.failed[0].description, /Selected adoption failed validation before writing/);
    assert.deepEqual(snapshot(), before);
  });
});

describe('interactive setup cancellation and confirmation', () => {
  it('collects and validates every choice before confirmation or writes', async () => {
    const before = snapshot();
    const answers = ['notes', 'tracked', 'yes', 'none', 'bootstrap', 'The project has no document workflow yet.', 'Write a specification for the first release.', '', 'no'];
    let count = 0;
    const { report } = await setup([], { interactive: true, ask(question) {
      assert.deepEqual(snapshot(), before, `Unexpected write at question ${question}`);
      count++;
      return Promise.resolve(answers.shift() ?? null);
    } });
    assert.equal(count, 9);
    assert.equal(report.status, 'cancelled');
    assert.deepEqual(snapshot(), before);
  });

  it('applies only after an affirmative confirmation of the concrete preview', async () => {
    const before = snapshot();
    const answers = ['notes', '', '', '', '', '', 'yes'];
    const { report, output } = await setup([], { interactive: true, ask(question) {
      assert.deepEqual(snapshot(), before);
      if (question.startsWith('Apply')) assert.equal(answers.length, 1);
      return Promise.resolve(answers.shift() ?? null);
    } });
    assert.equal(report.status, 'completed', JSON.stringify(report.failed));
    assert.ok(existsSync(path.join(repo, 'notes/plans/.gitkeep')));
    assert.match(output, /Setup preview/);
    assert.match(output, /Setup completed/);
  });

  for (const answers of [[], ['docs', 'untracked', 'no', 'none', '', ''], ['cancel']]) {
    it(`handles EOF/cancellation after ${answers.length} answers without writes or hanging`, async () => {
      const before = snapshot();
      const input = Readable.from(answers.map(answer => `${answer}\n`));
      const { report } = await setup([], { interactive: true, input, prompts: { write() {} } });
      assert.equal(report.status, 'cancelled');
      assert.deepEqual(snapshot(), before);
    });
  }

  it('refuses changed adoption sources after the preview is confirmed', async () => {
    put('docs/picked.md', '# Before review\n');
    const { report } = await setup(['--adopt', 'docs/picked.md'], { interactive: true, ask(question) {
      if (question.startsWith('Apply')) { put('docs/picked.md', '# Edited during review\n'); return Promise.resolve('yes'); }
      return Promise.resolve('');
    } });
    assert.equal(report.status, 'failed');
    assert.match(report.failed[0].description, /source changed|sources changed/);
    assert.ok(!existsSync(path.join(repo, 'runlist.config.mjs')));
    assert.ok(!existsSync(path.join(repo, '.gitignore')));
  });
});

describe('explicit host work and real CLI effects', () => {
  it('never invokes any host by default', async () => {
    mkdirSync(path.join(process.env.HOME, '.claude'));
    const { report } = await setup(['--yes'], { hostRunner() { throw new Error('Unexpected host invocation'); } });
    assert.equal(report.status, 'completed');
    assert.equal(report.checks.host, null);
    assert.doesNotMatch(report.actions.find(item => item.id === 'init').preview, /\/plugin install|SessionStart|A few starting points/);
  });

  it('isolates failed dry-run host status and never applies in preview mode', async () => {
    const before = snapshot();
    const { report } = await setup(['--host', 'codex'], { hostRunner({ dryRun }) {
      assert.equal(dryRun, true);
      return { status: 1, available: false, stderr: 'CLI unavailable\n' };
    } });
    assert.equal(report.status, 'preview');
    assert.equal(process.exitCode, 0);
    assert.ok(report.outstanding.some(item => /unavailable/.test(item.description)));
    assert.deepEqual(snapshot(), before);
  });

  it('applies the explicit host verb only after project setup and reports reload outstanding', async () => {
    const calls = [];
    const { report } = await setup(['--yes', '--host', 'claude'], { hostRunner(request) {
      calls.push(request);
      assert.equal(existsSync(path.join(repo, 'runlist.config.mjs')), !request.dryRun);
      return { status: 0, available: true, stdout: 'Stubbed install\n' };
    } });
    assert.deepEqual(calls.map(call => call.dryRun), [true, false]);
    assert.equal(report.status, 'completed');
    assert.ok(report.completed.some(item => item.id === 'host'));
    assert.ok(report.outstanding.some(item => /Reload\/restart claude.*unverified/.test(item.description)));
  });

  for (const available of [true, false]) it(`reports ${available ? 'failed' : 'unavailable'} host work with project changes retained`, async () => {
    const { report } = await setup(['--yes', '--host', 'codex'], { hostRunner({ dryRun }) {
      return { status: dryRun ? 0 : 7, available, stderr: dryRun ? '' : 'Synthetic installer failure\n' };
    } });
    assert.equal(report.status, 'partial');
    assert.equal(process.exitCode, 1);
    assert.ok(existsSync(path.join(repo, 'runlist.config.mjs')));
    assert.ok(report.completed.some(item => item.id === 'init'));
    assert.match(report.failed[0].description, available ? /install failed \(exit 7\)/ : /unavailable/);
  });

  it('actual CLI previews without hanging or writing, then applies with --yes', () => {
    const before = snapshot();
    const preview = cli(['setup', '--json']);
    assert.equal(preview.status, 0, preview.stderr);
    assert.equal(JSON.parse(preview.stdout).status, 'preview');
    assert.deepEqual(snapshot(), before);
    const applied = cli(['setup', '--json', '--yes', '--docs-root', 'notes', ...authored]);
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    assert.equal(JSON.parse(applied.stdout).checks.firstPlan.status, 'passed');
    assert.ok(existsSync(path.join(repo, 'notes/plans/bootstrap.md')));
    assert.ok(!existsSync(path.join(repo, '.gitignore')));
    const git = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' });
    assert.match(git.stdout, /notes\/plans\/bootstrap.md/);
  });

  it('actual CLI dry-run overrides --yes and resolves --config from a subdirectory', () => {
    put('selected.mjs', `export const root = 'notes';\nexport const promptTracking = 'tracked';\n`);
    mkdirSync(path.join(repo, 'nested'));
    const before = snapshot();
    const result = cli(['--config', '../selected.mjs', '--dry-run', 'setup', '--yes', '--prompt-tracking', 'local', '--gitignore', '--json'], path.join(repo, 'nested'));
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).status, 'preview');
    assert.deepEqual(snapshot(), before);
  });
});
