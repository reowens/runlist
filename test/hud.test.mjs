import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

let tmpDir;
const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-hud-'));
  spawnSync('git', ['init'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(path.join(docsDir, 'archived'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n`);
  // Pre-stamp the primer marker so the default test setup represents a
  // session that's already seen the teach-once primer. Tests that want to
  // exercise the first-session primer should delete this marker explicitly.
  mkdirSync(path.join(tmpDir, '.dotmd'), { recursive: true });
  writeFileSync(path.join(tmpDir, '.dotmd', 'primer-shown'), '');
  return docsDir;
}

function writeDoc(docsDir, filename, frontmatter, body = '') {
  const filePath = path.join(docsDir, filename);
  writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`);
  spawnSync('git', ['add', filePath], { cwd: tmpDir });
  spawnSync('git', ['commit', '-m', `add ${filename}`], { cwd: tmpDir });
  return filePath;
}

function runCli(args, { session = 'sess-A', input } = {}) {
  return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir,
    encoding: 'utf8',
    input,
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: session, PATH: process.env.PATH },
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// HUD contract:
//   - stdout emits the command primer line (the verb cheat-sheet) plus ONLY
//     signals that carry a direct instruction for this session: pending
//     prompts (consume with `dotmd use`) and a journal-attributed in-session
//     plan (continue / hand off with baton). Passive state — error counts,
//     journal chatter, refresh notices — stays suppressed; those nudged
//     agents into phantom follow-up work.
//   - `--json` still returns the structured shape (owned/prompts/errors/
//     journal) for any programmatic caller, and skips the human primer
//   - slash-command staleness is still self-healed, but silently (no stdout)
describe('dotmd hud', () => {
  it('always emits the command primer (one line)', () => {
    setupProject();
    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(/dotmd:/.test(r.stdout), `expected primer line; got: ${r.stdout}`);
    ok(/set <status>/.test(r.stdout), `primer should name the set verb; got: ${r.stdout}`);
    ok(/new <type>/.test(r.stdout), `primer should name the new verb; got: ${r.stdout}`);
    ok(/\buse\b/.test(r.stdout), `primer should name the use verb; got: ${r.stdout}`);
  });

  it('surfaces pending prompts as an actionable instruction; passive state stays suppressed', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'p.md', 'type: plan\nstatus: active\nupdated: 2025-01-01\nmodules: [core]', '# P\n');
    mkdirSync(path.join(docsDir, 'prompts'), { recursive: true });
    writeDoc(docsDir, 'prompts/x.md', 'type: prompt\nstatus: pending\ncreated: 2025-01-01', 'body\n');
    writeDoc(docsDir, 'broken.md', 'type: plan\nstatus: archived\nupdated: 2025-01-01', '# Broken\n');

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    // The handoff loop's last link: the next session MUST be told a prompt is
    // queued, or batons rot unconsumed (the 0.50.0 scrub broke this).
    ok(/1 pending prompt\b/.test(r.stdout), `stdout must announce the pending prompt; got: ${r.stdout}`);
    ok(r.stdout.includes('dotmd use'), `the announcement must name the consume verb; got: ${r.stdout}`);
    ok(r.stdout.includes('docs/prompts/x.md'), `the oldest prompt is named; got: ${r.stdout}`);
    // Passive state stays out — these nudged phantom work.
    ok(!/errors:/.test(r.stdout), `stdout must not mention validation errors; got: ${r.stdout}`);
    ok(!r.stdout.includes('run dotmd check'), `stdout must not point at check; got: ${r.stdout}`);

    // …and the structured shape still carries the state for programmatic callers.
    const j = JSON.parse(runCli(['hud', '--json']).stdout);
    strictEqual(j.prompts.length, 1, 'pending prompt present in --json');
    ok(j.errors >= 1, 'validation errors present in --json');
  });

  it('announces YOUR in-session plan when the journal attributes it to this sid', () => {
    const docsDir = setupProject();
    // Journal must be on for attribution.
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\nexport const journal = true;\n`);
    writeDoc(docsDir, 'mine.md', 'type: plan\nstatus: in-session\nupdated: 2025-01-01', '# Mine\n');
    writeDoc(docsDir, 'theirs.md', 'type: plan\nstatus: in-session\nupdated: 2025-01-01', '# Theirs\n');
    const entry = { ts: '2025-01-02T00:00:00.000Z', sid: 'sess-A', pid: 1, argv: ['use', 'docs/mine.md'], exit: 0, ms: 1, v: '0.0.0' };
    writeFileSync(path.join(tmpDir, '.dotmd', 'journal.jsonl'), JSON.stringify(entry) + '\n');

    const r = runCli(['hud'], { session: 'sess-A' });
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(r.stdout.includes('in-session (yours): docs/mine.md'), `owned plan announced; got: ${r.stdout}`);
    ok(r.stdout.includes('dotmd baton'), `handoff verb named; got: ${r.stdout}`);

    // A different session sees no owned line — and crucially, the
    // single-in-session fallback must NOT print at SessionStart (that plan
    // likely belongs to another live session).
    const other = runCli(['hud'], { session: 'sess-B' });
    ok(!other.stdout.includes('in-session (yours)'), `no owned line for an unattributed sid; got: ${other.stdout}`);
  });

  it('stays prompt-silent when nothing is pending', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'p.md', 'type: plan\nstatus: active\nupdated: 2025-01-01\nmodules: [core]', '# P\n');
    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(!/\d+ pending prompt/.test(r.stdout), `no pending-prompt line when queue is empty; got: ${r.stdout}`);
    ok(!/in-session \(yours\)/.test(r.stdout), `no owned line without journal attribution; got: ${r.stdout}`);
  });

  it('--json still exposes structured state for programmatic callers', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'p.md', 'type: plan\nstatus: active\nupdated: 2025-01-01\nmodules: [core]', '# P\n');

    const r = runCli(['hud', '--json']);
    strictEqual(r.status, 0, `hud --json failed: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    ok(Array.isArray(parsed.prompts), '.prompts is an array');
    strictEqual(typeof parsed.errors, 'number', '.errors is a number');
  });

  it('--json skips the human primer (structured output stays stable)', () => {
    setupProject();
    const r = runCli(['hud', '--json']);
    strictEqual(r.status, 0, `hud --json failed: ${r.stderr}`);
    ok(!r.stdout.includes('dotmd:'), 'no primer text in JSON output');
    JSON.parse(r.stdout); // should parse clean
  });

  it('removes retired generated slash-command files silently (no notice in stdout)', () => {
    setupProject();
    const cmdDir = path.join(tmpDir, '.claude', 'commands');
    mkdirSync(cmdDir, { recursive: true });
    const generatedPath = path.join(cmdDir, 'plans.md');
    const userPath = path.join(cmdDir, 'baton.md');
    writeFileSync(generatedPath, '---\ndescription: x\n---\n<!-- dotmd-generated: 0.0.1 -->\nstale body\n');
    writeFileSync(userPath, '---\ndescription: hand-written\n---\n# no banner\n');

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(!/slash commands|removed|cleaned/i.test(r.stdout), `cleanup must be silent; got: ${r.stdout}`);
    ok(/dotmd:/.test(r.stdout), `primer line should still emit; got: ${r.stdout}`);

    // The cleanup side effect still runs: the retired generated file is deleted,
    // the hand-authored one is left untouched.
    ok(!existsSync(generatedPath), 'retired generated file should be removed');
    ok(existsSync(userPath), 'hand-authored command must survive');
  });

  it('does not touch user-managed slash-command files (no banner)', () => {
    setupProject();
    const cmdDir = path.join(tmpDir, '.claude', 'commands');
    mkdirSync(cmdDir, { recursive: true });
    const customPath = path.join(cmdDir, 'plans.md');
    const original = '# my hand-rolled plans, no dotmd marker\n';
    writeFileSync(customPath, original);

    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(!/slash commands refreshed/.test(r.stdout), `should not announce refresh for user files; got: ${r.stdout}`);
    strictEqual(readFileSync(customPath, 'utf8'), original, 'user file untouched');
  });

  it('survives missing .claude/ directory without erroring', () => {
    setupProject();
    ok(!existsSync(path.join(tmpDir, '.claude')), 'precondition: no .claude/');
    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(/dotmd:/.test(r.stdout), `primer should still emit; got: ${r.stdout}`);
  });

  it('--json error count remains parity with `dotmd check --json`', () => {
    // Even though stdout no longer prints the error count, the --json shape
    // still surfaces .errors for programmatic callers. Contract: it equals
    // what `dotmd check --json` reports.
    function errorCount(json) { return JSON.parse(json).errors ?? 0; }
    function checkErrorCount(json) { return (JSON.parse(json).errors ?? []).length; }

    const docsDir = setupProject();
    writeDoc(docsDir, 'plan-a.md', 'type: plan\nstatus: active\nupdated: 2025-01-01\nmodules: [core]', '# A\n');
    let hudJson = runCli(['hud', '--json']);
    let checkJson = runCli(['check', '--json']);
    strictEqual(errorCount(hudJson.stdout), checkErrorCount(checkJson.stdout), 'clean-repo parity');
    strictEqual(errorCount(hudJson.stdout), 0, 'clean repo: 0 errors');

    writeDoc(docsDir, 'broken.md', 'type: plan\nstatus: archived\nupdated: 2025-01-01', '# Broken\n');
    hudJson = runCli(['hud', '--json']);
    checkJson = runCli(['check', '--json']);
    strictEqual(errorCount(hudJson.stdout), checkErrorCount(checkJson.stdout), 'archive-drift parity');
    ok(errorCount(hudJson.stdout) >= 1, 'archive drift counted');
  });

  it('stdout stays bounded (O(1)) regardless of repo state', () => {
    const docsDir = setupProject();
    for (let i = 0; i < 5; i++) {
      writeDoc(docsDir, `held-${i}.md`, 'type: plan\nstatus: active\nupdated: 2025-01-01', '# held\n');
      runCli(['pickup', `held-${i}.md`]);
    }
    mkdirSync(path.join(docsDir, 'prompts'), { recursive: true });
    // The pending-prompt line must name only the oldest + a count — never the
    // whole queue — so output size is independent of how many are pending.
    for (let i = 0; i < 25; i++) {
      writeDoc(docsDir, `prompts/p-${i}.md`, 'type: prompt\nstatus: pending\ncreated: 2025-01-01', 'body\n');
    }
    const r = runCli(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(r.stdout.length < 700, `hud output too large: ${r.stdout.length} bytes\n${r.stdout}`);
    ok(/25 pending prompts/.test(r.stdout), `count announced; got: ${r.stdout}`);
  });

  // The plugin's SessionStart/SubagentStart hooks fire in every repo. In a repo
  // with no dotmd config, the primer is irrelevant noise — hud must stay silent.
  it('is silent in a repo with no dotmd config (primer + subagent)', () => {
    const bare = mkdtempSync(path.join(os.tmpdir(), 'dotmd-nocfg-'));
    try {
      const run = (args) => spawnSync('node', [bin, ...args], { cwd: bare, encoding: 'utf8' });
      const r = run(['hud']);
      strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
      strictEqual(r.stdout, '', `expected silent hud in non-dotmd repo, got: ${r.stdout}`);
      const s = run(['hud', '--subagent']);
      strictEqual(s.status, 0, `hud --subagent failed: ${s.stderr}`);
      strictEqual(s.stdout, '', `expected silent subagent primer in non-dotmd repo, got: ${s.stdout}`);
      // --json still returns a structured shape for programmatic callers.
      const j = run(['hud', '--json']);
      strictEqual(j.status, 0, `hud --json failed: ${j.stderr}`);
      ok(j.stdout.trim().startsWith('{'), `--json should still emit a shape, got: ${j.stdout}`);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

});

// Phase 3 of plan b5: repeat guard offenses in THIS repo surface as one
// teaching line at SessionStart. Threshold 3 hits on one rule in 7 days.
describe('hud misuse recap', () => {
  let logDir;

  function runCliWithLog(args) {
    return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
      cwd: tmpDir,
      encoding: 'utf8',
      env: { ...process.env, DOTMD_ERROR_LOG_DIR: logDir, PATH: process.env.PATH },
    });
  }

  function writeMisuseLog(entries) {
    logDir = path.join(tmpDir, 'logs');
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, 'dotmd-misuse.log'),
      entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  }

  function entry(rule, { repo = tmpDir, daysAgo = 0 } = {}) {
    return {
      ts: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
      repo, rule, decision: 'warn', tool: 'Edit', detail: 'x.md',
    };
  }

  it('surfaces a repeat-offense rule (>=3 hits in 7 days) as one primer line', () => {
    setupProject();
    writeMisuseLog([entry('edit-status'), entry('edit-status', { daysAgo: 1 }), entry('edit-status', { daysAgo: 2 }), entry('cat-prompt')]);
    const r = runCliWithLog(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(r.stdout.includes('tripped edit-status 3×'), `expected recap line, got: ${r.stdout}`);
    ok(r.stdout.includes('dotmd set'), `recap should carry the corrective verb, got: ${r.stdout}`);
  });

  it('stays silent under the threshold', () => {
    setupProject();
    writeMisuseLog([entry('edit-status'), entry('edit-status', { daysAgo: 1 })]);
    const r = runCliWithLog(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(!r.stdout.includes('tripped'), `expected no recap under threshold, got: ${r.stdout}`);
  });

  it('ignores hits older than 7 days and hits from other repos', () => {
    setupProject();
    writeMisuseLog([
      entry('edit-status', { daysAgo: 9 }), entry('edit-status', { daysAgo: 10 }), entry('edit-status', { daysAgo: 11 }),
      entry('cat-prompt', { repo: '/somewhere/else' }), entry('cat-prompt', { repo: '/somewhere/else' }), entry('cat-prompt', { repo: '/somewhere/else' }),
    ]);
    const r = runCliWithLog(['hud']);
    strictEqual(r.status, 0, `hud failed: ${r.stderr}`);
    ok(!r.stdout.includes('tripped'), `stale/foreign hits must not recap, got: ${r.stdout}`);
  });

  it('--json carries misuseRecap', () => {
    setupProject();
    writeMisuseLog([entry('cat-prompt'), entry('cat-prompt'), entry('cat-prompt'), entry('cat-prompt')]);
    const j = JSON.parse(runCliWithLog(['hud', '--json']).stdout);
    ok(j.misuseRecap.includes('cat-prompt 4×'), `expected recap in json, got: ${JSON.stringify(j.misuseRecap)}`);
    ok(j.misuseRecap.includes('dotmd use'), `expected corrective verb, got: ${JSON.stringify(j.misuseRecap)}`);
  });
});
