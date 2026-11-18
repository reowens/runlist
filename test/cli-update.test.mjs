import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyCli, updatePathCli, warnOtherVersions } from '../src/cli-update.mjs';

function fixture(t) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'runlist-update-'));
  t.after(() => {
    // Pinned artifacts are intentionally read-only.
    spawnSync('chmod', ['-R', 'u+w', tmp]);
    rmSync(tmp, { recursive: true, force: true });
  });
  const bin = path.join(tmp, 'bin');
  mkdirSync(bin);
  return { tmp, launcher: path.join(bin, 'runlist'), env: { ...process.env, PATH: [bin, path.dirname(process.execPath)].join(path.delimiter) } };
}

function packageAt(root, version) {
  mkdirSync(path.join(root, 'bin'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'runlist', version }));
  const entry = path.join(root, 'bin/runlist.mjs');
  writeFileSync(entry, `#!/usr/bin/env node\nconsole.log('${version}');\n`);
  chmodSync(entry, 0o755);
  return entry;
}

test('missing PATH CLI, unmanaged packages, checkout links and global prefix mismatch', { skip: process.platform === 'win32' }, t => {
  const { tmp, launcher, env } = fixture(t);
  assert.throws(() => classifyCli({ PATH: path.dirname(launcher) }), /No persistent/);
  const pkg = path.join(tmp, 'package');
  symlinkSync(packageAt(pkg, '1.0.0'), launcher);
  assert.throws(() => classifyCli(env), /Unrecognized/);
  mkdirSync(path.join(pkg, '.git'));
  assert.equal(classifyCli(env).kind, 'checkout');
  unlinkSync(launcher);
  symlinkSync(packageAt(path.join(tmp, 'lib/node_modules/runlist'), '1.0.0'), launcher);
  const target = classifyCli(env);
  assert.equal(target.kind, 'global');
  assert.throws(() => updatePathCli(target, env, (_, args) => {
    assert.deepEqual(args, ['prefix', '-g']);
    return { status: 0, stdout: os.tmpdir() };
  }), /differs from PATH/);
  if (process.getuid() !== 0) {
    chmodSync(target.root, 0o555);
    try {
      assert.throws(() => updatePathCli(target, env, (_, args) => {
        assert.deepEqual(args, ['prefix', '-g']);
        return { status: 0, stdout: tmp };
      }), /not writable/);
    } finally { chmodSync(target.root, 0o755); }
  }
  assert.throws(() => updatePathCli(target, env, (cmd, args, options) => cmd === 'npm'
    ? { status: 0, stdout: args[0] === 'prefix' ? tmp : args[0] === 'view' ? '{"version":"2.0.0"}' : '' }
    : spawnSync(cmd, args, options)), /expected 2.0.0/);
});

for (const scenario of ['success', 'integrity mismatch', 'link changed']) {
  test(`published pinned update: ${scenario}`, { skip: process.platform === 'win32' }, t => {
    const { tmp, launcher, env } = fixture(t);
    const old = path.join(tmp, 'old');
    const oldEntry = packageAt(path.join(old, 'package'), '1.0.0');
    writeFileSync(path.join(old, 'receipt.json'), JSON.stringify({ schemaVersion: 1, sourceCommit: 'a'.repeat(40),
      version: '1.0.0', files: { 'bin/runlist.mjs': 'b'.repeat(64) } }));
    symlinkSync(oldEntry, launcher);
    const entry = packageAt(path.join(tmp, 'package'), '2.0.0');
    const tarball = path.join(tmp, 'published.tgz');
    execFileSync('tar', ['-czf', tarball, '-C', tmp, 'package']);
    const integrity = 'sha512-' + createHash('sha512').update(scenario === 'integrity mismatch' ? 'bad' : readFileSync(tarball)).digest('base64');
    const run = (cmd, args, options) => {
      if (cmd !== 'npm') return spawnSync(cmd, args, options);
      if (args[0] === 'view') return { status: 0, stdout: JSON.stringify({ version: '2.0.0', 'dist.integrity': integrity }) };
      assert.equal(args[0], 'pack');
      copyFileSync(tarball, path.join(args.at(-1), 'runlist.tgz'));
      if (scenario === 'link changed') {
        unlinkSync(launcher);
        symlinkSync(entry, launcher);
      }
      return { status: 0, stdout: '[{"filename":"runlist.tgz"}]' };
    };
    const update = () => updatePathCli(classifyCli(env), env, run);
    if (scenario === 'success') {
      const selected = update();
      assert.equal(selected.kind, 'pinned');
      assert.equal(selected.version, '2.0.0');
      const repeated = update();
      assert.equal(repeated.entry, selected.entry);
      assert.equal(execFileSync(oldEntry, ['--version'], { encoding: 'utf8' }).trim(), '1.0.0');
    } else {
      assert.throws(update, scenario === 'link changed' ? /selection changed/ : /integrity differs/);
      assert.equal(readlinkSync(launcher), scenario === 'link changed' ? entry : oldEntry);
    }
  });
}

test('secondary PATH launchers warn once per distinct mismatched executable', { skip: process.platform === 'win32' }, t => {
  const { tmp, launcher, env } = fixture(t);
  const root = path.join(tmp, 'source');
  const entry = packageAt(root, '1.0.0');
  mkdirSync(path.join(root, '.git'));
  symlinkSync(entry, launcher);
  const other = packageAt(path.join(tmp, 'old'), '0.9.0');
  symlinkSync(other, path.join(tmp, 'bin', 'rl'));
  symlinkSync(other, path.join(tmp, 'bin', 'dotmd'));
  const writes = t.mock.method(process.stderr, 'write', () => true);
  warnOtherVersions(classifyCli(env), env, spawnSync);
  assert.equal(writes.mock.calls.length, 1);
  assert.match(writes.mock.calls[0].arguments[0], /rl reports 0\.9\.0; selected CLI is 1\.0\.0/);
});
