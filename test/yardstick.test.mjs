import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import { readYardstick, compareYardstick, renderYardstick } from '../src/yardstick.mjs';
import { runYardstick } from '../src/yardstick-command.mjs';
import { buildCard, renderCard } from '../src/pickup-card.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from '../src/frontmatter.mjs';
import { runArchive } from '../src/lifecycle.mjs';
import { buildIndex } from '../src/index.mjs';
import { sanitizeTelemetryArgv } from '../src/journal.mjs';

const projects = [];
const quiet = { write() {} };
const bin = path.resolve(import.meta.dirname, '../bin/runlist.mjs');
afterEach(() => { for (const root of projects.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function project({ goal = '# Product goal\n\nKeep project documents useful and easy to find.\n', setting = "'docs/goal.md'", extraConfig = '' } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runlist-yardstick-'));
  projects.push(root);
  mkdirSync(path.join(root, 'docs/plans'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: root });
  writeFileSync(path.join(root, 'runlist.config.mjs'), `export const root = 'docs';\nexport const yardstick = ${setting};\n${extraConfig}`);
  if (goal !== null) writeFileSync(path.join(root, 'docs/goal.md'), goal);
  const config = await resolveConfig(root);
  return { root, config, goalFile: path.join(root, 'docs/goal.md') };
}

function plan(p, name = 'a', fields = '', body = '# Plan\n\nKeep this body.\n') {
  const file = path.join(p.root, `docs/plans/${name}.md`);
  writeFileSync(file, `---\ntype: plan\nstatus: planned\nupdated: 2026-10-09\n${fields}---\n${body}`);
  return file;
}
function fm(file) { return parseSimpleFrontmatter(extractFrontmatter(readFileSync(file, 'utf8')).frontmatter); }
function call(p, argv, opts = {}) { return runYardstick([...argv, '--no-index'], p.config, { out: quiet, ...opts }); }
function cli(p, argv, session = 'yardstick-owner') {
  return spawnSync(process.execPath, [bin, ...argv], { cwd: p.root, encoding: 'utf8', env: {
    ...process.env, CODEX_THREAD_ID: session, CODEX_SESSION_ID: session, CLAUDE_CODE_SESSION_ID: session,
  } });
}

test('opt-out is quiet, while the plan delivery is still visible', async () => {
  const p = await project({ setting: 'null' });
  const file = plan(p, 'a', 'delivers: Find documents quickly.\n');
  assert.equal(readYardstick(p.config).state, 'disabled');
  const card = buildCard(file, readFileSync(file, 'utf8'), p.config);
  assert.equal(card.yardstick, null);
  assert.match(renderCard(card), /This plan delivers: Find documents quickly/);
});

test('literal body excludes goal metadata; revisions ignore frontmatter and CRLF', async () => {
  const p = await project({ goal: '---\ntype: doc\nupdated: yesterday\nprivate_note: not for the card\n---\n# Goal\n\nFind docs.\n' });
  const first = readYardstick(p.config);
  assert.equal(first.state, 'ready');
  assert.doesNotMatch(JSON.stringify(first), /private_note|expectedContent|yesterday/);
  writeFileSync(p.goalFile, readFileSync(p.goalFile, 'utf8').replace('yesterday', 'today').replace(/\n/g, '\r\n'));
  assert.equal(readYardstick(p.config).revision, first.revision);
  writeFileSync(p.goalFile, '# Goal\n\nEdit docs.\n');
  const compared = compareYardstick({ yardstick_disposition: 'serves', yardstick_revision: first.revision }, p.config);
  assert.equal(compared.assessment.reviewedEarlierGoal, true);
  assert.match(renderYardstick(compared), /earlier goal/);
});

test('missing, empty, malformed, oversized and invalid goal sources are explicit', async () => {
  for (const [goal, expected] of [[null, /ENOENT/], ['', /empty/], ['---\ntype: doc\nnot closed', /malformed/], ['x'.repeat(1024 * 1024 + 1), /1 MiB/]]) {
    const p = await project({ goal });
    const result = readYardstick(p.config);
    assert.equal(result.state, 'unavailable');
    assert.match(result.message, expected);
  }
  const p = await project({ setting: 'true' });
  assert.match(readYardstick(p.config).message, /repository-relative Markdown/);
  assert.ok(p.config.configWarnings.some(w => w.includes('yardstick')));
});

test('goal reader rejects repository escapes and saved prompts', async () => {
  const p = await project();
  const outside = await project();
  rmSync(p.goalFile);
  symlinkSync(outside.goalFile, p.goalFile);
  assert.equal(readYardstick(p.config).state, 'unavailable');
  assert.match(readYardstick(p.config).message, /inside this repository/);
  rmSync(p.goalFile);
  writeFileSync(p.goalFile, '---\ntype: prompt\nstatus: pending\n---\nPrivate prompt.\n');
  assert.match(readYardstick(p.config).message, /saved prompt/);
});

test('show is read-only JSON and cards visibly bound long literal content', async () => {
  const p = await project({ goal: 'Long goal '.repeat(100) });
  const file = plan(p, 'a', 'delivers: |\n  First line.\n  Second line.\n');
  const before = readFileSync(file, 'utf8');
  const shown = cli(p, ['yardstick', 'show', file, '--json']);
  assert.equal(shown.status, 0, shown.stderr);
  const result = JSON.parse(shown.stdout);
  assert.equal(result.delivers, 'First line.\nSecond line.');
  assert.equal(result.assessment.disposition, null);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.match(renderCard(buildCard(file, before, p.config)), /shortened; read the source/);
  const used = cli(p, ['use', file, '--json', '--no-index']);
  assert.equal(used.status, 0, used.stderr);
  assert.equal(JSON.parse(used.stdout).card.yardstick.goal.state, 'ready');
});

test('serves and clear preserve execution status, unrelated fields and content', async () => {
  const p = await project();
  const file = plan(p, 'a', 'description: |\n  Keep this text.\ncustom: yes\n');
  const reason = 'Owner says "useful": keeps \\ paths\nand detail.';
  await call(p, ['mark', file, 'serves', '--reason', reason]);
  assert.equal(fm(file).status, 'planned');
  assert.equal(fm(file).yardstick_reason, reason);
  assert.equal(fm(file).description, 'Keep this text.');
  assert.match(readFileSync(file, 'utf8'), /Keep this body/);
  await call(p, ['clear', file]);
  assert.equal(fm(file).yardstick_disposition, undefined);
  assert.equal(fm(file).status, 'planned');
  assert.equal(fm(file).custom, 'yes');
  assert.match(readFileSync(file, 'utf8'), /assessment cleared/);
});

test('close archives and records the assessment in the same tracked move', async () => {
  const p = await project();
  const file = plan(p);
  spawnSync('git', ['add', '.'], { cwd: p.root });
  spawnSync('git', ['commit', '-qm', 'Synthetic corpus'], { cwd: p.root });
  const result = await call(p, ['close', file, '--reason', 'Not needed for the goal.']);
  assert.equal(existsSync(file), false);
  const archived = path.join(p.root, result.path);
  assert.equal(fm(archived).status, 'archived');
  assert.equal(fm(archived).yardstick_disposition, 'closed');
  assert.match(readFileSync(archived, 'utf8'), /Not needed for the goal/);
  assert.match(spawnSync('git', ['status', '--short'], { cwd: p.root, encoding: 'utf8' }).stdout, /docs\/archived\/a.md/);
  await call(p, ['clear', archived]);
  assert.equal(fm(archived).status, 'archived');
  assert.equal(existsSync(file), false);
});

test('a close preview can heal archive-status drift in place', async () => {
  const p = await project();
  mkdirSync(path.join(p.root, 'docs/archived'));
  const file = path.join(p.root, 'docs/archived/drift.md');
  writeFileSync(file, '---\ntype: plan\nstatus: active\n---\n# Archived path\n');
  const before = readFileSync(file, 'utf8');
  const preview = await call(p, ['close', file, '--reason', 'No longer needed.'], { dryRun: true });
  assert.equal(preview.path, 'docs/archived/drift.md');
  assert.match(preview.lifecycle, /heal frontmatter in place/);
  assert.equal(readFileSync(file, 'utf8'), before);
  await call(p, ['close', file, '--reason', 'No longer needed.'], { expectedDestination: file });
  assert.equal(fm(file).status, 'archived');
  assert.equal(fm(file).yardstick_disposition, 'closed');
});

test('fold retains and repairs its replacement link with custom reference lists', async () => {
  const p = await project({ extraConfig: "export const referenceFields = { bidirectional: [], unidirectional: ['custom_ref'] };\n" });
  const source = plan(p);
  const target = plan(p, 'b');
  const folded = await call(p, ['fold', source, '--into', target, '--reason', 'Combined work.']);
  const archived = path.join(p.root, folded.path);
  assert.equal(fm(archived).yardstick_disposition, 'folded');
  assert.equal(path.resolve(path.dirname(archived), fm(archived).yardstick_into), target);
  const movedTarget = runArchive([target, '--no-index'], p.config, { out: quiet });
  assert.equal(path.resolve(path.dirname(archived), fm(archived).yardstick_into), path.join(p.root, movedTarget.newRepoPath));
});

test('invalid enum, missing reason, nonplan and missing/outside/self/cyclic targets do not write', async () => {
  const p = await project();
  const source = plan(p);
  const before = readFileSync(source, 'utf8');
  await assert.rejects(call(p, ['mark', source, 'closed']), /explicit archive actions/);
  await assert.rejects(call(p, ['close', source]), /--reason/);
  await assert.rejects(call(p, ['fold', source, '--reason', 'Merge']), /--into/);
  await assert.rejects(call(p, ['fold', source, '--into', source, '--reason', 'Merge']), /itself|circular/);
  await assert.rejects(call(p, ['fold', source, '--into', 'missing', '--reason', 'Merge']), /not found/);
  const target = plan(p, 'b', 'yardstick_disposition: folded\nyardstick_into: ./a.md\n');
  await assert.rejects(call(p, ['fold', source, '--into', target, '--reason', 'Merge']), /circular/);
  const outside = await project();
  await assert.rejects(call(p, ['fold', source, '--into', plan(outside), '--reason', 'Merge']), /roots|outside/);
  await assert.rejects(call(p, ['close', p.goalFile, '--reason', 'No']), /only to plans/);
  assert.equal(readFileSync(source, 'utf8'), before);
});

test('dry-run changes neither plan bytes nor Git staging', async () => {
  const p = await project();
  const source = plan(p);
  const target = plan(p, 'b');
  const before = readFileSync(source, 'utf8');
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: p.root, encoding: 'utf8' }).stdout;
  for (const argv of [['mark', source, 'serves'], ['close', source, '--reason', 'No'], ['fold', source, '--into', target, '--reason', 'Combined'], ['clear', source]]) {
    assert.equal((await call(p, argv, { dryRun: true })).dryRun, true);
    assert.equal(readFileSync(source, 'utf8'), before);
  }
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: p.root, encoding: 'utf8' }).stdout, status);
});

test('missing goal prevents assessments, but clear remains possible', async () => {
  const p = await project();
  const file = plan(p);
  await call(p, ['mark', file, 'serves']);
  rmSync(p.goalFile);
  const before = readFileSync(file, 'utf8');
  await assert.rejects(call(p, ['close', file, '--reason', 'No']), /unavailable/);
  assert.equal(readFileSync(file, 'utf8'), before);
  await call(p, ['clear', file]);
  assert.equal(fm(file).yardstick_disposition, undefined);
});

test('other-session ownership blocks both serves and archival actions', async () => {
  const p = await project();
  const file = plan(p);
  const claimed = cli(p, ['use', file, '--no-index'], 'owner-one');
  assert.equal(claimed.status, 0, claimed.stderr);
  const before = readFileSync(file, 'utf8');
  for (const argv of [['mark', file, 'serves'], ['close', file, '--reason', 'No']]) {
    const denied = cli(p, ['yardstick', ...argv, '--no-index'], 'owner-two');
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, /busy|owned|another/i);
    assert.equal(readFileSync(file, 'utf8'), before);
  }
});

test('archive failures roll back the assessment and source move together', async () => {
  const p = await project();
  const file = plan(p);
  const before = readFileSync(file, 'utf8');
  await assert.rejects(call(p, ['close', file, '--reason', 'No'], { testHooks: {
    afterSourceMove() { throw new Error('injected archive failure'); },
  } }), /injected archive failure/);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.equal(existsSync(path.join(p.root, 'docs/archived/a.md')), false);
});

test('goal, plan and replacement changes during archive preparation fail without an assessment', async () => {
  for (const changed of ['goal', 'source', 'target']) {
    const p = await project();
    const file = plan(p);
    const target = plan(p, 'b');
    const before = readFileSync(file, 'utf8');
    const altered = changed === 'goal' ? p.goalFile : changed === 'source' ? file : target;
    await assert.rejects(call(p, ['fold', file, '--into', target, '--reason', 'Combined'], { testHooks: {
      beforeMoveSnapshot() { writeFileSync(altered, readFileSync(altered, 'utf8') + '\nPeer change.\n'); },
    } }), /changed while/);
    assert.equal(fm(file).yardstick_disposition, undefined);
    assert.equal(readFileSync(file, 'utf8'), changed === 'source' ? before + '\nPeer change.\n' : before);
  }
});

test('an archived assessment can be reviewed again without a second move', async () => {
  const p = await project();
  const first = await call(p, ['close', plan(p), '--reason', 'No']);
  const archived = path.join(p.root, first.path);
  writeFileSync(p.goalFile, 'A changed product goal.\n');
  assert.equal(compareYardstick(fm(archived), p.config, readYardstick(p.config), true).assessment.reviewedEarlierGoal, true);
  const reviewed = await call(p, ['close', archived, '--reason', 'Still not needed.']);
  assert.equal(reviewed.path, first.path);
  assert.equal(reviewed.comparison.assessment.reviewedEarlierGoal, false);
});

test('check reports inconsistent authored assessments without closing or hiding a plan', async () => {
  const p = await project();
  const file = plan(p, 'a', `yardstick_disposition: closed\nyardstick_reason: No\nyardstick_revision: ${readYardstick(p.config).revision}\n`);
  const idx = buildIndex(p.config, { gitStaleness: false });
  assert.ok(idx.warnings.some(w => /inconsistent with a live plan/.test(w.message)));
  assert.ok(idx.docs.some(doc => doc.path === 'docs/plans/a.md'));
  assert.equal(fm(file).status, 'planned');
});

test('reason text is redacted from global telemetry', () => {
  assert.deepEqual(sanitizeTelemetryArgv(['yardstick', 'close', 'a.md', '--reason', 'Private owner context']),
    ['yardstick', 'close', 'a.md', '--reason', '[redacted]']);
});

test('CLI write JSON stays parseable, and preview exposes the reason and planned move', async () => {
  const p = await project();
  const file = plan(p);
  const before = readFileSync(file, 'utf8');
  const preview = cli(p, ['yardstick', 'close', file, '--reason', 'Owner chose to drop it.', '--dry-run', '--no-index']);
  assert.equal(preview.status, 0, preview.stderr);
  assert.match(preview.stdout, /Would move/);
  assert.match(preview.stdout, /Owner chose to drop it/);
  assert.equal(readFileSync(file, 'utf8'), before);
  const committed = cli(p, ['yardstick', 'close', file, '--reason', 'Owner chose to drop it.', '--json', '--no-index']);
  assert.equal(committed.status, 0, committed.stderr);
  const result = JSON.parse(committed.stdout);
  assert.equal(result.comparison.assessment.disposition, 'closed');
  assert.match(result.lifecycle, /Archived/);
});

test('the owning session can close its plan and release its claim normally', async () => {
  const p = await project();
  const file = plan(p);
  assert.equal(cli(p, ['use', file, '--no-index']).status, 0);
  const closed = cli(p, ['yardstick', 'close', file, '--reason', 'Owner chose closure.', '--no-index', '--json']);
  assert.equal(closed.status, 0, closed.stderr);
  const result = JSON.parse(closed.stdout);
  assert.equal(result.comparison.assessment.disposition, 'closed');
  assert.equal(fm(path.join(p.root, result.path)).status, 'archived');
  assert.equal(existsSync(file), false);
});

test('an assessment cannot archive its own configured goal through a file alias', async () => {
  const p = await project({ goal: '---\ntype: plan\nstatus: planned\nupdated: 2026-10-09\n---\n# Goal\n\nKeep docs useful.\n' });
  const alias = path.join(p.root, 'docs/plans/goal-alias.md');
  symlinkSync(p.goalFile, alias);
  const before = readFileSync(p.goalFile, 'utf8');
  await assert.rejects(call(p, ['close', p.goalFile, '--reason', 'No']), /cannot assess or archive itself/);
  await assert.rejects(call(p, ['close', alias, '--reason', 'No']), /may not be a symlink/);
  rmSync(alias);
  linkSync(p.goalFile, alias);
  await assert.rejects(call(p, ['close', alias, '--reason', 'No']), /cannot assess or archive itself/);
  assert.equal(readFileSync(p.goalFile, 'utf8'), before);
});
