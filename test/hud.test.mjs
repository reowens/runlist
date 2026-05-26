import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

let tmpDir;
const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-hud-'));
  spawnSync('git', ['init'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(path.join(docsDir, 'archived'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n`);
  // Pre-stamp the primer marker so the default test setup represents a
  // session that's already seen the teach-once primer. Tests that want to
  // exercise the first-session primer should delete this marker explicitly.
  mkdirSync(path.join(tmpDir, '.dotmd'), { recursive: true });
  writeFileSync(path.join(tmpDir, '.dotmd', 'primer-shown'), '');
  return docsDir;
}

function writeDoc(docsDir, filename, frontmatter, body = '') {
  const filePath = path.join(docsDir, filename);
  writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`);
  spawnSync('git', ['add', filePath], { cwd: tmpDir });
  spawnSync('git', ['commit', '-m', `add ${filename}`], { cwd: tmpDir });
  return filePath;
}

function runCli(args, { session = 'sess-A', input } = {}) {
  return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir,
    encoding: 'utf8',
    input,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: session, PATH: process.env.PATH },
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('dotmd hud', () => {
  it('is silent when there is nothing actionable', () => {
    setupProject();
    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    strictEqual(r.stdout, '', 'output should be empty when clean');
  });

  it('shows owned leases', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan-a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# A\n');
    runCli(['pickup', planPath]);

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(r.stdout.includes('You hold 1 plan'), `expected lease line, got: ${r.stdout}`);
    ok(r.stdout.includes('plan-a'), 'plan slug present');
  });

  it('--json returns structured output', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan-a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# A\n');
    runCli(['pickup', planPath]);

    const r = runCli(['hud', '--json']);
    strictEqual(r.status, 0, `hud --json failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    ok(Array.isArray(parsed.owned), 'owned is array');
    ok(Array.isArray(parsed.stale), 'stale is array');
    ok(Array.isArray(parsed.prompts), 'prompts is array');
    strictEqual(parsed.owned.length, 1);
    ok(parsed.owned[0].includes('plan-a'));
  });

  it('shows pending prompts with consume hint', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'prompts'), { recursive: true });
    writeDoc(docsDir, 'prompts/resume-me.md', 'type: prompt\nstatus: pending\ncreated: 2025-01-01', 'body');

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(r.stdout.includes('1 pending prompt'), `expected prompt line, got: ${r.stdout}`);
    ok(r.stdout.includes('resume-me'), 'prompt slug present');
    ok(r.stdout.includes('dotmd prompts use'), 'consume hint present');
  });

  it('finds prompts when the prompts/ dir is configured directly as a root (#6)', () => {
    // Custom setup: root list points straight at docs/prompts rather than
    // at docs/ as a parent containing a prompts/ subdir.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-hud-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    const promptsDir = path.join(tmpDir, 'docs', 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      path.join(tmpDir, 'dotmd.config.mjs'),
      `export const root = ['docs/prompts'];\n`,
    );
    const filePath = path.join(promptsDir, 'foo.md');
    writeFileSync(filePath, '---\ntype: prompt\nstatus: pending\ncreated: 2025-01-01\n---\nbody');
    spawnSync('git', ['add', filePath], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'add foo'], { cwd: tmpDir });

    const r = runCli(['hud', '--json']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    ok(
      parsed.prompts.some(p => p.endsWith('docs/prompts/foo.md')),
      `expected docs/prompts/foo.md in prompts, got: ${JSON.stringify(parsed.prompts)}`,
    );
  });

  it('does not list already-archived prompts', () => {
    const docsDir = setupProject();
    // Archived prompts live under prompts/archived/ (validator enforces this).
    mkdirSync(path.join(docsDir, 'prompts', 'archived'), { recursive: true });
    writeDoc(docsDir, 'prompts/archived/done.md', 'type: prompt\nstatus: archived\ncreated: 2025-01-01\nupdated: 2025-01-01', 'body');

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    strictEqual(r.stdout, '', 'no prompt line when only archived prompts exist');
  });

  it('does not list claimed prompts (default counted)', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'prompts'), { recursive: true });
    writeDoc(docsDir, 'prompts/in-progress.md', 'type: prompt\nstatus: claimed\ncreated: 2025-01-01\nupdated: 2025-01-01', 'body');

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    strictEqual(r.stdout, '', 'no prompt line when only claimed prompts exist');
  });

  it('surfaces prompts in custom-expanded statuses (config-driven)', () => {
    // User adds an `urgent` status to types.prompt.statuses with context: 'expanded'.
    // hud should treat it as actionable alongside pending — no code change needed.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-hud-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
    const promptsDir = path.join(tmpDir, 'docs', 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    writeFileSync(
      path.join(tmpDir, 'dotmd.config.mjs'),
      `export const root = 'docs';
export const types = {
  prompt: {
    statuses: {
      'pending':  { context: 'expanded', staleDays: 30 },
      'urgent':   { context: 'expanded' },
      'claimed':  { context: 'counted', quiet: true },
      'archived': { context: 'counted', archive: true, terminal: true, quiet: true },
    },
  },
};
`,
    );
    function write(name, fm) {
      const p = path.join(promptsDir, name);
      writeFileSync(p, `---\n${fm}\n---\nbody`);
      spawnSync('git', ['add', p], { cwd: tmpDir });
      spawnSync('git', ['commit', '-m', `add ${name}`], { cwd: tmpDir });
    }
    write('p1.md', 'type: prompt\nstatus: pending\ncreated: 2025-01-01');
    write('p2.md', 'type: prompt\nstatus: urgent\ncreated: 2025-01-01');
    write('p3.md', 'type: prompt\nstatus: claimed\ncreated: 2025-01-01\nupdated: 2025-01-01');

    const r = runCli(['hud', '--json']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    strictEqual(parsed.prompts.length, 2, `expected 2 actionable, got: ${JSON.stringify(parsed.prompts)}`);
    ok(parsed.prompts.some(p => p.endsWith('p1.md')), 'pending surfaced');
    ok(parsed.prompts.some(p => p.endsWith('p2.md')), 'urgent surfaced');
    ok(!parsed.prompts.some(p => p.endsWith('p3.md')), 'claimed NOT surfaced');
  });

  it('surfaces validation errors (not silent when check is failing)', () => {
    // Pre-fix: hud was documented as "silent when clean" but stayed silent
    // even when there were N validation errors. SessionStart hook firing hud
    // therefore left the agent with no signal that a doc was broken. Now an
    // error count gets a red line with the `dotmd check` hint.
    const docsDir = setupProject();
    // A doc that will fail validation: archive status but wrong location.
    writeDoc(docsDir, 'broken.md',
      'type: plan\nstatus: archived\nupdated: 2025-01-01', '# Broken\n');

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(/validation error/.test(r.stdout),
      `hud should surface validation error count; got: ${r.stdout}`);
    ok(r.stdout.includes('dotmd check'),
      `hud error line should hint at dotmd check; got: ${r.stdout}`);
  });

  it('--json includes errors count', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'broken.md',
      'type: plan\nstatus: archived\nupdated: 2025-01-01', '# Broken\n');

    const r = runCli(['hud', '--json']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    strictEqual(typeof parsed.errors, 'number', 'errors is a number in JSON output');
    ok(parsed.errors >= 1, `expected at least 1 error; got: ${parsed.errors}`);
  });

  it('self-heals stale slash-command files and surfaces a dim line', () => {
    // The SessionStart hook fires hud every session. When `.claude/commands/*.md`
    // banners are older than the installed dotmd version, hud should silently
    // regen them and surface a single dim line so the diff isn't a surprise.
    setupProject();
    const cmdDir = path.join(tmpDir, '.claude', 'commands');
    mkdirSync(cmdDir, { recursive: true });
    const batonPath = path.join(cmdDir, 'baton.md');
    writeFileSync(batonPath, '<!-- dotmd-generated: 0.0.1 -->\nstale body\n');

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(/slash commands refreshed/.test(r.stdout),
      `expected refresh line; got: ${r.stdout}`);
    ok(/0\.0\.1\s*→/.test(r.stdout),
      `refresh line should show version transition; got: ${r.stdout}`);
    ok(/baton\.md/.test(r.stdout),
      `refresh line should name the file; got: ${r.stdout}`);

    const content = readFileSync(batonPath, 'utf8');
    ok(!content.includes('dotmd-generated: 0.0.1'),
      'stale banner should be gone after refresh');
    ok(!content.includes('stale body'),
      'stale body should be replaced with regenerated content');
  });

  it('stays silent when slash-command banners are current', () => {
    // Inverse of the refresh test — when nothing is stale, the silent-clean
    // contract holds. Otherwise every session would print a refresh line.
    setupProject();
    const cmdDir = path.join(tmpDir, '.claude', 'commands');
    mkdirSync(cmdDir, { recursive: true });
    const pkgVersion = JSON.parse(readFileSync(
      path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8',
    )).version;
    // Plant a file with the CURRENT version banner.
    writeFileSync(
      path.join(cmdDir, 'baton.md'),
      `<!-- dotmd-generated: ${pkgVersion} -->\ncurrent body\n`,
    );

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    strictEqual(r.stdout, '',
      `hud should stay silent when banners are current; got: ${r.stdout}`);
  });

  it('does not touch user-managed slash-command files (no banner)', () => {
    // A file without the `dotmd-generated:` banner is treated as user-managed
    // by scaffoldClaudeCommands — the hud refresh path inherits that rule.
    setupProject();
    const cmdDir = path.join(tmpDir, '.claude', 'commands');
    mkdirSync(cmdDir, { recursive: true });
    const customPath = path.join(cmdDir, 'baton.md');
    const original = '# my hand-rolled baton, no dotmd marker\n';
    writeFileSync(customPath, original);

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(!/slash commands refreshed/.test(r.stdout),
      `should not announce a refresh for user-managed files; got: ${r.stdout}`);
    strictEqual(readFileSync(customPath, 'utf8'), original,
      'user-managed file must be left untouched');
  });

  it('survives missing .claude/ directory without erroring', () => {
    // SessionStart hook must not break for users who do not use Claude Code
    // and have no .claude/ dir at all. The scaffolder no-ops; hud follows.
    setupProject();
    ok(!existsSync(path.join(tmpDir, '.claude')), 'precondition: no .claude/');
    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    strictEqual(r.stdout, '', `expected silent run; got: ${r.stdout}`);
  });

  it('prints the teach-once primer on a fresh repo, then stays silent', () => {
    // On a clean repo with no actionable signals, hud was previously silent —
    // meaning a brand-new install gave Claude no hint that dotmd manages docs/.
    // First run should emit the primer line and drop a .dotmd/primer-shown
    // marker; second run on the same repo should be silent again.
    setupProject();
    // setupProject pre-stamps the marker for default silence; for THIS test
    // we want the fresh-install case, so remove it before the first run.
    rmSync(path.join(tmpDir, '.dotmd', 'primer-shown'), { force: true });

    const first = runCli(['hud']);
    strictEqual(first.status, 0, `hud failed: ${first.stderr}`);
    ok(/dotmd: managing/.test(first.stdout),
      `expected primer line on first run; got: ${first.stdout}`);
    ok(/dotmd new prompt/.test(first.stdout),
      `primer should mention the handoff command; got: ${first.stdout}`);
    ok(existsSync(path.join(tmpDir, '.dotmd', 'primer-shown')),
      'primer marker should be created after first run');

    const second = runCli(['hud']);
    strictEqual(second.status, 0, `hud failed: ${second.stderr}`);
    strictEqual(second.stdout, '',
      `hud should be silent after primer has been shown; got: ${second.stdout}`);
  });

  it('primer is skipped in --json mode (structured output stays stable)', () => {
    // Programmatic callers (e.g. tooling parsing hud --json) must not see
    // teach-text leak into the JSON payload, and the marker must not be
    // created as a side effect of a JSON probe.
    setupProject();
    rmSync(path.join(tmpDir, '.dotmd', 'primer-shown'), { force: true });

    const r = runCli(['hud', '--json']);
    strictEqual(r.status, 0, `hud --json failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    ok(typeof parsed === 'object', 'JSON output parses');
    ok(!('primer' in parsed), 'no primer field leaks into JSON');
    ok(!existsSync(path.join(tmpDir, '.dotmd', 'primer-shown')),
      'JSON mode should not create the primer marker');
  });

  it('output stays under ~500 bytes when full of common signals', () => {
    const docsDir = setupProject();
    for (let i = 0; i < 5; i++) {
      writeDoc(docsDir, `held-${i}.md`, 'type: plan\nstatus: active\nupdated: 2025-01-01', '# held\n');
      runCli(['pickup', `held-${i}.md`]);
    }
    mkdirSync(path.join(docsDir, 'prompts'), { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeDoc(docsDir, `prompts/p-${i}.md`, 'type: prompt\nstatus: pending\ncreated: 2025-01-01', 'body\n');
    }

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(r.stdout.length < 800, `hud output too large: ${r.stdout.length} bytes\n${r.stdout}`);
  });
});
