import { describe, it, afterEach } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual, throws } from 'node:assert';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../src/config.mjs';
import { buildIndex } from '../src/index.mjs';
import { fixMembershipBackrefs } from '../src/fix-membership.mjs';
import { MutationConflictError } from '../src/atomic-mutation.mjs';
import { classifyIssueAction } from '../src/render.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-fix-membership-'));
  spawnSync('git', ['init', '-q'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
  mkdirSync(path.join(tmpDir, 'docs', 'plans', 'archived'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n`);
  return path.join(tmpDir, 'docs', 'plans');
}

function writeDoc(file, frontmatter, body = '') {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---\n${frontmatter}\n---\n${body}`);
  return file;
}

function hub(plans, filename, body, { extra = '', status = 'active' } = {}) {
  return writeDoc(path.join(plans, filename), `type: plan
status: ${status}
execution_mode: coordination
updated: 2026-08-01${extra ? `\n${extra}` : ''}
current_state: hub
next_step: ship`, body);
}

function plan(plans, filename, { parent, status = 'active', type = 'plan', extra = '' } = {}) {
  const parentLine = parent === undefined ? '' : `\nparent_plan:${parent ? ` ${parent}` : ''}`;
  return writeDoc(path.join(plans, filename), `type: ${type}
status: ${status}
updated: 2026-08-01${parentLine}${extra ? `\n${extra}` : ''}
current_state: work
next_step: ship`, `# ${filename}\n`);
}

function ranked(ref) {
  return `# Hub

## Ranked queue

| Rank | Plan | Status |
|---|---|---|
| 1 | [Child](${ref}) | active |
`;
}

async function fixture() {
  const config = await resolveConfig(tmpDir);
  return { config, docs: buildIndex(config, { gitStaleness: false }).docs };
}

function run(args) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', DOTMD_SESSION_ID: 'fix-membership-test' },
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('membership repair candidate boundary', () => {
  it('repairs a body-order child with a child-relative forward-slash ref', async () => {
    const plans = setupProject();
    const hubFile = hub(plans, 'program/master-runlist.md', ranked('../work/child.md'));
    const childFile = plan(plans, 'work/child.md', { parent: '' });
    const { config, docs } = await fixture();

    const result = fixMembershipBackrefs(config, { docs, quiet: true });
    strictEqual(result.fixed, 1);
    deepStrictEqual(result.changes[0].sources, ['body-order']);
    match(readFileSync(childFile, 'utf8'), /^parent_plan: \.\.\/program\/master-runlist\.md$/m);
    ok(!readFileSync(hubFile, 'utf8').includes('parent_plan:'), 'hub prose/frontmatter is untouched');
  });

  it('repairs a frontmatter runlist child and classifies its warning as fixable', async () => {
    const plans = setupProject();
    hub(plans, 'billing-runlist.md', '# Billing\n', { extra: 'runlist:\n  - child.md' });
    const childFile = plan(plans, 'child.md', { parent: '' });
    const { config, docs } = await fixture();
    const index = buildIndex(config, { gitStaleness: false });
    const warning = index.warnings.find(item => item.path.endsWith('child.md')
      && item.meta?.source === 'frontmatter-runlist');
    strictEqual(warning.meta.kind, 'hub-membership-backref');
    deepStrictEqual(classifyIssueAction(warning), {
      action: 'dotmd fix-membership', fixable: true, label: 'membership back-references',
    });

    const result = fixMembershipBackrefs(config, { docs, quiet: true });
    strictEqual(result.fixed, 1);
    match(readFileSync(childFile, 'utf8'), /^parent_plan: billing-runlist\.md$/m);
  });

  it('refuses a parentless child ranked by two distinct hubs', async () => {
    const plans = setupProject();
    hub(plans, 'alpha-runlist.md', ranked('child.md'));
    hub(plans, 'beta-runlist.md', ranked('child.md'));
    const childFile = plan(plans, 'child.md', { parent: '' });
    const before = readFileSync(childFile, 'utf8');
    const { config, docs } = await fixture();

    const result = fixMembershipBackrefs(config, { docs, quiet: true });
    strictEqual(result.fixed, 0);
    strictEqual(result.skipped, 1);
    strictEqual(result.ambiguous, 1);
    deepStrictEqual(result.ambiguousDetails[0].hubs, [
      'docs/plans/alpha-runlist.md', 'docs/plans/beta-runlist.md',
    ]);
    strictEqual(readFileSync(childFile, 'utf8'), before);
  });

  it('preserves a different parent and leaves that runlist conflict manual', async () => {
    const plans = setupProject();
    hub(plans, 'billing-runlist.md', '# Billing\n', { extra: 'runlist:\n  - child.md' });
    hub(plans, 'owner-runlist.md', '# Owner\n\nSee [child](child.md).\n');
    const childFile = plan(plans, 'child.md', { parent: 'owner-runlist.md' });
    const before = readFileSync(childFile, 'utf8');
    const { config, docs } = await fixture();
    const warning = buildIndex(config, { gitStaleness: false }).warnings
      .find(item => item.meta?.kind === 'hub-membership-conflict');
    strictEqual(classifyIssueAction(warning).fixable, false);

    const result = fixMembershipBackrefs(config, { docs, quiet: true });
    strictEqual(result.fixed, 0);
    strictEqual(readFileSync(childFile, 'utf8'), before);
  });

  it('never overwrites a non-empty parent_plan array', async () => {
    const plans = setupProject();
    hub(plans, 'billing-runlist.md', ranked('child.md'));
    const childFile = plan(plans, 'child.md', {
      parent: undefined,
      extra: 'parent_plan:\n  - owner-runlist.md\n  - portfolio-runlist.md',
    });
    const before = readFileSync(childFile, 'utf8');
    const { config, docs } = await fixture();

    const result = fixMembershipBackrefs(config, { docs, quiet: true });
    strictEqual(result.fixed, 0);
    strictEqual(readFileSync(childFile, 'utf8'), before);
  });

  it('honors one-way entries and skips terminal, non-plan, nested-hub, and untyped children', async () => {
    const plans = setupProject();
    hub(plans, 'one-way-runlist.md', ranked('one-way.md'), { extra: 'runlist:\n  - "> one-way.md"' });
    plan(plans, 'one-way.md', { parent: '' });
    hub(plans, 'terminal-runlist.md', ranked('terminal.md'));
    plan(plans, 'terminal.md', { parent: '', status: 'archived' });
    hub(plans, 'types-runlist.md', `# Types

## Order of operations

1. [Doc](doc.md)
2. [Nested](nested-runlist.md)
3. [Legacy](legacy.md)
`);
    plan(plans, 'doc.md', { parent: '', type: 'doc' });
    hub(plans, 'nested-runlist.md', '# Nested\n');
    writeDoc(path.join(plans, 'legacy.md'), `status: active
updated: 2026-08-01
current_state: legacy
next_step: ship`, '# Legacy\n');
    const { config, docs } = await fixture();

    const result = fixMembershipBackrefs(config, { docs, quiet: true });
    strictEqual(result.fixed, 0);
    strictEqual(result.skipped, 1, 'untyped legacy finding is diagnosed but never mutated');
    strictEqual(result.skippedDetails[0].reason, 'untyped-child');
  });

  it('supports narrowing repair to named hub paths', async () => {
    const plans = setupProject();
    hub(plans, 'alpha-runlist.md', ranked('alpha.md'));
    hub(plans, 'beta-runlist.md', ranked('beta.md'));
    const alpha = plan(plans, 'alpha.md', { parent: '' });
    const beta = plan(plans, 'beta.md', { parent: '' });
    const { config, docs } = await fixture();

    const result = fixMembershipBackrefs(config, {
      docs, quiet: true, hubPaths: new Set(['docs/plans/alpha-runlist.md']),
    });
    strictEqual(result.fixed, 1);
    match(readFileSync(alpha, 'utf8'), /^parent_plan: alpha-runlist\.md$/m);
    ok(!/^parent_plan: /m.test(readFileSync(beta, 'utf8')));
  });
});

describe('membership repair mutation safety', () => {
  it('dry-run is byte-identical and a repeated apply is idempotent', async () => {
    const plans = setupProject();
    hub(plans, 'billing-runlist.md', ranked('child.md'));
    const childFile = plan(plans, 'child.md', { parent: '' });
    const before = readFileSync(childFile, 'utf8');
    let state = await fixture();

    strictEqual(fixMembershipBackrefs(state.config, { docs: state.docs, dryRun: true, quiet: true }).fixed, 1);
    strictEqual(readFileSync(childFile, 'utf8'), before);
    strictEqual(fixMembershipBackrefs(state.config, { docs: state.docs, quiet: true }).fixed, 1);
    state = await fixture();
    strictEqual(fixMembershipBackrefs(state.config, { docs: state.docs, quiet: true }).fixed, 0);
  });

  it('aborts without a child write when hub evidence changes after planning', async () => {
    const plans = setupProject();
    const hubFile = hub(plans, 'billing-runlist.md', ranked('child.md'));
    const childFile = plan(plans, 'child.md', { parent: '' });
    const childBefore = readFileSync(childFile, 'utf8');
    const { config, docs } = await fixture();

    throws(() => fixMembershipBackrefs(config, {
      docs,
      quiet: true,
      testHooks: {
        afterMembershipPlan() {
          writeFileSync(hubFile, readFileSync(hubFile, 'utf8').replace('[Child]', '[Changed]'));
        },
      },
    }), MutationConflictError);
    strictEqual(readFileSync(childFile, 'utf8'), childBefore);
  });

  it('aborts without overwriting a child that changes after planning', async () => {
    const plans = setupProject();
    hub(plans, 'billing-runlist.md', ranked('child.md'));
    const childFile = plan(plans, 'child.md', { parent: '' });
    const { config, docs } = await fixture();

    throws(() => fixMembershipBackrefs(config, {
      docs,
      quiet: true,
      testHooks: {
        afterMembershipPlan() {
          writeFileSync(childFile, readFileSync(childFile, 'utf8').replace('next_step: ship', 'next_step: changed'));
        },
      },
    }), MutationConflictError);
    const after = readFileSync(childFile, 'utf8');
    match(after, /next_step: changed/);
    ok(!/^parent_plan: /m.test(after));
  });

  it('aborts when the child changes after candidate discovery', async () => {
    const plans = setupProject();
    hub(plans, 'billing-runlist.md', ranked('child.md'));
    const childFile = plan(plans, 'child.md', { parent: '' });
    const { config, docs } = await fixture();

    throws(() => fixMembershipBackrefs(config, {
      docs,
      quiet: true,
      testHooks: {
        afterMembershipCandidates() {
          writeFileSync(childFile, readFileSync(childFile, 'utf8').replace('type: plan', 'type: doc'));
        },
      },
    }), MutationConflictError);
    const after = readFileSync(childFile, 'utf8');
    match(after, /type: doc/);
    ok(!/^parent_plan: /m.test(after));
  });

  it('rolls back every child when a multi-file commit fails', async () => {
    const plans = setupProject();
    hub(plans, 'billing-runlist.md', `# Billing

## Order of operations

1. [A](a.md)
2. [B](b.md)
`);
    const a = plan(plans, 'a.md', { parent: '' });
    const b = plan(plans, 'b.md', { parent: '' });
    const aBefore = readFileSync(a, 'utf8');
    const bBefore = readFileSync(b, 'utf8');
    const { config, docs } = await fixture();

    throws(() => fixMembershipBackrefs(config, {
      docs,
      quiet: true,
      testHooks: { afterSetCommit(count) { if (count === 1) throw new Error('injected'); } },
    }), /injected/);
    strictEqual(readFileSync(a, 'utf8'), aBefore);
    strictEqual(readFileSync(b, 'utf8'), bBefore);
  });
});

describe('dotmd fix-membership command and compositions', () => {
  it('--dry-run --json reports stable changes and apply converges to zero', () => {
    const plans = setupProject();
    hub(plans, 'billing-runlist.md', ranked('child.md'));
    const childFile = plan(plans, 'child.md', { parent: '' });
    const before = readFileSync(childFile, 'utf8');

    const preview = run(['fix-membership', '--dry-run', '--json']);
    strictEqual(preview.status, 0, preview.stderr);
    const payload = JSON.parse(preview.stdout);
    strictEqual(payload.dryRun, true);
    strictEqual(payload.fixed, 1);
    strictEqual(payload.ambiguous, 0);
    strictEqual(payload.changes[0].ref, 'billing-runlist.md');
    strictEqual(readFileSync(childFile, 'utf8'), before);

    strictEqual(run(['fix-membership']).status, 0);
    const repeated = run(['fix-membership', '--json']);
    strictEqual(repeated.status, 0, repeated.stderr);
    strictEqual(JSON.parse(repeated.stdout).fixed, 0);
  });

  it('is composed into check --fix', () => {
    const plans = setupProject();
    hub(plans, 'billing-runlist.md', ranked('child.md'));
    const childFile = plan(plans, 'child.md', { parent: '' });

    const result = run(['check', '--fix']);
    strictEqual(result.status, 0, result.stderr);
    match(readFileSync(childFile, 'utf8'), /^parent_plan: billing-runlist\.md$/m);
  });

  it('is previewed by default and applied by doctor --apply', () => {
    const plans = setupProject();
    hub(plans, 'billing-runlist.md', ranked('child.md'));
    const childFile = plan(plans, 'child.md', { parent: '' });
    const before = readFileSync(childFile, 'utf8');

    const preview = run(['doctor']);
    strictEqual(preview.status, 0, preview.stderr);
    match(preview.stdout, /Would set: docs\/plans\/child\.md/);
    strictEqual(readFileSync(childFile, 'utf8'), before);

    const applied = run(['doctor', '--apply']);
    strictEqual(applied.status, 0, applied.stderr);
    match(readFileSync(childFile, 'utf8'), /^parent_plan: billing-runlist\.md$/m);
  });
});
