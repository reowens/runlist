import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import { addFlag, deriveFlags, flagsFile, flagsHudLine, locateFlag, openFlags, readFlagEvents, resolveAuthor, syncCheckFlags, triageFlag } from '../src/flags.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;
const env = { ...process.env, NO_COLOR: '1', RUNLIST_SESSION_ID: 'test-session-1' };

function run(args) {
  return spawnSync('node', [BIN, ...args], { cwd: tmpDir, encoding: 'utf8', env });
}

function setup(config = '') {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-flags-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), `export const root = 'docs';\n${config}`);
  writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\ntype: doc\nstatus: current\n---\n# A\n\nfirst claim\nsecond claim\n');
  return resolveConfig(tmpDir);
}

const by = { kind: 'person', name: 'tester' };

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('flags', () => {
  it('adds a flag with its place, the line as it read, and its author', async () => {
    const config = await setup();
    const { flag, added } = addFlag(config, { place: 'docs/a.md:8', text: 'second claim contradicts b', severity: 'problem', by });
    ok(added);
    strictEqual(flag.id, 'F1');
    deepStrictEqual([flag.file, flag.line, flag.quote], ['docs/a.md', 8, 'second claim']);
    strictEqual(openFlags(config).length, 1);
  });

  it('merges a repeat of an open flag on the same place, ignoring case and spacing', async () => {
    const config = await setup();
    addFlag(config, { place: 'docs/a.md:8', text: 'Second claim is wrong', by });
    const again = addFlag(config, { place: 'docs/a.md:8', text: 'second  claim is WRONG', by });
    ok(!again.added);
    strictEqual(again.flag.id, 'F1');
    ok(addFlag(config, { place: 'docs/a.md:7', text: 'Second claim is wrong', by }).added);
  });

  it('refuses a missing file, a line past the end and an unknown severity', async () => {
    await setup();
    for (const [args, re] of [
      [['flag', 'add', 'docs/nope.md', 'x'], /No such file/],
      [['flag', 'add', 'docs/a.md:99', 'x'], /there is no line 99/],
      [['flag', 'add', 'docs/a.md', 'x', '--severity', 'huge'], /--severity is one of/],
      [['flag', 'add', 'docs/a.md'], /Usage: runlist flag add/],
    ]) {
      const r = run(args);
      ok(r.status !== 0, args.join(' '));
      match(r.stderr, re);
    }
    ok(!existsSync(path.join(tmpDir, '.runlist', 'flags.jsonl')));
  });

  it('says where the flagged text is now: here, moved, changed or gone', async () => {
    const config = await setup();
    const { flag } = addFlag(config, { place: 'docs/a.md:8', text: 't', by });
    strictEqual(locateFlag(flag, config).status, 'here');
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\ntype: doc\nstatus: current\n---\n# A\n\nnew line\nfirst claim\nsecond claim\n');
    deepStrictEqual(locateFlag(flag, config), { status: 'moved', line: 9 });
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\ntype: doc\nstatus: current\n---\n# A\n\nrewritten\n');
    strictEqual(locateFlag(flag, config).status, 'changed');
    rmSync(path.join(tmpDir, 'docs', 'a.md'));
    strictEqual(locateFlag(flag, config).status, 'gone');
  });

  it('keeps triage as events: accept stays open, reject closes, a closed flag refuses more', async () => {
    const config = await setup();
    addFlag(config, { place: 'docs/a.md', text: 'one', by });
    addFlag(config, { place: 'docs/a.md', text: 'two', by });
    triageFlag(config, { id: 'F1', event: 'accept', note: 'real', by });
    triageFlag(config, { id: 'F2', event: 'reject', by });
    deepStrictEqual(openFlags(config).map(f => [f.id, f.triage]), [['F1', 'accepted']]);
    const r = run(['flag', 'resolve', 'F2']);
    ok(r.status !== 0);
    match(r.stderr, /F2 is already rejected/);
    triageFlag(config, { id: 'F1', event: 'resolve', by });
    strictEqual(openFlags(config).length, 0);
    const events = readFlagEvents(flagsFile(config)).map(e => e.event);
    deepStrictEqual(events, ['add', 'add', 'accept', 'reject', 'resolve']);
  });

  it('lists problems before warnings, newest first within a severity', async () => {
    const config = await setup();
    addFlag(config, { place: 'docs/a.md', text: 'a warning', by });
    addFlag(config, { place: 'docs/a.md', text: 'a problem', severity: 'problem', by });
    addFlag(config, { place: 'docs/a.md', text: 'a note', severity: 'info', by });
    deepStrictEqual(openFlags(config).map(f => f.text), ['a problem', 'a warning', 'a note']);
  });

  it('takes the author from the session, from --by, or from the person', () => {
    deepStrictEqual(resolveAuthor(null, { RUNLIST_SESSION_ID: 's1' }), { kind: 'session', name: 'explicit override', session: 's1' });
    deepStrictEqual(resolveAuthor('check:runlist check', {}), { kind: 'check', name: 'runlist check' });
    strictEqual(resolveAuthor(null, {}).kind, 'person');
  });

  it("a check's flags follow what it reports", async () => {
    const config = await setup();
    const first = syncCheckFlags(config, 'c', [{ file: 'docs/a.md', text: 'broken link' }, { file: 'docs/a.md', text: 'bad status' }]);
    deepStrictEqual(first, { added: 2, resolved: 0 });
    deepStrictEqual(syncCheckFlags(config, 'c', [{ file: 'docs/a.md', text: 'broken link' }, { file: 'docs/a.md', text: 'bad status' }]), { added: 0, resolved: 0 });
    addFlag(config, { place: 'docs/a.md', text: 'a person noticed this', by });
    deepStrictEqual(syncCheckFlags(config, 'c', [{ file: 'docs/a.md', text: 'broken link' }]), { added: 0, resolved: 1 });
    deepStrictEqual(openFlags(config).map(f => f.text).sort(), ['a person noticed this', 'broken link']);
  });

  it('`check --flag` puts check errors on the list and refuses a scoped run', async () => {
    await setup();
    writeFileSync(path.join(tmpDir, 'docs', 'bad.md'), '---\ntype: doc\nstatus: nonsense\n---\n# Bad\n');
    const r = run(['check', '--flag']);
    match(r.stderr, /flags: [1-9]\d* added, 0 resolved/);
    const listed = run(['flags', '--json']);
    const flags = JSON.parse(listed.stdout);
    ok(flags.some(f => f.file === 'docs/bad.md' && f.by.kind === 'check'));
    const scoped = run(['check', 'docs/a.md', '--flag']);
    ok(scoped.status !== 0);
    match(scoped.stderr, /whole repository/);
  });

  it('the session-start line names the open flags, and says nothing when none are open', async () => {
    const config = await setup();
    strictEqual(flagsHudLine(config), null);
    addFlag(config, { place: 'docs/a.md:7', text: 'first claim is stale', severity: 'problem', by });
    match(flagsHudLine(config), /1 open flag, 1 problem, for awareness: F1 docs\/a\.md:7 first claim is stale/);
    const hud = run(['hud']);
    match(hud.stdout, /1 open flag/);
  });

  it('a torn line in the log is skipped, and the file can be moved by config', async () => {
    const config = await setup(`export const flags = { file: 'notes/flags.jsonl' };`);
    addFlag(config, { place: 'docs/a.md', text: 'one', by });
    const file = path.join(tmpDir, 'notes', 'flags.jsonl');
    ok(existsSync(file));
    writeFileSync(file, readFileSync(file, 'utf8') + '{"event":"add","id":\n');
    strictEqual(deriveFlags(readFlagEvents(file)).length, 1);
  });
});
