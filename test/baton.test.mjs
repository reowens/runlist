import { describe, it, beforeEach, afterEach } from 'node:test';
import { ok, strictEqual, match } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

let tmpDir;
let docsDir;
let plansDir;
let configPath;

function setupProject({ journal = true } = {}) {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-baton-'));
  spawnSync('git', ['init', '-q'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

  docsDir = path.join(tmpDir, 'docs');
  plansDir = path.join(docsDir, 'plans');
  mkdirSync(path.join(docsDir, 'prompts'), { recursive: true });
  mkdirSync(plansDir, { recursive: true });

  configPath = path.join(tmpDir, 'dotmd.config.mjs');
  writeFileSync(configPath, `export const root = 'docs';\nexport const journal = ${journal};\n`);
}

function writePlan(name, { status = 'in-session', frontmatter = true } = {}) {
  const file = path.join(plansDir, `${name}.md`);
  const content = frontmatter
    ? `---\ntype: plan\nstatus: ${status}\ntitle: ${name}\n---\n# ${name}\n\nbody\n`
    : `# ${name}\n\nno frontmatter here\n`;
  writeFileSync(file, content);
  spawnSync('git', ['add', file], { cwd: tmpDir });
  spawnSync('git', ['commit', '-qm', `add ${name}`], { cwd: tmpDir });
  return file;
}

// Seed the journal so findOwnedPlan attributes a plan to this "session".
function journalOwn(planRepoPath, sid = 'test-sid') {
  journalArgv(['use', planRepoPath], sid);
}

// Seed an arbitrary journal entry (e.g. `use <prompt>` under another sid) to
// exercise ownership-signal gating.
function journalArgv(argv, sid = 'test-sid') {
  const dir = path.join(tmpDir, '.dotmd');
  mkdirSync(dir, { recursive: true });
  const entry = {
    ts: new Date().toISOString(), sid, pid: 1,
    argv, exit: 0, ms: 1, v: '0.0.0',
  };
  appendFileSync(path.join(dir, 'journal.jsonl'), JSON.stringify(entry) + '\n');
}

function run(args, { input, sid = 'test-sid' } = {}) {
  return spawnSync('node', [bin, ...args, '--config', configPath], {
    cwd: tmpDir, encoding: 'utf8', input,
    env: {
      ...process.env, NO_COLOR: '1',
      CLAUDE_CODE_SESSION_ID: sid,
      DOTMD_ERROR_LOG_DIR: path.join(tmpDir, '.logs'),
    },
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('dotmd baton', () => {
  beforeEach(() => setupProject());

  it('explicit plan: saves resume prompt, flips to active, prints the commit hint', () => {
    writePlan('auth-revamp');
    const r = run(['baton', 'docs/plans/auth-revamp.md', '--message', 'next: wire the refresh endpoint']);
    strictEqual(r.status, 0, r.stderr);

    const prompt = path.join(docsDir, 'prompts', 'resume-auth-revamp.md');
    ok(existsSync(prompt), 'resume prompt created');
    const promptRaw = readFileSync(prompt, 'utf8');
    ok(promptRaw.includes('next: wire the refresh endpoint'), 'body landed');
    ok(promptRaw.includes('status: pending'), 'prompt pending');

    const plan = readFileSync(path.join(plansDir, 'auth-revamp.md'), 'utf8');
    ok(plan.includes('status: active'), `plan released to active:\n${plan}`);

    match(r.stderr, /Baton passed/);
    match(r.stderr, /git commit -m "baton: auth-revamp in-session → active" -- docs\/plans\/auth-revamp\.md/);
    ok(!r.stderr.includes('prompts/resume-auth-revamp.md --'), 'prompt not in pathspec');
  });

  it('body via stdin pipe works', () => {
    writePlan('auth-revamp');
    const r = run(['baton', 'docs/plans/auth-revamp.md'], { input: 'resume: do the next thing\n' });
    strictEqual(r.status, 0, r.stderr);
    const promptRaw = readFileSync(path.join(docsDir, 'prompts', 'resume-auth-revamp.md'), 'utf8');
    ok(promptRaw.includes('resume: do the next thing'));
  });

  it('body via @path works', () => {
    writePlan('auth-revamp');
    const draft = path.join(tmpDir, 'draft.md');
    writeFileSync(draft, 'resume: from a draft file\n');
    const r = run(['baton', 'docs/plans/auth-revamp.md', `@${draft}`]);
    strictEqual(r.status, 0, r.stderr);
    const promptRaw = readFileSync(path.join(docsDir, 'prompts', 'resume-auth-revamp.md'), 'utf8');
    ok(promptRaw.includes('resume: from a draft file'));
  });

  it('refuses to run without a body — nothing mutates', () => {
    writePlan('auth-revamp');
    const r = run(['baton', 'docs/plans/auth-revamp.md']);
    ok(r.status !== 0);
    match(r.stderr, /needs the resume draft/);
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-auth-revamp.md')), 'no prompt created');
    const plan = readFileSync(path.join(plansDir, 'auth-revamp.md'), 'utf8');
    ok(plan.includes('status: in-session'), 'plan untouched');
  });

  it('resolves the owned plan from the journal when no plan arg given', () => {
    writePlan('mine');
    writePlan('theirs');
    journalOwn('docs/plans/mine.md');
    const r = run(['baton', '--message', 'resume mine']);
    strictEqual(r.status, 0, r.stderr);
    ok(existsSync(path.join(docsDir, 'prompts', 'resume-mine.md')), 'owned plan picked');
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-theirs.md')));
    const theirs = readFileSync(path.join(plansDir, 'theirs.md'), 'utf8');
    ok(theirs.includes('status: in-session'), 'other session\'s plan untouched');
  });

  it('falls back to the only in-session plan without a journal match', () => {
    writePlan('solo');
    const r = run(['baton', '--message', 'resume solo']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /only in-session plan/);
    ok(existsSync(path.join(docsDir, 'prompts', 'resume-solo.md')));
  });

  it('does NOT hand off the lone in-session plan when this session worked elsewhere (misfire repro)', () => {
    // Session A owns `theirs` (in-session, journal-attributed to sid A).
    // Session B consumed a `use <prompt>` — an ownership command that points at
    // no in-session plan — then runs `baton` with no arg. Baton must refuse, not
    // flip A's plan.
    writePlan('theirs');
    journalOwn('docs/plans/theirs.md', 'session-A');
    journalArgv(['use', 'docs/prompts/resume-my-real-work.md'], 'session-B');

    const r = run(['baton', '--message', 'resume my real work'], { sid: 'session-B' });
    ok(r.status !== 0, `baton should refuse; stderr: ${r.stderr}`);
    match(r.stderr, /No in-session plan/);
    // A's plan is untouched and no misnamed prompt was minted.
    ok(readFileSync(path.join(plansDir, 'theirs.md'), 'utf8').includes('status: in-session'),
      "other session's plan must stay in-session");
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-theirs.md')),
      'no resume prompt named after the stranger plan');
  });

  it('does NOT grab the lone in-session plan when this session used a since-released plan', () => {
    // This sid ran `use other` (now `active`, not in-session); a different lone
    // plan is in-session. The ownership signal points elsewhere → refuse.
    writePlan('released', { status: 'active' });
    writePlan('someone-elses');
    journalArgv(['use', 'docs/plans/released.md'], 'test-sid');

    const r = run(['baton', '--message', 'x']);
    ok(r.status !== 0, `should refuse; stderr: ${r.stderr}`);
    match(r.stderr, /No in-session plan/);
    ok(readFileSync(path.join(plansDir, 'someone-elses.md'), 'utf8').includes('status: in-session'));
  });

  it('still fast-paths the lone in-session plan when the journal ties this sid to it', () => {
    // The legit single-session case: this sid `use`d the plan (journal match).
    writePlan('solo');
    journalOwn('docs/plans/solo.md');
    const r = run(['baton', '--message', 'resume solo']);
    strictEqual(r.status, 0, r.stderr);
    ok(existsSync(path.join(docsDir, 'prompts', 'resume-solo.md')));
    ok(readFileSync(path.join(plansDir, 'solo.md'), 'utf8').includes('status: active'), 'flipped to active');
  });

  it('stamps the created resume prompt with a `plan:` link back to its plan', () => {
    writePlan('kinetic');
    journalOwn('docs/plans/kinetic.md');
    const r = run(['baton', '--message', 'resume kinetic']);
    strictEqual(r.status, 0, r.stderr);
    const prompt = readFileSync(path.join(docsDir, 'prompts', 'resume-kinetic.md'), 'utf8');
    match(prompt, /^plan:\s*docs\/plans\/kinetic\.md\s*$/m);
  });

  it('round-trip: consuming a baton prompt claims its plan so the next baton hands it off', () => {
    // Session A hands off `kinetic` (→ active) with a plan-linked resume prompt.
    writePlan('kinetic');
    journalOwn('docs/plans/kinetic.md', 'session-A');
    const a = run(['baton', '--message', 'A: wire the endpoint'], { sid: 'session-A' });
    strictEqual(a.status, 0, a.stderr);
    ok(readFileSync(path.join(plansDir, 'kinetic.md'), 'utf8').includes('status: active'), 'A released to active');

    // Session B consumes the resume prompt → the plan is claimed in-session.
    const b1 = run(['use', 'resume-kinetic.md'], { sid: 'session-B' });
    strictEqual(b1.status, 0, b1.stderr);
    match(b1.stderr, /Claimed.*kinetic\.md/);
    ok(readFileSync(path.join(plansDir, 'kinetic.md'), 'utf8').includes('status: in-session'),
      'consume claimed the plan in-session');

    // Session B batons with no arg → resolves the claimed plan via the journal
    // (NOT the single-in-session fast path) and hands it off.
    const b2 = run(['baton', '--message', 'B: add the retry'], { sid: 'session-B' });
    strictEqual(b2.status, 0, `B's baton should resolve the claimed plan; stderr: ${b2.stderr}`);
    match(b2.stderr, /Baton passed/);
    ok(readFileSync(path.join(plansDir, 'kinetic.md'), 'utf8').includes('status: active'),
      'B released the claimed plan to active');
  });

  it('consume does not claim a plan whose link is stale (plan archived/removed)', () => {
    // A resume prompt pointing at a nonexistent plan must consume cleanly, no claim.
    writeFileSync(path.join(docsDir, 'prompts', 'resume-ghost.md'),
      '---\ntype: prompt\nstatus: pending\nplan: docs/plans/ghost.md\n---\n# resume\n\nbody\n');
    const r = run(['use', 'resume-ghost.md']);
    strictEqual(r.status, 0, r.stderr);
    ok(!/Claimed/.test(r.stderr), `no claim for a stale link; stderr: ${r.stderr}`);
  });

  it('dies listing candidates when multiple in-session plans are unattributable', () => {
    writePlan('plan-a');
    writePlan('plan-b');
    const r = run(['baton', '--message', 'x']);
    ok(r.status !== 0);
    match(r.stderr, /Multiple plans are in-session/);
    match(r.stderr, /plan-a\.md/);
    match(r.stderr, /plan-b\.md/);
  });

  it('asks for a slug when no plan is in-session and none was passed', () => {
    writePlan('idle', { status: 'active' });
    const r = run(['baton', '--message', 'x']);
    ok(r.status !== 0);
    match(r.stderr, /No in-session plan/);
    match(r.stderr, /dotmd baton <slug>/);
  });

  it('slug mode: bare word saves resume-<slug> and touches nothing else', () => {
    writePlan('idle', { status: 'active' });
    const r = run(['baton', 'checkout-fixes', '--message', 'resume: finish the totals rounding']);
    strictEqual(r.status, 0, r.stderr);
    const prompt = path.join(docsDir, 'prompts', 'resume-checkout-fixes.md');
    ok(existsSync(prompt), 'prompt saved');
    ok(readFileSync(prompt, 'utf8').includes('totals rounding'));
    const plan = readFileSync(path.join(plansDir, 'idle.md'), 'utf8');
    ok(plan.includes('status: active'), 'no plan was touched');
    ok(!r.stderr.includes('git commit'), 'no commit hint — nothing repo-tracked changed');
    match(r.stderr, /Baton passed/);
  });

  it('slug mode: a slug already starting with resume- is not double-prefixed', () => {
    const r = run(['baton', 'resume-checkout-fixes', '--message', 'x']);
    strictEqual(r.status, 0, r.stderr);
    ok(existsSync(path.join(docsDir, 'prompts', 'resume-checkout-fixes.md')));
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-resume-checkout-fixes.md')));
  });

  it('slug mode: --status and --note are ignored with a warning, not an error', () => {
    const r = run(['baton', 'side-quest', '--status', 'paused', '--note', 'irrelevant', '--message', 'x']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /--status ignored/);
    match(r.stderr, /--note ignored/);
    ok(existsSync(path.join(docsDir, 'prompts', 'resume-side-quest.md')));
  });

  it('bare word that matches a PLAN slug goes plan mode, not slug mode', () => {
    writePlan('auth-revamp');
    const r = run(['baton', 'auth-revamp', '--message', 'resume']);
    strictEqual(r.status, 0, r.stderr);
    const plan = readFileSync(path.join(plansDir, 'auth-revamp.md'), 'utf8');
    ok(plan.includes('status: active'), 'plan released — plan mode engaged');
    match(r.stderr, /git commit/);
  });

  it('path-looking arg that does not resolve still dies (typos never become prompt names)', () => {
    const r = run(['baton', 'docs/plans/no-such-plan.md', '--message', 'x']);
    ok(r.status !== 0);
    match(r.stderr, /not found/i);
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-no-such-plan.md')), 'no prompt created from a typo');
  });

  it('collision-safe slug: a pending resume prompt does not block the handoff', () => {
    writePlan('auth-revamp');
    writeFileSync(path.join(docsDir, 'prompts', 'resume-auth-revamp.md'),
      '---\ntype: prompt\nstatus: pending\n---\nolder handoff\n');
    const r = run(['baton', 'docs/plans/auth-revamp.md', '--message', 'newer handoff']);
    strictEqual(r.status, 0, r.stderr);
    const second = path.join(docsDir, 'prompts', 'resume-auth-revamp-2.md');
    ok(existsSync(second), 'suffixed slug used');
    ok(readFileSync(second, 'utf8').includes('newer handoff'));
  });

  it('--status overrides the release status and --note lands in Version History', () => {
    writePlan('auth-revamp');
    const r = run(['baton', 'docs/plans/auth-revamp.md', '--status', 'awaiting', '--note', 'needs schema signoff', '--message', 'resume']);
    strictEqual(r.status, 0, r.stderr);
    const plan = readFileSync(path.join(plansDir, 'auth-revamp.md'), 'utf8');
    ok(plan.includes('status: awaiting'), plan);
    ok(plan.includes('needs schema signoff'), 'note in version history');
  });

  it('rejects an invalid --status BEFORE saving the prompt', () => {
    writePlan('auth-revamp');
    const r = run(['baton', 'docs/plans/auth-revamp.md', '--status', 'fnord', '--message', 'resume']);
    ok(r.status !== 0);
    match(r.stderr, /Invalid status/);
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-auth-revamp.md')), 'no prompt created');
  });

  it('plan without frontmatter dies with a bulk-tag pointer, before any mutation', () => {
    writePlan('legacy', { frontmatter: false });
    const r = run(['baton', 'docs/plans/legacy.md', '--message', 'resume']);
    ok(r.status !== 0);
    match(r.stderr, /no frontmatter block/);
    match(r.stderr, /dotmd bulk-tag docs\/plans\/legacy\.md/);
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-legacy.md')), 'no prompt created');
  });

  it('--dry-run previews without writing anything', () => {
    writePlan('auth-revamp');
    const r = run(['baton', 'docs/plans/auth-revamp.md', '--message', 'resume', '--dry-run']);
    strictEqual(r.status, 0, r.stderr);
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-auth-revamp.md')), 'no prompt written');
    const plan = readFileSync(path.join(plansDir, 'auth-revamp.md'), 'utf8');
    ok(plan.includes('status: in-session'), 'plan untouched');
  });
});

describe('dotmd hud --json owned', () => {
  beforeEach(() => setupProject());

  it('exposes the journal-attributed in-session plan as .owned', () => {
    writePlan('mine');
    writePlan('theirs');
    journalOwn('docs/plans/mine.md');
    const r = run(['hud', '--json']);
    strictEqual(r.status, 0, r.stderr);
    const hud = JSON.parse(r.stdout);
    ok(hud.owned, `owned should be set:\n${r.stdout}`);
    strictEqual(hud.owned.path, 'docs/plans/mine.md');
    strictEqual(hud.owned.via, 'journal');
  });

  it('owned is null when nothing is in-session', () => {
    writePlan('idle', { status: 'active' });
    const r = run(['hud', '--json']);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(JSON.parse(r.stdout).owned, null);
  });
});
