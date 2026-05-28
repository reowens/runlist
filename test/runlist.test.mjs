import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import { buildIndex } from '../src/index.mjs';

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
    // pickup writes its "Picked up" line to stderr
    match(r.stderr, /Picked up.*docs\/plans\/two\.md/);
    const twoRaw = readFileSync(path.join(plans, 'two.md'), 'utf8');
    match(twoRaw, /status: in-session/);
  });

  it('stops with a runlist-aware error when the next child is awaiting', () => {
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
    match(r.stderr, /status: awaiting/);
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
