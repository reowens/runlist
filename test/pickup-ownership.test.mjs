import { afterEach, describe, it } from 'node:test';
import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { beginClaimHookDelivery, canonicalPlanIdentity, canonicalizePathEntrySpelling, classifyPlanPickup, preparePlanClaim, readPlanOwnership } from '../src/pickup.mjs';
import { resolveConfig } from '../src/config.mjs';
import { buildIndex } from '../src/index.mjs';
import { completePlanClaim, pickupCandidates, runArchive, runSet, startPlan } from '../src/lifecycle.mjs';
import { mutateFileSet } from '../src/atomic-mutation.mjs';
import { consumePrompt } from '../src/prompts.mjs';
import { runBaton } from '../src/baton.mjs';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmp;

function facts(overrides = {}) {
  return {
    type: 'plan', status: 'active', validStatuses: new Set(['in-session', 'active', 'planned', 'blocked', 'partial', 'paused', 'awaiting', 'queued-after', 'archived', 'done']),
    startableStatuses: new Set(['active', 'planned']), terminalStatuses: new Set(['archived']),
    archiveStatuses: new Set(['archived']), physicallyArchived: false, ownership: null,
    sessionId: 'A', malformed: false, ...overrides,
  };
}

function setup(configExtra = '') {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'dotmd-own-'));
  spawnSync('git', ['init', '-q'], { cwd: tmp });
  spawnSync('git', ['config', 'user.email', 't@t.test'], { cwd: tmp });
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: tmp });
  mkdirSync(path.join(tmp, 'docs', 'plans'), { recursive: true });
  mkdirSync(path.join(tmp, 'docs', 'prompts'), { recursive: true });
  writeFileSync(path.join(tmp, 'dotmd.config.mjs'), `export const root = 'docs';\n${configExtra}`);
}

function plan(name, status = 'active') {
  const file = path.join(tmp, 'docs', 'plans', `${name}.md`);
  writeFileSync(file, `---\ntype: plan\nstatus: ${status}\ntitle: ${name}\nupdated: 2025-01-01T00:00:00Z\ncurrent_state: testing ${name}\n---\n# ${name}\n\n## Version History\n\n- **2025-01-01T00:00:00Z** Created.\n`);
  return file;
}

function run(args, sid = 'A', env = {}) {
  return spawnSync('node', [bin, ...args, '--config', path.join(tmp, 'dotmd.config.mjs')], {
    cwd: tmp, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', CLAUDE_CODE_SESSION_ID: sid, ...env },
  });
}

function runAsync(args, sid) {
  return new Promise(resolve => {
    const child = spawn('node', [bin, ...args, '--config', path.join(tmp, 'dotmd.config.mjs')], {
      cwd: tmp, env: { ...process.env, NO_COLOR: '1', CLAUDE_CODE_SESSION_ID: sid },
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => resolve({ status: code, stderr }));
  });
}

function ownershipFile() {
  const dir = path.join(tmp, '.dotmd', 'ownership');
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : [];
  strictEqual(files.length, 1);
  return path.join(dir, files[0]);
}

afterEach(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null; });

describe('pure pickup classifier', () => {
  it('distinguishes every default parked status from terminal and physical archive states', () => {
    for (const status of ['blocked', 'partial', 'paused', 'awaiting', 'queued-after']) {
      strictEqual(classifyPlanPickup(facts({ status })).kind, 'parked', status);
    }
    strictEqual(classifyPlanPickup(facts({ status: 'archived' })).kind, 'terminal');
    strictEqual(classifyPlanPickup(facts({ physicallyArchived: true })).kind, 'physical-archive');
  });

  it('honors custom terminal status and rejects malformed/type/config errors', () => {
    strictEqual(classifyPlanPickup(facts({ status: 'done', terminalStatuses: new Set(['done']) })).kind, 'terminal');
    strictEqual(classifyPlanPickup(facts({ malformed: true })).kind, 'malformed');
    strictEqual(classifyPlanPickup(facts({ type: 'doc' })).kind, 'wrong-type');
    strictEqual(classifyPlanPickup(facts({ status: 'mystery' })).kind, 'unconfigured-status');
  });

  it('distinguishes start, legacy adoption, same-owner resume, and busy', () => {
    strictEqual(classifyPlanPickup(facts()).kind, 'start');
    strictEqual(classifyPlanPickup(facts({ status: 'in-session' })).kind, 'adopt');
    strictEqual(classifyPlanPickup(facts({ status: 'in-session', ownership: { state: 'owned', sessionId: 'A' } })).kind, 'resume');
    strictEqual(classifyPlanPickup(facts({ ownership: { state: 'owned', sessionId: 'B' } })).kind, 'busy');
  });
});

describe('durable lifecycle ownership', () => {
  it('allows exactly one winner in a two-session claim race', async () => {
    setup();
    plan('race');
    const results = await Promise.all([
      runAsync(['use', 'docs/plans/race.md'], 'A'),
      runAsync(['use', 'docs/plans/race.md'], 'B'),
    ]);
    strictEqual(results.filter(r => r.status === 0).length, 1, results.map(r => r.stderr).join('\n'));
    const record = JSON.parse(readFileSync(ownershipFile(), 'utf8'));
    ok(['A', 'B'].includes(record.sessionId));
    strictEqual(record.state, 'owned');
  });

  it('same-owner resume is byte-idempotent and another owner is busy', () => {
    setup();
    const file = plan('resume');
    strictEqual(run(['use', file], 'A').status, 0);
    const before = { plan: readFileSync(file, 'utf8'), owner: readFileSync(ownershipFile(), 'utf8') };
    strictEqual(run(['use', file], 'A').status, 0);
    deepStrictEqual({ plan: readFileSync(file, 'utf8'), owner: readFileSync(ownershipFile(), 'utf8') }, before);
    const busy = run(['use', file], 'B');
    ok(busy.status !== 0);
    match(busy.stderr, /busy.*owned by A/i);
  });

  it('safely adopts a genuinely unowned legacy in-session plan', () => {
    setup();
    const file = plan('legacy', 'in-session');
    const before = readFileSync(file, 'utf8');
    strictEqual(run(['use', file], 'A').status, 0);
    strictEqual(readFileSync(file, 'utf8'), before, 'adoption does not invent a second start transition');
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).sessionId, 'A');
  });

  it('rejects a configured custom terminal status', () => {
    setup([
      `export const types = { plan: { statuses: ['in-session', 'active', 'planned', 'blocked', 'partial', 'paused', 'awaiting', 'queued-after', 'done'] } };`,
      `export const lifecycle = { terminalStatuses: ['done'] };`,
    ].join('\n'));
    const file = plan('finished', 'done');
    const result = run(['use', file], 'A');
    ok(result.status !== 0);
    match(result.stderr, /terminal/);
    ok(!existsSync(path.join(tmp, '.dotmd', 'ownership')));
  });

  it('requires explicit --force to recover another session and rewrites ownership', () => {
    setup();
    const file = plan('recover');
    strictEqual(run(['use', file], 'A').status, 0);
    ok(run(['use', file], 'B').status !== 0);
    strictEqual(run(['use', file, '--force'], 'B').status, 0);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).sessionId, 'B');
  });

  it('serializes a release/recovery race to one consistent winner', async () => {
    setup();
    const file = plan('release-race');
    strictEqual(run(['use', file], 'A').status, 0);
    const results = await Promise.all([
      runAsync(['set', 'active', file], 'A'),
      runAsync(['use', file, '--force'], 'B'),
    ]);
    const raw = readFileSync(file, 'utf8');
    const record = JSON.parse(readFileSync(ownershipFile(), 'utf8'));
    if (/^status: active$/m.test(raw)) strictEqual(record.state, 'released');
    else {
      match(raw, /^status: in-session$/m);
      strictEqual(record.state, 'owned');
      ok(['A', 'B'].includes(record.sessionId));
      const retry = run(['use', file], record.sessionId);
      strictEqual(retry.status, 0, `${results.map(result => result.stderr).join('\n')}\nretry: ${retry.stderr}`);
    }
  });

  // The deterministic half of the race above. That test drives two real
  // processes and can only observe whichever interleaving the scheduler happens
  // to produce; it flaked on CI for months precisely because the losing
  // interleaving was REAL — an adopt-shaped claim (plan already in-session, so
  // nothing to render) wrote only the ownership record, and neither locked nor
  // compare-and-swapped the plan file its decision came from. A concurrent
  // `set active` landing in that window produced a record owning a plan the file
  // called `active`. This drives the seam directly, so the invariant is pinned
  // by construction instead of by timing.
  it('refuses an adopt claim when the plan changed after the claim was prepared', async () => {
    setup();
    const file = plan('adopt-window', 'in-session');
    const config = await resolveConfig(tmp);
    const raw = readFileSync(file, 'utf8');
    const prepared = preparePlanClaim({
      filePath: file, sourceContent: raw, renderedContent: null,
      ownership: readPlanOwnership('docs/plans/adopt-window.md', config),
      sessionId: 'B', now: new Date().toISOString(), config,
    });
    ok(prepared.guards.some(guard => path.resolve(guard.path) === path.resolve(file)),
      'an adopt claim carries the plan file as a read-only guard');

    // The other session's release lands in the window between B's read and B's write.
    writeFileSync(file, raw.replace('status: in-session', 'status: active'));

    throws(
      () => mutateFileSet(
        { updates: prepared.updates, creations: prepared.creations, guards: prepared.guards },
        { repoRoot: config.repoRoot },
      ),
      /changed while the mutation set was being prepared/,
    );
    ok(!existsSync(path.join(tmp, '.dotmd', 'ownership')),
      'a refused claim leaves no record — and no empty directory — behind');
    match(readFileSync(file, 'utf8'), /^status: active$/m);
  });

  it('fails safe on ownership corruption and permits explicit forced recovery', () => {
    setup();
    const file = plan('corrupt');
    strictEqual(run(['use', file], 'A').status, 0);
    writeFileSync(ownershipFile(), '{broken\n');
    ok(run(['use', file], 'A').status !== 0);
    strictEqual(run(['use', file, '--force'], 'A').status, 0);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).schema, 2);
  });

  it('no-target set uses exactly one owned plan and never a global in-session fallback', () => {
    setup();
    const mine = plan('mine');
    plan('legacy', 'in-session');
    strictEqual(run(['use', mine], 'A').status, 0);
    strictEqual(run(['set', 'active'], 'A').status, 0);
    ok(readFileSync(mine, 'utf8').includes('status: active'));
    ok(readFileSync(path.join(tmp, 'docs', 'plans', 'legacy.md'), 'utf8').includes('status: in-session'));
    ok(run(['set', 'active'], 'A').status !== 0, 'released ownership is not reused');
  });

  it('no-target baton refuses ambiguity between two plans owned by one session', () => {
    setup();
    const a = plan('a');
    const b = plan('b');
    strictEqual(run(['use', a], 'A').status, 0);
    strictEqual(run(['use', b], 'A').status, 0);
    const result = run(['baton', '--message', 'resume'], 'A');
    ok(result.status !== 0);
    match(result.stderr, /Multiple plans are owned/);
  });

  it('DOTMD_SESSION_ID is an authoritative non-Claude override', () => {
    setup();
    const file = plan('host');
    const env = { CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', DOTMD_SESSION_ID: 'ci-worker-7' };
    strictEqual(run(['use', file], '', env).status, 0);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).sessionId, 'ci-worker-7');
  });

  it('recognizes OpenCode identity and otherwise fails closed across fresh processes', () => {
    setup();
    const file = plan('host-id');
    const cleared = {
      CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', DOTMD_SESSION_ID: '', TERM_SESSION_ID: '',
      OPENCODE_SESSION_ID: 'oc-42', OPENCODE_SESSION: '',
    };
    strictEqual(run(['use', file], '', cleared).status, 0);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).sessionId, 'oc-42');

    const other = plan('no-host');
    const failed = run(['use', other], '', { ...cleared, OPENCODE_SESSION_ID: '' });
    ok(failed.status !== 0);
    match(failed.stderr, /DOTMD_SESSION_ID/);
  });

  it('uses canonical filesystem identity across equivalent root spellings and case aliases where supported', async () => {
    setup();
    const file = plan('identity');
    const config = await resolveConfig(tmp, path.join(tmp, 'dotmd.config.mjs'));
    const direct = canonicalPlanIdentity(file, config);
    const aliasRoot = path.join(tmp, 'root-alias');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(tmp, aliasRoot);
    const aliased = canonicalPlanIdentity(path.join(aliasRoot, 'docs', 'plans', 'identity.md'), config);
    strictEqual(aliased.key, direct.key);
    strictEqual(aliased.canonicalPath, direct.canonicalPath);

    const caseAlias = path.join(tmp, 'DOCS', 'plans', 'identity.md');
    if (existsSync(caseAlias)) {
      const cased = canonicalPlanIdentity(caseAlias, config);
      strictEqual(cased.key, direct.key);
    }
  });

  it('canonicalizes filename entry spelling through the injectable filesystem abstraction', () => {
    const root = path.parse(path.resolve('repo')).root;
    const repo = path.join(root, 'repo');
    const exact = path.join(repo, 'Foo.md');
    const alias = path.join(repo, 'foo.md');
    const ids = new Map([
      [root, [1n, 1n]], [repo, [1n, 2n]], [exact, [1n, 3n]], [alias, [1n, 3n]],
    ]);
    const fs = {
      readdirSync(dir) { return dir === root ? ['repo'] : dir === repo ? ['Foo.md'] : []; },
      statSync(file) {
        const identity = ids.get(file);
        if (!identity) throw new Error('missing');
        return { dev: identity[0], ino: identity[1] };
      },
    };
    strictEqual(canonicalizePathEntrySpelling(alias, fs), exact);
  });

  it('claims filename case aliases as one plan and rejects a second session where supported', async () => {
    setup();
    const exact = plan('Foo');
    const alias = path.join(path.dirname(exact), 'foo.md');
    if (!existsSync(alias)) return;
    const config = await resolveConfig(tmp, path.join(tmp, 'dotmd.config.mjs'));
    const beforeKey = canonicalPlanIdentity(alias, config).key;
    strictEqual(run(['use', alias], 'A').status, 0);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).identityKey, beforeKey);
    const busy = run(['use', exact], 'B');
    ok(busy.status !== 0);
    match(busy.stderr, /busy/);
    strictEqual(readdirSync(path.join(tmp, '.dotmd', 'ownership')).filter(name => name.endsWith('.json')).length, 1);
  });

  it('fails closed when record plan/canonical/key binding is semantically corrupted', () => {
    setup();
    const file = plan('binding');
    strictEqual(run(['use', file], 'A').status, 0);
    const recordPath = ownershipFile();
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    record.plan = 'docs/plans/other.md';
    writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
    const use = run(['use', file], 'A');
    ok(use.status !== 0);
    match(use.stderr, /binding mismatch|ownership-corrupt/);
    const implicit = run(['set', 'active'], 'A');
    ok(implicit.status !== 0);
    match(implicit.stderr, /Ignored ownership records/);
  });

  it('validates canonicalPath and identityKey bindings independently', () => {
    setup();
    const file = plan('identity-binding');
    strictEqual(run(['use', file], 'A').status, 0);
    const recordPath = ownershipFile();
    const original = JSON.parse(readFileSync(recordPath, 'utf8'));
    for (const [field, value] of [['canonicalPath', `${original.canonicalPath}-other`], ['identityKey', '0'.repeat(64)]]) {
      writeFileSync(recordPath, JSON.stringify({ ...original, [field]: value }, null, 2) + '\n');
      const result = run(['use', file], 'A');
      ok(result.status !== 0, field);
      match(result.stderr, /ownership-corrupt|binding mismatch/, field);
    }
  });

  it('ignores and diagnoses an orphan/stale owned record for no-target set and baton', () => {
    setup();
    const file = plan('stale');
    strictEqual(run(['use', file], 'A').status, 0);
    writeFileSync(file, readFileSync(file, 'utf8').replace('status: in-session', 'status: active'));
    const set = run(['set', 'paused'], 'A');
    ok(set.status !== 0);
    match(set.stderr, /stale because the plan is not in-session/);
    const baton = run(['baton', '--message', 'resume'], 'A');
    ok(baton.status !== 0);
    match(baton.stderr, /Ignored ownership records/);
  });

  it('uses parsed frontmatter only when validating owned type/status', () => {
    setup();
    const file = plan('body-decoy');
    strictEqual(run(['use', file], 'A').status, 0);
    const raw = readFileSync(file, 'utf8')
      .replace('status: in-session', 'status: active')
      .replace('# body-decoy', '# body-decoy\n\n```yaml\ntype: plan\nstatus: in-session\n```');
    writeFileSync(file, raw);
    const result = run(['set', 'paused'], 'A');
    ok(result.status !== 0);
    match(result.stderr, /stale because the plan is not in-session/);
  });

  it('deprecated status cannot release another session and releases atomically for its owner', () => {
    setup();
    const file = plan('deprecated');
    strictEqual(run(['use', file], 'A').status, 0);
    const denied = run(['status', file, 'active'], 'B');
    ok(denied.status !== 0);
    match(denied.stderr, /busy in another session/);
    ok(readFileSync(file, 'utf8').includes('status: in-session'));
    strictEqual(run(['status', file, 'active'], 'A').status, 0);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).state, 'released');
  });

  it('rolls document and ownership back together when release transaction fails', async () => {
    setup();
    const file = plan('release-rollback');
    strictEqual(run(['use', file], 'A').status, 0);
    const config = await resolveConfig(tmp, path.join(tmp, 'dotmd.config.mjs'));
    const beforePlan = readFileSync(file, 'utf8');
    const beforeOwner = readFileSync(ownershipFile(), 'utf8');
    const oldSession = process.env.DOTMD_SESSION_ID;
    process.env.DOTMD_SESSION_ID = 'A';
    try {
      await rejects(runSet(['active', file], config, {
        testHooks: { afterSetCommit: () => { throw new Error('release failure'); } },
      }), /release failure/);
    } finally {
      if (oldSession === undefined) delete process.env.DOTMD_SESSION_ID;
      else process.env.DOTMD_SESSION_ID = oldSession;
    }
    strictEqual(readFileSync(file, 'utf8'), beforePlan);
    strictEqual(readFileSync(ownershipFile(), 'utf8'), beforeOwner);
  });

  it('rolls archive move and ownership release back together on ordinary failure', async () => {
    setup();
    const file = plan('archive-rollback');
    strictEqual(run(['use', file], 'A').status, 0);
    const config = await resolveConfig(tmp, path.join(tmp, 'dotmd.config.mjs'));
    const beforePlan = readFileSync(file, 'utf8');
    const beforeOwner = readFileSync(ownershipFile(), 'utf8');
    const oldSession = process.env.DOTMD_SESSION_ID;
    process.env.DOTMD_SESSION_ID = 'A';
    try {
      await rejects(Promise.resolve().then(() => runArchive([file], config, {
        testHooks: { afterMovePublish: () => { throw new Error('archive release failure'); } },
      })), /archive release failure/);
    } finally {
      if (oldSession === undefined) delete process.env.DOTMD_SESSION_ID;
      else process.env.DOTMD_SESSION_ID = oldSession;
    }
    strictEqual(readFileSync(file, 'utf8'), beforePlan);
    strictEqual(readFileSync(ownershipFile(), 'utf8'), beforeOwner);
    ok(!existsSync(path.join(tmp, 'docs', 'archived', 'archive-rollback.md')));
  });

  it('set in-session --note records the note through the claim transition', () => {
    setup();
    const file = plan('noted');
    const result = run(['set', 'in-session', file, '--note', 'starting focused pass'], 'A');
    strictEqual(result.status, 0, result.stderr);
    match(readFileSync(file, 'utf8'), /Started \(active → in-session\) — starting focused pass/);
  });

  it('same-session rename migrates ownership while another session remains rejected', () => {
    setup();
    const file = plan('rename-owned');
    strictEqual(run(['use', file], 'A').status, 0);
    const owned = run(['rename', file, 'renamed'], 'A');
    strictEqual(owned.status, 0, owned.stderr);
    const renamed = path.join(path.dirname(file), 'renamed.md');
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).plan, 'docs/plans/renamed.md');
    const other = run(['rename', renamed, 'forbidden'], 'B');
    ok(other.status !== 0);
    match(other.stderr, /another session/);
    ok(existsSync(renamed));
  });

  it('busy linked prompt remains pending and byte-identical', () => {
    setup();
    const file = plan('busy-linked');
    strictEqual(run(['use', file], 'A').status, 0);
    const prompt = path.join(tmp, 'docs', 'prompts', 'resume-busy.md');
    writeFileSync(prompt, '---\ntype: prompt\nstatus: pending\nplan: docs/plans/busy-linked.md\n---\nresume body\n');
    const before = readFileSync(prompt, 'utf8');
    const result = run(['use', prompt], 'B');
    ok(result.status !== 0);
    match(result.stderr, /busy/);
    strictEqual(readFileSync(prompt, 'utf8'), before);
  });

  it('prompt pickup applies custom startable, parked, terminal, and physical-archive classification', () => {
    setup([
      `export const types = { plan: { statuses: ['in-session', 'active', 'ready-now', 'done'] } };`,
      `export const lifecycle = { startableStatuses: ['ready-now'], terminalStatuses: ['done'] };`,
    ].join('\n'));
    plan('ready', 'ready-now');
    plan('parked-custom', 'active');
    plan('terminal-custom', 'done');
    const archivedDir = path.join(tmp, 'docs', 'plans', 'archived');
    mkdirSync(archivedDir, { recursive: true });
    writeFileSync(path.join(archivedDir, 'physical.md'), '---\ntype: plan\nstatus: ready-now\ntitle: physical\n---\n# Physical\n');
    for (const [name, ref] of [
      ['ready', 'docs/plans/ready.md'],
      ['parked', 'docs/plans/parked-custom.md'],
      ['terminal', 'docs/plans/terminal-custom.md'],
      ['physical', 'docs/plans/archived/physical.md'],
    ]) {
      writeFileSync(path.join(tmp, 'docs', 'prompts', `${name}.md`), `---\ntype: prompt\nstatus: pending\nplan: ${ref}\n---\n${name} body\n`);
    }
    strictEqual(run(['use', 'ready'], 'A').status, 0);
    for (const [name, kind] of [['parked', 'parked'], ['terminal', 'terminal'], ['physical', 'physical-archive']]) {
      const prompt = path.join(tmp, 'docs', 'prompts', `${name}.md`);
      const before = readFileSync(prompt, 'utf8');
      const result = run(['use', name], 'A');
      ok(result.status !== 0, name);
      match(result.stderr, new RegExp(kind), name);
      strictEqual(readFileSync(prompt, 'utf8'), before, name);
    }
  });

  it('linked prompt conflict rolls prompt, plan, and ownership back before body emission', async () => {
    setup();
    const file = plan('linked-conflict');
    const prompt = path.join(tmp, 'docs', 'prompts', 'resume-conflict.md');
    writeFileSync(prompt, '---\ntype: prompt\nstatus: pending\nplan: docs/plans/linked-conflict.md\n---\nsecret resume body\n');
    const beforePrompt = readFileSync(prompt, 'utf8');
    const beforePlan = readFileSync(file, 'utf8');
    const config = await resolveConfig(tmp, path.join(tmp, 'dotmd.config.mjs'));
    const oldSession = process.env.DOTMD_SESSION_ID;
    process.env.DOTMD_SESSION_ID = 'A';
    try {
      await rejects(consumePrompt(prompt, config, {
        testHooks: { afterMovePublish: () => { throw new Error('linked transaction conflict'); } },
      }), /linked transaction conflict/);
    } finally {
      if (oldSession === undefined) delete process.env.DOTMD_SESSION_ID;
      else process.env.DOTMD_SESSION_ID = oldSession;
    }
    strictEqual(readFileSync(prompt, 'utf8'), beforePrompt);
    strictEqual(readFileSync(file, 'utf8'), beforePlan);
    ok(!existsSync(path.join(tmp, '.dotmd', 'ownership')) || readdirSync(path.join(tmp, '.dotmd', 'ownership')).length === 0);
  });

  it('same-status baton still releases ownership and rejects in-session target', () => {
    setup();
    const file = plan('same-status');
    strictEqual(run(['use', file], 'A').status, 0);
    writeFileSync(file, readFileSync(file, 'utf8').replace('status: in-session', 'status: active'));
    const baton = run(['baton', file, '--status', 'active', '--message', 'resume'], 'A');
    strictEqual(baton.status, 0, baton.stderr);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).state, 'released');

    const other = plan('no-in-session-baton');
    strictEqual(run(['use', other], 'A').status, 0);
    const denied = run(['baton', other, '--status', 'in-session', '--message', 'resume'], 'A');
    ok(denied.status !== 0);
    match(denied.stderr, /contradicts baton release semantics/);
  });

  it('baton rolls prompt, status, history, and ownership back on release or prompt publication failure', async () => {
    setup();
    const file = plan('atomic-baton');
    strictEqual(run(['use', file], 'A').status, 0);
    const config = await resolveConfig(tmp, path.join(tmp, 'dotmd.config.mjs'));
    const beforePlan = readFileSync(file, 'utf8');
    const beforeOwner = readFileSync(ownershipFile(), 'utf8');
    const previous = process.env.DOTMD_SESSION_ID;
    process.env.DOTMD_SESSION_ID = 'A';
    try {
      for (const failAt of [1, 3]) {
        await rejects(runBaton([file, '--message', 'atomic resume'], config, {
          testHooks: { afterSetCommit: count => { if (count === failAt) throw new Error(`baton failure ${failAt}`); } },
        }), new RegExp(`baton failure ${failAt}`));
        strictEqual(readFileSync(file, 'utf8'), beforePlan);
        strictEqual(readFileSync(ownershipFile(), 'utf8'), beforeOwner);
        ok(!readdirSync(path.join(tmp, 'docs', 'prompts')).some(name => name.startsWith('resume-atomic-baton')));
      }
    } finally {
      if (previous === undefined) delete process.env.DOTMD_SESSION_ID;
      else process.env.DOTMD_SESSION_ID = previous;
    }
  });

  it('baton precommit takeover conflict exposes no prompt and does not release the new owner', async () => {
    setup();
    const file = plan('baton-takeover');
    strictEqual(run(['use', file], 'A').status, 0);
    const config = await resolveConfig(tmp, path.join(tmp, 'dotmd.config.mjs'));
    const previous = process.env.DOTMD_SESSION_ID;
    process.env.DOTMD_SESSION_ID = 'A';
    try {
      await rejects(runBaton([file, '--message', 'must stay hidden'], config, {
        testHooks: {
          afterSetPreflight: () => {
            const recordPath = ownershipFile();
            const record = JSON.parse(readFileSync(recordPath, 'utf8'));
            record.sessionId = 'B';
            record.updatedAt = new Date().toISOString();
            writeFileSync(recordPath, JSON.stringify(record, null, 2) + '\n');
          },
        },
      }), /changed while|changed during|File changed/);
    } finally {
      if (previous === undefined) delete process.env.DOTMD_SESSION_ID;
      else process.env.DOTMD_SESSION_ID = previous;
    }
    match(readFileSync(file, 'utf8'), /^status: in-session$/m);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).sessionId, 'B');
    ok(!readdirSync(path.join(tmp, 'docs', 'prompts')).some(name => name.startsWith('resume-baton-takeover')));
  });

  it('body write failure is at-most-once and points to archived recovery tooling', async () => {
    setup();
    const prompt = path.join(tmp, 'docs', 'prompts', 'write-failure.md');
    writeFileSync(prompt, '---\ntype: prompt\nstatus: pending\n---\nrecover this body\n');
    const config = await resolveConfig(tmp, path.join(tmp, 'dotmd.config.mjs'));
    await rejects(consumePrompt(prompt, config, {
      writeBody: () => { const err = new Error('closed pipe'); err.code = 'EPIPE'; throw err; },
    }), /will not be emitted again.*prompts show/);
    ok(!existsSync(prompt));
    const archived = path.join(tmp, 'docs', 'prompts', 'archived', 'write-failure.md');
    ok(existsSync(archived));
    const second = run(['use', archived], 'A');
    ok(second.status !== 0);
    strictEqual(second.stdout, '');
    const shown = run(['prompts', 'show', archived], 'A');
    strictEqual(shown.status, 0, shown.stderr);
    match(shown.stdout, /recover this body/);

    const backpressure = path.join(tmp, 'docs', 'prompts', 'backpressure.md');
    writeFileSync(backpressure, '---\ntype: prompt\nstatus: pending\n---\nbackpressure body\n');
    await rejects(consumePrompt(backpressure, config, { writeBody: () => false }), /BACKPRESSURE.*will not be emitted again/);
    ok(existsSync(path.join(tmp, 'docs', 'prompts', 'archived', 'backpressure.md')));
  });

  it('linked body output failure reports archived recovery and exact claim completion command', async () => {
    setup();
    writeFileSync(path.join(tmp, 'dotmd.config.mjs'), `export const root = 'docs';\nexport function onPickup() {}\n`);
    const file = plan('linked-output');
    const prompt = path.join(tmp, 'docs', 'prompts', 'linked-output.md');
    writeFileSync(prompt, '---\ntype: prompt\nstatus: pending\nplan: docs/plans/linked-output.md\n---\nlinked recovery body\n');
    const config = await resolveConfig(tmp, path.join(tmp, 'dotmd.config.mjs'));
    let error;
    const previous = process.env.DOTMD_SESSION_ID;
    process.env.DOTMD_SESSION_ID = 'A';
    try {
      await consumePrompt(prompt, config, {
        writeBody: () => { const err = new Error('pipe closed'); err.code = 'EPIPE'; throw err; },
      });
    } catch (err) { error = err; }
    finally {
      if (previous === undefined) delete process.env.DOTMD_SESSION_ID;
      else process.env.DOTMD_SESSION_ID = previous;
    }
    ok(error);
    match(error.message, /dotmd prompts show docs\/prompts\/archived\/linked-output\.md/);
    match(error.message, /dotmd use docs\/plans\/linked-output\.md/);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).operation.hook, 'pending');
    const archived = path.join(tmp, 'docs', 'prompts', 'archived', 'linked-output.md');
    const shown = run(['prompts', 'show', archived], 'A');
    match(shown.stdout, /linked recovery body/);
    strictEqual(run(['use', file], 'A').status, 0);
    strictEqual((readFileSync(file, 'utf8').match(/Started \(active → in-session\)/g) ?? []).length, 1);
  });

  it('configured interactive candidates come from the classifier', async () => {
    setup([
      `export const types = { plan: { statuses: ['in-session', 'active', 'planned', 'ready-now', 'blocked', 'archived'] } };`,
      `export const lifecycle = { startableStatuses: ['ready-now'], terminalStatuses: ['archived'] };`,
    ].join('\n'));
    plan('active-not-startable', 'active');
    plan('configured-startable', 'ready-now');
    const config = await resolveConfig(tmp, path.join(tmp, 'dotmd.config.mjs'));
    const candidates = pickupCandidates(buildIndex(config), config, 'A');
    deepStrictEqual(candidates.map(candidate => candidate.path), ['docs/plans/configured-startable.md']);
  });

  it('retries index and hook completion without repeating claim history and reuses operation ID', () => {
    setup();
    const events = path.join(tmp, 'events');
    const hookGate = path.join(tmp, 'hook-gate');
    writeFileSync(path.join(tmp, 'dotmd.config.mjs'), [
      `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';`,
      `export const root = 'docs';`,
      `export const statuses = { order: ['in-session', 'active', 'archived'] };`,
      `export const index = { path: 'docs/README.md' };`,
      `export function onPickup(event) { appendFileSync(${JSON.stringify(events)}, event.operationId + '\\n'); if (!existsSync(${JSON.stringify(hookGate)})) { writeFileSync(${JSON.stringify(hookGate)}, 'x'); throw new Error('hook failure'); } }`,
    ].join('\n'));
    writeFileSync(path.join(tmp, 'docs', 'README.md'), '# Index\n\n<!-- GENERATED:dotmd:start -->\n<!-- GENERATED:dotmd:end -->\n');
    const file = plan('retry');
    const first = run(['use', file], 'A');
    ok(first.status !== 0);
    const second = run(['use', file], 'A');
    strictEqual(second.status, 0, second.stderr);
    strictEqual((readFileSync(file, 'utf8').match(/Started \(active → in-session\)/g) ?? []).length, 1);
    const ids = readFileSync(events, 'utf8').trim().split('\n');
    strictEqual(ids.length, 2);
    strictEqual(ids[0], ids[1]);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).operation.hook, 'done');
  });

  it('retries a failed index completion without repeating the claim transition', () => {
    setup([
      `export const statuses = { order: ['in-session', 'active', 'archived'] };`,
      `export const index = { path: 'docs/README.md' };`,
    ].join('\n'));
    const indexPath = path.join(tmp, 'docs', 'README.md');
    mkdirSync(indexPath);
    const file = plan('index-retry');
    const first = run(['use', file], 'A');
    ok(first.status !== 0);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).operation.index, 'pending');
    rmSync(indexPath, { recursive: true });
    writeFileSync(indexPath, '# Index\n\n<!-- GENERATED:dotmd:start -->\n<!-- GENERATED:dotmd:end -->\n');
    const second = run(['use', file], 'A');
    strictEqual(second.status, 0, second.stderr);
    strictEqual((readFileSync(file, 'utf8').match(/Started \(active → in-session\)/g) ?? []).length, 1);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).operation.index, 'done');
    match(readFileSync(indexPath, 'utf8'), /index-retry/);
  });

  it('delivers a committed prompt body before index failure and retries completion through the plan', () => {
    setup([
      `export const statuses = { order: ['in-session', 'active', 'pending', 'archived'] };`,
      `export const index = { path: 'docs/README.md' };`,
    ].join('\n'));
    const indexPath = path.join(tmp, 'docs', 'README.md');
    mkdirSync(indexPath);
    const file = plan('prompt-index-retry');
    const prompt = path.join(tmp, 'docs', 'prompts', 'resume-index.md');
    writeFileSync(prompt, '---\ntype: prompt\nstatus: pending\nplan: docs/plans/prompt-index-retry.md\n---\nexact committed body\n');

    const first = run(['use', prompt], 'A');
    ok(first.status !== 0);
    strictEqual(first.stdout, 'exact committed body\n');
    ok(!existsSync(prompt));
    ok(existsSync(path.join(tmp, 'docs', 'prompts', 'archived', 'resume-index.md')));
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).operation.index, 'pending');

    rmSync(indexPath, { recursive: true });
    writeFileSync(indexPath, '# Index\n\n<!-- GENERATED:dotmd:start -->\n<!-- GENERATED:dotmd:end -->\n');
    strictEqual(run(['use', file], 'A').status, 0);
    strictEqual((readFileSync(file, 'utf8').match(/Started \(active → in-session\)/g) ?? []).length, 1);
    const again = run(['use', path.join(tmp, 'docs', 'prompts', 'archived', 'resume-index.md')], 'A');
    ok(again.status !== 0);
    strictEqual(again.stdout, '');
  });

  it('delivers a committed prompt body before hook failure and retries with the same operation ID', () => {
    setup();
    const events = path.join(tmp, 'prompt-hook-events');
    const gate = path.join(tmp, 'prompt-hook-gate');
    writeFileSync(path.join(tmp, 'dotmd.config.mjs'), [
      `import { appendFileSync, existsSync, writeFileSync } from 'node:fs';`,
      `export const root = 'docs';`,
      `export function onPickup(event) { appendFileSync(${JSON.stringify(events)}, event.operationId + '\\n'); if (!existsSync(${JSON.stringify(gate)})) { writeFileSync(${JSON.stringify(gate)}, 'x'); throw new Error('prompt hook failure'); } }`,
    ].join('\n'));
    const file = plan('prompt-hook-retry');
    const prompt = path.join(tmp, 'docs', 'prompts', 'resume-hook.md');
    writeFileSync(prompt, '---\ntype: prompt\nstatus: pending\nplan: docs/plans/prompt-hook-retry.md\n---\nhook body once\n');

    const first = run(['use', prompt], 'A');
    ok(first.status !== 0);
    strictEqual(first.stdout, 'hook body once\n');
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).operation.hook, 'pending');
    strictEqual(run(['use', file], 'A').status, 0);
    const ids = readFileSync(events, 'utf8').trim().split('\n');
    strictEqual(ids.length, 2);
    strictEqual(ids[0], ids[1]);
    strictEqual((readFileSync(file, 'utf8').match(/Started \(active → in-session\)/g) ?? []).length, 1);
  });

  it('refuses release while claim hook completion remains pending', () => {
    setup();
    writeFileSync(path.join(tmp, 'dotmd.config.mjs'), `export const root = 'docs';\nexport function onPickup() { throw new Error('still pending'); }\n`);
    const file = plan('pending-hook-release');
    ok(run(['use', file], 'A').status !== 0);
    const before = readFileSync(file, 'utf8');
    const release = run(['set', 'active', file], 'A');
    ok(release.status !== 0);
    match(release.stderr, /still pending/);
    strictEqual(readFileSync(file, 'utf8'), before);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).state, 'owned');
  });

  it('refuses baton before prompt creation while claim index completion remains pending', () => {
    setup(`export const index = { path: 'docs/README.md' };\n`);
    const indexPath = path.join(tmp, 'docs', 'README.md');
    mkdirSync(indexPath);
    const file = plan('pending-index-baton');
    ok(run(['use', file], 'A').status !== 0);
    const baton = run(['baton', file, '--message', 'must not save'], 'A');
    ok(baton.status !== 0);
    ok(!readdirSync(path.join(tmp, 'docs', 'prompts')).some(name => name.startsWith('resume-pending-index-baton')));
    match(readFileSync(file, 'utf8'), /^status: in-session$/m);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).operation.index, 'pending');
  });

  it('dry-run set/archive/baton never reconcile or mutate pending completion', () => {
    setup(`export const index = { path: 'docs/README.md' };\nexport function onPickup() { throw new Error('hook must not run'); }\n`);
    const indexPath = path.join(tmp, 'docs', 'README.md');
    mkdirSync(indexPath);
    const file = plan('pending-dry-run');
    ok(run(['use', file], 'A').status !== 0);
    const before = {
      plan: readFileSync(file, 'utf8'),
      owner: readFileSync(ownershipFile(), 'utf8'),
      prompts: readdirSync(path.join(tmp, 'docs', 'prompts')),
    };
    for (const args of [
      ['set', 'active', file, '--dry-run'],
      ['archive', file, '--dry-run'],
      ['baton', file, '--message', 'resume', '--dry-run'],
    ]) {
      const result = run(args, 'A');
      strictEqual(result.status, 0, result.stderr);
      match(result.stderr + result.stdout, /Pending claim completion would block/);
      strictEqual(readFileSync(file, 'utf8'), before.plan);
      strictEqual(readFileSync(ownershipFile(), 'utf8'), before.owner);
      deepStrictEqual(readdirSync(path.join(tmp, 'docs', 'prompts')), before.prompts);
    }
  });

  it('pickup hook can invoke same-plan CLI without ownership-lock deadlock', () => {
    setup();
    const childResult = path.join(tmp, 'reentrant-result');
    writeFileSync(path.join(tmp, 'dotmd.config.mjs'), [
      `import { spawnSync } from 'node:child_process';`,
      `import { writeFileSync } from 'node:fs';`,
      `export const root = 'docs';`,
      `export function onPickup(event) { const r = spawnSync(process.execPath, [${JSON.stringify(bin)}, 'set', 'active', event.path, '--config', ${JSON.stringify(path.join(tmp, 'dotmd.config.mjs'))}], { cwd: ${JSON.stringify(tmp)}, encoding: 'utf8', env: { ...process.env, DOTMD_SESSION_ID: 'A' } }); writeFileSync(${JSON.stringify(childResult)}, String(r.status) + '\\n' + r.stderr); }`,
    ].join('\n'));
    const file = plan('reentrant');
    const result = run(['use', file], 'A');
    strictEqual(result.status, 0, result.stderr);
    const child = readFileSync(childResult, 'utf8');
    match(child, /^1\n/);
    match(child, /delivery is already in progress/);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).operation.hook, 'done');
  });

  it('concurrent completers lease one hook delivery', async () => {
    setup();
    const events = path.join(tmp, 'concurrent-hook-events');
    writeFileSync(path.join(tmp, 'dotmd.config.mjs'), [
      `import { appendFileSync } from 'node:fs';`,
      `export const root = 'docs';`,
      `export function onPickup(event) { appendFileSync(${JSON.stringify(events)}, event.operationId + '\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); }`,
    ].join('\n'));
    const file = plan('concurrent-completion');
    const results = await Promise.all([runAsync(['use', file], 'A'), runAsync(['use', file], 'A')]);
    ok(results.some(result => result.status === 0));
    strictEqual(readFileSync(events, 'utf8').trim().split('\n').length, 1);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).operation.hook, 'done');
  });

  it('retries an abandoned delivering lease after timeout with the same operation ID', async () => {
    setup();
    const events = path.join(tmp, 'abandoned-events');
    writeFileSync(path.join(tmp, 'dotmd.config.mjs'), [
      `import { appendFileSync } from 'node:fs';`,
      `export const root = 'docs';`,
      `export function onPickup(event) { appendFileSync(${JSON.stringify(events)}, event.operationId + '\\n'); throw new Error('leave pending'); }`,
    ].join('\n'));
    const file = plan('abandoned');
    ok(run(['use', file], 'A').status !== 0);
    const config = await resolveConfig(tmp, path.join(tmp, 'dotmd.config.mjs'));
    const operation = JSON.parse(readFileSync(ownershipFile(), 'utf8')).operation;
    const bindingRecord = readPlanOwnership('docs/plans/abandoned.md', config);
    const binding = { sessionId: 'A', operationId: operation.id, identityKey: bindingRecord.identityKey };
    beginClaimHookDelivery('docs/plans/abandoned.md', config, binding, { now: new Date('2026-01-01T00:00:00Z') });
    config.hooks.onPickup = event => { writeFileSync(events, `${event.operationId}\n`); };
    process.env.DOTMD_SESSION_ID = 'A';
    try {
      completePlanClaim('docs/plans/abandoned.md', config, {
        hookLeaseNow: new Date('2026-01-01T00:01:00Z'),
        hookLeaseMs: 1000,
        hookOwnerLiveness: () => 'dead',
      });
    } finally { delete process.env.DOTMD_SESSION_ID; }
    strictEqual(readFileSync(events, 'utf8').trim(), operation.id);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).operation.hook, 'done');
  });

  it('live delivering hook remains active across age, no-hook reconciliation, release, and force takeover', async () => {
    setup();
    writeFileSync(path.join(tmp, 'dotmd.config.mjs'), `export const root = 'docs';\nexport function onPickup() { throw new Error('seed pending'); }\n`);
    const file = plan('live-delivery');
    ok(run(['use', file], 'A').status !== 0);
    const config = await resolveConfig(tmp, path.join(tmp, 'dotmd.config.mjs'));
    const record = readPlanOwnership('docs/plans/live-delivery.md', config);
    const binding = { sessionId: 'A', operationId: record.operation.id, identityKey: record.identityKey };
    const lease = beginClaimHookDelivery('docs/plans/live-delivery.md', config, binding, { now: new Date('2020-01-01T00:00:00Z') });
    strictEqual(lease.busy, false);
    const delivering = JSON.parse(readFileSync(ownershipFile(), 'utf8')).operation;
    strictEqual(delivering.hook, 'delivering');
    strictEqual(typeof delivering.hookDeliveryOwner.pid, 'number');
    strictEqual(typeof delivering.hookDeliveryOwner.hostname, 'string');
    ok('processStartIdentity' in delivering.hookDeliveryOwner);

    const noHook = { ...config, hooks: {} };
    throws(() => completePlanClaim('docs/plans/live-delivery.md', noHook, {
      hookLeaseNow: new Date('2030-01-01T00:00:00Z'), hookLeaseMs: 1,
      hookOwnerLiveness: () => 'live',
    }), /already in progress/);
    throws(() => completePlanClaim('docs/plans/live-delivery.md', noHook, {
      hookLeaseNow: new Date('2030-01-01T00:00:00Z'), hookLeaseMs: 1,
      hookOwnerLiveness: () => 'unverifiable',
    }), /already in progress/);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).operation.hook, 'delivering');

    const previous = process.env.DOTMD_SESSION_ID;
    process.env.DOTMD_SESSION_ID = 'A';
    try {
      await rejects(runSet(['active', file], noHook, {}), /already in progress/);
      process.env.DOTMD_SESSION_ID = 'B';
      await rejects(startPlan([file, '--force'], noHook, { quiet: true }), /hook delivery is active/);
    } finally {
      if (previous === undefined) delete process.env.DOTMD_SESSION_ID;
      else process.env.DOTMD_SESSION_ID = previous;
    }
    match(readFileSync(file, 'utf8'), /^status: in-session$/m);
    strictEqual(JSON.parse(readFileSync(ownershipFile(), 'utf8')).sessionId, 'A');
  });

  it('a stale completer cannot invoke or mark a force takeover operation', async () => {
    setup();
    const events = path.join(tmp, 'takeover-events');
    writeFileSync(path.join(tmp, 'dotmd.config.mjs'), [
      `import { appendFileSync } from 'node:fs';`,
      `export const root = 'docs';`,
      `export function onPickup(event) { appendFileSync(${JSON.stringify(events)}, event.operationId + '\\n'); throw new Error('leave pending'); }`,
    ].join('\n'));
    const file = plan('takeover-completion');
    ok(run(['use', file], 'A').status !== 0);
    const config = await resolveConfig(tmp, path.join(tmp, 'dotmd.config.mjs'));
    const beforeEvents = readFileSync(events, 'utf8');
    const oldSession = process.env.DOTMD_SESSION_ID;
    process.env.DOTMD_SESSION_ID = 'A';
    try {
      throws(() => completePlanClaim('docs/plans/takeover-completion.md', config, {
        testHooks: {
          beforeClaimHookInvoke: () => {
            process.env.DOTMD_SESSION_ID = 'B';
            void startPlan([file, '--force'], { ...config, hooks: {} }, { quiet: true, noIndex: true });
            process.env.DOTMD_SESSION_ID = 'A';
          },
        },
      }), /stale|superseded/);
    } finally {
      if (oldSession === undefined) delete process.env.DOTMD_SESSION_ID;
      else process.env.DOTMD_SESSION_ID = oldSession;
    }
    strictEqual(readFileSync(events, 'utf8'), beforeEvents, 'stale completer did not invoke the old hook again');
    const record = JSON.parse(readFileSync(ownershipFile(), 'utf8'));
    strictEqual(record.sessionId, 'B');
    strictEqual(record.operation.hook, 'skipped');
  });

  it('journal enablement does not change ownership outcomes', () => {
    setup(`export const journal = true;\n`);
    const file = plan('journal-independent');
    strictEqual(run(['use', file], 'A').status, 0);
    const record = JSON.parse(readFileSync(ownershipFile(), 'utf8'));
    strictEqual(record.sessionId, 'A');
    strictEqual(record.state, 'owned');
    ok(existsSync(path.join(tmp, '.dotmd', 'journal.jsonl')), 'journal remains optional observability');
  });

  it('dry-run creates neither ownership state nor plan changes', () => {
    setup();
    const file = plan('dry');
    const before = readFileSync(file, 'utf8');
    strictEqual(run(['use', file, '--dry-run'], 'A').status, 0);
    strictEqual(readFileSync(file, 'utf8'), before);
    ok(!existsSync(path.join(tmp, '.dotmd', 'ownership')));
  });

  it('prompt and direct claims share timestamp, history, index, and pickup hook behavior', () => {
    setup();
    const events = path.join(tmp, 'pickup-events.jsonl');
    writeFileSync(path.join(tmp, 'dotmd.config.mjs'), [
      `import { appendFileSync } from 'node:fs';`,
      `export const root = 'docs';`,
      `export const index = { path: 'docs/README.md' };`,
      `export const statuses = { order: ['in-session', 'active', 'planned', 'archived'] };`,
      `export function onPickup(event) { appendFileSync(${JSON.stringify(events)}, JSON.stringify(event) + '\\n'); }`,
      '',
    ].join('\n'));
    writeFileSync(path.join(tmp, 'docs', 'README.md'), '# Index\n\n<!-- GENERATED:dotmd:start -->\n<!-- GENERATED:dotmd:end -->\n');
    const direct = plan('direct');
    const linked = plan('linked');
    writeFileSync(path.join(tmp, 'docs', 'prompts', 'resume-linked.md'),
      '---\ntype: prompt\nstatus: pending\nplan: docs/plans/linked.md\n---\ncontinue linked\n');

    const directResult = run(['use', direct], 'A');
    strictEqual(directResult.status, 0, directResult.stderr);
    const promptResult = run(['use', 'resume-linked'], 'B');
    strictEqual(promptResult.status, 0, promptResult.stderr);
    for (const file of [direct, linked]) {
      const raw = readFileSync(file, 'utf8');
      match(raw, /^status: in-session$/m);
      match(raw, /^updated: \d{4}-\d{2}-\d{2}T/m);
      strictEqual((raw.match(/Started \(active → in-session\)\./g) || []).length, 1);
    }
    const pickupEvents = readFileSync(events, 'utf8').trim().split('\n').map(JSON.parse);
    strictEqual(pickupEvents.length, 2);
    ok(pickupEvents.every(event => event.oldStatus === 'active' && event.newStatus === 'in-session'));
    const index = readFileSync(path.join(tmp, 'docs', 'README.md'), 'utf8');
    match(index, /direct/);
    match(index, /linked/);
  });
});
