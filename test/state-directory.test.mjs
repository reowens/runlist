import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { mkdirStateSync } from '../src/state-directory.mjs';
import { migrateStateDirectory } from '../src/state-migration.mjs';

const tmps = [];
function tmp() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runlist-state-dir-'));
  tmps.push(dir);
  return dir;
}
afterEach(() => { while (tmps.length) rmSync(tmps.pop(), { recursive: true, force: true }); });

describe('mkdirStateSync', () => {
  it('hides the state folder from git and keeps an existing ignore file', () => {
    const repo = tmp();
    mkdirSync(path.join(repo, '.git'));
    mkdirStateSync(path.join(repo, '.runlist', 'locks'), { recursive: true });
    assert.equal(readFileSync(path.join(repo, '.runlist', '.gitignore'), 'utf8'), '*\n');
    writeFileSync(path.join(repo, '.runlist', '.gitignore'), '# kept\n');
    mkdirStateSync(path.join(repo, '.runlist', 'handoffs'), { recursive: true });
    assert.equal(readFileSync(path.join(repo, '.runlist', '.gitignore'), 'utf8'), '# kept\n');
  });

  it('still creates the folder and its ignore without hard links', () => {
    const repo = tmp();
    mkdirSync(path.join(repo, '.git'));
    const original = fs.linkSync;
    fs.linkSync = () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
    syncBuiltinESMExports();
    try {
      mkdirStateSync(path.join(repo, '.runlist', 'locks'), { recursive: true });
    } finally {
      fs.linkSync = original;
      syncBuiltinESMExports();
    }
    assert.ok(existsSync(path.join(repo, '.runlist', 'locks')));
    assert.equal(readFileSync(path.join(repo, '.runlist', '.gitignore'), 'utf8'), '*\n');
    assert.deepEqual(readdirSync(path.join(repo, '.runlist')).filter(name => name.endsWith('.tmp')), []);
  });

  it('never writes an ignore above the repository top', () => {
    const outer = tmp();
    const repo = path.join(outer, '.runlist', 'proj');
    mkdirSync(path.join(repo, '.git'), { recursive: true });
    mkdirStateSync(path.join(repo, 'docs', 'plans', 'archived'), { recursive: true });
    assert.ok(existsSync(path.join(repo, 'docs', 'plans', 'archived')));
    assert.equal(existsSync(path.join(outer, '.runlist', '.gitignore')), false);
  });
});

describe('state migration and the ignore file', () => {
  it('carries a legacy .dotmd/.gitignore over intact', () => {
    const repo = tmp();
    mkdirSync(path.join(repo, '.git'));
    mkdirSync(path.join(repo, '.dotmd'));
    writeFileSync(path.join(repo, '.dotmd', '.gitignore'), '*\n!notes.md\n');
    writeFileSync(path.join(repo, '.dotmd', 'notes.md'), 'synthetic\n');
    const result = migrateStateDirectory(repo);
    assert.equal(result.status, 'migrated');
    assert.equal(readFileSync(path.join(repo, '.runlist', '.gitignore'), 'utf8'), '*\n!notes.md\n');
  });

  it('adds the ignore when the legacy folder had none', () => {
    const repo = tmp();
    mkdirSync(path.join(repo, '.git'));
    mkdirSync(path.join(repo, '.dotmd'));
    writeFileSync(path.join(repo, '.dotmd', 'notes.md'), 'synthetic\n');
    assert.equal(migrateStateDirectory(repo).status, 'migrated');
    assert.equal(readFileSync(path.join(repo, '.runlist', '.gitignore'), 'utf8'), '*\n');
  });
});
