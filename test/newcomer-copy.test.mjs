import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const bin = path.join(root, 'bin', 'runlist.mjs');
const read = file => readFileSync(path.join(root, file), 'utf8');

function frontmatter(file) {
  const match = read(file).match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `${file} has frontmatter`);
  return Object.fromEntries(match[1].split('\n').map(line => {
    const i = line.indexOf(':');
    return [line.slice(0, i), line.slice(i + 1).trim().replace(/^"|"$/g, '')];
  }));
}

function quickPath() {
  const readme = read('README.md');
  const start = readme.indexOf('## Handoffs in 3 steps');
  return readme.slice(start, readme.indexOf('\n## Install\n', start));
}

test('slash commands keep a short description and carry activation phrases in when_to_use', () => {
  const triggers = {
    baton: ['baton', 'save where we are', 'wrap up', 'hand off', 'pick it up next time', 'context is getting tight'],
    pickup: ['pick up where we left off', 'where were we', 'resume my handoff'],
    plans: ['plan'],
    docs: ['ADR'],
    prompts: ['handoff'],
  };
  for (const [name, phrases] of Object.entries(triggers)) {
    const fm = frontmatter(`plugins/runlist/commands/${name}.md`);
    assert.ok(fm.when_to_use, `${name}: when_to_use is set`);
    assert.ok(fm.description.length <= 110, `${name}: description stays a user-facing summary`);
    assert.doesNotMatch(fm.description, /Use when/, `${name}: triggers live in when_to_use, not description`);
    assert.ok((fm.description + fm.when_to_use).length < 1536, `${name}: combined text fits Claude Code's listing cap`);
    for (const phrase of phrases) assert.ok(fm.when_to_use.includes(phrase), `${name}: when_to_use mentions "${phrase}"`);
    assert.ok(!('disable-model-invocation' in fm), `${name}: model invocation stays enabled`);
  }
});

test('/baton only prescribes --done when baton reports a pending plan update', () => {
  const body = read('plugins/runlist/commands/baton.md');
  const step = body.slice(body.indexOf('3. **'), body.indexOf('4. **'));
  assert.match(step, /Finish the handoff only if baton asks/);
  assert.ok(step.indexOf('Handoff not done yet') < step.indexOf('baton --done'), 'the condition comes before the verb');
  assert.match(step, /If baton did not say that \(slug mode, or no `next_step`\), skip `--done`/);
  assert.match(step, /Any other plan this session touched is a separate, ordinary update/);
  assert.doesNotMatch(step, /the same way/);
  assert.match(read('plugins/runlist/skills/runlist/SKILL.md'), /Only when baton's output says `Handoff not done yet`/);
});

test('baton --done after a slug-mode handoff fails, which is why /baton must not run it unconditionally', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'runlist-newcomer-'));
  try {
    const env = { ...process.env, RUNLIST_SESSION_ID: 'newcomer-copy', NO_COLOR: '1' };
    const run = args => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', env });
    assert.equal(run(['setup', '--yes']).status, 0);
    writeFileSync(path.join(dir, 'draft.md'), '# Resume\n\nCheck the synthetic exporter.\n');
    const saved = run(['baton', 'no-plan', '@draft.md']);
    assert.equal(saved.status, 0, saved.stdout + saved.stderr);
    assert.doesNotMatch(saved.stdout + saved.stderr, /Handoff not done yet/);
    const done = run(['baton', '--done', '--next-step', 'Add the remaining field.']);
    assert.equal(done.status, 1);
    assert.match(done.stderr + done.stdout, /No handoff of this session waits on a plan update/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('README quick path is install, baton, /pickup — no setup step, planning optional', () => {
  const path3 = quickPath();
  assert.match(path3, /npm install -g runlist\n\s+claude plugin marketplace add reowens\/runlist\n\s+claude plugin install runlist@runlist\n\s+```/);
  assert.match(path3, /There is no setup step\./);
  assert.match(path3, /^1\. \*\*Install\*\* \(once, in a terminal\):/m);
  assert.match(path3, /^2\. \*\*Stop with a handoff\.\*\*/m);
  assert.match(path3, /^3\. \*\*Pick it up next time\.\*\* In a new session, type `\/pickup`/m);
  const steps = path3.slice(path3.indexOf('1. **Install'), path3.indexOf('Planning is optional'));
  assert.doesNotMatch(steps, /runlist setup/, 'setup is not a step before the first handoff');
  assert.match(steps, /first handoff in a project also writes a small\s+`runlist\.config\.mjs`/);
  assert.match(path3, /Planning is optional: when you want plans, docs and an index, run `runlist\s+setup`/);
  assert.match(path3, /your saved handoffs stay where they are/);
  // Desktop's plugin browser is only for finding runlist once the marketplace is registered.
  assert.match(path3, /once the marketplace is registered/);
  assert.doesNotMatch(path3, /untested|has no shell|have no shell|restart it from a terminal|Restart Claude Desktop/);
  // The PATH diagnosis is one possibility, and doctor --session is not a PATH check.
  assert.match(path3, /either\s+runlist is not installed yet or the app is searching a different PATH/);
  assert.match(path3, /command -v runlist/);
  assert.match(path3, /fully quit and reopen Claude Desktop/);
  assert.doesNotMatch(path3, /doctor --session/);
  assert.match(path3, /Claude Code \(the Code tab in Claude Desktop, or a terminal\)\s+running on your own machine/);
  assert.doesNotMatch(path3, /Cowork[^.]*\bno shell\b/);
});

test('/baton, /plans and both skills lead with handoffs and keep plan steps conditional', () => {
  const baton = read('plugins/runlist/commands/baton.md');
  const verb = baton.slice(baton.indexOf('2. **'), baton.indexOf('3. **'));
  assert.ok(verb.indexOf('runlist baton <slug> @/tmp/baton.md') < verb.indexOf('runlist baton @/tmp/baton.md'), 'slug form first');
  assert.match(verb, /Pick the slug yourself/);
  assert.match(verb, /\*\*Only in a project that uses plans\*\*/);
  assert.match(read('plugins/runlist/commands/plans.md'), /If it says planning is off, relay that line and stop/);
  for (const file of ['plugins/runlist/skills/runlist/SKILL.md', 'plugins/runlist-codex/skills/runlist/SKILL.md']) {
    const skill = read(file);
    const handoffs = skill.indexOf('## Handoffs (every project)');
    assert.ok(handoffs > 0, `${file}: handoff section`);
    assert.ok(handoffs < skill.indexOf('## Planning projects'), `${file}: handoffs before planning`);
    assert.ok(handoffs < skill.indexOf('runlist use <plan-file>'), `${file}: plan verbs come after handoffs`);
    assert.match(skill, /`runlist plans`[^\n]*says planning is off/);
  }
  const claude = read('plugins/runlist/skills/runlist/SKILL.md');
  assert.ok(claude.indexOf('## Planning projects') < claude.indexOf('<!-- runlist:canonical-workflow:start -->'), 'the plan contract sits under planning');
});

test('GETTING_STARTED points source review at the checkout section', () => {
  const guide = read('GETTING_STARTED.md');
  assert.match(guide, /\(README\.md#checkout-review-and-migration\)/);
  assert.match(read('README.md'), /^### Checkout review and migration$/m);
});
