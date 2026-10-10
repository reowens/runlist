import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { syncCargoVersion } from '../scripts/version.mjs';

function fixture(t, lock) {
  const root = mkdtempSync(path.join(tmpdir(), 'runlist-cargo-version-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src-tauri/src'), { recursive: true });
  writeFileSync(path.join(root, 'src-tauri/src/lib.rs'), '');
  writeFileSync(path.join(root, 'src-tauri/Cargo.toml'), '[package]\nname = "runlist-desktop"\nversion = "0.90.0"\nedition = "2021"\n');
  writeFileSync(path.join(root, 'src-tauri/Cargo.lock'), lock);
  return root;
}

test('release stamping changes only the desktop package and keeps locked metadata valid', t => {
  const root = fixture(t, 'version = 4\n\n[[package]]\nname = "runlist-desktop"\nversion = "0.90.0"\n');
  syncCargoVersion(root, '0.94.1');
  const lock = readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8');
  assert.match(lock, /name = "runlist-desktop"\nversion = "0.94.1"/);
  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' });
  if (cargo.error?.code === 'ENOENT') return t.skip('Cargo is unavailable');
  const metadata = spawnSync('cargo', ['metadata', '--locked', '--offline', '--no-deps', '--format-version', '1', '--manifest-path', path.join(root, 'src-tauri/Cargo.toml')], { encoding: 'utf8' });
  assert.equal(metadata.status, 0, metadata.stderr);
  assert.equal(JSON.parse(metadata.stdout).packages[0].version, '0.94.1');
  assert.equal(readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8'), lock);
});

test('dependency entries remain unchanged and missing root entries fail before either file is written', t => {
  const dependency = '[[package]]\nname = "other"\nversion = "0.90.0"\nchecksum = "fixture"\n';
  const root = fixture(t, 'version = 4\n\n'+dependency+'\n[[package]]\nname = "runlist-desktop"\nversion = "0.90.0"\n');
  syncCargoVersion(root, '0.94.1-rc.1');
  assert.ok(readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8').includes(dependency));
  writeFileSync(path.join(root, 'src-tauri/Cargo.lock'), dependency);
  const before = readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
  assert.throws(() => syncCargoVersion(root, '0.94.2'), /Expected one desktop package/);
  assert.equal(readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8'), before);
  assert.equal(readFileSync(path.join(root, 'src-tauri/Cargo.lock'), 'utf8'), dependency);
});
