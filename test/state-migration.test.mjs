import { afterEach, describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { migrateStateDirectory } from '../src/state-migration.mjs';
import { PROCESS_STARTED_AT, PROCESS_START_IDENTITY } from '../src/atomic-mutation.mjs';
import { stateDir } from '../src/naming.mjs';

let tmpDir;
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

function setup() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-state-migration-'));
  return tmpDir;
}

function legacyState(root, { ownership = [], transactions = [], locks = [], extras = {} } = {}) {
  const legacy = path.join(root, '.dotmd');
  mkdirSync(path.join(legacy, 'ownership'), { recursive: true });
  for (const [name, content] of ownership) writeFileSync(path.join(legacy, 'ownership', name), content);
  for (const [id, manifest] of transactions) {
    mkdirSync(path.join(legacy, 'transactions', id), { recursive: true });
    writeFileSync(path.join(legacy, 'transactions', id, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  }
  for (const [name, owner] of locks) {
    mkdirSync(path.join(legacy, 'locks', name), { recursive: true });
    writeFileSync(path.join(legacy, 'locks', name, 'owner.json'), JSON.stringify(owner));
  }
  for (const [name, content] of Object.entries(extras)) {
    const target = path.join(legacy, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

const deadOwner = { pid: 99999999, hostname: os.hostname(), processStartedAt: 'dead', processStartIdentity: 'dead' };
const liveOwner = { pid: process.pid, hostname: os.hostname(), processStartedAt: PROCESS_STARTED_AT, processStartIdentity: PROCESS_START_IDENTITY };

describe('state directory migration', () => {
  it('does nothing when there is no legacy state', () => {
    const root = setup();
    strictEqual(migrateStateDirectory(root).status, 'noop');
    ok(!existsSync(path.join(root, '.runlist')));
  });

  it('moves ownership and terminal transaction state verbatim', () => {
    const root = setup();
    legacyState(root, {
      ownership: [['record.json', '{"state":"owned"}']],
      transactions: [['tx-wedged', { id: 'tx-wedged', status: 'failed-manual' }]],
    });
    strictEqual(migrateStateDirectory(root).status, 'migrated');
    strictEqual(readFileSync(path.join(root, '.runlist', 'ownership', 'record.json'), 'utf8'), '{"state":"owned"}');
    ok(existsSync(path.join(root, '.runlist', 'transactions', 'tx-wedged', 'manifest.json')));
    ok(!existsSync(path.join(root, '.dotmd')));
  });

  it('refuses a live lock and keeps resolving the legacy directory', () => {
    const root = setup();
    legacyState(root, { ownership: [['x.json', '{}']], locks: [['held.lock', liveOwner]] });
    const result = migrateStateDirectory(root);
    strictEqual(result.status, 'refused');
    strictEqual(result.reason, 'locks-held');
    match(result.message, /not provably abandoned/i);
    strictEqual(stateDir(root), path.join(root, '.dotmd'));
    ok(!existsSync(path.join(root, '.runlist')));
  });

  it('allows a provably dead lock to move', () => {
    const root = setup();
    legacyState(root, { locks: [['dead.lock', deadOwner]] });
    strictEqual(migrateStateDirectory(root).status, 'migrated');
  });

  it('refuses ownerless and unreadable locks instead of guessing', () => {
    const root = setup();
    legacyState(root);
    mkdirSync(path.join(root, '.dotmd', 'locks', 'ownerless.lock'), { recursive: true });
    let result = migrateStateDirectory(root);
    strictEqual(result.status, 'refused');
    deepStrictEqual(result.detail, [{ lock: 'ownerless.lock', status: 'owner-missing' }]);

    rmSync(path.join(root, '.dotmd', 'locks'), { recursive: true, force: true });
    mkdirSync(path.join(root, '.dotmd', 'locks', 'corrupt.lock'), { recursive: true });
    writeFileSync(path.join(root, '.dotmd', 'locks', 'corrupt.lock', 'owner.json'), '{not json');
    result = migrateStateDirectory(root);
    strictEqual(result.status, 'refused');
    deepStrictEqual(result.detail, [{ lock: 'corrupt.lock', status: 'owner-unreadable' }]);
  });

  it('refuses open and unreadable transaction manifests', () => {
    const root = setup();
    legacyState(root, { transactions: [['tx-open', { id: 'tx-open', status: 'active' }]] });
    const open = migrateStateDirectory(root);
    strictEqual(open.status, 'refused');
    deepStrictEqual(open.detail, [{ id: 'tx-open', status: 'active' }]);
    match(open.message, /doctor --transactions --apply/);

    rmSync(path.join(root, '.dotmd'), { recursive: true, force: true });
    legacyState(root, { transactions: [['tx-corrupt', '{not json']] });
    deepStrictEqual(migrateStateDirectory(root).detail, [{ id: 'tx-corrupt', status: 'unreadable' }]);
  });

  it('refuses a transaction directory with no manifest', () => {
    const root = setup();
    legacyState(root);
    mkdirSync(path.join(root, '.dotmd', 'transactions', 'tx-unpublished'), { recursive: true });
    const result = migrateStateDirectory(root);
    strictEqual(result.status, 'refused');
    deepStrictEqual(result.detail, [{ id: 'tx-unpublished', status: 'manifest-missing' }]);
  });

  it('drops the retired handoff sidecar and retains other state', () => {
    const root = setup();
    legacyState(root, { extras: { 'handoffs/old.json': '{}', 'journal.jsonl': '{"cmd":"x"}\n' } });
    strictEqual(migrateStateDirectory(root).status, 'migrated');
    ok(!existsSync(path.join(root, '.runlist', 'handoffs')));
    strictEqual(readFileSync(path.join(root, '.runlist', 'journal.jsonl'), 'utf8'), '{"cmd":"x"}\n');
  });

  it('is idempotent and merges state recreated by an old build', () => {
    const root = setup();
    legacyState(root, { ownership: [['first.json', 'one']] });
    strictEqual(migrateStateDirectory(root).status, 'migrated');
    strictEqual(migrateStateDirectory(root).status, 'noop');
    legacyState(root, { ownership: [['second.json', 'two']] });
    strictEqual(migrateStateDirectory(root).status, 'migrated');
    deepStrictEqual(readdirSync(path.join(root, '.runlist', 'ownership')).sort(), ['first.json', 'second.json']);
  });

  it('writes a completion marker and dry-run never moves', () => {
    const root = setup();
    legacyState(root, { ownership: [['x.json', '{}']] });
    strictEqual(migrateStateDirectory(root, { dryRun: true }).reason, 'dry-run');
    ok(!existsSync(path.join(root, '.runlist')));
    migrateStateDirectory(root);
    const marker = JSON.parse(readFileSync(path.join(root, '.runlist', 'migrated-from-dotmd.json'), 'utf8'));
    strictEqual(marker.from, '.dotmd');
    strictEqual(marker.to, '.runlist');
  });

  it('the canonical CLI migrates on a real command but not passive or dry-run commands', () => {
    const root = setup();
    mkdirSync(path.join(root, 'docs'), { recursive: true });
    writeFileSync(path.join(root, 'dotmd.config.mjs'), "export const root = 'docs';\n");
    const bin = path.resolve(import.meta.dirname, '..', 'bin', 'runlist.mjs');

    legacyState(root, { extras: { 'journal.jsonl': '' } });
    const passive = spawnSync('node', [bin, 'hud'], { cwd: root, encoding: 'utf8' });
    strictEqual(passive.status, 0, passive.stderr);
    ok(existsSync(path.join(root, '.dotmd')));
    ok(!existsSync(path.join(root, '.runlist')));

    const dry = spawnSync('node', [bin, '--dry-run', 'list'], { cwd: root, encoding: 'utf8' });
    strictEqual(dry.status, 0, dry.stderr);
    ok(existsSync(path.join(root, '.dotmd')));

    const real = spawnSync('node', [bin, 'list'], { cwd: root, encoding: 'utf8' });
    strictEqual(real.status, 0, real.stderr);
    match(real.stderr, /migrated \.dotmd\/ → \.runlist\//);
    ok(!existsSync(path.join(root, '.dotmd')));
    ok(existsSync(path.join(root, '.runlist', 'migrated-from-dotmd.json')));
  });
});
