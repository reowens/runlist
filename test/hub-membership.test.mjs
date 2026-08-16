import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, deepStrictEqual, match } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import { buildIndex } from '../src/index.mjs';
import { checkHubMembershipDrift } from '../src/hub-membership.mjs';

let tmpDir;

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-membership-'));
  spawnSync('git', ['init', '-q'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
  mkdirSync(path.join(tmpDir, 'docs', 'plans', 'archived'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n`);
  return path.join(tmpDir, 'docs', 'plans');
}

function writeDoc(dir, filename, frontmatter, body = '') {
  writeFileSync(path.join(dir, filename), `---\n${frontmatter}\n---\n${body}`);
}

function hub(plansDir, filename, body, { extra = '', status = 'active' } = {}) {
  writeDoc(plansDir, filename, `type: plan
status: ${status}
title: ${filename.replace(/\.md$/, '')}
execution_mode: coordination
updated: 2026-08-01${extra ? `\n${extra}` : ''}
current_state: hub
next_step: ship`, body);
  return `docs/plans/${filename}`;
}

function plan(plansDir, filename, { status = 'active', parent = null, extra = '' } = {}) {
  writeDoc(plansDir, filename, `type: plan
status: ${status}
title: ${filename.replace(/\.md$/, '')}
updated: 2026-08-01${parent ? `\nparent_plan: ${parent}` : ''}${extra ? `\n${extra}` : ''}
current_state: x
next_step: x`, `# ${filename}\n\n## Closeout\nn/a\n`);
  return `docs/plans/${filename}`;
}

async function warnings() {
  const config = await resolveConfig(tmpDir);
  const index = buildIndex(config, { gitStaleness: false });
  return checkHubMembershipDrift(index.docs, config);
}

function kinds(list, kind) {
  return list.filter(w => w.meta?.kind === kind);
}

afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

describe('a claim only the child makes', () => {
  it('warns on the hub when a plan claims it as parent and the hub knows nothing about it', async () => {
    const plans = setupProject();
    const hubPath = hub(plans, 'billing-runlist.md', '# Billing\n\nNo children listed here at all.\n');
    plan(plans, 'billing-a.md', { parent: './billing-runlist.md' });

    const found = kinds(await warnings(), 'hub-membership-orphan');
    strictEqual(found.length, 1);
    strictEqual(found[0].path, hubPath);
    match(found[0].message, /`docs\/plans\/billing-a\.md` claims `parent_plan: \.\/billing-runlist\.md`/);
  });

  it('is silent when the hub references the child at all — field or body link', async () => {
    const plans = setupProject();
    // via related_plans:
    hub(plans, 'billing-runlist.md', '# Billing\n', { extra: 'related_plans:\n  - ./billing-a.md' });
    plan(plans, 'billing-a.md', { parent: './billing-runlist.md' });
    // via a plain body link, in no particular section
    hub(plans, 'auth-runlist.md', '# Auth\n\nSee [the extract plan](auth-a.md) for context.\n');
    plan(plans, 'auth-a.md', { parent: './auth-runlist.md' });
    // via frontmatter runlist:
    hub(plans, 'pos-runlist.md', '# POS\n', { extra: 'runlist:\n  - ./pos-a.md' });
    plan(plans, 'pos-a.md', { parent: './pos-runlist.md' });

    deepStrictEqual(kinds(await warnings(), 'hub-membership-orphan'), []);
  });

  it('is silent when the named parent is not a hub, or either side is closed', async () => {
    const plans = setupProject();
    // A plain plan as parent: it rows nothing, so a link back is not expected.
    plan(plans, 'plain-parent.md');
    plan(plans, 'child-of-plain.md', { parent: './plain-parent.md' });
    // Archived hub.
    hub(plans, 'old-runlist.md', '# Old\n\n## Closeout\nn/a\n', { status: 'archived' });
    plan(plans, 'child-of-old.md', { parent: './old-runlist.md' });
    // Archived child.
    hub(plans, 'live-runlist.md', '# Live\n');
    plan(path.join(plans, 'archived'), 'closed-child.md', { status: 'archived', parent: '../live-runlist.md' });

    deepStrictEqual(kinds(await warnings(), 'hub-membership-orphan'), []);
  });
});

describe('a claim only the hub makes', () => {
  it('warns on the child when a hub ranks it in its body order and it points nowhere', async () => {
    const plans = setupProject();
    const hubPath = hub(plans, 'billing-runlist.md', `# Billing

## Ranked queue

| Rank | Plan | Status |
|---|---|---|
| 1 | [A](billing-a.md) | active |
`);
    const childPath = plan(plans, 'billing-a.md');

    const found = kinds(await warnings(), 'hub-membership-backref');
    strictEqual(found.length, 1);
    strictEqual(found[0].path, childPath);
    match(found[0].message, new RegExp(`ranked in the body order of \`${hubPath}\``));
    match(found[0].message, /has no `parent_plan:`/);
  });

  it('also reads an `## Order of operations` link list', async () => {
    const plans = setupProject();
    hub(plans, 'billing-runlist.md', `# Billing

## Order of operations

1. [A](billing-a.md)
`);
    plan(plans, 'billing-a.md');
    strictEqual(kinds(await warnings(), 'hub-membership-backref').length, 1);
  });

  it('a table under a link-list heading ranks the row subject, not its prose', async () => {
    // `## Runlist index — by category` matches the link-list heading list, but it
    // is written as tables. Taking every link in the section made each row's
    // descriptive prose a membership claim: the row is about A, its prose says A
    // spawned B, and B got warned for not naming the HUB as its parent — when the
    // hub never claimed B at all. In a table only the first link per row ranks.
    const plans = setupProject();
    hub(plans, 'billing-runlist.md', `# Billing

## Runlist index — by category

| Plan | Notes |
|---|---|
| [A](billing-a.md) | Phase 12 spawned a child, [B](billing-b.md), owned by A and not by this hub. |
`);
    plan(plans, 'billing-a.md');
    plan(plans, 'billing-b.md');

    const found = kinds(await warnings(), 'hub-membership-backref');
    strictEqual(found.length, 1, 'only the row subject is a member');
    match(found[0].path, /billing-a\.md$/);
  });

  it('ranks one plan per list line, so an item\'s commentary is not a claim', async () => {
    // A ranked item carries commentary, and commentary links elsewhere. Measured
    // on a real hub: item 1 is about plan A and notes that A's open item "closes
    // on a route decision in [B]" — B is cited, not ranked. First link per line,
    // the same rule a table row already follows.
    const plans = setupProject();
    hub(plans, 'billing-runlist.md', `# Billing

## Order of operations

1. **A** — its open item closes on a decision in [B](billing-b.md). See [A](billing-a.md).
2. [C](billing-c.md)
`);
    plan(plans, 'billing-a.md');
    plan(plans, 'billing-b.md');
    plan(plans, 'billing-c.md');

    const found = kinds(await warnings(), 'hub-membership-backref').map(w => w.path);
    strictEqual(found.length, 2, `first link per line only, got ${JSON.stringify(found)}`);
    ok(found.some(p => p.endsWith('billing-b.md')), 'line 1 ranks its first link');
    ok(found.some(p => p.endsWith('billing-c.md')), 'line 2 ranks its only link');
    ok(!found.some(p => p.endsWith('billing-a.md')), 'the second link on line 1 is commentary');
  });

  it('a multi-line link list still ranks every entry', async () => {
    const plans = setupProject();
    hub(plans, 'billing-runlist.md', `# Billing

## Order of operations

1. [A](billing-a.md)
2. [B](billing-b.md)
`);
    plan(plans, 'billing-a.md');
    plan(plans, 'billing-b.md');
    strictEqual(kinds(await warnings(), 'hub-membership-backref').length, 2);
  });

  it('stays silent when the child points at a DIFFERENT hub', async () => {
    // Measured on a real estate: an aggregator hub ranking plans owned by other
    // programs is legitimate and common. Demanding exclusivity would fire on
    // every such row with no fix that does not break the other hub's claim.
    const plans = setupProject();
    hub(plans, 'closeout-runlist.md', `# Closeout

## Ranked queue

| Rank | Plan | Status |
|---|---|---|
| 1 | [A](billing-a.md) | active |
`);
    hub(plans, 'billing-runlist.md', '# Billing\n', { extra: 'related_plans:\n  - ./billing-a.md' });
    plan(plans, 'billing-a.md', { parent: './billing-runlist.md' });

    deepStrictEqual(kinds(await warnings(), 'hub-membership-backref'), []);
  });

  it('leaves frontmatter `runlist:` children to the existing back-pointer check', async () => {
    const plans = setupProject();
    hub(plans, 'billing-runlist.md', `# Billing

## Order of operations

1. [A](billing-a.md)
`, { extra: 'runlist:\n  - ./billing-a.md' });
    plan(plans, 'billing-a.md');

    // The child is both ranked in the body AND in the frontmatter runlist. It
    // must be reported once, by the check that already owned that pair.
    const config = await resolveConfig(tmpDir);
    const index = buildIndex(config, { gitStaleness: false });
    const backref = index.warnings.filter(w => w.message.includes('parent_plan'));
    strictEqual(backref.length, 1, JSON.stringify(backref, null, 2));
    match(backref[0].message, /appears in runlist of/);
    deepStrictEqual(kinds(checkHubMembershipDrift(index.docs, config), 'hub-membership-backref'), []);
  });

  it('does not ask a hub, a non-plan, or a closed plan for a back-ref', async () => {
    const plans = setupProject();
    hub(plans, 'master-runlist.md', `# Master

## Ranked queue

| Rank | Plan | Status |
|---|---|---|
| 1 | [Billing](billing-runlist.md) | active |
| 2 | [Design](../design.md) | reference |
| 3 | [Closed](archived/closed.md) | archived |
`);
    hub(plans, 'billing-runlist.md', '# Billing\n');
    writeDoc(path.join(tmpDir, 'docs'), 'design.md', 'type: doc\nstatus: reference\ntitle: Design\nupdated: 2026-08-01', '# Design\n');
    plan(path.join(plans, 'archived'), 'closed.md', { status: 'archived' });

    deepStrictEqual(kinds(await warnings(), 'hub-membership-backref'), []);
  });

  it('does not treat an ordinary table as a membership claim', async () => {
    // Same pointer-row principle the status guard uses: rowing a plan somewhere
    // in the body says "related", not "this hub owns you".
    const plans = setupProject();
    hub(plans, 'billing-runlist.md', `# Billing

## Background

| Plan | Notes |
|---|---|
| [A](billing-a.md) | context only |
`);
    plan(plans, 'billing-a.md');

    deepStrictEqual(kinds(await warnings(), 'hub-membership-backref'), []);
  });
});

describe('both arrows together', () => {
  it('reports each side on the file that needs the edit', async () => {
    const plans = setupProject();
    const hubPath = hub(plans, 'billing-runlist.md', `# Billing

## Ranked queue

| Rank | Plan | Status |
|---|---|---|
| 1 | [A](billing-a.md) | active |
`);
    const ranked = plan(plans, 'billing-a.md');            // ranked, claims nobody
    plan(plans, 'billing-b.md', { parent: './billing-runlist.md' });  // claims the hub, unranked

    const found = await warnings();
    strictEqual(kinds(found, 'hub-membership-backref')[0].path, ranked);
    strictEqual(kinds(found, 'hub-membership-orphan')[0].path, hubPath);
    ok(found.every(w => w.level === 'warning'), 'membership drift never gates the exit code');
  });
});
