import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, throws } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { bumpVersion, isAllowed, listDirtyFiles } from '../src/ship.mjs';
import { assertGitIndex, listStagedPaths } from '../src/git.mjs';

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

  it('refuses an inherited staged file without altering the index', () => {
    setupRepo();
    writeFileSync(path.join(tmpDir, 'secret.env'), 'SUPER_SECRET=1\n');
    spawnSync('git', ['add', 'secret.env'], { cwd: tmpDir });
    writeFileSync(path.join(tmpDir, 'docs', 'note.md'), '# Note\n');

    const result = run(['ship', '--dry-run']);
    ok(result.status !== 0, 'ship should refuse inherited staged files');
    ok(/inherited staged files/i.test(result.stderr), `expected staged-index error, got: ${result.stderr}`);
    strictEqual(listStagedPaths(tmpDir).join(','), 'secret.env');
  });

  it('requires the staged index to exactly match the accepted paths', () => {
    setupRepo();
    writeFileSync(path.join(tmpDir, 'docs', 'note.md'), '# Note\n');
    writeFileSync(path.join(tmpDir, 'secret.env'), 'SUPER_SECRET=1\n');
    spawnSync('git', ['add', 'docs/note.md', 'secret.env'], { cwd: tmpDir });

    throws(() => assertGitIndex(tmpDir, ['docs/note.md']), /secret\.env/);
    strictEqual(listStagedPaths(tmpDir).sort().join(','), 'docs/note.md,secret.env');
  });

  it('preversion refuses a staged file even when npm version uses --force', { skip: process.platform === 'win32' && 'release automation is POSIX-only' }, () => {
    setupRepo();
    const pkgPath = path.join(tmpDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    pkg.scripts.preversion = `node ${JSON.stringify(path.resolve(import.meta.dirname, '..', 'scripts', 'release-preflight.mjs'))}`;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    spawnSync('git', ['add', 'package.json'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'add preversion'], { cwd: tmpDir });
    writeFileSync(path.join(tmpDir, 'secret.env'), 'SUPER_SECRET=1\n');
    spawnSync('git', ['add', 'secret.env'], { cwd: tmpDir });

    const result = spawnSync('npm', ['version', 'patch', '--force'], {
      cwd: tmpDir,
      encoding: 'utf8',
    });
    ok(result.status !== 0, 'preversion should block the forced bump');
    ok(/release preflight failed/.test(result.stderr), `expected preflight failure, got: ${result.stderr}`);
    strictEqual(JSON.parse(readFileSync(pkgPath, 'utf8')).version, '0.5.0');
    strictEqual(spawnSync('git', ['tag', '--list', 'v0.5.1'], { cwd: tmpDir, encoding: 'utf8' }).stdout, '');
    strictEqual(listStagedPaths(tmpDir).join(','), 'secret.env');
  });

  it('refuses skipped dirty files before creating a preparation commit', () => {
    setupRepo();
    const before = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout;
    writeFileSync(path.join(tmpDir, 'secret.env'), 'SUPER_SECRET=1\n');
    writeFileSync(path.join(tmpDir, 'docs', 'note.md'), '# Note\n');

    const result = run(['ship']);
    ok(result.status !== 0, 'ship should fail before npm version');
    ok(/skipped files are dirty/i.test(result.stderr), `expected skipped-file refusal, got: ${result.stderr}`);
    strictEqual(spawnSync('git', ['rev-parse', 'HEAD'], { cwd: tmpDir, encoding: 'utf8' }).stdout, before);
    strictEqual(listStagedPaths(tmpDir).length, 0);
  });

  it('reads unusual dirty paths without porcelain quoting loss', { skip: process.platform === 'win32' && 'Windows forbids these filename characters' }, () => {
    setupRepo();
    const names = ['docs/arrow -> note.md', 'docs/unicøde.md', 'docs/line\nbreak.md'];
    for (const name of names) writeFileSync(path.join(tmpDir, name), '# Note\n');
    const dirty = listDirtyFiles(tmpDir).map(entry => entry.path);
    for (const name of names) ok(dirty.includes(name), `missing exact path ${JSON.stringify(name)} in ${JSON.stringify(dirty)}`);
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

// `npm version` is canonical. Product changes must already be committed by its
// clean-tree preflight; the lifecycle stages only the two versioned manifests.
describe('npm version lifecycle prepares release artifacts', () => {
  it('git-adds only the synchronized plugin manifests', () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'),
    );
    const versionScript = pkg.scripts.version ?? '';
    strictEqual(versionScript, 'node scripts/prepare-version-commit.mjs');
    const prepareScript = readFileSync(
      path.resolve(import.meta.dirname, '..', 'scripts', 'prepare-version-commit.mjs'),
      'utf8',
    );
    // The point is that the version commit stages nothing beyond what it
    // synchronized itself: the plugin manifests, plus CHANGELOG.md when it
    // promoted the Unreleased heading. `test/release-lifecycle.test.mjs` covers
    // the resulting index for both cases; this guards the derivation so no
    // unrelated path can be appended to the add.
    ok(prepareScript.includes("['add', '--', ...stagedPaths]"),
      'version preparation should stage exactly the paths it derived');
    ok(prepareScript.includes('const stagedPaths = changelogStamped ? [...MANIFEST_PATHS, CHANGELOG_PATH] : MANIFEST_PATHS;'),
      'staged paths should come only from the synchronized manifests and the stamped changelog');
    ok(prepareScript.includes('assertGitIndex(projectRoot, stagedPaths)'),
      'version preparation should assert the index matches exactly what it staged');
  });

  it('does not mask plugin sync or staging failures', () => {
    const pkg = JSON.parse(
      readFileSync(path.resolve(import.meta.dirname, '..', 'package.json'), 'utf8'),
    );
    const versionScript = pkg.scripts.version ?? '';
    ok(!/;\s*true\s*$/.test(versionScript),
      `version script must not force a successful exit, got: ${versionScript}`);
    ok(!versionScript.includes('.claude/commands'),
      `version script should not stage retired generated commands, got: ${versionScript}`);
    strictEqual(pkg.scripts['release:resume'], 'node scripts/recover-local-release.mjs && bash scripts/postversion.sh');
    ok(pkg.scripts.preversion.startsWith('node scripts/release-preflight.mjs &&'),
      `preversion must refuse inherited staged files before tests, got: ${pkg.scripts.preversion}`);
  });

  it('postversion synchronizes every PATH-visible CLI copy', () => {
    const script = readFileSync(path.resolve(import.meta.dirname, '..', 'scripts', 'postversion.sh'), 'utf8');
    ok(script.includes('scripts/sync-global-cli.mjs'), 'postversion should run the global CLI synchronizer');
    ok(script.includes('scripts/verify-installed-plugin.mjs'), 'postversion should verify the installed plugin record');
    ok(script.includes('npm run release:resume'), 'push failure should print the resumable recovery command');
    ok(/gh release view/.test(script), 'GitHub release creation should be idempotent for resume mode');
    ok(script.includes('git push --atomic origin "HEAD:refs/heads/main" "refs/tags/${TAG}:refs/tags/${TAG}"'),
      'postversion should atomically push only main and the intended tag');
    ok(!script.includes('--tags'), 'postversion must not push unrelated local tags');
    ok(script.includes('headBranch==\\"${TAG}\\"'), 'workflow lookup should match the release tag as well as SHA');
    ok(script.includes('gh run rerun "${RID}" --failed'), 'resume should be able to rerun a failed publish workflow');
  });
});
