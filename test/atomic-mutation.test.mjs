import { afterEach, describe, it } from 'node:test';
import { match, ok, strictEqual, throws } from 'node:assert';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import {
  createFileExclusive,
  GIT_INDEX_STAGE_ATTEMPTS,
  moveFileAtomic,
  mutateFileSet,
  MutationConflictError,
  MUTATION_LOCK_TIMEOUT_MS,
  recoverAbandonedTransactions,
  replaceSnapshot,
  snapshotFile,
  withPathLocks,
} from '../src/atomic-mutation.mjs';
import { RENAME_RETRY_SLEEP_BUDGET_MS } from '../src/durable-rename.mjs';
import { resolveConfig } from '../src/config.mjs';
import { runArchive } from '../src/lifecycle.mjs';
import { consumePrompt } from '../src/prompts.mjs';
import { captureGitIndexGeneration, captureGitIndexPaths } from '../src/git.mjs';

const modulePath = pathToFileURL(path.resolve(import.meta.dirname, '..', 'src', 'atomic-mutation.mjs')).href;
const gitModulePath = pathToFileURL(path.resolve(import.meta.dirname, '..', 'src', 'git.mjs')).href;
const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;
const activeChildren = new Set();

function setup() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-atomic-'));
  return tmpDir;
}

function child(code, args = []) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.diagnostic = { stdout: '', stderr: '', status: null };
  proc.stdout.on('data', chunk => { proc.diagnostic.stdout += chunk; });
  proc.stderr.on('data', chunk => { proc.diagnostic.stderr += chunk; });
  proc.on('close', status => { proc.diagnostic.status = status; activeChildren.delete(proc); });
  activeChildren.add(proc);
  return proc;
}

function completed(proc) {
  return new Promise(resolve => {
    let stdout = '', stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('close', status => resolve({ status, stdout, stderr }));
  });
}

async function waitForFiles(files, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (!files.every(existsSync)) {
    if (Date.now() >= deadline) {
      const diagnostics = [...activeChildren].map(proc => `pid=${proc.pid} status=${proc.diagnostic.status}\nstdout:\n${proc.diagnostic.stdout}\nstderr:\n${proc.diagnostic.stderr}`).join('\n---\n');
      for (const proc of activeChildren) proc.kill('SIGKILL');
      await Promise.all([...activeChildren].map(proc => new Promise(resolve => proc.once('close', resolve))));
      throw new Error(`Timed out after ${timeoutMs}ms waiting for barriers: ${files.filter(file => !existsSync(file)).join(', ')}\n${diagnostics}`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function lockEntries(root) {
  const lockRoot = path.join(root, '.runlist', 'locks');
  return existsSync(lockRoot) ? readdirSync(lockRoot) : [];
}

function captureThrown(callback, pattern) {
  let caught = null;
  try { callback(); } catch (err) { caught = err; }
  ok(caught, 'expected callback to throw');
  match(caught.message, pattern);
  return caught;
}

afterEach(() => {
  for (const proc of activeChildren) proc.kill('SIGKILL');
  activeChildren.clear();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('atomic mutation substrate', () => {
  it('rejects an intervening edit and removes its temp and lock', () => {
    const root = setup();
    const file = path.join(root, 'doc.md');
    writeFileSync(file, 'old\n');
    const snapshot = snapshotFile(file);
    writeFileSync(file, 'intervening\n');

    throws(() => replaceSnapshot(snapshot, 'new\n', { repoRoot: root }), MutationConflictError);
    strictEqual(readFileSync(file, 'utf8'), 'intervening\n');
    strictEqual(readdirSync(root).filter(name => name.includes('dotmd-tmp')).length, 0);
    strictEqual(lockEntries(root).length, 0);
  });

  it('preserves mode and cleans a lock when the callback fails', () => {
    const root = setup();
    const file = path.join(root, 'doc.md');
    writeFileSync(file, 'old\n');
    if (process.platform !== 'win32') chmodSync(file, 0o640);
    const snapshot = snapshotFile(file);
    replaceSnapshot(snapshot, 'new\n', { repoRoot: root });
    if (process.platform !== 'win32') strictEqual(statSync(file).mode & 0o777, 0o640);

    throws(() => withPathLocks([file], { repoRoot: root }, () => { throw new Error('boom'); }), /boom/);
    strictEqual(lockEntries(root).length, 0);
  });

  it('flushes the lock root once per lock set, not once per lock', () => {
    // A reference sweep locks every doc in the repo. At one directory flush per
    // lock (~6ms on APFS) a few thousand docs put MINUTES between the move's
    // Git index snapshot and its publication CAS, which is what made concurrent
    // Git activity fail the whole move. Exclusion comes from mkdir's atomicity,
    // so the flush only has to cover the set before the callback mutates.
    const root = setup();
    const files = Array.from({ length: 25 }, (_, i) => {
      const file = path.join(root, `doc-${i}.md`);
      writeFileSync(file, 'body\n');
      return file;
    });
    const phases = [];
    let locksHeldDuringFlush = 0;
    withPathLocks(files, {
      repoRoot: root,
      testHooks: {
        beforeDirectoryFsync: phase => {
          phases.push(phase);
          if (phase === 'lock-directory-create') locksHeldDuringFlush = lockEntries(root).length;
        },
      },
    }, () => {
      strictEqual(lockEntries(root).length, files.length);
    });
    strictEqual(phases.filter(phase => phase === 'lock-directory-create').length, 1);
    strictEqual(phases.filter(phase => phase === 'lock-directory-delete').length, 1);
    strictEqual(locksHeldDuringFlush, files.length, 'every lock is durable before the callback runs');
    strictEqual(lockEntries(root).length, 0);
  });

  it('publishes exactly one complete winner under concurrent exclusive creation', async () => {
    const root = setup();
    const destination = path.join(root, 'winner.md');
    const gate = path.join(root, 'create.go');
    const code = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { createFileExclusive } from ${JSON.stringify(modulePath)};
      writeFileSync(process.argv[5], 'ready');
      while (!existsSync(process.argv[4])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      const content = 'winner-' + process.argv[2] + ':' + 'x'.repeat(100_000);
      try { createFileExclusive(process.argv[1], content, { repoRoot: process.argv[3] }); }
      catch (err) { process.stderr.write(err.code || err.message); process.exit(2); }
    `;
    const attempts = Array.from({ length: 8 }, (_, i) => {
      const content = `winner-${i}:` + 'x'.repeat(100_000);
      const ready = path.join(root, `create-${i}.ready`);
      return { content, ready, done: completed(child(code, [destination, String(i), root, gate, ready])) };
    });
    await waitForFiles(attempts.map(a => a.ready));
    writeFileSync(gate, 'go');
    const results = await Promise.all(attempts.map(a => a.done));
    strictEqual(results.filter(r => r.status === 0).length, 1);
    const final = readFileSync(destination, 'utf8');
    ok(attempts.some(a => a.content === final), 'destination contains one full contender payload');
    strictEqual(lockEntries(root).length, 0);
  });

  it('index-style replacement readers observe only complete old or new content', async () => {
    const root = setup();
    const file = path.join(root, 'docs.md');
    const oldContent = `OLD:${'a'.repeat(500_000)}`;
    const newContent = `NEW:${'b'.repeat(500_000)}`;
    writeFileSync(file, oldContent);
    const ready = path.join(root, 'replace.ready');
    const gate = path.join(root, 'replace.go');
    const code = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { snapshotFile, replaceSnapshot } from ${JSON.stringify(modulePath)};
      const snapshot = snapshotFile(process.argv[1]);
      const content = 'NEW:' + 'b'.repeat(Number(process.argv[2]));
      replaceSnapshot(snapshot, content, { repoRoot: process.argv[3], testHooks: { beforeReplacePublish: () => {
        writeFileSync(process.argv[4], 'ready');
        while (!existsSync(process.argv[5])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      } } });
    `;
    const proc = child(code, [file, '500000', root, ready, gate]);
    const done = completed(proc);
    await waitForFiles([ready]);
    strictEqual(readFileSync(file, 'utf8'), oldContent);
    writeFileSync(gate, 'go');
    const result = await done;
    strictEqual(result.status, 0, result.stderr);
    strictEqual(readFileSync(file, 'utf8'), newContent);
  });

  it('orders reversed multi-lock requests and finishes within the bound', async () => {
    const root = setup();
    const a = path.join(root, 'a.md');
    const b = path.join(root, 'b.md');
    writeFileSync(a, 'a');
    writeFileSync(b, 'b');
    const gate = path.join(root, 'locks.go');
    const code = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { withPathLocks } from ${JSON.stringify(modulePath)};
      writeFileSync(process.argv[4], 'ready');
      while (!existsSync(process.argv[5])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      withPathLocks([process.argv[1], process.argv[2]], { repoRoot: process.argv[3], timeoutMs: 1000 }, () => {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      });
    `;
    const started = Date.now();
    const readyA = path.join(root, 'locks-a.ready');
    const readyB = path.join(root, 'locks-b.ready');
    const pending = [completed(child(code, [a, b, root, readyA, gate])), completed(child(code, [b, a, root, readyB, gate]))];
    await waitForFiles([readyA, readyB]);
    writeFileSync(gate, 'go');
    const results = await Promise.all(pending);
    ok(Date.now() - started < 2000, 'requests must not wait indefinitely');
    ok(results.every(r => r.status === 0), results.map(r => r.stderr).join('\n'));
    strictEqual(lockEntries(root).length, 0);
  });

  it('dry-run creation creates no destination, temp, or lock tree', () => {
    const root = setup();
    mkdirSync(path.join(root, 'docs'));
    writeFileSync(path.join(root, 'dotmd.config.mjs'), `export const root = 'docs';\n`);
    const result = spawnSync(process.execPath, [bin, 'new', 'doc', 'dry', '--dry-run', '--config', path.join(root, 'dotmd.config.mjs')], {
      cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
    });
    strictEqual(result.status, 0, result.stderr);
    strictEqual(existsSync(path.join(root, 'docs', 'dry.md')), false);
    strictEqual(existsSync(path.join(root, '.runlist')), false);
    strictEqual(readdirSync(path.join(root, 'docs')).some(name => name.includes('dotmd-tmp')), false);
  });

  it('portable exclusive-create fallback never overwrites a race winner', () => {
    const root = setup();
    const destination = path.join(root, 'winner.md');
    const contender = path.join(root, 'contender.md');
    writeFileSync(contender, 'race-winner\n');
    throws(() => createFileExclusive(destination, 'dotmd\n', {
      repoRoot: root,
      testHooks: {
        forceLinkUnsupported: true,
        afterCreateReservation: reserved => renameSync(contender, reserved),
      },
    }), MutationConflictError);
    strictEqual(readFileSync(destination, 'utf8'), 'race-winner\n');
    strictEqual(lockEntries(root).length, 0);
  });

  it('reclaims demonstrably dead locks but never steals ownerless or live claims', () => {
    const root = setup();
    const file = path.join(root, 'doc.md');
    writeFileSync(file, 'x');
    const canonical = realpathSync(file);
    const key = createHash('sha256').update(canonical).digest('hex');
    const lockPath = path.join(root, '.runlist', 'locks', `${key}.lock`);
    mkdirSync(lockPath, { recursive: true });
    writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: 99999999, hostname: os.hostname(), createdAt: new Date().toISOString(), processStartedAt: 'dead', path: canonical,
    }));
    strictEqual(withPathLocks([file], { repoRoot: root }, () => 'recovered'), 'recovered');

    mkdirSync(lockPath, { recursive: true });
    writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
      pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString(), processStartedAt: 'live', path: canonical,
    }));
    throws(() => withPathLocks([file], { repoRoot: root, timeoutMs: 30, retryMs: 5 }, () => {}), err => {
      match(err.message, new RegExp(`pid ${process.pid}.*lock age`));
      return true;
    });
    rmSync(lockPath, { recursive: true });

    mkdirSync(lockPath, { recursive: true });
    throws(() => withPathLocks([file], { repoRoot: root, timeoutMs: 30, retryMs: 5 }, () => {}), /another process/);
    rmSync(lockPath, { recursive: true });
  });

  it('move validates the source immediately before moving', () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'original\n');
    throws(() => moveFileAtomic(source, target, 'rendered\n', {
      repoRoot: root,
      testHooks: { afterMoveValidation: () => writeFileSync(source, 'intervening\n') },
    }), MutationConflictError);
    strictEqual(readFileSync(source, 'utf8'), 'intervening\n');
    strictEqual(existsSync(target), false);
  });

  it('move reservation preserves a race winner and rolls the source back', () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    const contender = path.join(root, 'contender.md');
    writeFileSync(source, 'original\n');
    writeFileSync(contender, 'race-winner\n');
    throws(() => moveFileAtomic(source, target, 'rendered\n', {
      repoRoot: root,
      testHooks: { afterSourceMove: () => renameSync(contender, target) },
    }), MutationConflictError);
    strictEqual(readFileSync(source, 'utf8'), 'original\n');
    strictEqual(readFileSync(target, 'utf8'), 'race-winner\n');
  });

  it('rolls a move back after a post-publication failure', () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'original\n');
    throws(() => moveFileAtomic(source, target, 'rendered\n', {
      repoRoot: root,
      testHooks: { afterMovePublish: () => { throw new Error('injected publish failure'); } },
    }), /injected publish failure/);
    strictEqual(readFileSync(source, 'utf8'), 'original\n');
    strictEqual(existsSync(target), false);
  });

  it('rolls every file back when a multi-file commit fails', () => {
    const root = setup();
    const a = path.join(root, 'a.md');
    const b = path.join(root, 'b.md');
    const created = path.join(root, 'created.md');
    writeFileSync(a, 'a-old');
    writeFileSync(b, 'b-old');
    throws(() => mutateFileSet({
      updates: [{ path: a, content: 'a-new' }, { path: b, content: 'b-new' }],
      creations: [{ path: created, content: 'created' }],
    }, {
      repoRoot: root,
      testHooks: { afterSetCommit: count => { if (count === 2) throw new Error('injected set failure'); } },
    }), /injected set failure/);
    strictEqual(readFileSync(a, 'utf8'), 'a-old');
    strictEqual(readFileSync(b, 'utf8'), 'b-old');
    strictEqual(existsSync(created), false);
  });

  it('does not remove a concurrently replaced published target during rollback', () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'original\n');
    throws(() => moveFileAtomic(source, target, 'transaction\n', {
      repoRoot: root,
      testHooks: { afterMovePublish: () => { writeFileSync(target, 'new-owner\n'); throw new Error('fail'); } },
    }), err => {
      match(err.message, /Rollback conflict: published move target was replaced/);
      return true;
    });
    strictEqual(readFileSync(target, 'utf8'), 'new-owner\n');
    strictEqual(readFileSync(source, 'utf8'), 'original\n');
  });

  it('does not overwrite a concurrently recreated source during rollback', () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'original\n');
    let backup;
    throws(() => moveFileAtomic(source, target, 'transaction\n', {
      repoRoot: root,
      testHooks: { afterMovePublish: info => { backup = info.backup; writeFileSync(source, 'recreated\n'); throw new Error('fail'); } },
    }), err => {
      match(err.message, /source was recreated/);
      return true;
    });
    strictEqual(readFileSync(source, 'utf8'), 'recreated\n');
    strictEqual(readFileSync(backup, 'utf8'), 'original\n');
    strictEqual(existsSync(target), false);
  });

  it('does not clobber replaced multi-file updates or creations during rollback', () => {
    const root = setup();
    const updated = path.join(root, 'updated.md');
    writeFileSync(updated, 'old');
    throws(() => mutateFileSet({ updates: [{ path: updated, content: 'committed' }] }, {
      repoRoot: root,
      testHooks: { afterSetCommit: () => { writeFileSync(updated, 'replacement'); throw new Error('fail update'); } },
    }), err => {
      match(err.message, /Original content: .*runlist-recovery-original/);
      return true;
    });
    strictEqual(readFileSync(updated, 'utf8'), 'replacement');
    const recovery = readdirSync(root).find(name => name.includes('runlist-recovery-original'));
    strictEqual(readFileSync(path.join(root, recovery), 'utf8'), 'old');

    const created = path.join(root, 'created.md');
    throws(() => mutateFileSet({ creations: [{ path: created, content: 'committed' }] }, {
      repoRoot: root,
      testHooks: { afterSetCommit: () => { writeFileSync(created, 'replacement'); throw new Error('fail creation'); } },
    }), /Rollback conflict: created file was replaced/);
    strictEqual(readFileSync(created, 'utf8'), 'replacement');
  });

  it('cleans identifiable reservations when write or fsync fails', () => {
    const root = setup();
    const created = path.join(root, 'created.md');
    throws(() => createFileExclusive(created, 'content', {
      repoRoot: root,
      testHooks: { forceLinkUnsupported: true, beforeReserveFsync: () => { throw new Error('fsync failure'); } },
    }), /fsync failure/);
    strictEqual(existsSync(created), false);

    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'source');
    throws(() => moveFileAtomic(source, target, 'target', {
      repoRoot: root,
      testHooks: { beforeReserveFsync: () => { throw new Error('reservation failure'); } },
    }), /reservation failure/);
    strictEqual(readFileSync(source, 'utf8'), 'source');
    strictEqual(existsSync(target), false);
  });

  it('rolls back committed replacements when directory fsync fails', () => {
    const root = setup();
    const file = path.join(root, 'file.md');
    writeFileSync(file, 'original');
    throws(() => mutateFileSet({ updates: [{ path: file, content: 'replacement' }] }, {
      repoRoot: root,
      testHooks: { beforeDirectoryFsync: phase => { if (phase === 'replace-publish') throw new Error('replace fsync failure'); } },
    }), /replace fsync failure/);
    strictEqual(readFileSync(file, 'utf8'), 'original');
  });

  it('retains move recovery material through target fsync and never rolls back after backup deletion', () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'original');
    throws(() => moveFileAtomic(source, target, 'committed', {
      repoRoot: root,
      testHooks: { beforeDirectoryFsync: phase => { if (phase === 'move-target-publish') throw new Error('target fsync failure'); } },
    }), /target fsync failure/);
    strictEqual(readFileSync(source, 'utf8'), 'original');
    strictEqual(existsSync(target), false);

    throws(() => moveFileAtomic(source, target, 'committed', {
      repoRoot: root,
      testHooks: { beforeDirectoryFsync: phase => { if (phase === 'move-backup-delete') throw new Error('cleanup fsync failure'); } },
    }), err => {
      match(err.message, /content and Git index are committed/);
      return true;
    });
    strictEqual(existsSync(source), false);
    strictEqual(readFileSync(target, 'utf8'), 'committed');
    strictEqual(readdirSync(root).some(name => name.includes('dotmd-move')), false);
  });

  it('registers reservation ownership before post-reservation failures', () => {
    const root = setup();
    const created = path.join(root, 'created.md');
    throws(() => createFileExclusive(created, 'content', {
      repoRoot: root,
      testHooks: { forceLinkUnsupported: true, afterReservationAcquired: () => { throw new Error('snapshot phase failure'); } },
    }), /snapshot phase failure/);
    strictEqual(existsSync(created), false);

    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'source');
    throws(() => moveFileAtomic(source, target, 'target', {
      repoRoot: root,
      testHooks: { afterReservationAcquired: () => { throw new Error('move snapshot phase failure'); } },
    }), /move snapshot phase failure/);
    strictEqual(readFileSync(source, 'utf8'), 'source');
    strictEqual(existsSync(target), false);
  });

  it('rolls back failures injected immediately after rename or hard-link publication without reopening first', () => {
    const root = setup();
    const updated = path.join(root, 'updated.md');
    writeFileSync(updated, 'original');
    throws(() => mutateFileSet({ updates: [{ path: updated, content: 'replacement' }] }, {
      repoRoot: root,
      testHooks: { afterPublicationBeforePathOpen: phase => { if (phase === 'replace') throw new Error('after replace rename'); } },
    }), /after replace rename/);
    strictEqual(readFileSync(updated, 'utf8'), 'original');

    const created = path.join(root, 'created.md');
    throws(() => createFileExclusive(created, 'created', {
      repoRoot: root,
      testHooks: { afterPublicationBeforePathOpen: phase => { if (phase === 'create-hardlink') throw new Error('after hard link'); } },
    }), /after hard link/);
    strictEqual(existsSync(created), false);
    strictEqual(readdirSync(root).some(name => name.includes('dotmd-tmp')), false);

    const fallback = path.join(root, 'fallback.md');
    throws(() => createFileExclusive(fallback, 'created', {
      repoRoot: root,
      testHooks: {
        forceLinkUnsupported: true,
        afterPublicationBeforePathOpen: phase => { if (phase === 'create-rename') throw new Error('after create rename'); },
      },
    }), /after create rename/);
    strictEqual(existsSync(fallback), false);

    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'source');
    throws(() => moveFileAtomic(source, target, 'target', {
      repoRoot: root,
      testHooks: { afterPublicationBeforePathOpen: phase => { if (phase === 'move-target') throw new Error('after move rename'); } },
    }), /after move rename/);
    strictEqual(readFileSync(source, 'utf8'), 'source');
    strictEqual(existsSync(target), false);
  });

  it('recovers killed move transactions at every canonical publication phase', async () => {
    const phases = [
      ['lock', 1],
      ['manifest', 1],
      ['staging', 1],
      ['reservation', 1],
      ['source-move', 1],
      ['target-publication', 1],
      ['referrer-publication', 1],
      ['referrer-publication', 2],
      ['ownership-publication', 1],
      ['ownership-publication', 2],
      ['canonical-commit', 1],
      ['backup-deletion', 1],
      ['manifest-completion', 1],
      ['cleanup', 1],
      ['final-commit', 1],
    ];
    for (const [wantedPhase, wantedOccurrence] of phases) {
      const root = setup();
      const source = path.join(root, 'source.md');
      const target = path.join(root, 'target.md');
      const refA = path.join(root, 'ref-a.md');
      const refB = path.join(root, 'ref-b.md');
      const oldOwnership = path.join(root, '.runlist', 'ownership', 'old.json');
      const newOwnership = path.join(root, '.runlist', 'ownership', 'new.json');
      mkdirSync(path.dirname(oldOwnership), { recursive: true });
      writeFileSync(source, 'source-old');
      writeFileSync(refA, 'a-old');
      writeFileSync(refB, 'b-old');
      writeFileSync(oldOwnership, 'owner-old');
      const ready = path.join(root, 'killed.ready');
      const code = `
        import { writeFileSync } from 'node:fs';
        import { moveFileAtomic } from ${JSON.stringify(modulePath)};
        let occurrence = 0;
        moveFileAtomic(process.argv[1], process.argv[2], 'source-new', {
          repoRoot: process.argv[3],
          updates: [
            { path: process.argv[4], content: 'a-new' },
            { path: process.argv[5], content: 'b-new' },
          ],
          creations: [{ path: process.argv[7], content: 'owner-new', label: 'ownership' }],
          deletions: [{ path: process.argv[6], expectedContent: 'owner-old', label: 'ownership' }],
          testHooks: { afterTransactionPhase: phase => {
            if (phase === process.argv[9] && ++occurrence === Number(process.argv[10])) {
              writeFileSync(process.argv[8], phase);
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
            }
          } },
        });
      `;
      const proc = child(code, [source, target, root, refA, refB, oldOwnership, newOwnership, ready, wantedPhase, String(wantedOccurrence)]);
      const done = completed(proc);
      await waitForFiles([ready]);
      proc.kill('SIGKILL');
      await done;
      const recovered = recoverAbandonedTransactions(root);
      const lockOnly = wantedPhase === 'lock';
      strictEqual(recovered.length, lockOnly ? 0 : 1, `${wantedPhase}:${wantedOccurrence}`);
      if (lockOnly) withPathLocks([source, target, refA, refB, oldOwnership, newOwnership], { repoRoot: root }, () => {});
      const rolledForward = !lockOnly && recovered[0].result === 'rolled-forward';
      strictEqual(existsSync(source), !rolledForward);
      strictEqual(existsSync(target), rolledForward);
      strictEqual(readFileSync(refA, 'utf8'), rolledForward ? 'a-new' : 'a-old');
      strictEqual(readFileSync(refB, 'utf8'), rolledForward ? 'b-new' : 'b-old');
      strictEqual(existsSync(oldOwnership), !rolledForward);
      strictEqual(existsSync(newOwnership), rolledForward);
      const txRoot = path.join(root, '.runlist', 'transactions');
      strictEqual(existsSync(txRoot) ? readdirSync(txRoot).length : 0, 0);
      strictEqual(readdirSync(root).some(name => name.includes('dotmd-move') || name.includes('dotmd-tmp')), false);
      rmSync(root, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('fails closed with manifest and artifact guidance when recovery evidence is ambiguous', async () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    const ref = path.join(root, 'ref.md');
    const ready = path.join(root, 'ambiguous.ready');
    writeFileSync(source, 'source-old');
    writeFileSync(ref, 'ref-old');
    const code = `
      import { writeFileSync } from 'node:fs';
      import { moveFileAtomic } from ${JSON.stringify(modulePath)};
      moveFileAtomic(process.argv[1], process.argv[2], 'source-new', {
        repoRoot: process.argv[3], updates: [{ path: process.argv[4], content: 'ref-new' }],
        testHooks: { afterTransactionPhase: phase => {
          if (phase === 'target-publication') {
            writeFileSync(process.argv[5], phase);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
          }
        } },
      });
    `;
    const proc = child(code, [source, target, root, ref, ready]);
    const done = completed(proc);
    await waitForFiles([ready]);
    proc.kill('SIGKILL');
    await done;
    writeFileSync(ref, 'unrelated-new-generation');
    throws(() => recoverAbandonedTransactions(root), err => {
      match(err.message, /refused to guess/i);
      match(err.message, /Manifest:/);
      match(err.message, /recovery artifacts/i);
      return true;
    });
    strictEqual(readFileSync(ref, 'utf8'), 'unrelated-new-generation');
    ok(readdirSync(path.join(root, '.runlist', 'transactions')).length > 0, 'intent and artifacts remain for manual repair');
  });

  it('rejects untrusted manifest paths, Git traversal, and symlink escapes', async () => {
    const cases = ['absolute', 'dotdot', 'symlink-parent', 'artifact', 'artifact-symlink', 'git', 'created-dir'];
    for (const attack of cases) {
      const root = setup();
      mkdirSync(path.join(root, 'docs'));
      const configPath = path.join(root, 'dotmd.config.mjs');
      writeFileSync(configPath, `export const root = 'docs';\n`);
      const validDoc = path.join(root, 'docs', 'doc.md');
      writeFileSync(validDoc, '# doc');
      const escapeTarget = path.join(root, 'outside');
      if (attack === 'symlink-parent' || attack === 'artifact-symlink') mkdirSync(escapeTarget);
      if (attack === 'symlink-parent') symlinkSync(escapeTarget, path.join(root, 'docs', 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      const directory = path.join(root, '.runlist', 'transactions', `attack-${attack}`);
      mkdirSync(directory, { recursive: true });
      if (attack === 'artifact-symlink') symlinkSync(escapeTarget, path.join(directory, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      let participantPath = validDoc;
      if (attack === 'absolute') participantPath = '/tmp/dotmd-malicious.md';
      if (attack === 'dotdot') participantPath = path.resolve(root, 'docs', '..', 'outside.md');
      if (attack === 'symlink-parent') participantPath = path.join(root, 'docs', 'escape', 'malicious.md');
      const sourceArtifact = path.join(directory, 'source-old');
      const targetArtifact = path.join(directory, 'target-new');
      writeFileSync(sourceArtifact, 'old');
      writeFileSync(targetArtifact, 'new');
      const participant = {
        path: participantPath, policy: 'managed', label: 'source',
        old: { exists: true, hash: createHash('sha256').update('old').digest('hex'), mode: 0o644, artifact: sourceArtifact }, new: { exists: false, artifact: null }, transientHashes: [],
      };
      if (attack === 'artifact') participant.old = { exists: true, hash: 'a'.repeat(64), mode: 0o644, artifact: '/tmp/dotmd-artifact' };
      if (attack === 'artifact-symlink') participant.old = { exists: true, hash: 'a'.repeat(64), mode: 0o644, artifact: path.join(directory, 'escape', 'artifact') };
      const manifest = {
        schema: 2, id: `attack-${attack}`, operation: 'move', sessionId: null,
        owner: { pid: 99999999, hostname: os.hostname(), processStartedAt: 'dead', processStartIdentity: 'dead' },
        createdAt: new Date().toISOString(), phase: 'manifest', status: 'active', result: null, directory,
        directoryToken: 'attack-token',
        participants: [participant, {
          path: path.join(root, 'docs', 'new.md'), policy: 'managed', label: 'target', old: { exists: false, artifact: null },
          new: { exists: true, hash: createHash('sha256').update('new').digest('hex'), mode: 0o644, artifact: targetArtifact }, transientHashes: [],
        }], gitIndex: { before: null, prepared: null, ownedAfter: null, retainedPaths: [] },
        gitMove: attack === 'git' ? { source: '../outside.md', target: 'docs/new.md' } : null,
        recoveryArtifacts: [], createdDirectories: attack === 'created-dir' ? [{
          path: path.join(root, 'docs', 'unrelated'), participantPath: validDoc,
          marker: path.join(root, 'docs', 'unrelated', `dotmd-transaction-attack-${attack}`), token: 'attack-token',
        }] : [],
      };
      writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
      const config = await resolveConfig(root, configPath);
      throws(() => recoverAbandonedTransactions(root, { config }), /outside|unsafe|escapes|Git path|participant/i, attack);
      ok(existsSync(path.join(directory, 'manifest.json')), 'malicious evidence is never recursively deleted');
      rmSync(root, { recursive: true, force: true });
      tmpDir = null;
    }

    const root = setup();
    mkdirSync(path.join(root, '.runlist'));
    const escapeTarget = path.join(root, 'outside');
    mkdirSync(escapeTarget);
    symlinkSync(escapeTarget, path.join(root, '.runlist', 'transactions'), process.platform === 'win32' ? 'junction' : 'dir');
    throws(() => recoverAbandonedTransactions(root), /symlink|unsafe/i);
    rmSync(path.join(root, '.runlist', 'transactions'));
    symlinkSync(escapeTarget, path.join(root, '.runlist', 'locks'), process.platform === 'win32' ? 'junction' : 'dir');
    const file = path.join(root, 'doc.md');
    writeFileSync(file, 'x');
    throws(() => withPathLocks([file], { repoRoot: root }, () => {}), /symlink|unsafe/i);
  });

  it('durably syncs transaction directory creation before manifest publication', () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'nested', 'target.md');
    writeFileSync(source, 'old');
    const phases = [];
    moveFileAtomic(source, target, 'new', {
      repoRoot: root,
      testHooks: { beforeDirectoryFsync: phase => phases.push(phase) },
    });
    ok(phases.indexOf('transaction-directory-create') < phases.indexOf('transaction-manifest'));
    ok(phases.includes('transaction-cleanup-manifest-delete'));
    ok(phases.includes('transaction-cleanup-directory-delete'));

    for (const injected of ['transaction-directory-create', 'transaction-manifest']) {
      const sourceAgain = path.join(root, `${injected}-source.md`);
      const targetAgain = path.join(root, `${injected}-target.md`);
      writeFileSync(sourceAgain, 'old');
      throws(() => moveFileAtomic(sourceAgain, targetAgain, 'new', {
        repoRoot: root,
        testHooks: { beforeDirectoryFsync: phase => { if (phase === injected) throw new Error(`injected ${injected}`); } },
      }), new RegExp(`injected ${injected}`));
      strictEqual(readFileSync(sourceAgain, 'utf8'), 'old');
      strictEqual(existsSync(targetAgain), false);
      const txRoot = path.join(root, '.runlist', 'transactions');
      strictEqual(existsSync(txRoot) ? readdirSync(txRoot).length : 0, 0);
    }
  });

  it('removes transaction-created empty destination directories on ordinary rollback', () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'new', 'nested', 'target.md');
    writeFileSync(source, 'old');
    throws(() => moveFileAtomic(source, target, 'new', {
      repoRoot: root,
      testHooks: { afterSourceMove: () => { throw new Error('rollback directories'); } },
    }), /rollback directories/);
    strictEqual(existsSync(path.join(root, 'new')), false);
    strictEqual(readFileSync(source, 'utf8'), 'old');
  });

  it('retains evidence when the restored source parent cannot be fsynced', () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'old');
    throws(() => moveFileAtomic(source, target, 'new', {
      repoRoot: root,
      testHooks: {
        afterMovePublish: () => { throw new Error('force rollback'); },
        beforeDirectoryFsync: phase => { if (phase === 'rollback-source-restore') throw new Error('source parent fsync'); },
      },
    }), /source parent fsync/);
    strictEqual(readFileSync(source, 'utf8'), 'old');
    strictEqual(existsSync(target), false);
    const txRoot = path.join(root, '.runlist', 'transactions');
    const manifest = JSON.parse(readFileSync(path.join(txRoot, readdirSync(txRoot)[0], 'manifest.json'), 'utf8'));
    strictEqual(manifest.status, 'failed-manual');
  });

  it('recovers a crash after source rename-back but before parent fsync', async () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    const ready = path.join(root, 'restore-fsync.ready');
    writeFileSync(source, 'old');
    const code = `
      import { writeFileSync } from 'node:fs';
      import { moveFileAtomic } from ${JSON.stringify(modulePath)};
      moveFileAtomic(process.argv[1], process.argv[2], 'new', { repoRoot: process.argv[3], testHooks: {
        afterMovePublish: () => { throw new Error('rollback'); },
        beforeDirectoryFsync: phase => { if (phase === 'rollback-source-restore') {
          writeFileSync(process.argv[4], phase);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
        } },
      } });
    `;
    const proc = child(code, [source, target, root, ready]);
    const done = completed(proc);
    await waitForFiles([ready]);
    proc.kill('SIGKILL');
    await done;
    strictEqual(readFileSync(source, 'utf8'), 'old');
    strictEqual(recoverAbandonedTransactions(root)[0].result, 'rolled-back');
  });

  // Recovery sweeps every manifest in the repo and runs at the top of every
  // move, so a manifest that cannot be locked belongs to work the caller is not
  // doing. Treating that contention as damage marked the manifest failed-manual,
  // and the failed-manual check then refused EVERY later mutation in the repo —
  // reporting a file the failing command never touched. Contention must defer.
  it('defers a transaction whose paths are locked instead of marking it failed-manual', async () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    const ready = path.join(root, 'abandon.ready');
    writeFileSync(source, 'old');
    const code = `
      import { writeFileSync } from 'node:fs';
      import { moveFileAtomic } from ${JSON.stringify(modulePath)};
      moveFileAtomic(process.argv[1], process.argv[2], 'new', { repoRoot: process.argv[3], testHooks: {
        afterMovePublish: () => { throw new Error('rollback'); },
        beforeDirectoryFsync: phase => { if (phase === 'rollback-source-restore') {
          writeFileSync(process.argv[4], phase);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
        } },
      } });
    `;
    const proc = child(code, [source, target, root, ready]);
    const done = completed(proc);
    await waitForFiles([ready]);
    proc.kill('SIGKILL');
    await done;

    const txRoot = path.join(root, '.runlist', 'transactions');
    const manifestPath = path.join(txRoot, readdirSync(txRoot)[0], 'manifest.json');
    const statusBefore = JSON.parse(readFileSync(manifestPath, 'utf8')).status;
    ok(statusBefore !== 'failed-manual', `abandoned manifest starts recoverable, got ${statusBefore}`);

    // Hold the participant locks so recovery cannot acquire them. This process
    // is alive, so the lock is not reclaimable and acquisition times out.
    const recovered = withPathLocks([source, target], { repoRoot: root }, () =>
      recoverAbandonedTransactions(root, { timeoutMs: 50 }));

    strictEqual(recovered.length, 1);
    strictEqual(recovered[0].result, 'deferred-locked');
    strictEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).status, statusBefore,
      'contention must not poison the manifest');

    // Still recoverable once the lock is gone — the whole point of deferring.
    strictEqual(recoverAbandonedTransactions(root)[0].result, 'rolled-back');
  });

  // The escape hatch. A failed-manual manifest blocks every mutation in the
  // repo and previously had no CLI surface at all — the only guidance was to
  // hand-restore generations and delete the manifest.
  it('doctor --transactions reports a wedged transaction and clears the resolvable case', async () => {
    // realpath so the manifest's directory binding matches what the CLI
    // resolves from cwd (/var vs /private/var on macOS).
    const root = realpathSync(setup());
    mkdirSync(path.join(root, 'docs'));
    writeFileSync(path.join(root, 'dotmd.config.mjs'), `export const root = 'docs';\n`);
    const source = path.join(root, 'docs', 'source.md');
    const target = path.join(root, 'docs', 'target.md');
    const ready = path.join(root, 'abandon.ready');
    writeFileSync(source, 'old');
    const code = `
      import { writeFileSync } from 'node:fs';
      import { moveFileAtomic } from ${JSON.stringify(modulePath)};
      moveFileAtomic(process.argv[1], process.argv[2], 'new', { repoRoot: process.argv[3], testHooks: {
        afterMovePublish: () => { throw new Error('rollback'); },
        beforeDirectoryFsync: phase => { if (phase === 'rollback-source-restore') {
          writeFileSync(process.argv[4], phase);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
        } },
      } });
    `;
    const proc = child(code, [source, target, root, ready]);
    const done = completed(proc);
    await waitForFiles([ready]);
    proc.kill('SIGKILL');
    await done;

    const txRoot = path.join(root, '.runlist', 'transactions');
    const manifestPath = path.join(txRoot, readdirSync(txRoot)[0], 'manifest.json');
    // Force the terminal state the wedge produces.
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.phase = 'failed-manual';
    manifest.result = 'failed-manual';
    manifest.status = 'failed-manual';
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

    const report = spawnSync(process.execPath, [bin, 'doctor', '--transactions', '--json'], { cwd: root, encoding: 'utf8' });
    strictEqual(report.status, 0, report.stderr);
    const parsed = JSON.parse(report.stdout);
    strictEqual(parsed.transactions.length, 1);
    ok(parsed.transactions[0].readable, `manifest unreadable: ${parsed.transactions[0].reason}`);
    strictEqual(parsed.transactions[0].status, 'failed-manual');
    strictEqual(parsed.cleared.length, 0, 'reports without --apply');
    ok(existsSync(manifestPath), 'nothing cleared without --apply');

    // The source was restored by the killed process's rollback, so the files
    // agree on one generation and the manifest is safe to clear.
    strictEqual(readFileSync(source, 'utf8'), 'old');
    strictEqual(parsed.transactions[0].resolvable, true);

    const applied = spawnSync(process.execPath, [bin, 'doctor', '--transactions', '--apply', '--json'], { cwd: root, encoding: 'utf8' });
    strictEqual(applied.status, 0, applied.stderr);
    strictEqual(JSON.parse(applied.stdout).cleared.length, 1, `${applied.stdout}\n${applied.stderr}`);
    strictEqual(readFileSync(source, 'utf8'), 'old', 'document content untouched');

    // The repo mutates again — the wedge is gone.
    strictEqual(recoverAbandonedTransactions(root).length, 0);
  });

  it('retains manual intent and preserves concurrent same-path Git staging when CAS rollback fails', async () => {
    const root = setup();
    mkdirSync(path.join(root, 'docs'));
    const source = path.join(root, 'docs', 'source.md');
    const target = path.join(root, 'docs', 'target.md');
    writeFileSync(source, 'source');
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    spawnSync('git', ['add', '.'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    const configPath = path.join(root, 'dotmd.config.mjs');
    writeFileSync(configPath, `export const root = 'docs';\n`);
    const config = await resolveConfig(root, configPath);
    const before = captureGitIndexGeneration(root);
    throws(() => moveFileAtomic(source, target, 'transaction', {
      repoRoot: root, config, operation: 'rename', gitIndex: before, gitMove: true,
      testHooks: { afterMoveFinalize: () => {
        const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, encoding: 'utf8', input: 'concurrent-index' }).stdout.trim();
        spawnSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},docs/target.md`], { cwd: root });
        throw new Error('after concurrent staging');
      } },
    }), /current staging was preserved/);
    const staged = captureGitIndexPaths([source, target], root);
    ok(staged.records.some(record => record.includes('docs/target.md')));
    const txRoot = path.join(root, '.runlist', 'transactions');
    const manifests = readdirSync(txRoot).map(entry => JSON.parse(readFileSync(path.join(txRoot, entry, 'manifest.json'), 'utf8')));
    strictEqual(manifests[0].status, 'failed-manual');
  });

  it('preserves external staging before publication and during alternate-index preparation', async () => {
    for (const hookName of ['beforeGitIndexPrepare', 'afterGitIndexPrepared']) {
      const root = setup();
      mkdirSync(path.join(root, 'docs'));
      const source = path.join(root, 'docs', 'source.md');
      const target = path.join(root, 'docs', 'target.md');
      const external = path.join(root, 'external.txt');
      writeFileSync(source, 'source');
      writeFileSync(external, 'initial');
      spawnSync('git', ['init', '-q'], { cwd: root });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
      spawnSync('git', ['add', '.'], { cwd: root });
      spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
      const configPath = path.join(root, 'dotmd.config.mjs');
      writeFileSync(configPath, `export const root = 'docs';\n`);
      const config = await resolveConfig(root, configPath);
      const before = captureGitIndexGeneration(root);
      const stageExternal = () => {
        writeFileSync(external, hookName);
        strictEqual(spawnSync('git', ['add', 'external.txt'], { cwd: root }).status, 0);
      };
      // The hook re-stages on every attempt, so it wins the CAS race each time
      // and the bounded re-stage budget is exhausted.
      throws(() => moveFileAtomic(source, target, 'transaction', {
        repoRoot: root, config, operation: 'rename', gitIndex: before, gitMove: true,
        testHooks: { [hookName]: stageExternal },
      }), /Git index changed before transaction publication/);
      strictEqual(readFileSync(source, 'utf8'), 'source');
      strictEqual(existsSync(target), false);
      const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n');
      ok(staged.includes('external.txt'));
      // Publication provably never happened, so the content rollback is
      // complete and nothing is left for manual repair. Retaining the
      // transaction here (as this once did) bricked every later mutation in
      // the repo until `doctor --transactions --apply` ran.
      strictEqual(readdirSync(path.join(root, '.runlist', 'transactions')).length, 0);
      rmSync(root, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('holds the real Git index lock across compare and publication', async () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    const external = path.join(root, 'external.txt');
    writeFileSync(source, 'source');
    writeFileSync(external, 'initial');
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    spawnSync('git', ['add', '.'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    writeFileSync(external, 'external change');
    let externalStatus = null;
    moveFileAtomic(source, target, 'new', {
      repoRoot: root, operation: 'rename', gitMove: true, gitIndex: captureGitIndexGeneration(root),
      testHooks: { afterGitIndexLock: () => { externalStatus = spawnSync('git', ['add', 'external.txt'], { cwd: root }).status; } },
    });
    ok(externalStatus !== 0, 'cooperating external Git cannot stage while index.lock is held');
    const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n');
    ok(!staged.includes('external.txt'));
    ok(staged.includes('target.md'));
  });

  it('re-bases the index CAS on staging that landed during the content phase', () => {
    // The failure this covers: `set` on a large repo spent a minute rewriting
    // references, a peer (even a bare `git status`, which rewrites the index to
    // refresh its stat cache) touched .git/index in that window, and the move
    // died against a snapshot taken before the content phase even started.
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    const external = path.join(root, 'external.txt');
    writeFileSync(source, 'source');
    writeFileSync(external, 'initial');
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    spawnSync('git', ['add', '.'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    const before = captureGitIndexGeneration(root);
    let rebased = 0;
    moveFileAtomic(source, target, 'moved', {
      repoRoot: root, operation: 'rename', gitMove: true, gitIndex: before,
      testHooks: {
        afterMovePublish: () => {
          writeFileSync(external, 'staged by a peer');
          strictEqual(spawnSync('git', ['add', 'external.txt'], { cwd: root }).status, 0);
        },
        afterTransactionPhase: phase => { if (phase === 'git-index-rebase') rebased++; },
      },
    });
    strictEqual(rebased, 1);
    const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n');
    // Staged on top of the peer's work, exactly as `git mv` would have.
    ok(staged.includes('external.txt'), 'the peer staging survives');
    ok(staged.includes('target.md'));
    ok(!existsSync(source));
    strictEqual(readdirSync(path.join(root, '.runlist', 'transactions')).length, 0);
  });

  it('retries a lost index publication once the racer stops winning', () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    const external = path.join(root, 'external.txt');
    writeFileSync(source, 'source');
    writeFileSync(external, 'initial');
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    spawnSync('git', ['add', '.'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    let races = 0;
    let retries = 0;
    moveFileAtomic(source, target, 'moved', {
      repoRoot: root, operation: 'rename', gitMove: true, gitIndex: captureGitIndexGeneration(root),
      testHooks: {
        // Beat the CAS on the first attempt only.
        afterGitIndexPrepared: () => {
          if (races++) return;
          writeFileSync(external, 'staged mid-flight');
          strictEqual(spawnSync('git', ['add', 'external.txt'], { cwd: root }).status, 0);
        },
        afterTransactionPhase: phase => { if (phase === 'git-index-stage-retry') retries++; },
      },
    });
    strictEqual(retries, 1);
    const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n');
    ok(staged.includes('external.txt'));
    ok(staged.includes('target.md'));
    strictEqual(readdirSync(path.join(root, '.runlist', 'transactions')).length, 0);
  });

  it('rolls back cleanly when a live peer holds the real Git index lock', () => {
    // `git status` takes .git/index.lock to rewrite its stat cache. Publication
    // loses that link, and the scratch-state tidy-up must not mistake the peer's
    // lock for damage — that combination retained the transaction and blocked
    // every later mutation in the repo.
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'source');
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    spawnSync('git', ['add', '.'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    const foreignLock = path.join(root, '.git', 'index.lock');
    let retries = 0;
    throws(() => moveFileAtomic(source, target, 'moved', {
      repoRoot: root, operation: 'rename', gitMove: true, gitIndex: captureGitIndexGeneration(root),
      testHooks: {
        beforeGitIndexPrepare: () => { if (!existsSync(foreignLock)) writeFileSync(foreignLock, 'peer git'); },
        afterTransactionPhase: phase => { if (phase === 'git-index-stage-retry') retries++; },
      },
    }), /Git index is locked by another process/);
    strictEqual(retries, GIT_INDEX_STAGE_ATTEMPTS - 1);
    strictEqual(readFileSync(foreignLock, 'utf8'), 'peer git', 'the peer keeps its lock');
    strictEqual(readFileSync(source, 'utf8'), 'source');
    strictEqual(existsSync(target), false);
    strictEqual(readdirSync(path.join(root, '.runlist', 'transactions')).length, 0);
  });

  it('does not retry a Git staging failure that is a verdict rather than a race', () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'source');
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    spawnSync('git', ['add', '.'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    // A clean filter that always fails makes `git add` refuse the destination.
    writeFileSync(path.join(root, '.gitattributes'), 'target.md filter=boom\n');
    spawnSync('git', ['config', 'filter.boom.clean', 'false'], { cwd: root });
    spawnSync('git', ['config', 'filter.boom.required', 'true'], { cwd: root });
    let prepares = 0;
    throws(() => moveFileAtomic(source, target, 'moved', {
      repoRoot: root, operation: 'rename', gitMove: true, gitIndex: captureGitIndexGeneration(root),
      testHooks: { beforeGitIndexPrepare: () => { prepares++; } },
    }), /Could not stage moved document/);
    strictEqual(prepares, 1, 'a refused `git add` is not contention; retrying only multiplies it');
    strictEqual(readFileSync(source, 'utf8'), 'source');
    strictEqual(existsSync(target), false);
    strictEqual(readdirSync(path.join(root, '.runlist', 'transactions')).length, 0);
  });

  it('checkpoints and cleans exact working state when ordinary Git preparation fails', () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'source');
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['add', 'source.md'], { cwd: root });
    throws(() => moveFileAtomic(source, target, 'new', {
      repoRoot: root, operation: 'rename', gitMove: true, gitIndex: captureGitIndexGeneration(root),
      testHooks: { afterGitIndexSubprocessBeforeCheckpoint: () => { throw new Error('ordinary preparation failure'); } },
    }), /ordinary preparation failure/);
    strictEqual(readFileSync(source, 'utf8'), 'source');
    strictEqual(existsSync(target), false);
    strictEqual(readdirSync(path.join(root, '.git')).some(name => name.startsWith('.runlist-index-') || name === 'index.lock'), false);
    strictEqual(readdirSync(path.join(root, '.runlist', 'transactions')).length, 0);
  });

  it('retains unverified work and manual evidence when preparation directory fsync fails', () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'source');
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['add', 'source.md'], { cwd: root });
    const error = captureThrown(() => moveFileAtomic(source, target, 'new', {
      repoRoot: root, operation: 'rename', gitMove: true, gitIndex: captureGitIndexGeneration(root),
      testHooks: { beforeGitIndexDirectoryFsync: ({ reason }) => {
        if (reason === 'working-index-step') throw new Error('working index step fsync failed');
      } },
    }), /working index step fsync failed/);
    const txRoot = path.join(root, '.runlist', 'transactions');
    const manifestPath = path.join(txRoot, readdirSync(txRoot)[0], 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    strictEqual(manifest.status, 'failed-manual');
    strictEqual(manifest.gitIndex.retainedPaths.length, 1);
    const retainedPath = manifest.gitIndex.retainedPaths[0];
    ok(existsSync(retainedPath));
    ok(error.message.includes(retainedPath));
    ok(error.message.includes(manifestPath));
    throws(() => recoverAbandonedTransactions(root), /failed\/manual.*will not be retried|failed-manual/i);
    strictEqual(readFileSync(retainedPath).length > 0, true);
  });

  it('fsyncs indexDir after removing a failed transaction-owned publication lock', { skip: process.platform === 'win32' && 'Windows does not expose POSIX chmod changes' }, () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'source');
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['add', 'source.md'], { cwd: root });
    const indexPath = path.join(root, '.git', 'index');
    const changedMode = (statSync(indexPath).mode & 0o7777) === 0o600 ? 0o640 : 0o600;
    let observedAfterUnlink = false;
    throws(() => moveFileAtomic(source, target, 'new', {
      repoRoot: root, operation: 'rename', gitMove: true, gitIndex: captureGitIndexGeneration(root),
      testHooks: {
        afterGitIndexLock: () => chmodSync(indexPath, changedMode),
        beforeGitIndexDirectoryFsync: ({ reason }) => {
          if (reason === 'failed-lock-delete') {
            observedAfterUnlink = !existsSync(`${indexPath}.lock`);
            throw new Error('failed lock delete fsync');
          }
        },
      },
    }), /failed lock delete fsync/);
    strictEqual(observedAfterUnlink, true);
    strictEqual(existsSync(`${indexPath}.lock`), false);
  });

  it('resumes cleanup and does not require missing artifacts when canonical generations are already desired', async () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    const ready = path.join(root, 'cleanup.ready');
    writeFileSync(source, 'old');
    const code = `
      import { writeFileSync } from 'node:fs';
      import { moveFileAtomic } from ${JSON.stringify(modulePath)};
      moveFileAtomic(process.argv[1], process.argv[2], 'new', { repoRoot: process.argv[3], testHooks: {
        afterTransactionPhase: phase => { if (phase === 'manifest-completion') {
          writeFileSync(process.argv[4], phase);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
        } },
      } });
    `;
    const proc = child(code, [source, target, root, ready]);
    const done = completed(proc);
    await waitForFiles([ready]);
    proc.kill('SIGKILL');
    await done;
    const txRoot = path.join(root, '.runlist', 'transactions');
    const directory = path.join(txRoot, readdirSync(txRoot)[0]);
    const manifest = JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    for (const artifact of manifest.participants.flatMap(item => [item.old.artifact, item.new.artifact]).filter(Boolean)) unlinkSync(artifact);
    const recovered = recoverAbandonedTransactions(root);
    strictEqual(recovered[0].result, 'rolled-forward');
    strictEqual(readFileSync(target, 'utf8'), 'new');

    const empty = path.join(txRoot, 'interrupted-empty-cleanup');
    mkdirSync(empty);
    strictEqual(recoverAbandonedTransactions(root)[0].result, 'cleanup-completed');
    strictEqual(existsSync(empty), false);
  });

  it('recovers or fails closed across directory intent, mkdir, and marker kill windows', async () => {
    for (const phase of ['directory-intent', 'directory-create', 'directory-marker']) {
      const root = setup();
      const source = path.join(root, 'source.md');
      const target = path.join(root, 'new-dir', 'target.md');
      const ready = path.join(root, `${phase}.ready`);
      writeFileSync(source, 'old');
      const code = `
        import { writeFileSync } from 'node:fs';
        import { moveFileAtomic } from ${JSON.stringify(modulePath)};
        moveFileAtomic(process.argv[1], process.argv[2], 'new', { repoRoot: process.argv[3], testHooks: {
          afterTransactionPhase: current => { if (current === process.argv[5]) {
            writeFileSync(process.argv[4], current);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
          } },
        } });
      `;
      const proc = child(code, [source, target, root, ready, phase]);
      const done = completed(proc);
      await waitForFiles([ready]);
      proc.kill('SIGKILL');
      await done;
      const recovery = recoverAbandonedTransactions(root)[0];
      strictEqual(recovery.result, 'rolled-back');
      if (phase === 'directory-intent') strictEqual(existsSync(path.join(root, 'new-dir')), false);
      else {
        ok(existsSync(path.join(root, 'new-dir')), 'abandoned recovery never deletes manifest-described directories');
        ok(recovery.retainedDirectories.includes(path.join(root, 'new-dir')));
      }
      rmSync(root, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('never removes a directory created by another actor after intent recording', () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const directory = path.join(root, 'raced-dir');
    const target = path.join(directory, 'target.md');
    const unrelated = path.join(directory, 'unrelated.txt');
    writeFileSync(source, 'old');
    throws(() => moveFileAtomic(source, target, 'new', {
      repoRoot: root,
      testHooks: { afterTransactionPhase: phase => {
        if (phase === 'directory-intent') {
          mkdirSync(directory);
          writeFileSync(unrelated, 'other actor');
        }
      } },
    }), /EEXIST|exist/i);
    strictEqual(readFileSync(unrelated, 'utf8'), 'other actor');
    strictEqual(readFileSync(source, 'utf8'), 'old');
    strictEqual(existsSync(target), false);
  });

  it('handles SIGKILL at real Git index prepare, lock, compare, and publication phases', async () => {
    for (const phase of ['git-index-artifact', 'git-index-post-subprocess', 'git-index-prepare-step', 'git-index-prepared', 'git-index-lock', 'git-index-compare', 'git-index-publication']) {
      const root = setup();
      const source = path.join(root, 'source.md');
      const target = path.join(root, 'target.md');
      const ready = path.join(root, `${phase}.ready`);
      writeFileSync(source, 'old');
      spawnSync('git', ['init', '-q'], { cwd: root });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
      spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
      spawnSync('git', ['add', '.'], { cwd: root });
      spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
      const code = `
        import { writeFileSync } from 'node:fs';
        import { moveFileAtomic } from ${JSON.stringify(modulePath)};
        import { captureGitIndexGeneration } from ${JSON.stringify(gitModulePath)};
        moveFileAtomic(process.argv[1], process.argv[2], 'new', {
          repoRoot: process.argv[3], operation: 'rename', gitMove: true,
          gitIndex: captureGitIndexGeneration(process.argv[3]),
          testHooks: { afterTransactionPhase: current => { if (current === process.argv[5]) {
            writeFileSync(process.argv[4], current);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
          } } },
        });
      `;
      const proc = child(code, [source, target, root, ready, phase]);
      const done = completed(proc);
      await waitForFiles([ready]);
      proc.kill('SIGKILL');
      await done;
      if (phase === 'git-index-post-subprocess') {
        const recoveryError = captureThrown(() => recoverAbandonedTransactions(root), /unverified work.*manual recovery|\.runlist-index-/i);
        const txRoot = path.join(root, '.runlist', 'transactions');
        const manifestPath = path.join(txRoot, readdirSync(txRoot)[0], 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        strictEqual(manifest.status, 'failed-manual');
        strictEqual(manifest.gitIndex.retainedPaths.length, 1);
        const retainedPath = manifest.gitIndex.retainedPaths[0];
        ok(existsSync(retainedPath));
        ok(recoveryError.message.includes(retainedPath));
        throws(() => recoverAbandonedTransactions(root), /failed\/manual.*will not be retried|failed-manual/i);
        rmSync(root, { recursive: true, force: true });
        tmpDir = null;
        continue;
      }
      const recovery = recoverAbandonedTransactions(root)[0];
      strictEqual(recovery.result, 'rolled-forward');
      strictEqual(readFileSync(target, 'utf8'), 'new');
      const tracked = spawnSync('git', ['ls-files', '--error-unmatch', 'target.md'], { cwd: root });
      strictEqual(tracked.status, 0, phase);
      strictEqual(existsSync(path.join(root, '.git', 'index.lock')), false);
      const prepResidue = readdirSync(path.join(root, '.git')).filter(name => name.startsWith('.runlist-index-'));
      strictEqual(prepResidue.length, 0);
      strictEqual(readdirSync(path.join(root, '.runlist', 'transactions')).length, 0);
      rmSync(root, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('publishes Git index CAS for unborn repositories and SHA-256 repositories', () => {
    for (const objectFormat of [null, 'sha256']) {
      const root = setup();
      const initArgs = ['init', '-q', ...(objectFormat ? [`--object-format=${objectFormat}`] : [])];
      const initialized = spawnSync('git', initArgs, { cwd: root, encoding: 'utf8' });
      if (initialized.status !== 0 && objectFormat) {
        rmSync(root, { recursive: true, force: true });
        tmpDir = null;
        continue;
      }
      strictEqual(initialized.status, 0, initialized.stderr);
      const source = path.join(root, 'source.md');
      const target = path.join(root, 'target.md');
      writeFileSync(source, 'old');
      if (objectFormat) {
        spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
        spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
        spawnSync('git', ['add', 'source.md'], { cwd: root });
        spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
      }
      const before = captureGitIndexGeneration(root);
      if (!objectFormat) strictEqual(before.exists, false);
      moveFileAtomic(source, target, 'new', { repoRoot: root, operation: 'rename', gitMove: true, gitIndex: before });
      strictEqual(spawnSync('git', ['ls-files', '--error-unmatch', 'target.md'], { cwd: root }).status, 0);
      if (!objectFormat && process.platform !== 'win32') strictEqual(statSync(path.join(root, '.git', 'index')).mode & 0o777, 0o666 & ~process.umask());
      strictEqual(existsSync(path.join(root, '.git', 'index.lock')), false);
      rmSync(root, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('preserves index mode and honors a relative inherited GIT_INDEX_FILE', () => {
    const root = setup();
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'old');
    spawnSync('git', ['add', 'source.md'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    const normalIndex = path.join(root, '.git', 'index');
    if (process.platform !== 'win32') chmodSync(normalIndex, 0o660);
    const alternate = path.join(root, '.git', 'alternate-index');
    writeFileSync(alternate, readFileSync(normalIndex), { mode: 0o660 });
    if (process.platform !== 'win32') chmodSync(alternate, 0o660);
    const normalBytes = readFileSync(normalIndex);
    const prior = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = '.git/alternate-index';
    try {
      const before = captureGitIndexGeneration(root);
      strictEqual(before.indexPath, alternate);
      moveFileAtomic(source, target, 'new', { repoRoot: root, operation: 'rename', gitMove: true, gitIndex: before });
      if (process.platform !== 'win32') strictEqual(statSync(alternate).mode & 0o777, 0o660);
      strictEqual(spawnSync('git', ['ls-files', '--error-unmatch', 'target.md'], { cwd: root }).status, 0);
      strictEqual(Buffer.compare(readFileSync(normalIndex), normalBytes), 0, 'normal index remains untouched');
      strictEqual(existsSync(`${alternate}.lock`), false);
      strictEqual(readdirSync(path.dirname(alternate)).some(name => name.startsWith('.runlist-index-')), false);
    } finally {
      if (prior === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = prior;
    }
  });

  it('fsyncs an absolute alternate index directory and exposes publication durability injection', () => {
    const root = setup();
    spawnSync('git', ['init', '-q'], { cwd: root });
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'old');
    spawnSync('git', ['add', 'source.md'], { cwd: root });
    const outside = path.join(root, 'absolute-indexes');
    mkdirSync(outside);
    const alternate = path.join(outside, 'selected.index');
    writeFileSync(alternate, readFileSync(path.join(root, '.git', 'index')));
    const prior = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = alternate;
    const syncs = [];
    try {
      moveFileAtomic(source, target, 'new', {
        repoRoot: root, operation: 'rename', gitMove: true, gitIndex: captureGitIndexGeneration(root),
        testHooks: { beforeGitIndexDirectoryFsync: info => syncs.push(info) },
      });
      ok(syncs.some(info => info.directory === outside && info.reason === 'publication'));
      ok(syncs.every(info => info.directory !== path.join(root, '.git')), 'alternate publication does not fsync unrelated gitDir');
    } finally {
      if (prior === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = prior;
    }

    const source2 = path.join(root, 'source-2.md');
    const target2 = path.join(root, 'target-2.md');
    writeFileSync(source2, 'old-2');
    process.env.GIT_INDEX_FILE = alternate;
    try {
      throws(() => moveFileAtomic(source2, target2, 'new-2', {
        repoRoot: root, operation: 'rename', gitMove: true, gitIndex: captureGitIndexGeneration(root),
        testHooks: { beforeGitIndexDirectoryFsync: ({ directory, reason }) => {
          if (directory === outside && reason === 'publication') throw new Error('alternate index directory fsync failure');
        } },
      }), /alternate index directory fsync failure/);
      const txRoot = path.join(root, '.runlist', 'transactions');
      const manifest = JSON.parse(readFileSync(path.join(txRoot, readdirSync(txRoot)[0], 'manifest.json'), 'utf8'));
      strictEqual(manifest.status, 'failed-manual');
    } finally {
      if (prior === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = prior;
    }
  });

  it('treats a same-byte concurrent index chmod as a CAS conflict', { skip: process.platform === 'win32' && 'Windows does not expose POSIX chmod changes' }, () => {
    const root = setup();
    spawnSync('git', ['init', '-q'], { cwd: root });
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'old');
    spawnSync('git', ['add', 'source.md'], { cwd: root });
    const indexPath = path.join(root, '.git', 'index');
    const before = captureGitIndexGeneration(root);
    const modes = before.mode === 0o600 ? [0o640, 0o600] : [0o600, 0o640];
    // Mode is part of the generation identity: a concurrent chmod that leaves
    // every byte alone still has to lose the CAS. Alternating the mode makes
    // the racer win every attempt, so the bounded re-stage budget runs out.
    let chmods = 0;
    throws(() => moveFileAtomic(source, target, 'new', {
      repoRoot: root, operation: 'rename', gitMove: true, gitIndex: before,
      testHooks: { afterGitIndexLock: () => chmodSync(indexPath, modes[chmods++ % modes.length]) },
    }), /Git index changed before transaction publication/);
    ok(chmods > 1, 'the losing attempt was retried on a fresh generation');
    strictEqual(statSync(indexPath).mode & 0o7777, modes[(chmods - 1) % modes.length]);
    strictEqual(readFileSync(source, 'utf8'), 'old');
    strictEqual(readdirSync(path.join(root, '.runlist', 'transactions')).length, 0);
  });

  it('fails closed when recovery selects a different inherited Git index', async () => {
    const root = setup();
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    const ready = path.join(root, 'selected-index.ready');
    writeFileSync(source, 'old');
    spawnSync('git', ['add', 'source.md'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    const code = `
      import { writeFileSync } from 'node:fs';
      import { moveFileAtomic } from ${JSON.stringify(modulePath)};
      import { captureGitIndexGeneration } from ${JSON.stringify(gitModulePath)};
      moveFileAtomic(process.argv[1], process.argv[2], 'new', { repoRoot: process.argv[3], operation: 'rename', gitMove: true,
        gitIndex: captureGitIndexGeneration(process.argv[3]), testHooks: { afterTransactionPhase: phase => {
          if (phase === 'git-index-prepared') { writeFileSync(process.argv[4], phase); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000); }
        } } });
    `;
    const proc = child(code, [source, target, root, ready]);
    const done = completed(proc);
    await waitForFiles([ready]);
    proc.kill('SIGKILL');
    await done;
    const alternate = path.join(root, '.git', 'alternate-index');
    writeFileSync(alternate, readFileSync(path.join(root, '.git', 'index')));
    const prior = process.env.GIT_INDEX_FILE;
    process.env.GIT_INDEX_FILE = '.git/alternate-index';
    try { throws(() => recoverAbandonedTransactions(root), /different Git index|selects a different/i); }
    finally {
      if (prior === undefined) delete process.env.GIT_INDEX_FILE;
      else process.env.GIT_INDEX_FILE = prior;
    }
    strictEqual(recoverAbandonedTransactions(root)[0].result, 'rolled-forward');
  });

  it('preserves a foreign replacement at an abandoned prepared-index path', async () => {
    const root = setup();
    spawnSync('git', ['init', '-q'], { cwd: root });
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    const ready = path.join(root, 'prepared.ready');
    writeFileSync(source, 'old');
    spawnSync('git', ['add', 'source.md'], { cwd: root });
    const code = `
      import { writeFileSync } from 'node:fs';
      import { moveFileAtomic } from ${JSON.stringify(modulePath)};
      import { captureGitIndexGeneration } from ${JSON.stringify(gitModulePath)};
      moveFileAtomic(process.argv[1], process.argv[2], 'new', { repoRoot: process.argv[3], operation: 'rename', gitMove: true,
        gitIndex: captureGitIndexGeneration(process.argv[3]), testHooks: { afterTransactionPhase: phase => {
          if (phase === 'git-index-prepared') { writeFileSync(process.argv[4], phase); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000); }
        } } });
    `;
    const proc = child(code, [source, target, root, ready]);
    const done = completed(proc);
    await waitForFiles([ready]);
    proc.kill('SIGKILL');
    await done;
    const txRoot = path.join(root, '.runlist', 'transactions');
    const manifestPath = path.join(txRoot, readdirSync(txRoot)[0], 'manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    unlinkSync(manifest.gitIndex.prepared.path);
    writeFileSync(manifest.gitIndex.prepared.path, 'foreign');
    throws(() => recoverAbandonedTransactions(root), /ownership could not be verified|foreign/i);
    strictEqual(readFileSync(manifest.gitIndex.prepared.path, 'utf8'), 'foreign');
  });

  it('preserves a foreign selected-index lock during abandoned recovery', async () => {
    const root = setup();
    spawnSync('git', ['init', '-q'], { cwd: root });
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    const ready = path.join(root, 'foreign-lock.ready');
    writeFileSync(source, 'old');
    spawnSync('git', ['add', 'source.md'], { cwd: root });
    const code = `
      import { writeFileSync } from 'node:fs';
      import { moveFileAtomic } from ${JSON.stringify(modulePath)};
      import { captureGitIndexGeneration } from ${JSON.stringify(gitModulePath)};
      moveFileAtomic(process.argv[1], process.argv[2], 'new', { repoRoot: process.argv[3], operation: 'rename', gitMove: true,
        gitIndex: captureGitIndexGeneration(process.argv[3]), testHooks: { afterTransactionPhase: phase => {
          if (phase === 'git-index-prepared') { writeFileSync(process.argv[4], phase); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000); }
        } } });
    `;
    const proc = child(code, [source, target, root, ready]);
    const done = completed(proc);
    await waitForFiles([ready]);
    proc.kill('SIGKILL');
    await done;
    const lockPath = path.join(root, '.git', 'index.lock');
    writeFileSync(lockPath, 'foreign lock');
    throws(() => recoverAbandonedTransactions(root), /lock is foreign/i);
    strictEqual(readFileSync(lockPath, 'utf8'), 'foreign lock');
  });

  it('preserves split-index extensions and shared sidecars when supported', () => {
    const root = setup();
    spawnSync('git', ['init', '-q'], { cwd: root });
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'old');
    spawnSync('git', ['add', 'source.md'], { cwd: root });
    const split = spawnSync('git', ['update-index', '--split-index'], { cwd: root, encoding: 'utf8' });
    if (split.status !== 0) return;
    const indexPath = path.join(root, '.git', 'index');
    const beforeBytes = readFileSync(indexPath);
    ok(beforeBytes.includes(Buffer.from('link')), 'split index carries the link extension');
    const sidecars = readdirSync(path.join(root, '.git')).filter(name => name.startsWith('sharedindex.'));
    const sidecarBytes = new Map(sidecars.map(name => [name, readFileSync(path.join(root, '.git', name))]));
    moveFileAtomic(source, target, 'new', { repoRoot: root, operation: 'rename', gitMove: true, gitIndex: captureGitIndexGeneration(root) });
    ok(readFileSync(indexPath).includes(Buffer.from('link')), 'published index preserves split-index extension');
    for (const [name, bytes] of sidecarBytes) strictEqual(Buffer.compare(readFileSync(path.join(root, '.git', name)), bytes), 0, `${name} was not corrupted`);
  });

  it('recovers SIGKILL during artifact, manifest, and transaction-directory cleanup windows', async () => {
    for (const phase of ['transaction-cleanup-artifact-delete', 'transaction-cleanup-manifest-delete', 'transaction-cleanup-directory-delete']) {
      const root = setup();
      const source = path.join(root, 'source.md');
      const target = path.join(root, 'target.md');
      const ready = path.join(root, `${phase}.ready`);
      writeFileSync(source, 'old');
      const code = `
        import { writeFileSync } from 'node:fs';
        import { moveFileAtomic } from ${JSON.stringify(modulePath)};
        moveFileAtomic(process.argv[1], process.argv[2], 'new', { repoRoot: process.argv[3], testHooks: {
          beforeDirectoryFsync: current => { if (current === process.argv[5]) {
            writeFileSync(process.argv[4], current);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
          } },
        } });
      `;
      const proc = child(code, [source, target, root, ready, phase]);
      const done = completed(proc);
      await waitForFiles([ready]);
      proc.kill('SIGKILL');
      await done;
      const recovered = recoverAbandonedTransactions(root);
      if (phase === 'transaction-cleanup-directory-delete') strictEqual(recovered.length, 0);
      else ok(['rolled-forward', 'cleanup-completed'].includes(recovered[0].result));
      strictEqual(readFileSync(target, 'utf8'), 'new');
      const txRoot = path.join(root, '.runlist', 'transactions');
      strictEqual(existsSync(txRoot) ? readdirSync(txRoot).length : 0, 0);
      rmSync(root, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('retains and reports an empty directory after marker unlink SIGKILL', async () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const directory = path.join(root, 'nested');
    const target = path.join(directory, 'target.md');
    const ready = path.join(root, 'marker-delete.ready');
    writeFileSync(source, 'old');
    const code = `
      import { writeFileSync } from 'node:fs';
      import { moveFileAtomic } from ${JSON.stringify(modulePath)};
      moveFileAtomic(process.argv[1], process.argv[2], 'new', { repoRoot: process.argv[3], testHooks: {
        afterMovePublish: () => { throw new Error('rollback'); },
        beforeDirectoryFsync: current => { if (current === 'canonical-directory-marker-delete') {
          writeFileSync(process.argv[4], current);
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
        } },
      } });
    `;
    const proc = child(code, [source, target, root, ready]);
    const done = completed(proc);
    await waitForFiles([ready]);
    proc.kill('SIGKILL');
    await done;
    const recovery = recoverAbandonedTransactions(root)[0];
    strictEqual(recovery.result, 'rolled-back');
    strictEqual(existsSync(directory), true);
    ok(recovery.retainedDirectories.includes(directory));
    strictEqual(readFileSync(source, 'utf8'), 'old');
    const repeated = recoverAbandonedTransactions(root)[0];
    strictEqual(repeated.result, 'rolled-back');
    ok(repeated.retainedDirectories.includes(directory));
  });
});

describe('windows rename retry', () => {
  // Every test forces Windows rename semantics so the retry branch is reachable on
  // the POSIX machines that actually run the suite — otherwise these would all
  // silently assert plain passthrough and prove nothing.
  it('retries a transient EPERM and still publishes', () => {
    const root = setup();
    const file = path.join(root, 'doc.md');
    writeFileSync(file, 'original');
    const attempts = [];
    replaceSnapshot(snapshotFile(file), 'replacement', {
      repoRoot: root,
      testHooks: {
        forceWindowsRenameSemantics: true,
        forceRenameError: attempt => { attempts.push(attempt); return attempt < 2 ? 'EPERM' : null; },
      },
    });
    strictEqual(readFileSync(file, 'utf8'), 'replacement');
    strictEqual(attempts.length, 3);
    strictEqual(readdirSync(root).some(name => name.includes('dotmd-tmp')), false);
  });

  it('retries EBUSY and EACCES as well as EPERM', () => {
    for (const code of ['EBUSY', 'EACCES']) {
      const root = setup();
      const file = path.join(root, 'doc.md');
      writeFileSync(file, 'original');
      replaceSnapshot(snapshotFile(file), `replaced-${code}`, {
        repoRoot: root,
        testHooks: {
          forceWindowsRenameSemantics: true,
          forceRenameError: attempt => (attempt < 1 ? code : null),
        },
      });
      strictEqual(readFileSync(file, 'utf8'), `replaced-${code}`);
    }
  });

  it('propagates the original error once the retry budget is exhausted', () => {
    const root = setup();
    const file = path.join(root, 'doc.md');
    writeFileSync(file, 'original');
    let attempts = 0;
    throws(() => replaceSnapshot(snapshotFile(file), 'replacement', {
      repoRoot: root,
      testHooks: {
        forceWindowsRenameSemantics: true,
        forceRenameError: () => { attempts += 1; return 'EPERM'; },
      },
    }), err => err.code === 'EPERM');
    strictEqual(attempts, 10);
    strictEqual(readFileSync(file, 'utf8'), 'original');
    strictEqual(readdirSync(root).some(name => name.includes('dotmd-tmp')), false);
  });

  it('does not retry an error that Windows contention cannot cause', () => {
    const root = setup();
    const file = path.join(root, 'doc.md');
    writeFileSync(file, 'original');
    let attempts = 0;
    throws(() => replaceSnapshot(snapshotFile(file), 'replacement', {
      repoRoot: root,
      testHooks: {
        forceWindowsRenameSemantics: true,
        forceRenameError: () => { attempts += 1; return 'ENOSPC'; },
      },
    }), err => err.code === 'ENOSPC');
    strictEqual(attempts, 1);
    strictEqual(readFileSync(file, 'utf8'), 'original');
  });

  it('passes retryable codes straight through on POSIX', () => {
    const root = setup();
    const file = path.join(root, 'doc.md');
    writeFileSync(file, 'original');
    let attempts = 0;
    throws(() => replaceSnapshot(snapshotFile(file), 'replacement', {
      repoRoot: root,
      testHooks: {
        forceWindowsRenameSemantics: false,
        forceRenameError: () => { attempts += 1; return 'EPERM'; },
      },
    }), err => err.code === 'EPERM');
    strictEqual(attempts, 1);
  });

  // The retry runs while withPathLocks holds the lock, so the whole budget has to
  // fit well inside the timeout a peer waits before MutationLockError — otherwise
  // this trades a rare transient EPERM for common peer lock timeouts. Asserted
  // against the constants rather than by timing a run: the publish around the
  // sleep is slow and variable on shared CI runners, so a wall-clock threshold
  // here would itself be the flake this whole change exists to remove.
  it('keeps the exhausted retry sleep budget well under the peer lock timeout', () => {
    ok(
      RENAME_RETRY_SLEEP_BUDGET_MS * 2 < MUTATION_LOCK_TIMEOUT_MS,
      `retry sleep budget ${RENAME_RETRY_SLEEP_BUDGET_MS}ms leaves too little headroom under the ${MUTATION_LOCK_TIMEOUT_MS}ms lock timeout`,
    );
  });

  it('retries the move-transaction publish renames', () => {
    const root = setup();
    const source = path.join(root, 'source.md');
    const target = path.join(root, 'target.md');
    writeFileSync(source, 'source');
    let renameCalls = 0;
    moveFileAtomic(source, target, 'moved', {
      repoRoot: root,
      testHooks: {
        forceWindowsRenameSemantics: true,
        // Fail the first attempt of every retrying rename in the move path.
        forceRenameError: attempt => { if (attempt === 0) renameCalls += 1; return attempt < 1 ? 'EPERM' : null; },
      },
    });
    strictEqual(readFileSync(target, 'utf8'), 'moved');
    strictEqual(existsSync(source), false);
    ok(renameCalls >= 2, `expected the source-backup and target publishes to retry, saw ${renameCalls}`);
  });
});

describe('concurrent lifecycle transitions', () => {
  it('serializes ordinary and git touch writers with a lifecycle transition', async () => {
    const root = setup();
    mkdirSync(path.join(root, 'docs'));
    const configPath = path.join(root, 'dotmd.config.mjs');
    writeFileSync(configPath, `export const root = 'docs';\n`);
    const plan = path.join(root, 'docs', 'plan.md');
    writeFileSync(plan, `---\ntype: plan\nstatus: active\nupdated: 2020-01-01\n---\n# Plan\n\n## Version History\n`);
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    spawnSync('git', ['add', '.'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'future'], {
      cwd: root,
      env: { ...process.env, GIT_AUTHOR_DATE: '2030-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2030-01-01T00:00:00Z' },
    });
    const gate = path.join(root, 'touch.go');
    const wrapper = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      writeFileSync(process.argv[1], 'ready');
      while (!existsSync(process.argv[2])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      const result = spawnSync(process.execPath, JSON.parse(process.argv[3]), { cwd: process.argv[4], stdio: 'inherit', env: process.env });
      process.exit(result.status ?? 1);
    `;
    const commands = [
      [bin, 'touch', plan, '--config', configPath],
      [bin, 'touch', '--git', plan, '--config', configPath],
      [bin, 'set', 'planned', plan, '--note', 'concurrent lifecycle', '--no-index', '--config', configPath],
    ];
    const pending = commands.map((args, index) => {
      const ready = path.join(root, `touch-${index}.ready`);
      return { ready, done: completed(child(wrapper, [ready, gate, JSON.stringify(args), root])) };
    });
    await waitForFiles(pending.map(item => item.ready));
    writeFileSync(gate, 'go');
    const results = await Promise.all(pending.map(item => item.done));
    ok(results.every(result => result.status === 0), results.map(result => result.stderr).join('\n'));
    const final = readFileSync(plan, 'utf8');
    match(final, /^status: planned$/m);
    match(final, /concurrent lifecycle/);
    ok(final.startsWith('---\n') && final.includes('\n---\n# Plan'));
  });

  it('serializes six transitions without truncation and preserves every history entry', async () => {
    const root = setup();
    mkdirSync(path.join(root, 'docs'));
    writeFileSync(path.join(root, 'dotmd.config.mjs'), `export const root = 'docs';\nexport const types = { plan: { statuses: ['in-session', 'active', 'planned', 'blocked', 'partial', 'paused', 'awaiting', 'queued-after', 'reviewing', 'archived'] } };\n`);
    const plan = path.join(root, 'docs', 'plan.md');
    writeFileSync(plan, `---
type: plan
status: active
updated: 2026-01-01T00:00:00Z
---
# Plan

## Version History

- **2026-01-01T00:00:00Z** Created.
`);
    // Pickup has its own exclusive ownership race semantics; this test targets
    // ordinary status-transition serialization only.
    const statuses = ['planned', 'reviewing', 'awaiting', 'partial', 'blocked', 'queued-after'];
    const gate = path.join(root, 'transitions.go');
    const wrapper = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      writeFileSync(process.argv[1], 'ready');
      while (!existsSync(process.argv[2])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      const result = spawnSync(process.execPath, JSON.parse(process.argv[3]), { cwd: process.argv[4], stdio: 'inherit', env: process.env });
      process.exit(result.status ?? 1);
    `;
    const pending = statuses.map((status, index) => {
      const ready = path.join(root, `transition-${index}.ready`);
      const args = [bin, 'set', status, plan, '--note', `transition-${status}`, '--no-index', '--config', path.join(root, 'dotmd.config.mjs')];
      return { ready, done: completed(child(wrapper, [ready, gate, JSON.stringify(args), root])) };
    });
    await waitForFiles(pending.map(item => item.ready));
    writeFileSync(gate, 'go');
    const runs = pending.map(item => item.done);
    const results = await Promise.all(runs);
    ok(results.every(r => r.status === 0), results.map(r => r.stderr).join('\n'));
    const final = readFileSync(plan, 'utf8');
    ok(final.startsWith('---\n') && final.includes('\n---\n# Plan'));
    for (const status of statuses) {
      strictEqual((final.match(new RegExp(`transition-${status}`, 'g')) ?? []).length, 1, `history preserved for ${status}`);
    }
    strictEqual(lockEntries(root).length, 0);
  });

  it('keeps the normal generated index current across concurrent transitions', async () => {
    const root = setup();
    mkdirSync(path.join(root, 'docs'));
    const configPath = path.join(root, 'dotmd.config.mjs');
    writeFileSync(configPath, `export const root = 'docs';\nexport const types = { plan: { statuses: ['in-session', 'active', 'planned', 'blocked', 'partial', 'paused', 'awaiting', 'queued-after', 'reviewing', 'archived'] } };\nexport const index = { path: 'docs/docs.md', startMarker: '<!-- START -->', endMarker: '<!-- END -->' };\n`);
    const plan = path.join(root, 'docs', 'plan.md');
    writeFileSync(plan, `---\ntype: plan\nstatus: active\ntitle: Plan\nupdated: 2026-01-01\n---\n# Plan\n\n## Version History\n`);
    writeFileSync(path.join(root, 'docs', 'docs.md'), `# Index\n\n<!-- START -->\n\n<!-- END -->\n`);
    const gate = path.join(root, 'indexed.go');
    const wrapper = `
      import { existsSync, writeFileSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      writeFileSync(process.argv[1], 'ready');
      while (!existsSync(process.argv[2])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      const result = spawnSync(process.execPath, JSON.parse(process.argv[3]), { cwd: process.argv[4], stdio: 'inherit', env: process.env });
      process.exit(result.status ?? 1);
    `;
    const statuses = ['planned', 'reviewing', 'awaiting', 'partial', 'blocked', 'queued-after'];
    const pending = statuses.map((status, index) => {
      const ready = path.join(root, `indexed-${index}.ready`);
      const args = [bin, 'set', status, plan, '--note', `indexed-${status}`, '--config', configPath];
      return { ready, done: completed(child(wrapper, [ready, gate, JSON.stringify(args), root])) };
    });
    await waitForFiles(pending.map(item => item.ready));
    writeFileSync(gate, 'go');
    const results = await Promise.all(pending.map(item => item.done));
    ok(results.every(result => result.status === 0), results.map(result => result.stderr).join('\n'));
    const printed = spawnSync(process.execPath, [bin, 'index', '--print', '--config', configPath], { cwd: root, encoding: 'utf8' });
    strictEqual(printed.status, 0, printed.stderr);
    strictEqual(readFileSync(path.join(root, 'docs', 'docs.md'), 'utf8'), printed.stdout);
  });
});

describe('atomic lifecycle moves', () => {
  it('builds consume results from actual claim, archive, ownership, and index work', async () => {
    const root = setup();
    mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });
    mkdirSync(path.join(root, 'docs', 'prompts'), { recursive: true });
    const configPath = path.join(root, 'dotmd.config.mjs');
    writeFileSync(configPath, `export const root = 'docs';\nexport const index = { path: 'docs/docs.md', startMarker: '<!-- START -->', endMarker: '<!-- END -->' };\n`);
    writeFileSync(path.join(root, 'docs', 'docs.md'), '# Index\n\n<!-- START -->\n\n<!-- END -->\n');
    const plan = path.join(root, 'docs', 'plans', 'linked.md');
    const prompt = path.join(root, 'docs', 'prompts', 'resume.md');
    const referrer = path.join(root, 'docs', 'referrer.md');
    writeFileSync(plan, '---\ntype: plan\nstatus: active\nupdated: 2026-01-01\n---\n# Plan\n');
    writeFileSync(prompt, '---\ntype: prompt\nstatus: pending\nplan: docs/plans/linked.md\nupdated: 2026-01-01\n---\nresume\n');
    const referrerContent = '---\ntype: doc\nstatus: active\nupdated: 2026-01-01\nrelated_docs: [prompts/resume.md]\n---\n[prompt](prompts/resume.md)\n';
    writeFileSync(referrer, referrerContent);
    const config = await resolveConfig(root, configPath);
    const prior = process.env.DOTMD_SESSION_ID;
    process.env.DOTMD_SESSION_ID = 'consume-result';
    try {
      const result = await consumePrompt(prompt, config, { writeBody: async () => true });
      strictEqual(result.operation, 'consume');
      strictEqual(result.claim.changed, true);
      strictEqual(result.claim.pendingCompletion, false);
      ok(result.repositoryFiles.includes('docs/plans/linked.md'));
      ok(!result.repositoryFiles.includes('docs/referrer.md'));
      strictEqual(readFileSync(referrer, 'utf8'), referrerContent, 'session-local prompt consumption skips durable inbound-reference repair');
      ok(result.repositoryFiles.every(file => !file.startsWith('.runlist/ownership/')));
      ok(result.sessionFiles.some(file => file.startsWith('.runlist/ownership/')));
      ok(result.sessionFiles.includes('docs/prompts/resume.md'));
      ok(result.sessionFiles.includes('docs/prompts/archived/resume.md'));
      strictEqual(result.generatedFiles.join(','), 'docs/docs.md');
      strictEqual(result.deferredGeneratedFiles.length, 0);
      const existingOwnershipPath = path.join(root, result.sessionFiles.find(file => file.startsWith('.runlist/ownership/')));
      const existingOwnership = JSON.parse(readFileSync(existingOwnershipPath, 'utf8'));
      existingOwnership.state = 'released';
      existingOwnership.operation = null;
      existingOwnership.releasedAt = new Date().toISOString();
      writeFileSync(existingOwnershipPath, JSON.stringify(existingOwnership, null, 2) + '\n');
      writeFileSync(plan, readFileSync(plan, 'utf8').replace('status: in-session', 'status: active'));
      const resumedPrompt = path.join(root, 'docs', 'prompts', 'resume-existing.md');
      writeFileSync(resumedPrompt, '---\ntype: prompt\nstatus: pending\nplan: docs/plans/linked.md\nupdated: 2026-01-02\n---\nresume existing\n');
      const resumed = await consumePrompt(resumedPrompt, config, { writeBody: async () => true });
      ok(resumed.sessionFiles.some(file => file.startsWith('.runlist/ownership/')), 'existing ownership update is session state');
      ok(resumed.repositoryFiles.every(file => !file.startsWith('.runlist/ownership/')), 'existing ownership update is never repository state');
    } finally {
      if (prior === undefined) delete process.env.DOTMD_SESSION_ID;
      else process.env.DOTMD_SESSION_ID = prior;
    }
  });

  it('prompt consumption emits the body from the locked committed source generation', async () => {
    const root = setup();
    mkdirSync(path.join(root, 'docs', 'prompts', 'archived'), { recursive: true });
    const configPath = path.join(root, 'dotmd.config.mjs');
    writeFileSync(configPath, `export const root = 'docs';\n`);
    const prompt = path.join(root, 'docs', 'prompts', 'resume.md');
    const makePrompt = body => `---\ntype: prompt\nstatus: pending\nupdated: 2026-01-01\n---\n${body}\n`;
    writeFileSync(prompt, makePrompt('stale body'));
    const config = await resolveConfig(root, configPath);
    let stdout = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = chunk => { stdout += String(chunk); return true; };
    try {
      consumePrompt(prompt, config, {
        noIndex: true,
        testHooks: { beforeMoveSnapshot: () => writeFileSync(prompt, makePrompt('locked body')) },
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    strictEqual(stdout, 'locked body\n');
    match(readFileSync(path.join(root, 'docs', 'prompts', 'archived', 'resume.md'), 'utf8'), /locked body/);
  });

  it('rolls source, destination, and inbound references back together', async () => {
    const root = setup();
    mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });
    mkdirSync(path.join(root, 'docs', 'archived'), { recursive: true });
    const configPath = path.join(root, 'dotmd.config.mjs');
    writeFileSync(configPath, `export const root = 'docs';\n`);
    const source = path.join(root, 'docs', 'plans', 'plan.md');
    const inbound = path.join(root, 'docs', 'other.md');
    const sourceRaw = `---\ntype: plan\nstatus: active\nupdated: 2026-01-01\nrelated_docs:\n  - ../other.md\n---\n# Plan\n`;
    const inboundRaw = `---\ntype: doc\nstatus: active\nupdated: 2026-01-01\nrelated_plans:\n  - plans/plan.md\n---\n[Plan](plans/plan.md)\n`;
    writeFileSync(source, sourceRaw);
    writeFileSync(inbound, inboundRaw);
    const config = await resolveConfig(root, configPath);
    throws(() => runArchive([source, '--no-index'], config, {
      testHooks: { afterMovePublish: () => { throw new Error('reference transaction failure'); } },
    }), /reference transaction failure/);
    strictEqual(readFileSync(source, 'utf8'), sourceRaw);
    strictEqual(readFileSync(inbound, 'utf8'), inboundRaw);
    strictEqual(existsSync(path.join(root, 'docs', 'archived', 'plan.md')), false);
  });

  it('renders closeout from the locked current body without losing a concurrent edit', async () => {
    const root = setup();
    const plans = path.join(root, 'docs', 'plans');
    mkdirSync(path.join(root, 'docs', 'archived'), { recursive: true });
    mkdirSync(plans, { recursive: true });
    const configPath = path.join(root, 'dotmd.config.mjs');
    writeFileSync(configPath, `export const root = 'docs';\n`);
    const source = path.join(plans, 'plan.md');
    const initial = `---\ntype: plan\nstatus: active\nupdated: 2026-01-01\n---\n# Plan\n\n## Version History\n\n- **2026-01-01** Created.\n`;
    writeFileSync(source, initial);
    const config = await resolveConfig(root, configPath);
    runArchive([source, '--closeout-template', '--no-index'], config, {
      testHooks: { beforeMoveSnapshot: () => writeFileSync(source, initial.replace('# Plan', '# Plan\n\nConcurrent body edit').replace('- **2026-01-01** Created.', '- **2026-02-01** Concurrent history.\n- **2026-01-01** Created.')) },
    });
    const archived = readFileSync(path.join(root, 'docs', 'archived', 'plan.md'), 'utf8');
    match(archived, /Concurrent body edit/);
    match(archived, /Concurrent history/);
    match(archived, /## Closeout/);
    match(archived, /Archived\./);
  });

  it('preserves git staging semantics for a tracked move', async () => {
    const root = setup();
    mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });
    mkdirSync(path.join(root, 'docs', 'archived'), { recursive: true });
    const configPath = path.join(root, 'dotmd.config.mjs');
    writeFileSync(configPath, `export const root = 'docs';\n`);
    const source = path.join(root, 'docs', 'plans', 'plan.md');
    writeFileSync(source, `---\ntype: plan\nstatus: active\nupdated: 2026-01-01\n---\n# Plan\n\n## Version History\n`);
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    spawnSync('git', ['add', '.'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    const config = await resolveConfig(root, configPath);
    runArchive([source, '--no-index'], config);
    const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n').sort();
    strictEqual(staged.includes('docs/plans/plan.md'), true);
    strictEqual(staged.includes('docs/archived/plan.md'), true);
    strictEqual(staged.some(item => item.includes('dotmd-move')), false);
  });

  it('restores the exact Git index entries when a tracked move rolls back', async () => {
    const root = setup();
    mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });
    mkdirSync(path.join(root, 'docs', 'archived'), { recursive: true });
    const configPath = path.join(root, 'dotmd.config.mjs');
    writeFileSync(configPath, `export const root = 'docs';\n`);
    const source = path.join(root, 'docs', 'plans', 'plan.md');
    writeFileSync(source, `---\ntype: plan\nstatus: active\nupdated: 2026-01-01\n---\n# Initial\n`);
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    spawnSync('git', ['add', '.'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    writeFileSync(source, readFileSync(source, 'utf8').replace('# Initial', '# Staged'));
    spawnSync('git', ['add', source], { cwd: root });
    const indexBefore = spawnSync('git', ['ls-files', '--stage', '--', 'docs/plans/plan.md', 'docs/archived/plan.md'], { cwd: root, encoding: 'utf8' }).stdout;
    writeFileSync(source, readFileSync(source, 'utf8').replace('# Staged', '# Worktree'));
    const config = await resolveConfig(root, configPath);
    throws(() => runArchive([source, '--no-index'], config, {
      testHooks: { afterMoveFinalize: () => { throw new Error('after staging'); } },
    }), /after staging/);
    const indexAfter = spawnSync('git', ['ls-files', '--stage', '--', 'docs/plans/plan.md', 'docs/archived/plan.md'], { cwd: root, encoding: 'utf8' }).stdout;
    strictEqual(indexAfter, indexBefore);
    match(readFileSync(source, 'utf8'), /# Worktree/);
    strictEqual(existsSync(path.join(root, 'docs', 'archived', 'plan.md')), false);
  });

  it('does not restore the Git index when failure occurs before staging is attempted', async () => {
    const root = setup();
    mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });
    mkdirSync(path.join(root, 'docs', 'archived'), { recursive: true });
    const configPath = path.join(root, 'dotmd.config.mjs');
    writeFileSync(configPath, `export const root = 'docs';\n`);
    const source = path.join(root, 'docs', 'plans', 'plan.md');
    const concurrent = path.join(root, 'concurrent.txt');
    writeFileSync(source, `---\ntype: plan\nstatus: active\nupdated: 2026-01-01\n---\n# Plan\n`);
    writeFileSync(concurrent, 'initial');
    spawnSync('git', ['init', '-q'], { cwd: root });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    spawnSync('git', ['add', '.'], { cwd: root });
    spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
    const config = await resolveConfig(root, configPath);
    throws(() => runArchive([source, '--no-index'], config, {
      testHooks: { afterReservationAcquired: () => {
        writeFileSync(concurrent, 'concurrent staged edit');
        spawnSync('git', ['add', concurrent], { cwd: root });
        throw new Error('early move failure');
      } },
    }), /early move failure/);
    const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: root, encoding: 'utf8' }).stdout.trim().split('\n');
    strictEqual(staged.includes('concurrent.txt'), true);
    strictEqual(readFileSync(source, 'utf8').includes('# Plan'), true);
  });
});
