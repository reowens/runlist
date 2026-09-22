import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { insertDecision, nextDecisionId } from '../src/decision.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function run(args, opts = {}) {
  return spawnSync('node', [BIN, ...args], { cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' }, ...opts });
}

function setup(config = '') {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-decision-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), `export const root = ['docs/plans', 'docs'];\n${config}`);
}

function plan(name, body) {
  const file = path.join(tmpDir, 'docs', 'plans', `${name}.md`);
  writeFileSync(file, `---\ntype: plan\nstatus: planned\nupdated: 2025-01-01T00:00:00Z\n---\n# ${name}\n\n${body}`);
  return file;
}

function record(text = 'The widget shelf is empty today. It lives in `src/shelf.ts:4`. Yes: the shelf fills. No: it stays empty.') {
  const file = path.join(tmpDir, 'record.md');
  writeFileSync(file, `${text}\n`);
  return `@${file}`;
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('nextDecisionId', () => {
  it('follows the highest id of the prefix the text mentions', () => {
    strictEqual(nextDecisionId('### D2 a\n\nsee D9 in another plan\n### D4 b', 'D'), 'D10');
  });
  it('starts at 1 and ignores ids inside fences and other prefixes', () => {
    strictEqual(nextDecisionId('```\nD40\n```\nP7 and DD3 and D12x', 'D'), 'D1');
  });
});

describe('insertDecision', () => {
  const entry = { id: 'D3', question: 'Which way?', disposition: 'open', record: 'Record.' };

  it('appends after the last line of the top-level decisions section, subsections included', () => {
    const body = '## Decisions\n\n### D1 x\n\nOne.\n\n### D2 y\n\nTwo.\n\n## Next\n\nMore.\n';
    const out = insertDecision(body, entry);
    strictEqual(out.body, '## Decisions\n\n### D1 x\n\nOne.\n\n### D2 y\n\nTwo.\n\n### D3  Which way?\n\nDisposition: OPEN.\n\nRecord.\n\n## Next\n\nMore.\n');
  });

  it('leaves a decisions heading nested in a workstream alone and adds a section before Version History', () => {
    const body = '## A\n\n### Decisions ruled\n\n- D1 done\n\n## Version History\n\n- x\n';
    const out = insertDecision(body, entry);
    match(out.body, /## A\n\n### Decisions ruled\n\n- D1 done\n\n## Decisions\n\n### D3  Which way\?\n\nDisposition: OPEN\.\n\nRecord\.\n\n## Version History/);
  });

  it('adds the section at the end when there is nowhere better', () => {
    const out = insertDecision('## Problem\n\nText.\n', entry);
    strictEqual(out.body, '## Problem\n\nText.\n\n## Decisions\n\n### D3  Which way?\n\nDisposition: OPEN.\n\nRecord.\n');
  });
});

describe('runlist new decision', () => {
  it('writes the next entry into the plan and bumps updated', () => {
    setup();
    const file = plan('widgets', '## Decisions\n\n### D1  First? RULED 2025-01-02.\n\nDone.\n');
    const r = run(['new', 'decision', 'widgets', '--question', 'Does the shelf fill?', record()]);
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /Added D2 to docs\/plans\/widgets\.md/);
    const text = readFileSync(file, 'utf8');
    match(text, /### D2  Does the shelf fill\?\n\nDisposition: OPEN\.\n\nThe widget shelf is empty today\./);
    ok(!text.includes('updated: 2025-01-01T00:00:00Z'));
  });

  it('takes --disposition held and refuses anything else', () => {
    setup();
    const file = plan('widgets', '');
    strictEqual(run(['new', 'decision', 'widgets', '--question', 'Q?', '--disposition', 'held', record()]).status, 0);
    match(readFileSync(file, 'utf8'), /### D1  Q\?\n\nDisposition: HELD\./);
    const bad = run(['new', 'decision', 'widgets', '--question', 'Q?', '--disposition', 'ruled', record()]);
    ok(bad.status !== 0);
    match(bad.stderr, /open or held/);
  });

  it('refuses without a question or a record, and writes nothing', () => {
    setup();
    const file = plan('widgets', '## Decisions\n');
    const before = readFileSync(file, 'utf8');
    const noQuestion = run(['new', 'decision', 'widgets', record()]);
    ok(noQuestion.status !== 0);
    match(noQuestion.stderr, /--question is required/);
    const noRecord = run(['new', 'decision', 'widgets', '--question', 'Q?'], { input: '' });
    ok(noRecord.status !== 0);
    match(noRecord.stderr, /needs its record/);
    strictEqual(readFileSync(file, 'utf8'), before);
  });

  it('dry-run names the id and place and writes nothing', () => {
    setup();
    const file = plan('widgets', '## Decisions\n');
    const before = readFileSync(file, 'utf8');
    const r = run(['new', 'decision', 'widgets', '--question', 'Q?', record(), '-n']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /Would add D1 to docs\/plans\/widgets\.md under `Decisions`/);
    strictEqual(readFileSync(file, 'utf8'), before);
  });

  it('uses the prefix and heading from config', () => {
    setup(`export const decisions = { prefix: 'Q', section: 'Open questions' };`);
    const file = plan('widgets', '## Problem\n\nText.\n');
    strictEqual(run(['new', 'decision', 'widgets', '--question', 'Q?', record()]).status, 0);
    match(readFileSync(file, 'utf8'), /## Open questions\n\n### Q1  Q\?\n\nDisposition: OPEN\./);
  });

  it('refuses a plan that does not exist', () => {
    setup();
    const r = run(['new', 'decision', 'nope', '--question', 'Q?', record()]);
    ok(r.status !== 0);
    match(r.stderr, /No such plan: nope/);
  });
});

describe('runlist new hub and unknown types', () => {
  it('`new hub` makes a coordination hub plan', () => {
    setup();
    const r = run(['new', 'hub', 'platform']);
    strictEqual(r.status, 0, r.stderr);
    const text = readFileSync(path.join(tmpDir, 'docs', 'plans', 'platform.md'), 'utf8');
    match(text, /type: plan/);
    match(text, /execution_mode: coordination/);
  });

  it('`new hub --roadmap` makes a roadmap hub', () => {
    setup();
    strictEqual(run(['new', 'hub', 'q3', '--roadmap']).status, 0);
    match(readFileSync(path.join(tmpDir, 'docs', 'plans', 'q3.md'), 'utf8'), /execution_mode: roadmap/);
  });

  it('refuses an unknown type followed by a slug, and creates nothing', () => {
    setup();
    const r = run(['new', 'decison', 'foo']);
    ok(r.status !== 0);
    match(r.stderr, /Unknown type `decison`/);
    match(r.stderr, /runlist new doc decison "foo"/);
    ok(!readdirSync(path.join(tmpDir, 'docs')).includes('decison.md'));
  });

  it('still takes a name and a multi-word inline body with the type left out', () => {
    setup();
    const r = run(['new', 'notes', 'some inline body']);
    strictEqual(r.status, 0, r.stderr);
    ok(existsSync(path.join(tmpDir, 'docs', 'plans', 'notes.md')) || existsSync(path.join(tmpDir, 'docs', 'notes.md')));
  });
});
