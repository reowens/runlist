import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import { buildIndex } from '../src/index.mjs';
import { buildRunlistIndex, buildCoordinationIndex, isCoordinationHub } from '../src/runlist.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function run(args, opts = {}) {
  return spawnSync('node', [BIN, 'runlist', ...args], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    ...opts,
  });
}

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-runlist-'));
  spawnSync('git', ['init', '-q'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
  mkdirSync(path.join(tmpDir, 'docs', 'plans', 'archived'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n`);
  return path.join(tmpDir, 'docs', 'plans');
}

function writeDoc(plansDir, filename, frontmatter, body = '') {
  const filePath = path.join(plansDir, filename);
  writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`);
}

// Fixed-date fixtures drift: a rendered age like `6d` is only correct on one
// calendar day. Derive `updated` relative to today (UTC, matching the floor used
// by computeDaysSinceUpdate) so the `Nd` age assertions below stay deterministic
// whenever the suite runs.
function daysAgoDate(n) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('dotmd runlist <hub> (show)', () => {
  it('renders children in order with statuses and marks the first non-archived with →', () => {
    const plans = setupProject();
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: 2026-05-26
runlist:
  - one.md
  - two.md
  - three.md`);
    writeDoc(plans, 'one.md', `type: plan
status: archived
title: One
parent_plan: hub.md
updated: 2026-05-25`);
    writeDoc(plans, 'two.md', `type: plan
status: active
title: Two
parent_plan: hub.md
updated: 2026-05-26`, '## Phases\n\n### ⬜ todo\n');
    writeDoc(plans, 'three.md', `type: plan
status: planned
title: Three
parent_plan: hub.md
updated: 2026-05-26`);

    const r = run(['docs/plans/hub.md']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    match(r.stdout, /runlist: docs\/plans\/hub\.md/);
    // 1st child archived → no arrow
    match(r.stdout, /1\. \[archived\] docs\/plans\/one\.md/);
    // 2nd child is the first non-archived → arrow
    match(r.stdout, /→\s+2\. \[active\] docs\/plans\/two\.md/);
    // 3rd child not marked (already picked one)
    match(r.stdout, /3\. \[planned\] docs\/plans\/three\.md/);
  });

  it('prints empty-runlist message when the hub has no children', () => {
    const plans = setupProject();
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: 2026-05-26`);
    const r = run(['docs/plans/hub.md']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    match(r.stdout, /\(empty/);
  });

  it('uses markdown links under body order sections as a transient runlist', () => {
    const plans = setupProject();
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: 2026-05-26`, `# Hub

## Order of operations

- [First](one.md)
- [Second](two.md)
`);
    writeDoc(plans, 'one.md', `type: plan
status: archived
title: One
updated: 2026-05-25`);
    writeDoc(plans, 'two.md', `type: plan
status: active
title: Two
updated: 2026-05-26`);
    const r = run(['docs/plans/hub.md']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    match(r.stdout, /from body links/);
    match(r.stdout, /1\. \[archived\] docs\/plans\/one\.md/);
    match(r.stdout, /→\s+2\. \[active\] docs\/plans\/two\.md/);
  });

  it('flags missing refs without erroring out the show command', () => {
    const plans = setupProject();
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: 2026-05-26
runlist:
  - missing-child.md`);
    const r = run(['docs/plans/hub.md']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    match(r.stdout, /missing.*missing-child\.md/);
  });

  it('emits structured JSON with --json', () => {
    const plans = setupProject();
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: 2026-05-26
runlist:
  - one.md`);
    writeDoc(plans, 'one.md', `type: plan
status: active
title: One
parent_plan: hub.md
updated: 2026-05-26`);
    const r = run(['docs/plans/hub.md', '--json']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    strictEqual(parsed.hub, 'docs/plans/hub.md');
    strictEqual(parsed.children.length, 1);
    strictEqual(parsed.children[0].path, 'docs/plans/one.md');
    strictEqual(parsed.children[0].status, 'active');
  });

  it('marks → on the first pickup-able child, skipping a parked one, and notes parked when none remain', () => {
    const plans = setupProject();
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: 2026-05-26
runlist:
  - one.md
  - two.md`);
    // First child parked, second pickup-able → → lands on the second.
    writeDoc(plans, 'one.md', `type: plan
status: partial
title: One
parent_plan: hub.md
updated: 2026-05-26`);
    writeDoc(plans, 'two.md', `type: plan
status: planned
title: Two
parent_plan: hub.md
updated: 2026-05-26`);
    const r = run(['docs/plans/hub.md']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    match(r.stdout, /\s+1\. \[partial\] docs\/plans\/one\.md/);   // no → on the parked child
    match(r.stdout, /→\s+2\. \[planned\] docs\/plans\/two\.md/);

    // Now make the second child parked too → no pickup-able child → parked note.
    writeDoc(plans, 'two.md', `type: plan
status: blocked
title: Two
parent_plan: hub.md
updated: 2026-05-26`);
    const r2 = run(['docs/plans/hub.md']);
    strictEqual(r2.status, 0, `stderr: ${r2.stderr}`);
    match(r2.stdout, /No pickup-able child — 2 parked/);
    ok(!/Hub is ready for archive/.test(r2.stdout), 'parked hub is not "ready for archive"');
  });
});

describe('dotmd runlist <hub> slug resolution', () => {
  it('accepts a bare slug (no path, no .md) for a plan under docs/plans/', () => {
    const plans = setupProject();
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: 2026-05-26
runlist:
  - one.md`);
    writeDoc(plans, 'one.md', `type: plan
status: active
title: One
parent_plan: hub.md
updated: 2026-05-26`);
    const r = run(['hub']);
    strictEqual(r.status, 0, `bare slug should resolve: ${r.stderr}`);
    match(r.stdout, /runlist: docs\/plans\/hub.md/);
  });

  it('accepts <slug>.md (no path prefix)', () => {
    const plans = setupProject();
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: 2026-05-26
runlist:
  - one.md`);
    writeDoc(plans, 'one.md', `type: plan
status: active
title: One
parent_plan: hub.md
updated: 2026-05-26`);
    const r = run(['hub.md']);
    strictEqual(r.status, 0, `<slug>.md should resolve: ${r.stderr}`);
    match(r.stdout, /runlist: docs\/plans\/hub.md/);
  });
});

describe('dotmd runlist next <hub>', () => {
  it('picks up the first non-archived child', () => {
    const plans = setupProject();
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: 2026-05-26
runlist:
  - one.md
  - two.md`);
    writeDoc(plans, 'one.md', `type: plan
status: archived
title: One
parent_plan: hub.md
updated: 2026-05-25`);
    writeDoc(plans, 'two.md', `type: plan
status: active
title: Two
parent_plan: hub.md
updated: 2026-05-26
modules: [test]`);
    spawnSync('git', ['add', '-A'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpDir });

    const r = run(['next', 'docs/plans/hub.md']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    // startPlan writes its "Started" line to stderr
    match(r.stderr, /Started.*docs\/plans\/two\.md/);
    const twoRaw = readFileSync(path.join(plans, 'two.md'), 'utf8');
    match(twoRaw, /status: in-session/);
  });

  it('advances past a parked child to the first pickup-able one', () => {
    const plans = setupProject();
    // First non-archived child is parked (awaiting) — next must skip it and pick
    // up the pickup-able `planned` child behind it, not stop on the parked one.
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: 2026-05-26
runlist:
  - parked.md
  - ready.md`);
    writeDoc(plans, 'parked.md', `type: plan
status: awaiting
title: Parked
parent_plan: hub.md
modules: [test]
updated: 2026-05-26`);
    writeDoc(plans, 'ready.md', `type: plan
status: planned
title: Ready
parent_plan: hub.md
updated: 2026-05-26`);
    spawnSync('git', ['add', '-A'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpDir });

    const r = run(['next', 'docs/plans/hub.md']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    match(r.stderr, /Started.*docs\/plans\/ready\.md/);
    const readyRaw = readFileSync(path.join(plans, 'ready.md'), 'utf8');
    match(readyRaw, /status: in-session/);
    // The parked child is untouched.
    match(readFileSync(path.join(plans, 'parked.md'), 'utf8'), /status: awaiting/);
  });

  it('stops with a runlist-aware error when every remaining child is parked', () => {
    const plans = setupProject();
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: 2026-05-26
runlist:
  - blocked-child.md`);
    writeDoc(plans, 'blocked-child.md', `type: plan
status: awaiting
title: Blocked Child
parent_plan: hub.md
modules: [test]
updated: 2026-05-26`);
    spawnSync('git', ['add', '-A'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: tmpDir });

    const r = run(['next', 'docs/plans/hub.md']);
    ok(r.status !== 0, 'should exit non-zero');
    match(r.stderr, /runlist docs\/plans\/hub\.md/);
    match(r.stderr, /every remaining child is parked/);
    match(r.stderr, /status: awaiting/);
    // Surfaces the unstick verbs so the agent has a path forward.
    match(r.stderr, /dotmd set active <child>/);
  });

  it('reports when all children are archived', () => {
    const plans = setupProject();
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: 2026-05-26
runlist:
  - docs/plans/archived/done.md`);
    writeDoc(path.join(plans, 'archived'), 'done.md', `type: plan
status: archived
title: Done
updated: 2026-05-25`);
    const r = run(['next', 'docs/plans/hub.md']);
    ok(r.status !== 0, 'should exit non-zero');
    match(r.stderr, /All children.*archived/);
  });
});

describe('runlist back-pointer validation', () => {
  it('warns when a child plan in a runlist lacks parent_plan back-link', async () => {
    const plans = setupProject();
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: 2026-05-26
modules: [test]
runlist:
  - child.md`);
    writeDoc(plans, 'child.md', `type: plan
status: active
title: Child
updated: 2026-05-26
modules: [test]`);

    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    const child = index.docs.find(d => d.path === 'docs/plans/child.md');
    ok(child, 'child doc indexed');
    const backPointerWarn = child.warnings.find(w => /parent_plan/.test(w.message) && /runlist/.test(w.message));
    ok(backPointerWarn, `expected back-pointer warning on child, got: ${JSON.stringify(child.warnings)}`);
  });

  it('does NOT warn when child correctly back-links via parent_plan', async () => {
    const plans = setupProject();
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: 2026-05-26
modules: [test]
runlist:
  - child.md`);
    writeDoc(plans, 'child.md', `type: plan
status: active
title: Child
updated: 2026-05-26
modules: [test]
parent_plan: hub.md`);

    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    const child = index.docs.find(d => d.path === 'docs/plans/child.md');
    const backPointerWarn = child.warnings.find(w => /runlist/.test(w.message) && /parent_plan/.test(w.message));
    ok(!backPointerWarn, `expected no back-pointer warning, got: ${backPointerWarn?.message}`);
  });

  it('does NOT warn when the runlist entry is one-way (`>` prefix)', async () => {
    // M5: the `>` per-ref opt-out the bidirectional check honors (A4) now also
    // suppresses the runlist back-pointer requirement, so a hub can order a
    // child it doesn't own without nagging the child to add parent_plan.
    const plans = setupProject();
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: 2026-05-26
modules: [test]
runlist:
  - "> child.md"`);
    writeDoc(plans, 'child.md', `type: plan
status: active
title: Child
updated: 2026-05-26
modules: [test]`);

    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    const child = index.docs.find(d => d.path === 'docs/plans/child.md');
    ok(child, 'child doc indexed');
    const backPointerWarn = child.warnings.find(w => /runlist/.test(w.message) && /parent_plan/.test(w.message));
    ok(!backPointerWarn, `one-way runlist entry should not require a back-pointer, got: ${backPointerWarn?.message}`);
  });
});

describe('runlist dangling-ref validation', () => {
  it('errors when a runlist entry does not resolve to an existing file', async () => {
    const plans = setupProject();
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: 2026-05-26
modules: [test]
runlist:
  - does-not-exist.md`);

    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    const hub = index.docs.find(d => d.path === 'docs/plans/hub.md');
    const refError = hub.errors.find(e => /does-not-exist\.md/.test(e.message));
    ok(refError, `expected runlist ref-resolution error, got: ${JSON.stringify(hub.errors)}`);
  });
});

function runPlans(args, opts = {}) {
  return spawnSync('node', [BIN, 'plans', ...args], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', COLUMNS: '120' },
    ...opts,
  });
}

// A hub + three children + one standalone, mirroring the docs example.
function setupSprint() {
  const plans = setupProject();
  writeDoc(plans, 'auth-revamp.md', `type: plan
status: active
title: Auth Revamp
updated: ${daysAgoDate(8)}
runlist:
  - auth-revamp-01-extract.md
  - auth-revamp-02-rewrite.md
  - auth-revamp-03-cleanup.md
next_step: ship the auth revamp sprint`);
  writeDoc(plans, 'auth-revamp-01-extract.md', `type: plan
status: active
title: Extract
parent_plan: auth-revamp.md
updated: ${daysAgoDate(6)}
next_step: pull auth code into its own module`);
  writeDoc(plans, 'auth-revamp-02-rewrite.md', `type: plan
status: planned
title: Rewrite
parent_plan: auth-revamp.md
updated: ${daysAgoDate(7)}
next_step: rewrite the token refresh flow`);
  writeDoc(plans, 'auth-revamp-03-cleanup.md', `type: plan
status: planned
title: Cleanup
parent_plan: auth-revamp.md
updated: ${daysAgoDate(9)}
next_step: delete the legacy auth shims`);
  writeDoc(plans, 'unrelated-plan.md', `type: plan
status: active
title: Unrelated
updated: ${daysAgoDate(3)}
next_step: do the standalone thing`);
  return plans;
}

describe('buildRunlistIndex', () => {
  it('maps hubs to ordered children with progress, next pickup, and reverse links', async () => {
    setupSprint();
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    const { hubs, childToHub } = buildRunlistIndex(index, config);

    const hub = hubs.get('docs/plans/auth-revamp.md');
    ok(hub, 'hub should be detected');
    strictEqual(hub.total, 3);
    strictEqual(hub.doneCount, 0);
    strictEqual(hub.nextChildPath, 'docs/plans/auth-revamp-01-extract.md');
    strictEqual(hub.children.map(c => c.path).join(','),
      'docs/plans/auth-revamp-01-extract.md,docs/plans/auth-revamp-02-rewrite.md,docs/plans/auth-revamp-03-cleanup.md');
    strictEqual(childToHub.get('docs/plans/auth-revamp-02-rewrite.md'), 'docs/plans/auth-revamp.md');
    // A standalone plan is neither a hub nor a child.
    ok(!hubs.has('docs/plans/unrelated-plan.md'));
    ok(!childToHub.has('docs/plans/unrelated-plan.md'));
  });

  it('counts archived (moved) children toward progress via basename fallback', async () => {
    setupSprint();
    // Archive the first child — it physically moves under plans/archived/.
    spawnSync('node', [BIN, 'archive', 'docs/plans/auth-revamp-01-extract.md'], { cwd: tmpDir, encoding: 'utf8' });
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    const { hubs } = buildRunlistIndex(index, config);
    const hub = hubs.get('docs/plans/auth-revamp.md');
    strictEqual(hub.doneCount, 1, 'archived child counts as done even after it moved dirs');
    strictEqual(hub.nextChildPath, 'docs/plans/auth-revamp-02-rewrite.md', 'next pickup skips the archived child');
  });

  it('skips parked children as next-pickup without counting them as done', async () => {
    const plans = setupProject();
    // [archived, partial, active]: next-pickup must advance past the parked
    // `partial` child to the `active` one, but the partial must NOT tick
    // done/total (skipped ≠ shipped) — it lands in parkedCount instead.
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: ${daysAgoDate(1)}
runlist:
  - docs/plans/archived/one.md
  - two.md
  - three.md`);
    writeDoc(path.join(plans, 'archived'), 'one.md', `type: plan
status: archived
title: One
updated: ${daysAgoDate(5)}`);
    writeDoc(plans, 'two.md', `type: plan
status: partial
title: Two
parent_plan: hub.md
modules: [test]
updated: ${daysAgoDate(4)}`);
    writeDoc(plans, 'three.md', `type: plan
status: active
title: Three
parent_plan: hub.md
updated: ${daysAgoDate(3)}`);
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    const hub = buildRunlistIndex(index, config).hubs.get('docs/plans/hub.md');
    strictEqual(hub.doneCount, 1, 'only the archived child counts as done');
    strictEqual(hub.parkedCount, 1, 'the partial child counts as parked, not done');
    strictEqual(hub.nextChildPath, 'docs/plans/three.md', 'next pickup skips the parked partial child');
  });

  it('reports nextChildPath null + parkedCount when every live child is parked', async () => {
    const plans = setupProject();
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: ${daysAgoDate(1)}
runlist:
  - docs/plans/archived/done.md
  - parked.md`);
    writeDoc(path.join(plans, 'archived'), 'done.md', `type: plan
status: archived
title: Done
updated: ${daysAgoDate(5)}`);
    writeDoc(plans, 'parked.md', `type: plan
status: partial
title: Parked
parent_plan: hub.md
modules: [test]
updated: ${daysAgoDate(4)}`);
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    const hub = buildRunlistIndex(index, config).hubs.get('docs/plans/hub.md');
    strictEqual(hub.nextChildPath, null, 'no pickup-able child → no next');
    strictEqual(hub.doneCount, 1);
    strictEqual(hub.parkedCount, 1);
  });
});

describe('dotmd plans (runlist folding)', () => {
  it('tags the hub [RUNLIST], folds children under it, and counts it as a runlist', () => {
    setupSprint();
    const r = runPlans([]);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    // Hub reclassified out of the active bucket into its own runlist count.
    match(r.stdout, /1 runlist/);
    match(r.stdout, /2 active/);
    // Hub header carries the tag + progress + next pickup.
    match(r.stdout, /auth-revamp\s+runlist · 0\/3 · next → 01-extract\s+\[RUNLIST\]/);
    // Children fold under the hub, slug stripped of the hub prefix, next marked →.
    match(r.stdout, /→ 01-extract\s+6d/);
    match(r.stdout, /02-rewrite\s+7d/);
    // Standalone plan still renders with its own [ACTIVE] tag.
    match(r.stdout, /unrelated-plan\s+3d.*\[ACTIVE\]/);
  });

  it('shows "N parked" (not "all archived") when no child is pickup-able but one is parked', () => {
    const plans = setupProject();
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: ${daysAgoDate(1)}
runlist:
  - docs/plans/archived/done.md
  - tail.md`);
    writeDoc(path.join(plans, 'archived'), 'done.md', `type: plan
status: archived
title: Done
updated: ${daysAgoDate(5)}`);
    writeDoc(plans, 'tail.md', `type: plan
status: partial
title: Tail
parent_plan: hub.md
modules: [test]
updated: ${daysAgoDate(3)}`);
    const r = runPlans([]);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    match(r.stdout, /hub\s+runlist · 1\/2 · 1 parked/);
    ok(!/all archived/.test(r.stdout), 'a parked-but-unfinished runlist is not "all archived"');
  });

  it('renders a child standalone when its hub is filtered out of the view', () => {
    setupSprint();
    const r = runPlans(['--status', 'planned']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    // Hub is active → absent under --status planned, so children are not folded.
    ok(!/\[RUNLIST\]/.test(r.stdout), 'no hub block when hub is filtered out');
    match(r.stdout, /auth-revamp-02-rewrite\s+7d/);
    match(r.stdout, /auth-revamp-03-cleanup\s+9d/);
  });

  it('folds children in runlist order even when a later-added child has a newer mtime', () => {
    const plans = setupProject();
    // runlist order is a,b,c but c is the most recently updated — recency sort
    // would float it to the top; the fold must keep it in runlist position.
    writeDoc(plans, 'seq.md', `type: plan
status: active
title: Seq
updated: ${daysAgoDate(1)}
runlist:
  - seq-01-a.md
  - seq-02-b.md
  - seq-03-c.md`);
    writeDoc(plans, 'seq-01-a.md', `type: plan
status: planned
title: A
parent_plan: seq.md
updated: ${daysAgoDate(5)}`);
    writeDoc(plans, 'seq-02-b.md', `type: plan
status: planned
title: B
parent_plan: seq.md
updated: ${daysAgoDate(4)}`);
    writeDoc(plans, 'seq-03-c.md', `type: plan
status: planned
title: C
parent_plan: seq.md
updated: ${daysAgoDate(0)}`); // newest

    const r = runPlans([]);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    // Child rows carry an age column (`0N-x   Nd`); the hub header's
    // `next → 01-a` does not, so this matches only the three folded children.
    const rows = r.stdout.split('\n').filter(l => /0\d-[abc]\s+\d+d/.test(l));
    strictEqual(rows.length, 3);
    ok(/01-a/.test(rows[0]), `expected 01-a first, got: ${rows[0]}`);
    ok(/02-b/.test(rows[1]), `expected 02-b second, got: ${rows[1]}`);
    ok(/03-c/.test(rows[2]), `expected 03-c last, got: ${rows[2]}`);
  });

  it('shows "all archived" once every child is closed', () => {
    setupSprint();
    for (const f of ['auth-revamp-01-extract', 'auth-revamp-02-rewrite', 'auth-revamp-03-cleanup']) {
      spawnSync('node', [BIN, 'archive', `docs/plans/${f}.md`], { cwd: tmpDir, encoding: 'utf8' });
    }
    const r = runPlans([]);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    match(r.stdout, /auth-revamp\s+runlist · 3\/3 · all archived\s+\[RUNLIST\]/);
  });
});

// A coordination hub (execution_mode: coordination) + a slug-convention hub
// (*-runlist, no execution_mode) + standalone leaves.
function setupCoordination() {
  const plans = setupProject();
  writeDoc(plans, 'master-runlist.md', `type: plan
status: active
title: Master Runlist
execution_mode: coordination
updated: 2026-06-25
related_plans:
  - ./billing-runlist.md
  - ./stripe-testing.md
next_step: pick from unblocked heads`);
  writeDoc(plans, 'billing-runlist.md', `type: plan
status: active
title: Billing Runlist
updated: 2026-06-24
related_plans:
  - ./stripe-testing.md
next_step: ranked head is cadence migration`);
  writeDoc(plans, 'stripe-testing.md', `type: plan
status: active
title: Stripe testing
updated: 2026-06-26
next_step: run the smoke matrix`);
  writeDoc(plans, 'unrelated.md', `type: plan
status: active
title: Unrelated
updated: 2026-06-27
next_step: do the standalone thing`);
  return plans;
}

describe('isCoordinationHub / buildCoordinationIndex', () => {
  it('detects execution_mode:coordination and the *-runlist slug, not leaves', () => {
    strictEqual(isCoordinationHub({ path: 'docs/plans/x.md', type: 'plan', executionMode: 'coordination' }), true);
    strictEqual(isCoordinationHub({ path: 'docs/plans/billing-runlist.md', type: 'plan' }), true);
    strictEqual(isCoordinationHub({ path: 'docs/plans/pos/runlist.md', type: 'plan' }), true);
    strictEqual(isCoordinationHub({ path: 'docs/plans/auth-revamp.md', type: 'plan' }), false);
    // a non-plan doc named *-runlist is not a plan hub
    strictEqual(isCoordinationHub({ path: 'docs/x-runlist.md', type: 'doc' }), false);
  });

  it('counts related_plans children resolved against the index', async () => {
    setupCoordination();
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    const hubs = buildCoordinationIndex(index, config);
    ok(hubs.has('docs/plans/master-runlist.md'));
    ok(hubs.has('docs/plans/billing-runlist.md'), 'slug-convention hub detected without execution_mode');
    strictEqual(hubs.get('docs/plans/master-runlist.md').childCount, 2);
    strictEqual(hubs.get('docs/plans/billing-runlist.md').childCount, 1);
    ok(!hubs.has('docs/plans/stripe-testing.md'));
    ok(!hubs.has('docs/plans/unrelated.md'));
  });
});

describe('dotmd plans (coordination-hub section)', () => {
  it('lifts hubs into a Runlists section and out of the active count', () => {
    setupCoordination();
    const r = runPlans([]);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    // 4 docs, 2 of them hubs → headline counts the 2 active leaves only; the
    // 2 runlists read as a separate sibling, held out of the plan count.
    match(r.stdout, /2 plans · 2 runlists · 2 active/);
    match(r.stdout, /Runlists \(2\)/);
    // Hubs appear in the section with a related-cluster count, NOT as [ACTIVE]
    // leaf rows. The count is labelled `related` (it's the related_plans cluster).
    match(r.stdout, /master-runlist\s+\d+d\s+2 related/);
    match(r.stdout, /billing-runlist\s+\d+d\s+1 related/);
    // Leaves still render as normal tagged rows.
    match(r.stdout, /unrelated\s+\d+d.*\[ACTIVE\]/);
    ok(!/master-runlist.*\[ACTIVE\]/.test(r.stdout), 'hub must not render as an [ACTIVE] leaf');
  });

  it('caps each section independently and footers the remainder', () => {
    setupCoordination();
    const r = runPlans(['--limit', '1']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    // 2 leaves capped to 1 → 1 more plans; 2 hubs capped to 1 → 1 more runlists.
    match(r.stdout, /1 more plans/);
    match(r.stdout, /Runlists \(2\)/);
    match(r.stdout, /1 more runlists/);
  });

  it('labels a subdir hub with its parent dir (pos/runlist, not runlist)', () => {
    const plans = setupProject();
    writeDoc(plans, 'top.md', `type: plan
status: active
title: Top
updated: 2026-06-26
next_step: a leaf`);
    mkdirSync(path.join(plans, 'pos'), { recursive: true });
    writeDoc(path.join(plans, 'pos'), 'runlist.md', `type: plan
status: active
title: POS Runlist
execution_mode: coordination
updated: 2026-06-25
next_step: pos coordination`);
    const r = runPlans([]);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    match(r.stdout, /pos\/runlist\s+\d+d/);
  });
});

function runRunlistsCmd(args, opts = {}) {
  return spawnSync('node', [BIN, 'runlists', ...args], {
    cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', COLUMNS: '120' }, ...opts,
  });
}

// A coordination hub (execution_mode: coordination) whose body encodes its order
// as a `## Ranked queue` table of markdown links — the founder-runlist shape.
// Ranks 1-2 archived (physically under archived/), rank 3 is the next pickup.
function setupRankedQueue() {
  const plans = setupProject();
  writeDoc(plans, 'founder-runlist.md', `type: plan
status: active
title: Founder Runlist
execution_mode: coordination
updated: 2026-06-25`, `# Founder Runlist

## Ranked queue (next pickup)

| Rank | Plan | Status | Next step |
|------|------|--------|-----------|
| 1 | [founder-timeline](archived/founder-timeline.md) | archived | done |
| 2 | [founder-landing](archived/founder-landing.md) | archived | done |
| 3 | [founder-brand-conflicts](./founder-brand-conflicts.md) | active **← next** | Phase 3 |
| 4 | [founder-data-isolation](./founder-data-isolation.md) | active | program |
`);
  writeDoc(path.join(plans, 'archived'), 'founder-timeline.md', `type: plan
status: archived
title: Timeline
updated: 2026-06-10`);
  writeDoc(path.join(plans, 'archived'), 'founder-landing.md', `type: plan
status: archived
title: Landing
updated: 2026-06-10`);
  writeDoc(plans, 'founder-brand-conflicts.md', `type: plan
status: active
title: Brand Conflicts
parent_plan: founder-runlist.md
created: 2026-06-20
updated: 2026-06-24`);
  writeDoc(plans, 'founder-data-isolation.md', `type: plan
status: active
title: Data Isolation
parent_plan: founder-runlist.md
created: 2026-06-20
updated: 2026-06-23`);
  return plans;
}

describe('coordination-hub next-pickup (body ranked queue)', () => {
  it('buildCoordinationIndex resolves nextPickup to the first non-archived ranked child', async () => {
    setupRankedQueue();
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    const hub = buildCoordinationIndex(index, config).get('docs/plans/founder-runlist.md');
    ok(hub.nextPickup, 'nextPickup resolved from the ranked-queue table');
    strictEqual(hub.nextPickup.path, 'docs/plans/founder-brand-conflicts.md');
    strictEqual(hub.nextPickup.status, 'active');
    // Hub's leading module segment stripped, like sprint children drop the prefix.
    strictEqual(hub.nextPickup.label, 'brand-conflicts');
  });

  it('advances nextPickup past a parked ranked child to the first pickup-able one', async () => {
    const plans = setupProject();
    // Rank 1 archived, rank 2 partial (parked), rank 3 active → next-pickup is
    // rank 3: a parked ranked child is skipped, never surfaced as `→`.
    writeDoc(plans, 'roadmap-runlist.md', `type: plan
status: active
title: Roadmap Runlist
execution_mode: coordination
updated: 2026-06-25`, `# Roadmap Runlist

## Ranked queue

| Rank | Plan | Status |
|------|------|--------|
| 1 | [roadmap-shipped](archived/roadmap-shipped.md) | archived |
| 2 | [roadmap-tail](./roadmap-tail.md) | partial |
| 3 | [roadmap-next](./roadmap-next.md) | active |
`);
    writeDoc(path.join(plans, 'archived'), 'roadmap-shipped.md', `type: plan
status: archived
title: Shipped
updated: 2026-06-10`);
    writeDoc(plans, 'roadmap-tail.md', `type: plan
status: partial
title: Tail
parent_plan: roadmap-runlist.md
modules: [test]
updated: 2026-06-24`);
    writeDoc(plans, 'roadmap-next.md', `type: plan
status: active
title: Next
parent_plan: roadmap-runlist.md
updated: 2026-06-23`);
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    const hub = buildCoordinationIndex(index, config).get('docs/plans/roadmap-runlist.md');
    ok(hub.nextPickup, 'a pickup-able ranked child resolves');
    strictEqual(hub.nextPickup.path, 'docs/plans/roadmap-next.md', 'skips the parked partial rank');
    strictEqual(hub.nextPickup.status, 'active');
  });

  it('returns nextPickup: null when the hub body has no parseable order', async () => {
    setupCoordination(); // master/billing carry related_plans but no body order section
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    const hubs = buildCoordinationIndex(index, config);
    strictEqual(hubs.get('docs/plans/master-runlist.md').nextPickup, null);
    strictEqual(hubs.get('docs/plans/billing-runlist.md').nextPickup, null);
  });

  it('dotmd runlists renders → <label> for a hub with a ranked queue', () => {
    setupRankedQueue();
    const r = runRunlistsCmd([]);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    match(r.stdout, /founder-runlist\s+\d+d.*→ brand-conflicts/);

    const j = runRunlistsCmd(['--json']);
    const hub = JSON.parse(j.stdout).runlists.find(x => /founder-runlist/.test(x.path));
    strictEqual(hub.nextPickup.path, 'docs/plans/founder-brand-conflicts.md');
    strictEqual(hub.nextPickup.label, 'brand-conflicts');
  });

  it('dotmd health Runlists section shows the next pickup', () => {
    setupRankedQueue();
    const r = runCmd('health', []);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    match(r.stdout, /founder-runlist\s+\d+d.*→ brand-conflicts/);
    const j = runCmd('health', ['--json']);
    const hub = JSON.parse(j.stdout).runlists.hubs.find(x => /founder-runlist/.test(x.path));
    strictEqual(hub.nextPickup.label, 'brand-conflicts');
  });

  it('dotmd runlist <hub> (singular) reads the ranked-queue table, marking the first non-archived', () => {
    setupRankedQueue();
    const r = run(['docs/plans/founder-runlist.md']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    match(r.stdout, /1\. \[archived\] docs\/plans\/archived\/founder-timeline\.md/);
    match(r.stdout, /→\s+3\. \[active\] docs\/plans\/founder-brand-conflicts\.md/);
  });
});

describe('dotmd runlists (dashboard)', () => {
  it('lists every coordination hub, most stale first, with --json support', () => {
    setupCoordination();
    const r = runRunlistsCmd([]);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    match(r.stdout, /Runlists \(2\)/);
    match(r.stdout, /master-runlist/);
    match(r.stdout, /billing-runlist/);
    // leaves are NOT listed here
    ok(!/unrelated/.test(r.stdout), 'runlists dashboard shows only hubs');
    // Default sort is `age` (most stale first): billing (updated 06-24) is older
    // than master (06-25), so it leads.
    ok(r.stdout.indexOf('billing-runlist') < r.stdout.indexOf('master-runlist'),
      'stale-first default: older billing before master');

    const j = runRunlistsCmd(['--json']);
    const parsed = JSON.parse(j.stdout);
    strictEqual(parsed.count, 2);
    const master = parsed.runlists.find(x => /master-runlist/.test(x.path));
    strictEqual(master.childCount, 2);
  });

  it('--sort recent reverses to newest-first; --sort related ranks by cluster size', () => {
    setupCoordination();
    const recent = runRunlistsCmd(['--sort', 'recent']);
    strictEqual(recent.status, 0, `stderr: ${recent.stderr}`);
    ok(recent.stdout.indexOf('master-runlist') < recent.stdout.indexOf('billing-runlist'),
      'recent: newer master before older billing');
    // master has 2 related, billing 1 → master leads under --sort related.
    const related = runRunlistsCmd(['--sort', 'related']);
    ok(related.stdout.indexOf('master-runlist') < related.stdout.indexOf('billing-runlist'),
      'related: bigger cluster (master) first');
  });

  it('rejects an unknown --sort value', () => {
    setupCoordination();
    const r = runRunlistsCmd(['--sort', 'bogus']);
    ok(r.status !== 0, 'should exit non-zero');
    match(r.stderr, /Unknown --sort 'bogus'/);
  });

  it('reports nothing when there are no runlists', () => {
    const plans = setupProject();
    writeDoc(plans, 'leaf.md', `type: plan
status: active
title: Leaf
updated: 2026-06-26`);
    const r = runRunlistsCmd([]);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    match(r.stdout, /No runlists found/);
  });
});

describe('coordination-hub execution_mode nudge (dotmd check)', () => {
  it('warns when a *-runlist plan lacks execution_mode: coordination', () => {
    const plans = setupProject();
    // slug-only hub → should be nudged
    writeDoc(plans, 'billing-runlist.md', `type: plan
status: active
title: Billing
updated: 2026-06-25
related_plans:
  - ./x.md`);
    // explicit coordination hub → should NOT be nudged
    writeDoc(plans, 'master-runlist.md', `type: plan
status: active
title: Master
execution_mode: coordination
updated: 2026-06-25`);
    writeDoc(plans, 'x.md', `type: plan
status: active
title: X
updated: 2026-06-25`);
    const r = spawnSync('node', [BIN, 'check', '--verbose'], { cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    const out = r.stdout + r.stderr;
    match(out, /billing-runlist\.md: reads as a coordination runlist[\s\S]*missing `execution_mode: coordination`/);
    ok(!/master-runlist\.md: reads as a coordination runlist/.test(out), 'explicit coordination hub is not nudged');
  });
});

function runCmd(cmd, args, opts = {}) {
  return spawnSync('node', [BIN, cmd, ...args], {
    cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', COLUMNS: '120' }, ...opts,
  });
}

describe('dotmd briefing (coordination-hub awareness)', () => {
  it('lifts coordination hubs into a runlists bucket and out of the active work list', () => {
    setupCoordination();
    const r = runCmd('briefing', []);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    // 2 coordination hubs held out of the headline plan count entirely → the
    // headline reads the 2 active leaves; runlists show on their own pointer line.
    match(r.stdout, /2 live plans: 2 active/);
    ok(!/live plans:.*runlist/.test(r.stdout), 'runlists are not summed into the headline breakdown');
    // leaves appear in the `>` work list; hubs do not.
    match(r.stdout, /> stripe-testing \(active\)/);
    match(r.stdout, /> unrelated \(active\)/);
    ok(!/> master-runlist /.test(r.stdout), 'coordination hub must not appear as a work item');
    ok(!/> billing-runlist /.test(r.stdout), 'slug-convention hub must not appear as a work item');
    // discoverability pointer.
    match(r.stdout, /2 runlists · dotmd runlists/);
  });

  it('emits a runlists array in --json, split out of active/inSession', () => {
    setupCoordination();
    const r = runCmd('briefing', ['--json']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    strictEqual(parsed.plans.runlists.length, 2);
    strictEqual(parsed.plans.active.length, 2);
    ok(!parsed.plans.active.some(p => /runlist/.test(p.path)), 'hubs excluded from active[]');
    const master = parsed.plans.runlists.find(x => /master-runlist/.test(x.path));
    strictEqual(master.childCount, 2);
  });

  it('leaves output unchanged on a repo with no coordination hubs', () => {
    const plans = setupProject();
    writeDoc(plans, 'leaf.md', `type: plan
status: active
title: Leaf
updated: 2026-06-26
next_step: do it`);
    const r = runCmd('briefing', []);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(!/runlist/i.test(r.stdout), 'no runlist wording when there are no hubs');
    match(r.stdout, /1 live plans: 1 active/);
  });
});

describe('dotmd health (coordination-hub awareness)', () => {
  it('holds coordination hubs out of the pipeline/active aging into a Runlists section', () => {
    setupCoordination();
    const r = runCmd('health', []);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    // Pipeline active counts the 2 leaves, not the 2 hubs.
    match(r.stdout, /active\s+2\s/);
    // Dedicated runlists tally with the related-cluster count.
    match(r.stdout, /Runlists: 2\s+· dotmd runlists/);
    match(r.stdout, /master-runlist\s+.*2 related/);
    // Active aging lists leaves; hubs are absent from it.
    match(r.stdout, /Active plans:[\s\S]*stripe-testing/);
    ok(!/Active plans:[\s\S]*master-runlist/.test(r.stdout), 'hub not in active aging list');
  });

  it('adds a runlists tally to --json with the active count excluding hubs', () => {
    setupCoordination();
    const r = runCmd('health', ['--json']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    strictEqual(parsed.runlists.count, 2);
    strictEqual(parsed.active.count, 2);
    strictEqual(parsed.byStatus.active, 2);
  });

  it('labels a subdir hub with its parent dir in the Runlists section (pos/runlist)', () => {
    const plans = setupProject();
    writeDoc(plans, 'leaf.md', `type: plan
status: active
title: Leaf
created: 2026-06-20
updated: 2026-06-26`);
    mkdirSync(path.join(plans, 'pos'), { recursive: true });
    writeDoc(path.join(plans, 'pos'), 'runlist.md', `type: plan
status: active
title: POS Runlist
execution_mode: coordination
updated: 2026-06-25`);
    const r = runCmd('health', []);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    match(r.stdout, /Runlists: 1/);
    match(r.stdout, /pos\/runlist\s+\d+d/);
  });
});

describe('dotmd health (pipeline derived from status vocab)', () => {
  it('shows live statuses the old hardcoded list hid (in-session, partial)', () => {
    const plans = setupProject();
    writeDoc(plans, 'a.md', `type: plan
status: in-session
title: A
created: 2026-06-20
updated: 2026-06-26`);
    writeDoc(plans, 'b.md', `type: plan
status: partial
title: B
created: 2026-06-20
updated: 2026-06-26`);
    const r = runCmd('health', []);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    const pipeline = r.stdout.slice(r.stdout.indexOf('Pipeline:'), r.stdout.indexOf('Active plans:') >= 0 ? r.stdout.indexOf('Active plans:') : undefined);
    match(pipeline, /in-session\s+1/);
    match(pipeline, /partial\s+1/);
    // dead statuses from the old hardcoded list never render an empty row
    ok(!/\bready\b/.test(pipeline), 'no dead "ready" row');
    ok(!/\bscoping\b/.test(pipeline), 'no dead "scoping" row');
  });
});

describe('dotmd runlist add <hub> <child...>', () => {
  function sprintHub(plans) {
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Auth Revamp
updated: 2026-05-26
runlist:
  - one.md
  - two.md`);
    writeDoc(plans, 'one.md', `type: plan
status: active
title: One
parent_plan: hub.md
updated: 2026-05-26`);
    writeDoc(plans, 'two.md', `type: plan
status: active
title: Two
parent_plan: hub.md
updated: 2026-05-26`);
  }

  it('scaffolds a planned stub for a bare slug and appends it to the runlist array', () => {
    const plans = setupProject();
    sprintHub(plans);

    const r = run(['add', 'docs/plans/hub.md', 'deploy']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);

    // hub frontmatter gained the new child as the 3rd entry, numbered 03.
    const hub = readFileSync(path.join(plans, 'hub.md'), 'utf8');
    match(hub, /runlist:\n  - one\.md\n  - two\.md\n  - hub-03-deploy\.md/);

    // the stub exists, is `planned`, and points parent_plan back at the hub.
    const child = readFileSync(path.join(plans, 'hub-03-deploy.md'), 'utf8');
    match(child, /^status: planned$/m);
    match(child, /^parent_plan: hub\.md$/m);
    match(child, /# Deploy/);
  });

  it('wires in an existing plan with a hub-relative ref and sets its parent_plan back-ref', () => {
    const plans = setupProject();
    sprintHub(plans);
    writeDoc(plans, 'legacy.md', `type: plan
status: planned
title: Legacy
updated: 2026-05-26`);

    const r = run(['add', 'docs/plans/hub.md', 'legacy']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);

    const hub = readFileSync(path.join(plans, 'hub.md'), 'utf8');
    match(hub, /  - legacy\.md/);
    // no new stub was scaffolded for the existing plan.
    ok(!/legacy-0/.test(hub), 'existing plan should be referenced as-is, not renumbered');

    const legacy = readFileSync(path.join(plans, 'legacy.md'), 'utf8');
    match(legacy, /^parent_plan: hub\.md$/m);
  });

  it('does not clobber an existing parent_plan that points elsewhere', () => {
    const plans = setupProject();
    sprintHub(plans);
    writeDoc(plans, 'other-hub.md', `type: plan
status: active
title: Other Hub
updated: 2026-05-26`);
    writeDoc(plans, 'claimed.md', `type: plan
status: planned
title: Claimed
parent_plan: other-hub.md
updated: 2026-05-26`);

    const r = run(['add', 'docs/plans/hub.md', 'claimed']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    // still added to the hub's runlist, but the back-ref is left intact + warned.
    match(readFileSync(path.join(plans, 'hub.md'), 'utf8'), /  - claimed\.md/);
    match(readFileSync(path.join(plans, 'claimed.md'), 'utf8'), /^parent_plan: other-hub\.md$/m);
    match(r.stderr + r.stdout, /already has parent_plan/);
  });

  it('--dry-run writes nothing (hub + no stub created)', () => {
    const plans = setupProject();
    sprintHub(plans);
    const before = readFileSync(path.join(plans, 'hub.md'), 'utf8');

    const r = run(['add', 'docs/plans/hub.md', 'deploy', '--dry-run']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    match(r.stdout, /\[dry-run\]/);
    strictEqual(readFileSync(path.join(plans, 'hub.md'), 'utf8'), before, 'hub must be untouched');
    ok(!existsSync(path.join(plans, 'hub-03-deploy.md')), 'no stub on dry-run');
  });

  it('dedupes a child already in the runlist and exits nonzero when nothing is left to add', () => {
    const plans = setupProject();
    sprintHub(plans);

    const r = run(['add', 'docs/plans/hub.md', 'one']);
    strictEqual(r.status, 1, 'all-skipped add should fail');
    match(r.stderr + r.stdout, /already in the runlist/);
  });

  it('promotes a plain plan (no runlist) into a hub', () => {
    const plans = setupProject();
    writeDoc(plans, 'plain.md', `type: plan
status: active
title: Plain
updated: 2026-05-26`);

    const r = run(['add', 'docs/plans/plain.md', 'alpha', 'beta']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    const hub = readFileSync(path.join(plans, 'plain.md'), 'utf8');
    match(hub, /runlist:\n  - plain-01-alpha\.md\n  - plain-02-beta\.md/);
    ok(existsSync(path.join(plans, 'plain-01-alpha.md')));
    ok(existsSync(path.join(plans, 'plain-02-beta.md')));
  });

  it('refuses a coordination hub with an actionable message', () => {
    const plans = setupProject();
    writeDoc(plans, 'master-runlist.md', `type: plan
status: active
title: Master
execution_mode: coordination
updated: 2026-05-26`, '## Ranked queue\n\n| # | Plan | Why | Status |\n|---|---|---|---|\n');

    const r = run(['add', 'docs/plans/master-runlist.md', 'gamma']);
    strictEqual(r.status, 1, 'coordination hub add should be refused');
    match(r.stderr + r.stdout, /coordination hub/);
    ok(!existsSync(path.join(plans, 'master-runlist-01-gamma.md')), 'no stub scaffolded for refused hub');
  });

  it('refuses a path token that points at no existing file (scaffolds from bare slugs only)', () => {
    const plans = setupProject();
    sprintHub(plans);
    const r = run(['add', 'docs/plans/hub.md', 'nested/ghost.md']);
    strictEqual(r.status, 1);
    match(r.stderr + r.stdout, /Pass a bare slug/);
  });

  it('--json reports the added children and the resulting runlist', () => {
    const plans = setupProject();
    sprintHub(plans);
    const r = run(['add', 'docs/plans/hub.md', 'deploy', '--json']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    strictEqual(parsed.hub, 'docs/plans/hub.md');
    strictEqual(parsed.added.length, 1);
    strictEqual(parsed.added[0].scaffolded, true);
    strictEqual(parsed.runlist.length, 3);
    strictEqual(parsed.runlist[2], 'hub-03-deploy.md');
  });

  it('continues numbering from the current child count', () => {
    const plans = setupProject();
    sprintHub(plans); // 2 children already
    run(['add', 'docs/plans/hub.md', 'three']);   // → hub-03-three.md
    const r = run(['add', 'docs/plans/hub.md', 'four']); // → hub-04-four.md
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(existsSync(path.join(plans, 'hub-03-three.md')));
    ok(existsSync(path.join(plans, 'hub-04-four.md')));
  });

  it('keeps the body `## Order of operations` link list in sync when adding', () => {
    const plans = setupProject();
    writeDoc(plans, 'hub.md', `type: plan
status: active
title: Hub
updated: 2026-05-26
runlist:
  - one.md
  - two.md`, `# Hub

## Order of operations

1. [One](one.md) ⬜
2. [Two](two.md) ⬜

## Version History
`);
    writeDoc(plans, 'one.md', `type: plan
status: active
title: One
updated: 2026-05-26`);
    writeDoc(plans, 'two.md', `type: plan
status: active
title: Two
updated: 2026-05-26`);

    run(['add', 'docs/plans/hub.md', 'deploy']);
    const hub = readFileSync(path.join(plans, 'hub.md'), 'utf8');
    match(hub, /3\. \[Deploy\]\(hub-03-deploy\.md\) ⬜/);
  });
});

describe('dotmd runlist remove / reorder', () => {
  // A sprint hub with a body `## Order of operations` list (the `--runlist`
  // scaffold shape) + child files, so body-sync and slug matching are exercised.
  function sprintWithBody(plans) {
    writeDoc(plans, 'sprint.md', `type: plan
status: active
title: Sprint
updated: 2026-05-26
runlist:
  - sprint-01-a.md
  - sprint-02-b.md
  - sprint-03-c.md`, `# Sprint

## Order of operations

1. [A](sprint-01-a.md) ⬜
2. [B](sprint-02-b.md) ✅
3. [C](sprint-03-c.md) ⬜

Pick up the next child with \`dotmd runlist next sprint\`.

## Version History
`);
    for (const [f, t] of [['sprint-01-a.md', 'A'], ['sprint-02-b.md', 'B'], ['sprint-03-c.md', 'C']]) {
      writeDoc(plans, f, `type: plan
status: planned
title: ${t}
parent_plan: sprint.md
updated: 2026-05-26`);
    }
  }

  const order = (plans) => readFileSync(path.join(plans, 'sprint.md'), 'utf8')
    .match(/runlist:\n((?:  - .*\n?)*)/)[1].split('\n')
    .map(l => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);

  it('removes a child by its short slug and renumbers the body order list', () => {
    const plans = setupProject();
    sprintWithBody(plans);
    const r = run(['remove', 'docs/plans/sprint.md', 'b']); // slug → sprint-02-b.md
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    strictEqual(order(plans).join(','), 'sprint-01-a.md,sprint-03-c.md');
    const hub = readFileSync(path.join(plans, 'sprint.md'), 'utf8');
    match(hub, /1\. \[A\]\(sprint-01-a\.md\) ⬜\n2\. \[C\]\(sprint-03-c\.md\) ⬜/);
    ok(!/sprint-02-b/.test(hub), 'removed child gone from body list too');
  });

  it('--clear-parent blanks the removed child\'s back-ref', () => {
    const plans = setupProject();
    sprintWithBody(plans);
    run(['remove', 'docs/plans/sprint.md', 'b', '--clear-parent']);
    match(readFileSync(path.join(plans, 'sprint-02-b.md'), 'utf8'), /^parent_plan:\s*$/m);
  });

  it('remove --dry-run writes nothing', () => {
    const plans = setupProject();
    sprintWithBody(plans);
    const before = readFileSync(path.join(plans, 'sprint.md'), 'utf8');
    const r = run(['remove', 'docs/plans/sprint.md', 'b', '--dry-run']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    strictEqual(readFileSync(path.join(plans, 'sprint.md'), 'utf8'), before);
  });

  it('errors when removing a child that is not in the runlist', () => {
    const plans = setupProject();
    sprintWithBody(plans);
    const r = run(['remove', 'docs/plans/sprint.md', 'ghost']);
    strictEqual(r.status, 1);
    match(r.stderr + r.stdout, /not in the runlist/);
  });

  it('reorder --before moves one child and preserves other items\' status markers', () => {
    const plans = setupProject();
    sprintWithBody(plans);
    const r = run(['reorder', 'docs/plans/sprint.md', 'c', '--before', 'a']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    strictEqual(order(plans).join(','), 'sprint-03-c.md,sprint-01-a.md,sprint-02-b.md');
    // B kept its ✅ through the move.
    match(readFileSync(path.join(plans, 'sprint.md'), 'utf8'), /\[B\]\(sprint-02-b\.md\) ✅/);
  });

  it('reorder --after places the child after the anchor', () => {
    const plans = setupProject();
    sprintWithBody(plans);
    run(['reorder', 'docs/plans/sprint.md', 'a', '--after', 'c']);
    strictEqual(order(plans).join(','), 'sprint-02-b.md,sprint-03-c.md,sprint-01-a.md');
  });

  it('reorder accepts a full new order (permutation of all children)', () => {
    const plans = setupProject();
    sprintWithBody(plans);
    const r = run(['reorder', 'docs/plans/sprint.md', 'c', 'a', 'b']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    strictEqual(order(plans).join(','), 'sprint-03-c.md,sprint-01-a.md,sprint-02-b.md');
  });

  it('rejects a partial reorder list (not a full permutation)', () => {
    const plans = setupProject();
    sprintWithBody(plans);
    const r = run(['reorder', 'docs/plans/sprint.md', 'c', 'a']);
    strictEqual(r.status, 1);
    match(r.stderr + r.stdout, /needs all 3 children/);
  });

  it('refuses to move a child relative to itself', () => {
    const plans = setupProject();
    sprintWithBody(plans);
    const r = run(['reorder', 'docs/plans/sprint.md', 'a', '--before', 'a']);
    strictEqual(r.status, 1);
    match(r.stderr + r.stdout, /relative to itself/);
  });

  it('refuses remove/reorder on a hub with no runlist array', () => {
    const plans = setupProject();
    writeDoc(plans, 'plain.md', `type: plan
status: active
title: Plain
updated: 2026-05-26`);
    const r = run(['reorder', 'docs/plans/plain.md', 'x', '--before', 'y']);
    strictEqual(r.status, 1);
    match(r.stderr + r.stdout, /no `runlist:` array/);
  });
});

describe('dotmd plans --status (Runlists nav discoverability)', () => {
  it('shows a "hidden by filter" pointer when a status filter hides a live coordination hub', () => {
    const plans = setupProject();
    writeDoc(plans, 'master-runlist.md', `type: plan
status: active
title: Master
execution_mode: coordination
related_plans:
updated: ${daysAgoDate(2)}`);
    writeDoc(plans, 'leaf.md', `type: plan
status: blocked
title: Leaf
updated: ${daysAgoDate(2)}`);

    const r = runCmd('plans', ['--status', 'blocked']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    match(r.stdout, /1 runlist hidden by filter\s+·\s+dotmd runlists/);
  });

  it('does not show the pointer when the filter matches the hub (no filter case)', () => {
    const plans = setupProject();
    writeDoc(plans, 'master-runlist.md', `type: plan
status: active
title: Master
execution_mode: coordination
related_plans:
updated: ${daysAgoDate(2)}`);
    writeDoc(plans, 'leaf.md', `type: plan
status: active
title: Leaf
updated: ${daysAgoDate(2)}`);

    const r = runCmd('plans', []);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(!/hidden by filter/.test(r.stdout), 'no pointer without a narrowing filter');
  });
});
