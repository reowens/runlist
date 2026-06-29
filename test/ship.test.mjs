import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { bumpVersion, isAllowed } from '../src/ship.mjs';

let tmpDir;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('bumpVersion', () => {
  it('bumps patch', () => strictEqual(bumpVersion('0.41.1', 'patch'), '0.41.2'));
  it('bumps minor (resets patch)', () => strictEqual(bumpVersion('0.41.5', 'minor'), '0.42.0'));
  it('bumps major (resets minor + patch)', () => strictEqual(bumpVersion('0.41.5', 'major'), '1.0.0'));
});

describe('isAllowed', () => {
  it('allows release-shaped paths', () => {
    ok(isAllowed('src/ship.mjs'));
    ok(isAllowed('test/ship.test.mjs'));
    ok(isAllowed('bin/dotmd.mjs'));
    ok(isAllowed('docs/plans/foo.md'));
    ok(isAllowed('.claude/commands/plans.md'));
    // Plugin artifacts ship in lockstep with the CLI.
    ok(isAllowed('plugins/dotmd/skills/dotmd/SKILL.md'));
    ok(isAllowed('plugins/dotmd/commands/plans.md'));
    ok(isAllowed('plugins/dotmd/hooks.json'));
    ok(isAllowed('plugins/dotmd/bin/dotmd-hook'));
    ok(isAllowed('plugins/dotmd/.claude-plugin/plugin.json'));
    ok(isAllowed('.claude-plugin/marketplace.json'));
    ok(isAllowed('package.json'));
    ok(isAllowed('package-lock.json'));
    ok(isAllowed('dotmd.config.mjs'));
    ok(isAllowed('README.md'));
    ok(isAllowed('CLAUDE.md'));
    ok(isAllowed('CHANGELOG.md'));
    ok(isAllowed('.gitignore'));
  });

  it('refuses paths outside the release-relevant set', () => {
    ok(!isAllowed('.env'));
    ok(!isAllowed('.claude/settings.local.json'));
    ok(!isAllowed('.claude/scheduled_tasks.lock'));
    ok(!isAllowed('node_modules/foo/bar.js'));
    ok(!isAllowed('credentials.json'));
    ok(!isAllowed('scratch/notes.md'));
    ok(!isAllowed('.dotmd/in-session.json'));
  });
});

describe('dotmd ship (--dry-run, end-to-end)', () => {
  function setupRepo() {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-ship-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    writeFileSync(path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'demo', version: '0.5.0', scripts: { test: 'true' } }, null, 2));
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });
  }

  function run(args) {
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
    return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir,
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH },
    });
  }

  it('reads pkg version + previews the bump', () => {
    setupRepo();
    writeFileSync(path.join(tmpDir, 'src.dummy'), '');
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\nupdated: 2025-01-01\n---\n# A\n');

    const result = run(['ship', '--dry-run']);
    strictEqual(result.status, 0, `ship dry-run should succeed: ${result.stderr}`);
    ok(result.stdout.includes('0.5.0 → 0.5.1'), `should preview patch bump, got:\n${result.stdout}`);
    ok(result.stdout.includes('[dry-run]'), `should mark dry-run, got:\n${result.stdout}`);
  });

  it('supports minor and major bumps', () => {
    setupRepo();
    const minor = run(['ship', 'minor', '--dry-run']);
    strictEqual(minor.status, 0);
    ok(minor.stdout.includes('0.5.0 → 0.6.0'), `minor bump, got:\n${minor.stdout}`);

    const major = run(['ship', 'major', '--dry-run']);
    strictEqual(major.status, 0);
    ok(major.stdout.includes('0.5.0 → 1.0.0'), `major bump, got:\n${major.stdout}`);
  });

  it('rejects unknown bump arg', () => {
    setupRepo();
    const result = run(['ship', 'mega', '--dry-run']);
    ok(result.status !== 0, 'should fail');
    ok(/Invalid bump/.test(result.stderr), `expected validation error, got: ${result.stderr}`);
  });

  it('does not stage files outside the allowlist', () => {
    setupRepo();
    // Untracked file outside the allowlist
    writeFileSync(path.join(tmpDir, 'secret.env'), 'SUPER_SECRET=1\n');
    // Untracked file inside the allowlist
    writeFileSync(path.join(tmpDir, 'docs', 'note.md'),
      '---\nstatus: active\nupdated: 2025-01-01\n---\n# Note\n');

    const result = run(['ship', '--dry-run']);
    strictEqual(result.status, 0, `dry-run should succeed: ${result.stderr}`);
    ok(result.stdout.includes('docs/note.md'), `allowed file should be queued for staging, got:\n${result.stdout}`);
    ok(!/Would stage[\s\S]*secret\.env/.test(result.stdout),
      `secret.env should NOT be in the would-stage list, got:\n${result.stdout}`);
    ok(/secret\.env/.test(result.stderr),
      `should warn about skipped non-allowlist file, got:\n${result.stderr}`);
  });

  it('stages dirty plugin artifacts (plugin ships in lockstep)', () => {
    setupRepo();
    mkdirSync(path.join(tmpDir, 'plugins', 'dotmd', 'skills', 'dotmd'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'plugins', 'dotmd', 'skills', 'dotmd', 'SKILL.md'), '# skill\n');
    mkdirSync(path.join(tmpDir, '.claude-plugin'), { recursive: true });
    writeFileSync(path.join(tmpDir, '.claude-plugin', 'marketplace.json'), '{}\n');
    // Outside the allowlist — must stay skipped even with plugin files present.
    writeFileSync(path.join(tmpDir, 'secret.env'), 'X=1\n');

    const result = run(['ship', '--dry-run']);
    strictEqual(result.status, 0, `dry-run should succeed: ${result.stderr}`);
    ok(/plugins\/dotmd\/skills\/dotmd\/SKILL\.md/.test(result.stdout),
      `plugin SKILL.md should be queued for staging, got:\n${result.stdout}`);
    ok(/\.claude-plugin\/marketplace\.json/.test(result.stdout),
      `marketplace manifest should be queued for staging, got:\n${result.stdout}`);
    ok(!/Would stage[\s\S]*secret\.env/.test(result.stdout),
      `secret.env must not be staged, got:\n${result.stdout}`);
  });

  it('does not regenerate slash commands (scaffolding is retired)', () => {
    setupRepo();
    mkdirSync(path.join(tmpDir, '.claude', 'commands'), { recursive: true });
    // A leftover generated slash-command file should not trigger any regen
    // step at ship time — the dotmd plugin owns the workflow now.
    writeFileSync(path.join(tmpDir, '.claude', 'commands', 'plans.md'),
      '---\ndescription: stale\n---\n<!-- dotmd-generated: 0.0.1 -->\nbody\n');

    const result = run(['ship', '--dry-run']);
    strictEqual(result.status, 0, `dry-run should succeed: ${result.stderr}`);
    ok(!/regenerate slash commands/i.test(result.stdout),
      `ship must not mention slash-command regeneration, got:\n${result.stdout}`);
  });
});

// The OTHER release path: `npm version` (the documented one). Its lifecycle
// script must stage the whole plugin tree, not just the version-stamped
// manifests, or an edited SKILL.md / command / hook never reaches the release.
describe('npm version lifecycle stages plugin artifacts', () => {
  it('git-adds the plugins/ and .claude-plugin/ trees', () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'),
    );
    const versionScript = pkg.scripts.version ?? '';
    ok(/git add\b[^;&|]*\bplugins\b/.test(versionScript),
      `version script should git add the plugins/ tree, got: ${versionScript}`);
    ok(/git add\b[^;&|]*\.claude-plugin\b/.test(versionScript),
      `version script should git add .claude-plugin/, got: ${versionScript}`);
  });
});
