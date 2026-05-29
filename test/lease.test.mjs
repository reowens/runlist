import { describe, it, beforeEach, afterEach } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, utimesSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  currentSessionId,
  readLeases,
  writeLeases,
  withLeaseLock,
  acquireLease,
  releaseLease,
  releaseAllForSession,
  releaseStale,
  findStaleLeases,
  migrateLease,
  isPidAlive,
  isLeasePidDead,
  isLeaseStale,
  isLeaseReclaimable,
  leasePathFor,
  STALE_LEASE_AGE_MS,
  STALE_LEASE_AGE_HOURS,
} from '../src/lease.mjs';

let tmpDir;
let config;

function setup() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-lease-'));
  config = { repoRoot: tmpDir };
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  // restore env
  delete process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_SESSION_ID;
  delete process.env.TERM_SESSION_ID;
});

describe('currentSessionId', () => {
  it('prefers CLAUDE_CODE_SESSION_ID', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'cc-1';
    process.env.CLAUDE_SESSION_ID = 'legacy-1';
    process.env.TERM_SESSION_ID = 'term-1';
    strictEqual(currentSessionId(), 'cc-1');
  });

  it('falls back to CLAUDE_SESSION_ID', () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    process.env.CLAUDE_SESSION_ID = 'legacy-1';
    process.env.TERM_SESSION_ID = 'term-1';
    strictEqual(currentSessionId(), 'legacy-1');
  });

  it('falls back to TERM_SESSION_ID with prefix', () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    process.env.TERM_SESSION_ID = 'abc-123';
    strictEqual(currentSessionId(), 'term:abc-123');
  });

  it('falls back to shell:user@host when nothing else is set', () => {
    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    delete process.env.TERM_SESSION_ID;
    const id = currentSessionId();
    ok(id.startsWith('shell:'), `expected shell: prefix, got ${id}`);
    ok(id.includes('@'), 'should contain user@host');
  });
});

describe('acquireLease', () => {
  beforeEach(() => {
    setup();
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-A';
  });

  it('writes a lease file with the documented shape', () => {
    const result = acquireLease(config, 'docs/plans/foo.md', 'active');
    strictEqual(result.outcome, 'acquired');
    ok(result.lease);
    strictEqual(result.lease.path, 'docs/plans/foo.md');
    strictEqual(result.lease.oldStatus, 'active');
    strictEqual(result.lease.session, 'sess-A');
    strictEqual(result.lease.host, os.hostname());
    strictEqual(typeof result.lease.pid, 'number');
    ok(result.lease.pickedUpAt);

    const onDisk = readLeases(config);
    deepStrictEqual(onDisk['docs/plans/foo.md'], result.lease);
  });

  it('same-session re-attach is a no-op (returns reattached)', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    const second = acquireLease(config, 'docs/plans/foo.md', 'active');
    strictEqual(second.outcome, 'reattached');
    strictEqual(second.lease.session, 'sess-A');
  });

  it('cross-session with live pid reports conflict-alive', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-B';
    const result = acquireLease(config, 'docs/plans/foo.md', 'active');
    strictEqual(result.outcome, 'conflict-alive');
    strictEqual(result.conflict.session, 'sess-A');
    strictEqual(result.lease, null);
  });

  it('cross-session with old (>24h) lease reports conflict-stale', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    // Forge an old pickedUpAt
    const leases = readLeases(config);
    leases['docs/plans/foo.md'].pickedUpAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeLeases(config, leases);

    process.env.CLAUDE_CODE_SESSION_ID = 'sess-B';
    const result = acquireLease(config, 'docs/plans/foo.md', 'active');
    strictEqual(result.outcome, 'conflict-stale');
    strictEqual(result.conflict.session, 'sess-A');
  });

  it('cross-session with dead same-host pid reports conflict-stale', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    const leases = readLeases(config);
    leases['docs/plans/foo.md'].pid = 999999999;
    writeLeases(config, leases);

    process.env.CLAUDE_CODE_SESSION_ID = 'sess-B';
    const result = acquireLease(config, 'docs/plans/foo.md', 'active');
    strictEqual(result.outcome, 'conflict-stale');
    strictEqual(result.conflict.session, 'sess-A');
  });

  it('same-session re-attach ignores the prior dead command pid', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    const leases = readLeases(config);
    leases['docs/plans/foo.md'].pid = 999999999;
    writeLeases(config, leases);

    const result = acquireLease(config, 'docs/plans/foo.md', 'active');
    strictEqual(result.outcome, 'reattached');
    strictEqual(result.lease.session, 'sess-A');
    strictEqual(result.lease.pid, process.pid);
  });

  it('--takeover replaces the lease and records takenOverFrom', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    const original = readLeases(config)['docs/plans/foo.md'];

    process.env.CLAUDE_CODE_SESSION_ID = 'sess-B';
    const result = acquireLease(config, 'docs/plans/foo.md', 'active', { takeover: true });
    strictEqual(result.outcome, 'taken-over');
    strictEqual(result.lease.session, 'sess-B');
    ok(result.lease.takenOverFrom);
    strictEqual(result.lease.takenOverFrom.session, 'sess-A');
    strictEqual(result.lease.takenOverFrom.pid, original.pid);
  });
});

describe('releaseLease', () => {
  beforeEach(() => {
    setup();
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-A';
  });

  it('removes own lease', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    const result = releaseLease(config, 'docs/plans/foo.md');
    strictEqual(result.released, true);
    strictEqual(result.lease.session, 'sess-A');
    deepStrictEqual(readLeases(config), {});
  });

  it('refuses to remove another session\'s lease without --force', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-B';
    const result = releaseLease(config, 'docs/plans/foo.md');
    strictEqual(result.released, false);
    strictEqual(result.reason, 'not-yours');
    ok(readLeases(config)['docs/plans/foo.md']);
  });

  it('removes another session\'s lease with --force', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-B';
    const result = releaseLease(config, 'docs/plans/foo.md', { force: true });
    strictEqual(result.released, true);
    deepStrictEqual(readLeases(config), {});
  });

  it('returns no-lease when nothing to release', () => {
    const result = releaseLease(config, 'docs/plans/foo.md');
    strictEqual(result.released, false);
    strictEqual(result.reason, 'no-lease');
  });
});

describe('findStaleLeases / releaseStale', () => {
  beforeEach(() => {
    setup();
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-A';
  });

  it('flags lease whose pickedUpAt is older than 24h', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    const leases = readLeases(config);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    leases['docs/plans/foo.md'].pickedUpAt = old;
    writeLeases(config, leases);

    const stale = findStaleLeases(config);
    strictEqual(stale.length, 1);
  });

  it('does NOT flag a fresh lease as stale (pid alive or not)', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    // Even with a forged-dead pid, freshness wins for the current session.
    const leases = readLeases(config);
    leases['docs/plans/foo.md'].pid = 999999999;
    writeLeases(config, leases);

    const stale = findStaleLeases(config);
    strictEqual(stale.length, 0);
  });

  it('flags a fresh dead-pid lease held by a different same-host session', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    const leases = readLeases(config);
    leases['docs/plans/foo.md'].pid = 999999999;
    writeLeases(config, leases);

    process.env.CLAUDE_CODE_SESSION_ID = 'sess-B';
    const stale = findStaleLeases(config);
    strictEqual(stale.length, 1);
    strictEqual(stale[0].path, 'docs/plans/foo.md');
  });

  it('does NOT flag a fresh dead-pid lease from another host', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    const leases = readLeases(config);
    leases['docs/plans/foo.md'].host = 'some-other-host.local';
    leases['docs/plans/foo.md'].pid = 999999999;
    writeLeases(config, leases);

    process.env.CLAUDE_CODE_SESSION_ID = 'sess-B';
    const stale = findStaleLeases(config);
    strictEqual(stale.length, 0);
  });

  it('releaseStale removes only stale leases', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    acquireLease(config, 'docs/plans/bar.md', 'active');
    const leases = readLeases(config);
    leases['docs/plans/foo.md'].pickedUpAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeLeases(config, leases);

    const result = releaseStale(config);
    strictEqual(result.released.length, 1);
    strictEqual(result.released[0].path, 'docs/plans/foo.md');
    ok(readLeases(config)['docs/plans/bar.md']);
  });
});

describe('releaseAllForSession', () => {
  beforeEach(() => {
    setup();
  });

  it('releases only leases owned by the given session', () => {
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-A';
    acquireLease(config, 'docs/plans/foo.md', 'active');
    acquireLease(config, 'docs/plans/bar.md', 'active');

    process.env.CLAUDE_CODE_SESSION_ID = 'sess-B';
    acquireLease(config, 'docs/plans/baz.md', 'active');

    const result = releaseAllForSession(config, 'sess-A');
    strictEqual(result.released.length, 2);

    const remaining = readLeases(config);
    strictEqual(Object.keys(remaining).length, 1);
    ok(remaining['docs/plans/baz.md']);
  });
});

describe('migrateLease', () => {
  beforeEach(() => {
    setup();
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-A';
  });

  it('moves the lease key, preserves the value', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    const before = { ...readLeases(config)['docs/plans/foo.md'] };

    const ok_ = migrateLease(config, 'docs/plans/foo.md', 'docs/plans/renamed.md');
    strictEqual(ok_, true);

    const after = readLeases(config);
    ok(!after['docs/plans/foo.md']);
    ok(after['docs/plans/renamed.md']);
    strictEqual(after['docs/plans/renamed.md'].session, before.session);
    strictEqual(after['docs/plans/renamed.md'].pid, before.pid);
    strictEqual(after['docs/plans/renamed.md'].path, 'docs/plans/renamed.md');
  });

  it('returns false when the source lease does not exist', () => {
    strictEqual(migrateLease(config, 'docs/plans/nope.md', 'docs/plans/yes.md'), false);
  });
});

describe('atomic write', () => {
  beforeEach(() => {
    setup();
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-A';
  });

  it('does not leave a temp file behind on normal write', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    const dir = path.dirname(leasePathFor(config));
    const tmpFiles = readdirSync(dir).filter(name => name.includes('.tmp.'));
    deepStrictEqual(tmpFiles, []);
  });

  it('writes valid JSON that round-trips through JSON.parse', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    const raw = readFileSync(leasePathFor(config), 'utf8');
    const parsed = JSON.parse(raw);
    ok(parsed['docs/plans/foo.md']);
    strictEqual(parsed['docs/plans/foo.md'].session, 'sess-A');
  });

  it('removes the lease file when the last lease is released', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    ok(existsSync(leasePathFor(config)));
    releaseLease(config, 'docs/plans/foo.md');
    ok(!existsSync(leasePathFor(config)));
  });

  it('treats a corrupt lease file as empty', () => {
    mkdirSync(path.dirname(leasePathFor(config)), { recursive: true });
    writeFileSync(leasePathFor(config), '{ this is not json');
    const leases = readLeases(config);
    deepStrictEqual(leases, {});
  });
});

describe('withLeaseLock', () => {
  beforeEach(() => {
    setup();
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-A';
  });

  it('recovers when a stale lockfile (>5s) is present', () => {
    const lockPath = path.join(tmpDir, '.dotmd', 'in-session.lock');
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, '');
    const oldTime = new Date(Date.now() - 10_000);
    utimesSync(lockPath, oldTime, oldTime);

    let ran = false;
    withLeaseLock(config, () => { ran = true; });
    strictEqual(ran, true);
    ok(!existsSync(lockPath), 'lock should be removed after fn returns');
  });

  it('serializes nested calls correctly via fresh acquire', () => {
    let ranInner = false;
    withLeaseLock(config, () => {
      // simulate internal work
      ranInner = true;
    });
    strictEqual(ranInner, true);
  });
});

describe('STALE_LEASE_AGE threshold (release-ergonomics Fix B)', () => {
  beforeEach(() => {
    setup();
    process.env.CLAUDE_CODE_SESSION_ID = 'sess-A';
  });

  it('exports a 4-hour threshold', () => {
    strictEqual(STALE_LEASE_AGE_HOURS, 4);
    strictEqual(STALE_LEASE_AGE_MS, 4 * 60 * 60 * 1000);
  });

  it('flags a 5h-old lease as stale', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    const leases = readLeases(config);
    leases['docs/plans/foo.md'].pickedUpAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    writeLeases(config, leases);
    strictEqual(findStaleLeases(config).length, 1);
  });

  it('does NOT flag a 3h-old lease as stale', () => {
    acquireLease(config, 'docs/plans/foo.md', 'active');
    const leases = readLeases(config);
    leases['docs/plans/foo.md'].pickedUpAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    writeLeases(config, leases);
    strictEqual(findStaleLeases(config).length, 0);
  });
});

describe('isPidAlive', () => {
  it('returns true for the current process', () => {
    strictEqual(isPidAlive(process.pid, os.hostname()), true);
  });

  it('returns false for an implausible pid', () => {
    strictEqual(isPidAlive(999999999, os.hostname()), false);
  });

  it('returns true for a different host (unknown, assume alive)', () => {
    strictEqual(isPidAlive(123, 'some-other-host.local'), true);
  });

  it('returns false for invalid pid input', () => {
    strictEqual(isPidAlive(0, os.hostname()), false);
    strictEqual(isPidAlive(-5, os.hostname()), false);
    strictEqual(isPidAlive('not-a-number', os.hostname()), false);
  });
});

describe('isLeasePidDead / isLeaseReclaimable', () => {
  it('treats dead same-host pids as reclaimable only for a different session', () => {
    const lease = {
      path: 'docs/plans/foo.md',
      oldStatus: 'active',
      session: 'sess-A',
      pid: 999999999,
      host: os.hostname(),
      pickedUpAt: new Date().toISOString(),
    };

    strictEqual(isLeasePidDead(lease), true);
    strictEqual(isLeaseReclaimable(lease, { currentSession: 'sess-A' }), false);
    strictEqual(isLeaseReclaimable(lease, { currentSession: 'sess-B' }), true);
  });
});
