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
    schema: 2,
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

  // The `@draft` metavariable ships in the hud primer, both help texts, and the
  // wrap-up nudge. Copied verbatim it used to die with a bare "Body file not
  // found: draft", which reads as a missing file rather than a placeholder.
  it('names an unsubstituted body placeholder as a placeholder', () => {
    writePlan('auth-revamp');
    for (const placeholder of ['@draft', '@<draft-file>', '@/tmp/draft.md']) {
      const r = run(['baton', 'docs/plans/auth-revamp.md', placeholder]);
      ok(r.status !== 0, `${placeholder} should fail`);
      match(r.stderr, /is a placeholder, not a real path/);
      ok(!/^Body file not found/m.test(r.stderr), `${placeholder} used the generic message:\n${r.stderr}`);
    }
  });

  it('still reports a genuinely missing body file plainly', () => {
    writePlan('auth-revamp');
    const r = run(['baton', 'docs/plans/auth-revamp.md', '@/tmp/definitely-not-here-9f3a.md']);
    ok(r.status !== 0);
    match(r.stderr, /Body file not found/);
  });

  it('a real file named draft wins over the placeholder check', () => {
    writePlan('auth-revamp');
    const draft = path.join(tmpDir, 'draft');
    writeFileSync(draft, 'resume: real draft content\n');
    const r = run(['baton', 'docs/plans/auth-revamp.md', `@${draft}`]);
    strictEqual(r.status, 0, r.stderr);
    const promptRaw = readFileSync(path.join(docsDir, 'prompts', 'resume-auth-revamp.md'), 'utf8');
    ok(promptRaw.includes('resume: real draft content'));
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

  it('does not treat journal attribution as ownership', () => {
    writePlan('mine');
    writePlan('theirs');
    journalOwn('docs/plans/mine.md');
    const r = run(['baton', '--message', 'resume mine']);
    ok(r.status !== 0, r.stderr);
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-mine.md')));
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-theirs.md')));
    const theirs = readFileSync(path.join(plansDir, 'theirs.md'), 'utf8');
    ok(theirs.includes('status: in-session'), 'other session\'s plan untouched');
  });

  it('does not fall back to the only global in-session plan', () => {
    writePlan('solo');
    const r = run(['baton', '--message', 'resume solo']);
    ok(r.status !== 0, r.stderr);
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-solo.md')));
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
    match(r.stderr, /No valid in-session plan/);
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
    match(r.stderr, /No valid in-session plan/);
    ok(readFileSync(path.join(plansDir, 'someone-elses.md'), 'utf8').includes('status: in-session'));
  });

  it('uses the sole durable ownership record for no-target baton', () => {
    writePlan('solo', { status: 'active' });
    strictEqual(run(['use', 'docs/plans/solo.md']).status, 0);
    const r = run(['baton', '--message', 'resume solo']);
    strictEqual(r.status, 0, r.stderr);
    ok(existsSync(path.join(docsDir, 'prompts', 'resume-solo.md')));
    ok(readFileSync(path.join(plansDir, 'solo.md'), 'utf8').includes('status: active'), 'flipped to active');
  });

  it('stamps the created resume prompt with a `plan:` link back to its plan', () => {
    writePlan('kinetic', { status: 'active' });
    strictEqual(run(['use', 'docs/plans/kinetic.md']).status, 0);
    const r = run(['baton', '--message', 'resume kinetic']);
    strictEqual(r.status, 0, r.stderr);
    const prompt = readFileSync(path.join(docsDir, 'prompts', 'resume-kinetic.md'), 'utf8');
    match(prompt, /^plan:\s*docs\/plans\/kinetic\.md\s*$/m);
    match(prompt, /resume kinetic/, 'atomic link stamping preserves the prompt body');
  });

  it('round-trip: consuming a baton prompt claims its plan so the next baton hands it off', () => {
    // Session A hands off `kinetic` (→ active) with a plan-linked resume prompt.
    writePlan('kinetic', { status: 'active' });
    strictEqual(run(['use', 'docs/plans/kinetic.md'], { sid: 'session-A' }).status, 0);
    const a = run(['baton', '--message', 'A: wire the endpoint'], { sid: 'session-A' });
    strictEqual(a.status, 0, a.stderr);
    ok(readFileSync(path.join(plansDir, 'kinetic.md'), 'utf8').includes('status: active'), 'A released to active');

    // Session B consumes the resume prompt → the plan is claimed in-session.
    const b1 = run(['use', 'resume-kinetic.md'], { sid: 'session-B' });
    strictEqual(b1.status, 0, b1.stderr);
    match(b1.stderr, /Claimed.*kinetic\.md/);
    ok(readFileSync(path.join(plansDir, 'kinetic.md'), 'utf8').includes('status: in-session'),
      'consume claimed the plan in-session');

    // Session B batons with no arg using the durable ownership record.
    const b2 = run(['baton', '--message', 'B: add the retry'], { sid: 'session-B' });
    strictEqual(b2.status, 0, `B's baton should resolve the claimed plan; stderr: ${b2.stderr}`);
    match(b2.stderr, /Baton passed/);
    ok(readFileSync(path.join(plansDir, 'kinetic.md'), 'utf8').includes('status: active'),
      'B released the claimed plan to active');
  });

  it('consume claim is independent of journal records for later baton ownership', () => {
    writePlan('claimed', { status: 'active' });
    writePlan('other', { status: 'in-session' });
    writeFileSync(path.join(docsDir, 'prompts', 'resume-claimed.md'),
      '---\ntype: prompt\nstatus: pending\nplan: docs/plans/claimed.md\n---\n# Resume\n\ncontinue\n');
    const journal = path.join(tmpDir, '.dotmd', 'journal.jsonl');
    ok(!existsSync(journal), 'precondition: no journal history');

    const consume = run(['use', 'resume-claimed.md'], { sid: 'fresh-session' });
    strictEqual(consume.status, 0, consume.stderr);
    const entries = readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse);
    ok(!entries.some(entry => entry.argv?.join(' ') === 'set in-session docs/plans/claimed.md'));
    ok(entries.every(entry => entry.schema === 2), 'outer journal remains observability-only');
    ok(existsSync(path.join(tmpDir, '.dotmd', 'ownership')), 'durable ownership was created');

    const baton = run(['baton', '--message', 'continue claimed'], { sid: 'fresh-session' });
    strictEqual(baton.status, 0, baton.stderr);
    match(baton.stderr, /Baton passed.*claimed/);
    ok(readFileSync(path.join(plansDir, 'other.md'), 'utf8').includes('status: in-session'), 'unowned plan was untouched');
  });

  it('stale linked plan leaves the prompt pending and unchanged', () => {
    writeFileSync(path.join(docsDir, 'prompts', 'resume-ghost.md'),
      '---\ntype: prompt\nstatus: pending\nplan: docs/plans/ghost.md\n---\n# resume\n\nbody\n');
    const promptPath = path.join(docsDir, 'prompts', 'resume-ghost.md');
    const before = readFileSync(promptPath, 'utf8');
    const r = run(['use', 'resume-ghost.md']);
    ok(r.status !== 0);
    match(r.stderr, /prompt was not consumed/);
    strictEqual(readFileSync(promptPath, 'utf8'), before);
  });

  it('does not infer ownership from multiple unattributed in-session plans', () => {
    writePlan('plan-a');
    writePlan('plan-b');
    const r = run(['baton', '--message', 'x']);
    ok(r.status !== 0);
    match(r.stderr, /No valid in-session plan/);
  });

  it('asks for a slug when no plan is in-session and none was passed', () => {
    writePlan('idle', { status: 'active' });
    const r = run(['baton', '--message', 'x']);
    ok(r.status !== 0);
    match(r.stderr, /No valid in-session plan/);
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

  it('plan and slug JSON distinguish dry-run previews from applied operations', () => {
    writePlan('preview-plan');
    const plan = run(['baton', 'docs/plans/preview-plan.md', '--json', '--dry-run', '--message', 'resume']);
    strictEqual(plan.status, 0, plan.stderr);
    const planValue = JSON.parse(plan.stdout);
    strictEqual(planValue.dryRun, true);
    strictEqual(planValue.disposition, 'would-change');
    strictEqual(planValue.wouldChange, true);
    strictEqual(planValue.mode, 'plan');
    const slug = run(['baton', 'preview-slug', '--json', '--dry-run', '--message', 'resume']);
    strictEqual(slug.status, 0, slug.stderr);
    const slugValue = JSON.parse(slug.stdout);
    strictEqual(slugValue.dryRun, true);
    strictEqual(slugValue.disposition, 'would-change');
    strictEqual(slugValue.wouldChange, true);
    strictEqual(slugValue.mode, 'slug');
  });

  it('--json reports repository/session/deferred files and leaves the tracked index byte-identical', () => {
    writeFileSync(configPath, `
      export const root = 'docs';
      export const journal = true;
      export const index = { path: 'docs/docs.md', startMarker: '<!-- START -->', endMarker: '<!-- END -->' };
    `);
    writeFileSync(path.join(docsDir, 'docs.md'), '# Index\n\n<!-- START -->\n\n<!-- END -->\n');
    writePlan('structured', { status: 'active' });
    strictEqual(run(['use', 'docs/plans/structured.md'], { sid: 'json-session' }).status, 0);
    const indexBefore = readFileSync(path.join(docsDir, 'docs.md'));
    const result = run(['baton', '--json', '--message', 'continue structured'], { sid: 'json-session' });
    strictEqual(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    strictEqual(value.operation, 'baton');
    strictEqual(value.dryRun, false);
    strictEqual(value.disposition, 'applied');
    strictEqual(value.wouldChange, false);
    strictEqual(value.status.from, 'in-session');
    strictEqual(value.status.to, 'active');
    ok(value.repositoryFiles.includes('docs/plans/structured.md'));
    ok(value.sessionFiles.includes('docs/prompts/resume-structured.md'));
    ok(value.sessionFiles.some(item => item.startsWith('.dotmd/ownership/')));
    strictEqual(value.generatedFiles.length, 0);
    ok(value.deferredGeneratedFiles.includes('docs/docs.md'));
    strictEqual(Buffer.compare(readFileSync(path.join(docsDir, 'docs.md')), indexBefore), 0);
  });

  it('slug mode defers the tracked index and reports only the actual prompt session file', () => {
    writeFileSync(configPath, `
      export const root = 'docs';
      export const index = { path: 'docs/docs.md', startMarker: '<!-- START -->', endMarker: '<!-- END -->' };
    `);
    writeFileSync(path.join(docsDir, 'docs.md'), '# Index\n\n<!-- START -->\nkeep\n<!-- END -->\n');
    const before = readFileSync(path.join(docsDir, 'docs.md'));
    const result = run(['baton', 'standalone', '--json', '--message', 'continue standalone']);
    strictEqual(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout);
    strictEqual(value.mode, 'slug');
    strictEqual(value.repositoryFiles.length, 0);
    strictEqual(value.sessionFiles.length, 1);
    strictEqual(value.sessionFiles[0], 'docs/prompts/resume-standalone.md');
    strictEqual(value.generatedFiles.length, 0);
    ok(value.deferredGeneratedFiles.includes('docs/docs.md'));
    strictEqual(Buffer.compare(readFileSync(path.join(docsDir, 'docs.md')), before), 0);
  });
});

describe('dotmd hud --json owned', () => {
  beforeEach(() => setupProject());

  it('exposes the durably owned in-session plan as .owned', () => {
    writePlan('mine', { status: 'active' });
    writePlan('theirs');
    strictEqual(run(['use', 'docs/plans/mine.md']).status, 0);
    const r = run(['hud', '--json']);
    strictEqual(r.status, 0, r.stderr);
    const hud = JSON.parse(r.stdout);
    ok(hud.owned, `owned should be set:\n${r.stdout}`);
    strictEqual(hud.owned.path, 'docs/plans/mine.md');
    strictEqual(hud.owned.via, 'ownership');
  });

  it('owned is null when nothing is in-session', () => {
    writePlan('idle', { status: 'active' });
    const r = run(['hud', '--json']);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(JSON.parse(r.stdout).owned, null);
  });
});
