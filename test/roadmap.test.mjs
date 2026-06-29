import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import { buildIndex } from '../src/index.mjs';
import { buildRoadmapIndex, isRoadmapHub, isCoordinationHub } from '../src/runlist.mjs';
import { checkRoadmapHubExecutionMode, checkCoordinationHubExecutionMode } from '../src/validate.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-roadmap-'));
  spawnSync('git', ['init', '-q'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
  mkdirSync(path.join(tmpDir, 'docs', 'plans', 'archived'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n`);
  return path.join(tmpDir, 'docs', 'plans');
}

function writeDoc(plansDir, filename, frontmatter, body = '') {
  writeFileSync(path.join(plansDir, filename), `---\n${frontmatter}\n---\n${body}`);
}

function runNew(args) {
  return spawnSync('node', [BIN, 'new', ...args], {
    cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
}

function runCmd(args) {
  return spawnSync('node', [BIN, ...args], {
    cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
}

afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

describe('isRoadmapHub / isCoordinationHub', () => {
  it('detects execution_mode:roadmap, and a roadmap also counts as a held-out hub', () => {
    const rm = { path: 'docs/plans/q3.md', type: 'plan', executionMode: 'roadmap' };
    strictEqual(isRoadmapHub(rm), true);
    // A roadmap is held out of the active count like a coordination hub.
    strictEqual(isCoordinationHub(rm), true);
    // A coordination hub is NOT a roadmap.
    strictEqual(isRoadmapHub({ path: 'docs/plans/x-runlist.md', type: 'plan', executionMode: 'coordination' }), false);
    // No slug-convention fallback for roadmaps — explicit field only.
    strictEqual(isRoadmapHub({ path: 'docs/plans/master-runlist.md', type: 'plan' }), false);
    // Non-plan docs are never hubs.
    strictEqual(isRoadmapHub({ path: 'docs/x.md', type: 'doc', executionMode: 'roadmap' }), false);
  });
});

// Roadmap → { coordination child, sprint child, loose plan child }, each with a
// known rollup, so the recursive sum is deterministic.
function setupRoadmap() {
  const plans = setupProject();
  writeDoc(plans, 'master-roadmap.md', `type: plan
status: active
title: Master Roadmap
execution_mode: roadmap
updated: 2026-06-25
related_plans:
  - ./billing-runlist.md
  - ./auth-revamp.md
  - ./loose-plan.md
next_step: x`);
  // coordination child → total 2, done 1, parked 0
  writeDoc(plans, 'billing-runlist.md', `type: plan
status: active
title: Billing
execution_mode: coordination
updated: 2026-06-24
related_plans:
  - ./billing-a.md
  - ./billing-b.md
next_step: x`);
  writeDoc(plans, 'billing-a.md', 'type: plan\nstatus: archived\ntitle: Billing A\nupdated: 2026-06-24\nnext_step: -');
  writeDoc(plans, 'billing-b.md', 'type: plan\nstatus: active\ntitle: Billing B\nupdated: 2026-06-24\nnext_step: -');
  // sprint child (runlist: array) → total 2, done 1, parked 1
  writeDoc(plans, 'auth-revamp.md', `type: plan
status: active
title: Auth Revamp
updated: 2026-06-24
runlist:
  - ./auth-01.md
  - ./auth-02.md
next_step: x`);
  writeDoc(plans, 'auth-01.md', 'type: plan\nstatus: archived\ntitle: Auth 01\nupdated: 2026-06-24\nnext_step: -');
  writeDoc(plans, 'auth-02.md', 'type: plan\nstatus: blocked\ntitle: Auth 02\nupdated: 2026-06-24\nnext_step: -');
  // loose plan child → total 1, done 0, parked 0
  writeDoc(plans, 'loose-plan.md', 'type: plan\nstatus: active\ntitle: Loose\nupdated: 2026-06-24\nnext_step: -');
  return plans;
}

describe('buildRoadmapIndex (recursive rollup)', () => {
  it('rolls each child hub up into a grand total, tagging child kinds', async () => {
    setupRoadmap();
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    const roadmaps = buildRoadmapIndex(index, config);
    ok(roadmaps.has('docs/plans/master-roadmap.md'));
    const rm = roadmaps.get('docs/plans/master-roadmap.md');

    strictEqual(rm.childCount, 3);
    // grand total = 2 (billing) + 2 (auth) + 1 (loose) = 5; done = 1+1+0 = 2; parked = 0+1+0 = 1
    strictEqual(rm.grandTotal, 5);
    strictEqual(rm.grandDone, 2);
    strictEqual(rm.grandParked, 1);

    const byPath = new Map(rm.children.map(c => [c.path, c]));
    strictEqual(byPath.get('docs/plans/billing-runlist.md').kind, 'coordination');
    strictEqual(byPath.get('docs/plans/billing-runlist.md').doneCount, 1);
    strictEqual(byPath.get('docs/plans/auth-revamp.md').kind, 'runlist');
    strictEqual(byPath.get('docs/plans/auth-revamp.md').parkedCount, 1);
    strictEqual(byPath.get('docs/plans/loose-plan.md').kind, 'plan');
    strictEqual(byPath.get('docs/plans/loose-plan.md').total, 1);
  });

  it('returns an empty map when there are no roadmap hubs', async () => {
    const plans = setupProject();
    writeDoc(plans, 'x-runlist.md', 'type: plan\nstatus: active\nexecution_mode: coordination\ntitle: X\nupdated: 2026-06-24\nnext_step: -');
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    strictEqual(buildRoadmapIndex(index, config).size, 0);
  });
});

describe('dotmd new plan --roadmap', () => {
  it('scaffolds an execution_mode:roadmap hub with a ## Runlists body', () => {
    setupProject();
    const r = runNew(['plan', 'q3', '--roadmap']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    match(r.stdout, /\(roadmap hub\)/);
    const body = readFileSync(path.join(tmpDir, 'docs', 'plans', 'q3.md'), 'utf8');
    match(body, /execution_mode: roadmap/);
    match(body, /## Runlists/);
    match(body, /dotmd roadmap q3/);
  });

  it('rejects combining --roadmap with another body shape', () => {
    setupProject();
    const r = runNew(['plan', 'q3', '--roadmap', '--coordination']);
    ok(r.status !== 0, 'should exit non-zero');
    match(r.stderr + r.stdout, /mutually exclusive/);
  });
});

describe('checkRoadmapHubExecutionMode (nudge)', () => {
  it('nudges a coordination hub whose children are themselves hubs', async () => {
    const plans = setupProject();
    writeDoc(plans, 'domain-hub.md', `type: plan
status: active
title: Domain
execution_mode: coordination
updated: 2026-06-24
related_plans:
  - ./billing-runlist.md
  - ./auth-rls-runlist.md
next_step: x`);
    writeDoc(plans, 'billing-runlist.md', 'type: plan\nstatus: active\nexecution_mode: coordination\ntitle: Billing\nupdated: 2026-06-24\nnext_step: -');
    writeDoc(plans, 'auth-rls-runlist.md', 'type: plan\nstatus: active\nexecution_mode: coordination\ntitle: Auth\nupdated: 2026-06-24\nnext_step: -');
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    const warnings = checkRoadmapHubExecutionMode(index.docs, config);
    const w = warnings.find(w => w.path === 'docs/plans/domain-hub.md');
    ok(w, 'expected a nudge on the domain hub');
    match(w.message, /execution_mode: roadmap/);
  });

  it('does not nudge a coordination hub that points at leaf plans', async () => {
    const plans = setupProject();
    writeDoc(plans, 'domain-hub.md', `type: plan
status: active
title: Domain
execution_mode: coordination
updated: 2026-06-24
related_plans:
  - ./leaf-a.md
  - ./leaf-b.md
next_step: x`);
    writeDoc(plans, 'leaf-a.md', 'type: plan\nstatus: active\ntitle: A\nupdated: 2026-06-24\nnext_step: -');
    writeDoc(plans, 'leaf-b.md', 'type: plan\nstatus: active\ntitle: B\nupdated: 2026-06-24\nnext_step: -');
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    const warnings = checkRoadmapHubExecutionMode(index.docs, config);
    strictEqual(warnings.find(w => w.path === 'docs/plans/domain-hub.md'), undefined);
  });

  it('does not nudge a hub that is already a roadmap', async () => {
    setupRoadmap();
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    const warnings = checkRoadmapHubExecutionMode(index.docs, config);
    strictEqual(warnings.find(w => w.path === 'docs/plans/master-roadmap.md'), undefined);
  });

  // Regression: a `*-runlist`-slugged hub promoted to a roadmap must NOT be told
  // to add `execution_mode: coordination` — it's already an explicit (tier-up)
  // hub. Caught dogfooding the platform's master-runlist migration.
  it('coordination nudge skips a roadmap hub even with a *-runlist slug', async () => {
    const plans = setupProject();
    writeDoc(plans, 'master-runlist.md', `type: plan
status: active
title: Master
execution_mode: roadmap
updated: 2026-06-24
related_plans:
  - ./billing-runlist.md
next_step: x`);
    writeDoc(plans, 'billing-runlist.md', 'type: plan\nstatus: active\nexecution_mode: coordination\ntitle: Billing\nupdated: 2026-06-24\nnext_step: -');
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config);
    const warnings = checkCoordinationHubExecutionMode(index.docs, config);
    strictEqual(warnings.find(w => w.path === 'docs/plans/master-runlist.md'), undefined,
      'a roadmap with a *-runlist slug must not be nudged toward execution_mode: coordination');
  });
});

describe('roadmap views + integration (CLI)', () => {
  it('dotmd roadmaps lists the roadmap with its recursive grand total', () => {
    setupRoadmap();
    const r = runCmd(['roadmaps']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /Roadmaps \(1\)/);
    match(r.stdout, /master-roadmap\s+.*2\/5/); // billing 1/2 + auth 1/2 + loose 0/1
  });

  it('dotmd roadmap shows each child runlist row + grand total', () => {
    setupRoadmap();
    const r = runCmd(['roadmap']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /Roadmap: Master Roadmap\s+2\/5/);
    match(r.stdout, /billing-runlist\s+.*1\/2/);
    match(r.stdout, /auth-revamp\s+.*1\/2/);
  });

  it('dotmd roadmap next picks up the first startable plan across runlists', () => {
    setupRoadmap();
    // Walks in related_plans order: billing-runlist (coordination, no body order
    // → no next) is skipped; auth-revamp (sprint) is skipped too because its only
    // live child auth-02 is BLOCKED (parked, not startable); so the first genuinely
    // pickup-able plan across the whole roadmap is the loose-plan child.
    const r = runCmd(['roadmap', 'next']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /loose-plan/);
    match(r.stdout, /in-session/);
  });

  it('dotmd plans counts roadmaps separately and gives them a section', () => {
    setupRoadmap();
    const r = runCmd(['plans']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /1 roadmap/);
    match(r.stdout, /Roadmaps \(1\)/);
  });

  it('dotmd runlists excludes the roadmap and points at it', () => {
    setupRoadmap();
    const r = runCmd(['runlists']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /1 roadmap\s+·\s+dotmd roadmaps/);
    ok(!/master-roadmap/.test(r.stdout), 'roadmap must not appear in the runlists list');
  });
});
