import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, deepStrictEqual, match } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import { buildIndex } from '../src/index.mjs';
import { checkHubStatusDrift, collectHubStatusRows, syncHubStatuses } from '../src/sync-status.mjs';
import { applyStatusCase, findMarkedSpan, scanHubStatusRows, splitRowCells } from '../src/hub.mjs';
import { classifyIssueAction } from '../src/render.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-sync-status-'));
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

// A coordination hub whose body carries `rows` verbatim under a ranked-queue
// table with the given header.
function writeHub(plansDir, body, { filename = 'billing-runlist.md', related = [] } = {}) {
  const relatedBlock = related.length ? `related_plans:\n${related.map(r => `  - ./${r}`).join('\n')}\n` : '';
  writeDoc(plansDir, filename, `type: plan
status: active
title: Billing
execution_mode: coordination
updated: 2026-08-01
${relatedBlock}current_state: hub
next_step: ship`, body);
  return `docs/plans/${filename}`;
}

function child(plansDir, filename, status, extra = '') {
  writeDoc(plansDir, filename, `type: plan
status: ${status}
title: ${filename.replace(/\.md$/, '')}
updated: 2026-08-01
current_state: x
next_step: x${extra ? `\n${extra}` : ''}`, `# ${filename}\n\n## Closeout\nn/a\n`);
}

function run(args) {
  return spawnSync('node', [BIN, ...args], {
    cwd: tmpDir, encoding: 'utf8', env: { ...process.env, DOTMD_SESSION_ID: 'sync-status-test', NO_COLOR: '1' },
  });
}

async function findings() {
  const config = await resolveConfig(tmpDir);
  const index = buildIndex(config, { gitStaleness: false });
  return { config, docs: index.docs, ...checkHubStatusDrift(index.docs, config) };
}

function hubStatusMessages(entries) {
  return entries.filter(e => e.meta?.kind?.startsWith('hub-status')).map(e => e.message);
}

afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

describe('row parsing primitives', () => {
  it('splits cells while honoring escapes and inline code', () => {
    const cells = splitRowCells('| a | `x|y` | b\\|c |');
    deepStrictEqual(cells.map(c => c.raw.trim()), ['a', '`x|y`', 'b\\|c']);
    // Offsets are line-absolute so a fix can rewrite one word in place.
    strictEqual('| a | `x|y` | b\\|c |'.slice(cells[0].start, cells[0].end), ' a ');
  });

  it('reads a marked span and preserves its inner offsets', () => {
    const line = '| [x](x.md) | <!--s--> active <!--/s--> — next |';
    const span = findMarkedSpan(line);
    strictEqual(span.text, 'active');
    strictEqual(line.slice(span.start, span.end), 'active');
  });

  it('skips rows inside fenced code blocks', () => {
    const body = [
      '| Plan | Status |', '|---|---|', '| [a](a.md) | active |',
      '', '```', '| Plan | Status |', '|---|---|', '| [fake](fake.md) | active |', '```',
    ].join('\n');
    deepStrictEqual(scanHubStatusRows(body).map(r => r.ref), ['a.md']);
  });

  it('preserves the author case style when rewriting', () => {
    strictEqual(applyStatusCase('active', 'archived'), 'archived');
    strictEqual(applyStatusCase('Active', 'archived'), 'Archived');
    strictEqual(applyStatusCase('ACTIVE', 'archived'), 'ARCHIVED');
    strictEqual(applyStatusCase('in-session', 'queued-after'), 'queued-after');
  });
});

describe('the three-way split', () => {
  it('is silent on a table with no status column (pointer rows)', async () => {
    const plans = setupProject();
    child(plans, 'billing-a.md', 'archived');
    writeHub(plans, `# Billing

| Plan | Notes |
|---|---|
| [A](billing-a.md) | rowed only to say "related" |
`);
    const { warnings, errors } = await findings();
    deepStrictEqual(hubStatusMessages([...warnings, ...errors]), []);
  });

  it('warns on a row under a status column with no readable status word', async () => {
    const plans = setupProject();
    child(plans, 'billing-a.md', 'active');
    writeHub(plans, `# Billing

| Plan | Status |
|---|---|
| [A](billing-a.md) | **Gate: legal sign-off** then active |
`);
    const { warnings, errors } = await findings();
    strictEqual(errors.length, 0);
    const messages = hubStatusMessages(warnings);
    strictEqual(messages.length, 1);
    match(messages[0], /no status word could be read/);
    match(messages[0], /\*\*Gate: legal sign-off\*\* then active/);
  });

  it('is silent when the printed status agrees with the plan', async () => {
    const plans = setupProject();
    child(plans, 'billing-a.md', 'active');
    writeHub(plans, `# Billing

| Plan | Status |
|---|---|
| [A](billing-a.md) | active — next up, gated on the migration |
`);
    const { warnings, errors } = await findings();
    deepStrictEqual(hubStatusMessages([...warnings, ...errors]), []);
  });
});

describe('drift detection', () => {
  it('warns when the token was inferred and errors when it was marked', async () => {
    const plans = setupProject();
    child(plans, 'billing-a.md', 'archived');
    child(plans, 'billing-b.md', 'active');
    writeHub(plans, `# Billing

| Plan | Status |
|---|---|
| [A](billing-a.md) | active — next up |
| [B](billing-b.md) | <!--s-->planned<!--/s--> — after A |
`);
    const { warnings, errors } = await findings();
    const warned = hubStatusMessages(warnings);
    const errored = hubStatusMessages(errors);
    strictEqual(warned.length, 1);
    match(warned[0], /rows `docs\/plans\/billing-a\.md` as `active`, but that doc's status is `archived`/);
    strictEqual(errored.length, 1);
    match(errored[0], /inside a `<!--s-->…<!--\/s-->` marker/);
    match(errored[0], /that doc's status is `active`/);
  });

  it('resolves the vocabulary from the CHILD\'s type, not the hub\'s', async () => {
    const plans = setupProject();
    // `review` is a doc status and not a plan status. A doc rowed in a plan hub
    // must be read with the doc vocabulary, or the row reads as unreadable.
    writeDoc(path.join(tmpDir, 'docs'), 'design.md', `type: doc
status: reference
title: Design
updated: 2026-08-01`, '# Design\n');
    writeHub(plans, `# Billing

| Doc | Status |
|---|---|
| [Design](../design.md) | review — needs a second pass |
`);
    const { warnings, errors } = await findings();
    strictEqual(errors.length, 0);
    const messages = hubStatusMessages(warnings);
    strictEqual(messages.length, 1);
    match(messages[0], /as `review`, but that doc's status is `reference`/);
  });

  it('lets the archive directory outrank stale frontmatter', async () => {
    const plans = setupProject();
    // Physically archived, frontmatter never caught up (its own error). The hub
    // row should still be told the truth rather than agreeing with the stale word.
    child(path.join(plans, 'archived'), 'billing-a.md', 'active');
    writeHub(plans, `# Billing

| Plan | Status |
|---|---|
| [A](archived/billing-a.md) | active — next up |
`);
    const { warnings } = await findings();
    const messages = hubStatusMessages(warnings);
    strictEqual(messages.length, 1);
    match(messages[0], /but that doc's status is `archived`/);
  });

  it('does not double-report a row whose link target does not exist', async () => {
    const plans = setupProject();
    writeHub(plans, `# Billing

| Plan | Status |
|---|---|
| [Gone](billing-gone.md) | active — next up |
`);
    const { config, docs, warnings, errors } = await findings();
    deepStrictEqual(hubStatusMessages([...warnings, ...errors]), []);
    // The broken link is still reported once, by the body-link check.
    const hub = docs.find(d => d.path.endsWith('billing-runlist.md'));
    ok(hub.warnings.some(w => w.message.includes('billing-gone.md') && w.message.includes('does not resolve')));
    strictEqual(config.repoRoot, tmpDir);
  });

  it('skips hubs whose own status is archived', async () => {
    const plans = setupProject();
    child(plans, 'billing-a.md', 'archived');
    writeDoc(plans, 'old-runlist.md', `type: plan
status: archived
title: Old
execution_mode: coordination
updated: 2026-08-01`, `# Old

| Plan | Status |
|---|---|
| [A](billing-a.md) | active — next up |

## Closeout
n/a
`);
    const { warnings, errors } = await findings();
    deepStrictEqual(hubStatusMessages([...warnings, ...errors]), []);
  });
});

describe('dotmd sync-status', () => {
  it('rewrites drifted rows, preserving case and the rest of the cell', () => {
    const plans = setupProject();
    child(path.join(plans, 'archived'), 'billing-a.md', 'archived');
    child(plans, 'billing-b.md', 'paused');
    const hubPath = writeHub(plans, `# Billing

| Plan | Status |
|---|---|
| [A](archived/billing-a.md) | Active — next up, gated on the migration |
| [B](billing-b.md) | <!--s-->planned<!--/s--> — after A |
`);
    const result = run(['sync-status']);
    strictEqual(result.status, 0, result.stderr);
    const after = readFileSync(path.join(tmpDir, hubPath), 'utf8');
    ok(after.includes('| [A](archived/billing-a.md) | Archived — next up, gated on the migration |'), after);
    ok(after.includes('| [B](billing-b.md) | <!--s-->paused<!--/s--> — after A |'), after);
    // Rewriting is idempotent and leaves the check clean.
    strictEqual(run(['check']).status, 0, run(['check']).stdout);
  });

  it('--dry-run previews without writing', () => {
    const plans = setupProject();
    child(plans, 'billing-a.md', 'archived');
    const hubPath = writeHub(plans, `# Billing

| Plan | Status |
|---|---|
| [A](billing-a.md) | active — next up |
`);
    const before = readFileSync(path.join(tmpDir, hubPath), 'utf8');
    const result = run(['sync-status', '--dry-run']);
    strictEqual(result.status, 0, result.stderr);
    match(result.stdout, /\[dry-run\].*active → archived/s);
    strictEqual(readFileSync(path.join(tmpDir, hubPath), 'utf8'), before);
  });

  it('--adopt wraps a positional token; a plain run never adds markers', () => {
    const plans = setupProject();
    child(plans, 'billing-a.md', 'active');
    const hubPath = writeHub(plans, `# Billing

| Plan | Status |
|---|---|
| [A](billing-a.md) | active — next up |
`);
    run(['sync-status']);
    ok(!readFileSync(path.join(tmpDir, hubPath), 'utf8').includes('<!--s-->'),
      'a token-only sync must not add markers');

    const adopted = run(['sync-status', '--adopt']);
    strictEqual(adopted.status, 0, adopted.stderr);
    ok(readFileSync(path.join(tmpDir, hubPath), 'utf8')
      .includes('| [A](billing-a.md) | <!--s-->active<!--/s--> — next up |'));

    // Adoption is idempotent: an already-marked span is not double-wrapped.
    run(['sync-status', '--adopt']);
    strictEqual(readFileSync(path.join(tmpDir, hubPath), 'utf8').match(/<!--s-->/g).length, 1);
  });

  it('narrows to named hubs and refuses a non-hub argument', () => {
    const plans = setupProject();
    child(plans, 'billing-a.md', 'archived');
    child(plans, 'auth-a.md', 'archived');
    const billing = writeHub(plans, `# Billing

| Plan | Status |
|---|---|
| [A](billing-a.md) | active |
`);
    const auth = writeHub(plans, `# Auth

| Plan | Status |
|---|---|
| [A](auth-a.md) | active |
`, { filename: 'auth-runlist.md' });

    const scoped = run(['sync-status', 'billing-runlist']);
    strictEqual(scoped.status, 0, scoped.stderr);
    ok(readFileSync(path.join(tmpDir, billing), 'utf8').includes('| archived |'));
    ok(readFileSync(path.join(tmpDir, auth), 'utf8').includes('| active |'), 'other hubs untouched');

    const refused = run(['sync-status', 'billing-a']);
    strictEqual(refused.status, 1);
    match(refused.stderr, /is not a hub/);
  });

  it('--json reports the rows it touched', () => {
    const plans = setupProject();
    child(plans, 'billing-a.md', 'archived');
    writeHub(plans, `# Billing

| Plan | Status |
|---|---|
| [A](billing-a.md) | active — next up |
| [A again](billing-a.md) | **later** — unreadable |
`);
    const result = run(['sync-status', '--json', '--dry-run']);
    strictEqual(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout);
    strictEqual(payload.dryRun, true);
    strictEqual(payload.fixed, 1);
    strictEqual(payload.unreadable, 1);
    strictEqual(payload.hubs[0].changes[0].to, 'archived');
  });

  it('is offered as the fixable action for drift, but never for an unreadable cell', async () => {
    const plans = setupProject();
    child(plans, 'billing-b.md', 'active');
    writeHub(plans, `# Billing

| Plan | Status |
|---|---|
| [B](billing-b.md) | <!--s-->planned<!--/s--> — after A |
| [B again](billing-b.md) | **Gate: legal** then active |
`);
    // Marked drift is an error, and `check` prints the fix command for errors.
    const result = run(['check']);
    strictEqual(result.status, 1);
    match(result.stdout, /Fixable actions\n- dotmd sync-status/);

    // An unreadable cell is a warning and is never claimed as auto-fixable —
    // nothing can guess which word in the cell was meant to be the status.
    const { warnings } = await findings();
    const unreadable = warnings.find(w => w.meta?.kind === 'hub-status-unreadable');
    const action = classifyIssueAction(unreadable);
    strictEqual(action.fixable, false);
    match(action.action, /lead the status cell with the status word/);
  });

  it('offers auto-fix only for broken document links, not files or assets', () => {
    const base = { path: 'docs/a.md', message: 'body link `missing` does not resolve', meta: { kind: 'body-link-resolution' } };
    const document = classifyIssueAction({ ...base, meta: { ...base.meta, targetKind: 'document', reason: 'missing' } });
    const file = classifyIssueAction({ ...base, meta: { ...base.meta, targetKind: 'file', reason: 'missing' } });
    const escape = classifyIssueAction({ ...base, meta: { ...base.meta, targetKind: 'document', reason: 'outside-repo' } });
    strictEqual(document.fixable, true);
    strictEqual(document.action, 'dotmd fix-refs --dry-run');
    strictEqual(file.fixable, false);
    match(file.action, /correct the linked file, asset, or directory/);
    strictEqual(escape.fixable, false);
  });

  it('is reachable from `check --fix`', () => {
    const plans = setupProject();
    child(plans, 'billing-a.md', 'archived');
    const hubPath = writeHub(plans, `# Billing

| Plan | Status |
|---|---|
| [A](billing-a.md) | active — next up |
`);
    const result = run(['check', '--fix']);
    ok(readFileSync(path.join(tmpDir, hubPath), 'utf8').includes('| archived — next up |'), result.stdout);
  });
});

describe('markers and moves', () => {
  it('a move rewrites a row link that has a marker beside it', () => {
    const plans = setupProject();
    child(plans, 'billing-a.md', 'active');
    const hubPath = writeHub(plans, `# Billing

| Plan | Status |
|---|---|
| [A](billing-a.md) | <!--s-->active<!--/s--> — next up |
`);
    const result = run(['rename', 'docs/plans/billing-a.md', 'billing-alpha']);
    strictEqual(result.status, 0, result.stderr);
    const after = readFileSync(path.join(tmpDir, hubPath), 'utf8');
    ok(after.includes('(billing-alpha.md)'), after);
    ok(after.includes('<!--s-->active<!--/s-->'), 'the marker survives the move');
  });

  it('never writes a marker that would begin a line', async () => {
    const plans = setupProject();
    child(plans, 'billing-a.md', 'active');
    // A hypothetical "markers on their own line" layout. `reference-planner`
    // returns any line starting with `<!--` unmodified (CommonMark HTML block),
    // so a link sharing such a line would stop being rewritten by moves.
    const body = `# Billing

| Plan | Status |
|---|---|
| [A](billing-a.md) | x |
`;
    const hubPath = writeHub(plans, body);
    const config = await resolveConfig(tmpDir);
    const docs = buildIndex(config, { gitStaleness: false }).docs;
    const collected = collectHubStatusRows(docs, config);
    // Force the span to the start of its line, the shape the guard protects against.
    collected[0].rows[0].span = { start: 0, end: 1, text: 'x', marked: false };
    collected[0].rows[0].state = 'ok';
    collected[0].rows[0].printed = 'x';

    const before = readFileSync(path.join(tmpDir, hubPath), 'utf8');
    const result = syncHubStatuses(config, {
      docs, adopt: true, quiet: true,
      hubPaths: new Set(['docs/plans/billing-runlist.md']),
    });
    strictEqual(result.adopted, 0);
    strictEqual(readFileSync(path.join(tmpDir, hubPath), 'utf8'), before);
  });
});

describe('case-folding filesystems', () => {
  it('matches a row link that differs from the target only by case', async (t) => {
    const plans = setupProject();
    child(plans, 'billing-a.md', 'archived');
    if (!existsSync(path.join(plans, 'BILLING-A.md'))) {
      t.skip('case-sensitive filesystem');
      return;
    }
    writeHub(plans, `# Billing

| Plan | Status |
|---|---|
| [A](BILLING-A.md) | active — next up |
`);
    const { warnings } = await findings();
    const messages = hubStatusMessages(warnings);
    strictEqual(messages.length, 1);
    match(messages[0], /but that doc's status is `archived`/);
  });
});
