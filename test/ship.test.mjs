import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
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
    ok(isAllowed('package.json'));
    ok(isAllowed('package-lock.json'));
    ok(isAllowed('dotmd.config.mjs'));
    ok(isAllowed('README.md'));
    ok(isAllowed('CLAUDE.md'));
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

  it('regenerates slash commands at the TARGET version (not current)', () => {
    setupRepo();
    mkdirSync(path.join(tmpDir, '.claude', 'commands'), { recursive: true });
    // Seed an outdated slash-command file
    writeFileSync(path.join(tmpDir, '.claude', 'commands', 'plans.md'),
      '---\ndescription: stale\n---\n<!-- dotmd-generated: 0.0.1 -->\nbody\n');

    const result = run(['ship', '--dry-run']);
    strictEqual(result.status, 0, `dry-run should succeed: ${result.stderr}`);
    ok(result.stdout.includes('Would regenerate slash commands @ 0.5.1'),
      `regen line should reference the target version, got:\n${result.stdout}`);
  });
});
