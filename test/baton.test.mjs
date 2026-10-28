import { describe, it, beforeEach, afterEach } from 'node:test';
import { ok, strictEqual, match, rejects } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, appendFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import { runBaton } from '../src/baton.mjs';
import { withPathLocks } from '../src/atomic-mutation.mjs';

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

function writePlan(name, { status = 'in-session', frontmatter = true, tracked = true, body = 'body' } = {}) {
  const file = path.join(plansDir, `${name}.md`);
  const content = frontmatter
    ? `---\ntype: plan\nstatus: ${status}\ntitle: ${name}\n---\n# ${name}\n\n${body}\n`
    : `# ${name}\n\nno frontmatter here\n`;
  writeFileSync(file, content);
  if (!tracked) return file;
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
  const dir = path.join(tmpDir, '.runlist');
  mkdirSync(dir, { recursive: true });
  const entry = {
    schema: 2,
    ts: new Date().toISOString(), sid, pid: 1,
    argv, exit: 0, ms: 1, v: '0.0.0',
  };
  appendFileSync(path.join(dir, 'journal.jsonl'), JSON.stringify(entry) + '\n');
}

function run(args, { input, sid = 'test-sid', env = {} } = {}) {
  return spawnSync('node', [bin, ...args, '--config', configPath], {
    cwd: tmpDir, encoding: 'utf8', input,
    env: {
      ...process.env, NO_COLOR: '1',
      CLAUDE_CODE_SESSION_ID: sid,
      RUNLIST_ERROR_LOG_DIR: path.join(tmpDir, '.logs'),
      RUNLIST_PARENT_PROMPT: '',
      ...env,
    },
  });
}

function runAsync(args, sid = 'test-sid') {
  return new Promise(resolve => {
    const child = spawn('node', [bin, ...args, '--config', configPath], {
      cwd: tmpDir, env: { ...process.env, NO_COLOR: '1', CLAUDE_CODE_SESSION_ID: sid, RUNLIST_ERROR_LOG_DIR: path.join(tmpDir, '.logs') },
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', status => resolve({ status, stderr }));
  });
}

function git(args) {
  const result = spawnSync('git', args, { cwd: tmpDir, encoding: 'utf8' });
  strictEqual(result.status, 0, result.stderr);
  return result.stdout;
}

function executeCommitHint(result) {
  strictEqual(result.status, 0, result.stderr);
  const command = result.stderr.split('\n').find(line => line.startsWith('  git '))?.trim();
  ok(command, result.stderr);
  const committed = spawnSync(command, { cwd: tmpDir, encoding: 'utf8', shell: true });
  strictEqual(committed.status, 0, committed.stderr);
  strictEqual(git(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'docs/prompts']), '');
  return command;
}

async function withSessionIdentity(fn, sid = 'test-sid') {
  const previous = process.env.RUNLIST_SESSION_ID;
  process.env.RUNLIST_SESSION_ID = sid;
  try { return await fn(); }
  finally {
    if (previous === undefined) delete process.env.RUNLIST_SESSION_ID;
    else process.env.RUNLIST_SESSION_ID = previous;
  }
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('runlist baton in a fresh repository', () => {
  for (const promptTracking of ['untracked', 'tracked', 'local']) it(`prints an executable commit command with ${promptTracking} prompts`, () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-baton-fresh-'));
    const git = args => spawnSync('git', args, { cwd: tmpDir, encoding: 'utf8' });
    const cli = args => spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../bin/runlist.mjs'), ...args], {
      cwd: tmpDir, encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', CLAUDE_CODE_SESSION_ID: 'fresh-session', RUNLIST_ERROR_LOG_DIR: path.join(tmpDir, '.logs') },
    });
    for (const args of [['init', '-q'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Test'], ['commit', '--allow-empty', '-qm', 'Initial commit']]) {
      const result = git(args);
      strictEqual(result.status, 0, result.stderr);
    }
    for (const args of [['setup', '--yes', '--prompt-tracking', promptTracking], ['new', 'plan', 'demo'], ['use', 'docs/plans/demo.md']]) {
      const result = cli(args);
      strictEqual(result.status, 0, result.stderr);
    }
    writeFileSync(path.join(tmpDir, 'draft.md'), '## Progress\nThe first step is complete.\n\n## Next\nFinish the remaining step.\n');
    const result = cli(['baton', '@draft.md']);
    strictEqual(result.status, 0, result.stderr);
    const command = result.stderr.split('\n').find(line => line.startsWith('  git '))?.trim();
    strictEqual(command, 'git add -- docs/plans/demo.md && git commit -m "baton: demo in-session → active" -- docs/plans/demo.md');
    // A staged prompt must stay outside the commit, even when policy allows it.
    if (promptTracking === 'tracked') strictEqual(git(['add', '--', 'docs/prompts/resume-demo.md']).status, 0);
    const committed = spawnSync(command, { cwd: tmpDir, encoding: 'utf8', shell: true });
    strictEqual(committed.status, 0, committed.stderr);
    const plan = git(['show', 'HEAD:docs/plans/demo.md']);
    strictEqual(plan.status, 0, plan.stderr);
    match(plan.stdout, /status: active/);
    strictEqual(git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).stdout.trim(), 'docs/plans/demo.md');
    strictEqual(git(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'docs/prompts']).stdout, '');
  });
});

describe('runlist baton', () => {
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
    strictEqual(r.stderr.split('\n').find(line => line.startsWith('  git ')),
      '  git commit -m "baton: auth-revamp in-session → active" -- docs/plans/auth-revamp.md');
    ok(!r.stderr.includes('prompts/resume-auth-revamp.md --'), 'prompt not in pathspec');
    executeCommitHint(r);
  });

  for (const tracked of [true, false]) it(`commits an archived ${tracked ? 'tracked' : 'untracked'} plan with only the required paths`, () => {
    writePlan('demo', { tracked, body: 'Synthetic progress detail.\n'.repeat(30) });
    const r = run(['baton', 'docs/plans/demo.md', '--status', 'archived', '--message', 'resume']);
    const command = executeCommitHint(r);
    strictEqual(command, tracked
      ? 'git commit -m "baton: demo in-session → archived" -- docs/plans/demo.md docs/archived/demo.md'
      : 'git add -- docs/archived/demo.md && git commit -m "baton: demo in-session → archived" -- docs/archived/demo.md');
    strictEqual(git(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'docs/plans/demo.md']), '');
    match(git(['show', 'HEAD:docs/archived/demo.md']), /status: archived/);
    strictEqual(git(['diff', '--cached', '--name-only']), '');
    if (tracked) match(git(['show', '--format=', '--name-status', 'HEAD']), /R\d+\tdocs\/plans\/demo.md\tdocs\/archived\/demo.md/);
  });

  it('stages and commits a literal bracket filename without including its tracked decoy', () => {
    writePlan('v1');
    appendFileSync(path.join(plansDir, 'v1.md'), '\nUnrelated unstaged edit.\n');
    writePlan('v[1-2]', { tracked: false });
    const r = run(['baton', 'docs/plans/v[1-2].md', '--message', 'resume']);
    const command = executeCommitHint(r);
    match(command, /^git add -- ":\(top,literal\)docs\/plans\/v\[1-2\].md" &&/);
    strictEqual(git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']).trim(), 'docs/plans/v[1-2].md');
    match(git(['diff', '--', 'docs/plans/v1.md']), /Unrelated unstaged edit/);
  });

  it('omits ignored rewritten files while staging other untracked rewritten files', () => {
    writePlan('demo');
    mkdirSync(path.join(docsDir, 'scratch'));
    writeFileSync(path.join(tmpDir, '.gitignore'), 'docs/scratch/\n');
    const note = '---\ntype: doc\nstatus: active\n---\nSee [demo](../plans/demo.md).\n';
    writeFileSync(path.join(docsDir, 'scratch', 'notes.md'), note);
    writeFileSync(path.join(docsDir, 'notes.md'), note.replace('../plans/', 'plans/'));
    const r = run(['baton', 'docs/plans/demo.md', '--status', 'archived', '--message', 'resume']);
    match(readFileSync(path.join(docsDir, 'scratch', 'notes.md'), 'utf8'), /archived\/demo.md/);
    const command = executeCommitHint(r);
    ok(!command.includes('scratch/'), command);
    match(command, /^git add -- docs\/notes.md &&/);
    match(git(['show', 'HEAD:docs/notes.md']), /archived\/demo.md/);
    strictEqual(git(['ls-tree', '-r', '--name-only', 'HEAD', '--', 'docs/scratch']), '');
  });

  it('executes a configured commit command with unchanged argv', () => {
    writePlan('demo');
    appendFileSync(configPath, '\nexport function batonCommitCommand(message, paths) { return ["git", "-c", "commit.gpgSign=false", "commit", "-m", message, "--", ...paths]; }\n');
    const r = run(['baton', 'docs/plans/demo.md', '--message', 'resume']);
    strictEqual(executeCommitHint(r), 'git -c "commit.gpgSign=false" commit -m "baton: demo in-session → active" -- docs/plans/demo.md');
  });

  it('prints no commit when an ignored untracked move leaves no committable paths', () => {
    writeFileSync(path.join(tmpDir, '.gitignore'), 'docs/\n');
    writePlan('demo', { tracked: false });
    const r = run(['baton', 'docs/plans/demo.md', '--status', 'archived', '--message', 'resume']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /no commit needed/);
    ok(!r.stderr.includes('git add') && !r.stderr.includes('git commit'), r.stderr);
  });

  for (const tracked of [true, false]) it(`formats a configured commit argv unchanged for a ${tracked ? 'tracked' : 'untracked'} plan`, () => {
    const plan = writePlan('quote $PATH', { tracked });
    appendFileSync(configPath, '\nexport function batonCommitCommand(message, paths) { return ["just", "commit", message, ...paths]; }\n');
    const r = run(['baton', plan, '--message', 'resume']);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(r.stderr.split('\n').find(line => line.startsWith('  just ')),
      '  just commit "baton: quote \\$PATH in-session → active" "docs/plans/quote \\$PATH.md"');
    ok(!r.stderr.includes('git add'), 'wrapper command has no staging prefix');
    ok(!r.stderr.includes('docs/prompts/'), 'session prompt excluded from commit command');
  });

  it('quotes an untracked plan in both staging and commit pathspecs', () => {
    writePlan('quote $PATH', { tracked: false });
    const r = run(['baton', 'docs/plans/quote $PATH.md', '--message', 'resume']);
    strictEqual(r.status, 0, r.stderr);
    const command = r.stderr.split('\n').find(line => line.startsWith('  git ')).trim();
    strictEqual(command, 'git add -- "docs/plans/quote \\$PATH.md" && git commit -m "baton: quote \\$PATH in-session → active" -- "docs/plans/quote \\$PATH.md"');
  });

  it('keeps gitignored untracked plans out of commit hints', () => {
    writeFileSync(path.join(tmpDir, '.gitignore'), 'docs/plans/\n');
    writePlan('ignored-demo', { tracked: false });
    const r = run(['baton', 'docs/plans/ignored-demo.md', '--message', 'resume']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /is gitignored — no commit needed/);
    ok(!r.stderr.includes('git add') && !r.stderr.includes('git commit'), r.stderr);
  });

  for (const archived of [false, true]) it(`does not call the commit hook for an ignored source plan${archived ? ' moved into a non-ignored directory' : ''}`, () => {
    writeFileSync(path.join(tmpDir, '.gitignore'), archived ? 'docs/plans/\n' : 'docs/\n');
    writePlan('demo', { tracked: false });
    appendFileSync(configPath, `
import { writeFileSync } from 'node:fs';
export function batonCommitCommand(message, paths) {
  writeFileSync(new URL('./hook-called', import.meta.url), 'called');
  return ['just', 'commit', message, ...paths];
}
`);
    const r = run(['baton', 'docs/plans/demo.md', '--message', 'resume', ...(archived ? ['--status', 'archived'] : [])]);
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /docs\/plans\/demo.md is gitignored — no commit needed\./);
    ok(!existsSync(path.join(tmpDir, 'hook-called')), 'ignored source bypasses the hook');
    ok(!/just commit|git add|git commit/.test(r.stderr), r.stderr);
    strictEqual(git(['diff', '--cached', '--name-only']), '');
    if (archived) ok(existsSync(path.join(docsDir, 'archived', 'demo.md')));
  });

  it('prints no commit for an ignored source archived into a non-ignored directory', () => {
    writeFileSync(path.join(tmpDir, '.gitignore'), 'docs/plans/\n');
    writePlan('demo', { tracked: false });
    const r = run(['baton', 'docs/plans/demo.md', '--status', 'archived', '--message', 'resume']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /docs\/plans\/demo.md is gitignored — no commit needed\./);
    ok(existsSync(path.join(docsDir, 'archived', 'demo.md')));
    strictEqual(spawnSync('git', ['check-ignore', '-q', 'docs/archived/demo.md'], { cwd: tmpDir }).status, 1);
    ok(!/git add|git commit/.test(r.stderr), r.stderr);
    strictEqual(git(['diff', '--cached', '--name-only']), '');
  });

  for (const command of ['ls-files', 'ls-tree', 'check-ignore']) it(`falls back to the plain commit hint when ${command} classification fails`, () => {
    const tracked = command === 'ls-tree';
    writePlan('demo', { tracked });
    const preload = path.join(tmpDir, 'fail-classification.mjs');
    // Fail only classification, after normal lifecycle work has completed.
    writeFileSync(preload, `
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = childProcess.spawnSync;
childProcess.spawnSync = (file, args, options) => {
  if (file === 'git' && args[0] === ${JSON.stringify(command)}
      && args[1] === ${JSON.stringify(command === 'ls-tree' ? '-r' : command === 'ls-files' ? '-z' : '--stdin')}) {
    return { status: 128, stdout: '', stderr: 'Synthetic classification failure' };
  }
  return original(file, args, options);
};
syncBuiltinESMExports();
`);
    const r = spawnSync(process.execPath, ['--import', preload, bin,
      'baton', 'docs/plans/demo.md', '--message', 'resume', ...(tracked ? ['--status', 'archived'] : []), '--config', configPath], {
      cwd: tmpDir, encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', CLAUDE_CODE_SESSION_ID: 'test-sid', RUNLIST_ERROR_LOG_DIR: path.join(tmpDir, '.logs') },
    });
    strictEqual(r.status, 0, r.stderr);
    strictEqual(r.stderr.split('\n').find(line => line.startsWith('  git ')), tracked
      ? '  git commit -m "baton: demo in-session → archived" -- docs/plans/demo.md docs/archived/demo.md'
      : '  git commit -m "baton: demo in-session → active" -- docs/plans/demo.md');
    ok(!r.stderr.includes('git add'), r.stderr);
    if (tracked) executeCommitHint(r);
  });

  // Regression: a prompt-refresh pass named a plan slug to re-save its handoff
  // and got a status flip it never asked for (`awaiting` → the default
  // `active`), which it then had to notice and undo. Baton has no claim to
  // release on a plan that is not in-session and not owned here, so the status
  // someone chose stays chosen — the prompt (and its `plan:` link) still lands.
  it('a plan that is not in-session keeps its status; the prompt still links it', () => {
    writePlan('auth-revamp', { status: 'awaiting' });
    const r = run(['baton', 'docs/plans/auth-revamp.md', '--message', 'next: chase the answer']);
    strictEqual(r.status, 0, r.stderr);

    const plan = readFileSync(path.join(plansDir, 'auth-revamp.md'), 'utf8');
    ok(plan.includes('status: awaiting'), `status untouched:\n${plan}`);
    ok(!plan.includes('status: active'), 'not released to active');

    const promptRaw = readFileSync(path.join(docsDir, 'prompts', 'resume-auth-revamp.md'), 'utf8');
    ok(promptRaw.includes('plan: docs/plans/auth-revamp.md'), `prompt keeps its plan link:\n${promptRaw}`);
    match(r.stderr, /Baton passed/);
    match(r.stderr, /left at `awaiting` — it was not in-session/);
    ok(!/git commit -m "baton:/.test(r.stderr), `no release commit hint:\n${r.stderr}`);
  });

  // Same shape reached through the bare-slug form, which is how the real case
  // arrived: the slug resolved to a plan, so baton took plan mode.
  it('a bare slug that resolves to a parked plan does not flip it either', () => {
    writePlan('auth-revamp', { status: 'blocked' });
    const r = run(['baton', 'auth-revamp', '--message', 'next: vendor ships the hardware']);
    strictEqual(r.status, 0, r.stderr);
    ok(readFileSync(path.join(plansDir, 'auth-revamp.md'), 'utf8').includes('status: blocked'));
    ok(existsSync(path.join(docsDir, 'prompts', 'resume-auth-revamp.md')));
  });

  it('--status still flips a plan that is not in-session', () => {
    writePlan('auth-revamp', { status: 'awaiting' });
    const r = run(['baton', 'docs/plans/auth-revamp.md', '--status', 'planned', '--message', 'next: re-queue it']);
    strictEqual(r.status, 0, r.stderr);
    const plan = readFileSync(path.join(plansDir, 'auth-revamp.md'), 'utf8');
    ok(plan.includes('status: planned'), `explicit status applied:\n${plan}`);
    match(r.stderr, /git commit -m "baton: auth-revamp awaiting → planned"/);
  });

  it('refuses when a plan is not in-session and carries no status to leave in place', () => {
    const file = path.join(plansDir, 'auth-revamp.md');
    writeFileSync(file, '---\ntype: plan\ntitle: auth-revamp\n---\n# auth-revamp\n\nbody\n');
    const r = run(['baton', 'docs/plans/auth-revamp.md', '--message', 'next: something']);
    ok(r.status !== 0, 'refused');
    match(r.stderr, /is not in-session and its status/);
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-auth-revamp.md')), 'nothing saved');
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

  // The real-world shape of finding 2: `dotmd baton <slug> @- <<'EOF'` appeared
  // three times in the platform transcripts, each time with the heredoc already
  // attached and each time discarded for a file named `-`.
  it('body via @- reads stdin instead of hunting for a file named -', () => {
    writePlan('auth-revamp');
    const r = run(['baton', 'docs/plans/auth-revamp.md', '@-'], { input: 'resume: heredoc behind @-\n' });
    strictEqual(r.status, 0, r.stderr);
    const promptRaw = readFileSync(path.join(docsDir, 'prompts', 'resume-auth-revamp.md'), 'utf8');
    ok(promptRaw.includes('resume: heredoc behind @-'));
  });

  it('refuses to run without a body — nothing mutates', () => {
    writePlan('auth-revamp');
    const r = run(['baton', 'docs/plans/auth-revamp.md']);
    ok(r.status !== 0);
    match(r.stderr, /^Nothing saved: baton needs the resume you wrote, passed as @<file> or - \(stdin\)\.$/m);
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-auth-revamp.md')), 'no prompt created');
    const plan = readFileSync(path.join(plansDir, 'auth-revamp.md'), 'utf8');
    ok(plan.includes('status: in-session'), 'plan untouched');
  });

  // An agent's shell can hold stdin open as a pipe that never sends or closes.
  // A bare baton used to block on it until the tool call timed out.
  it('gives up on an open pipe that sends nothing, and lists the forms', async () => {
    writePlan('auth-revamp');
    const child = spawn('node', [bin, 'baton', 'docs/plans/auth-revamp.md', '--config', configPath], {
      cwd: tmpDir,
      env: { ...process.env, NO_COLOR: '1', CLAUDE_CODE_SESSION_ID: 'test-sid', RUNLIST_ERROR_LOG_DIR: path.join(tmpDir, '.logs') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    const started = Date.now();
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('baton blocked on a silent stdin pipe')); }, 10_000);
      child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    child.stdin.destroy();
    ok(code !== 0);
    ok(Date.now() - started < 10_000);
    match(stderr, /^Nothing saved: baton needs the resume you wrote/m);
    match(stderr, /runlist baton <slug> @\/tmp\/draft\.md/);
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

  it('--no-claim consumes a plan-linked prompt without starting the plan', () => {
    writePlan('kinetic', { status: 'active' });
    const prompt = path.join(docsDir, 'prompts', 'resume-kinetic.md');
    writeFileSync(prompt, '---\ntype: prompt\nstatus: pending\nplan: docs/plans/kinetic.md\n---\n# Resume\n\ncontinue\n');
    const r = run(['use', 'resume-kinetic', '--no-claim']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /continue/, 'body delivered');
    match(r.stderr, /Not claimed.*--no-claim/);
    ok(!/→ Claimed/.test(r.stderr), 'no claim reported');
    ok(!existsSync(prompt), 'prompt archived');
    ok(readFileSync(path.join(plansDir, 'kinetic.md'), 'utf8').includes('status: active'), 'plan left active');
  });

  it('--no-claim works for prompts next and prompts use', () => {
    writePlan('kinetic', { status: 'active' });
    writeFileSync(path.join(docsDir, 'prompts', 'resume-kinetic.md'),
      '---\ntype: prompt\nstatus: pending\nplan: docs/plans/kinetic.md\n---\nfirst\n');
    const next = run(['prompts', 'next', '--no-claim']);
    strictEqual(next.status, 0, next.stderr);
    ok(readFileSync(path.join(plansDir, 'kinetic.md'), 'utf8').includes('status: active'), 'next left plan active');
    writeFileSync(path.join(docsDir, 'prompts', 'resume-kinetic-b.md'),
      '---\ntype: prompt\nstatus: pending\nplan: docs/plans/kinetic.md\n---\nsecond\n');
    const use = run(['prompts', 'use', 'resume-kinetic-b', '--no-claim']);
    strictEqual(use.status, 0, use.stderr);
    ok(readFileSync(path.join(plansDir, 'kinetic.md'), 'utf8').includes('status: active'), 'prompts use left plan active');
  });

  it('--no-claim on a plan is refused rather than ignored', () => {
    writePlan('kinetic', { status: 'active' });
    const r = run(['use', 'docs/plans/kinetic.md', '--no-claim']);
    ok(r.status !== 0);
    match(r.stderr, /--no-claim applies to prompts only/);
    ok(readFileSync(path.join(plansDir, 'kinetic.md'), 'utf8').includes('status: active'), 'plan untouched');
  });

  it('consume claim is independent of journal records for later baton ownership', () => {
    writePlan('claimed', { status: 'active' });
    writePlan('other', { status: 'in-session' });
    writeFileSync(path.join(docsDir, 'prompts', 'resume-claimed.md'),
      '---\ntype: prompt\nstatus: pending\nplan: docs/plans/claimed.md\n---\n# Resume\n\ncontinue\n');
    const journal = path.join(tmpDir, '.runlist', 'journal.jsonl');
    ok(!existsSync(journal), 'precondition: no journal history');

    const consume = run(['use', 'resume-claimed.md'], { sid: 'fresh-session', env: { RUNLIST_JOURNAL: '1' } });
    strictEqual(consume.status, 0, consume.stderr);
    const entries = readFileSync(journal, 'utf8').trim().split('\n').map(JSON.parse);
    ok(!entries.some(entry => entry.argv?.join(' ') === 'set in-session docs/plans/claimed.md'));
    ok(entries.every(entry => entry.schema === 2), 'outer journal remains observability-only');
    ok(existsSync(path.join(tmpDir, '.runlist', 'ownership')), 'durable ownership was created');

    const baton = run(['baton', '--message', 'continue claimed'], { sid: 'fresh-session' });
    strictEqual(baton.status, 0, baton.stderr);
    match(baton.stderr, /Baton passed.*claimed/);
    ok(readFileSync(path.join(plansDir, 'other.md'), 'utf8').includes('status: in-session'), 'unowned plan was untouched');
  });

  it('claims a linked plan written doc-relative, not just repo-root-relative', () => {
    // `plan:` is a ref in the prompt's own frontmatter, so `../plans/x.md` from
    // `docs/prompts/` is as valid as `docs/plans/x.md`. Nothing validates the
    // field (it is not a `referenceFields` entry), so a resolver that read only
    // the repo-root form failed the claim against a plan that was plainly there.
    writePlan('doc-relative', { status: 'active' });
    writeFileSync(path.join(docsDir, 'prompts', 'resume-doc-relative.md'),
      '---\ntype: prompt\nstatus: pending\nplan: ../plans/doc-relative.md\n---\n# Resume\n\nbody\n');

    const r = run(['use', 'resume-doc-relative.md'], { sid: 'session-rel' });
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /Claimed.*doc-relative\.md/);
    ok(readFileSync(path.join(plansDir, 'doc-relative.md'), 'utf8').includes('status: in-session'),
      'doc-relative link claimed the plan in-session');

    // The claim is durable, so this session's no-arg baton hands the plan back.
    const baton = run(['baton', '--message', 'next'], { sid: 'session-rel' });
    strictEqual(baton.status, 0, baton.stderr);
    match(baton.stderr, /Baton passed.*doc-relative/);
  });

  // A linked plan that cannot be claimed must not withhold the BODY. Refusing
  // the whole consumption deadlocked the loop baton exists to close: baton
  // stamps the link and parks the plan in one breath, and only `active` and
  // `planned` are startable — so every other release status produced a prompt
  // `use` refused forever, while the SessionStart hud kept telling each new
  // session to run exactly that command.
  it('stale linked plan still delivers the body, and says why it did not claim', () => {
    writeFileSync(path.join(docsDir, 'prompts', 'resume-ghost.md'),
      '---\ntype: prompt\nstatus: pending\nplan: docs/plans/ghost.md\n---\n# resume\n\nGHOST-BODY\n');
    const r = run(['use', 'resume-ghost.md']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /GHOST-BODY/);
    match(r.stderr, /Not claimed.*missing/);
    ok(existsSync(path.join(docsDir, 'prompts', 'archived', 'resume-ghost.md')), 'prompt was consumed');
  });

  for (const status of ['paused', 'awaiting', 'partial', 'blocked', 'queued-after']) {
    it(`a plan parked as ${status} by baton yields a prompt the next session can still consume`, () => {
      writePlan('parked', { status: 'active' });
      run(['use', 'docs/plans/parked.md'], { sid: 'first' });
      const b = run(['baton', '--status', status, '--message', 'PARKED-BODY'], { sid: 'first' });
      strictEqual(b.status, 0, b.stderr);

      const r = run(['use'], { sid: 'second' });
      strictEqual(r.status, 0, r.stderr);
      match(r.stdout, /PARKED-BODY/, 'the body is the point of a saved prompt');
      match(r.stderr, new RegExp(`Not claimed.*is ${status}`));
      match(r.stderr, /runlist set active/, 'says how to unpark it');
    });
  }

  it('a release status that files the plan elsewhere repoints the prompt link', () => {
    appendFileSync(configPath, "export const lifecycle = { filedStatuses: { paused: 'held' } };\n");
    // Explicit filing moves paused plans into docs/plans/held/. The
    // prompt is created inside the same transaction with its final plan link.
    writePlan('filed', { status: 'active' });
    run(['use', 'docs/plans/filed.md'], { sid: 'first' });
    strictEqual(run(['baton', '--status', 'paused', '--message', 'x'], { sid: 'first' }).status, 0);

    ok(existsSync(path.join(plansDir, 'held', 'filed.md')), 'precondition: paused files the plan');
    const prompt = readFileSync(path.join(docsDir, 'prompts', 'resume-filed.md'), 'utf8');
    match(prompt, /^plan: docs\/plans\/held\/filed\.md$/m, 'link points at where the plan actually is');
  });

  it('publishes the filed plan link inside the move transaction and rolls both back on failure', async () => {
    appendFileSync(configPath, "export const lifecycle = { filedStatuses: { paused: 'held' } };\n");
    const source = writePlan('filed-atomic', { status: 'active' });
    strictEqual(run(['use', 'docs/plans/filed-atomic.md'], { sid: 'first' }).status, 0);
    const config = await resolveConfig(tmpDir, configPath);
    const promptPath = path.join(docsDir, 'prompts', 'resume-filed-atomic.md');
    const previous = process.env.DOTMD_SESSION_ID;
    process.env.DOTMD_SESSION_ID = 'first';
    try {
      await rejects(runBaton([source, '--status', 'paused', '--message', 'continue'], config, {
        testHooks: { afterMovePublish: () => {
          match(readFileSync(promptPath, 'utf8'), /^plan: docs\/plans\/held\/filed-atomic\.md$/m);
          throw new Error('abort filed baton');
        } },
      }), /abort filed baton/);
    } finally {
      if (previous === undefined) delete process.env.DOTMD_SESSION_ID;
      else process.env.DOTMD_SESSION_ID = previous;
    }
    match(readFileSync(source, 'utf8'), /^status: in-session$/m);
    ok(!existsSync(path.join(plansDir, 'held', 'filed-atomic.md')));
    ok(!existsSync(promptPath));
  });

  it('an unclaimable link does not stop a startable one from being claimed', () => {
    writePlan('live', { status: 'active' });
    writeFileSync(path.join(docsDir, 'prompts', 'resume-live.md'),
      '---\ntype: prompt\nstatus: pending\nplan: docs/plans/live.md\n---\n# resume\n\nLIVE-BODY\n');
    const r = run(['use', 'resume-live.md'], { sid: 'claimer' });
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /Claimed.*live\.md/);
    ok(!/Not claimed/.test(r.stderr), 'no skip notice when the claim succeeded');
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
    match(r.stderr, /runlist baton <slug>/);
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

  it('--subagent saves a child slug once and reports the actual name', () => {
    const r = run(['baton', '--subagent', 'subagent-totals-review', '--message', 'continue review', '--json']);
    strictEqual(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    strictEqual(result.savedPrompt, 'subagent-totals-review');
    strictEqual(result.prompt, 'docs/prompts/subagent-totals-review.md');
    match(readFileSync(path.join(tmpDir, result.prompt), 'utf8'), /continue review/);
    ok(!existsSync(path.join(docsDir, 'prompts', 'subagent-subagent-totals-review.md')));
  });

  it('prints a child draft without creating files and saves its parent metadata when filled', () => {
    const originalConfig = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, 'throw new Error("Template generation must not execute repository configuration");\n');
    const result = run(['baton', '--subagent', '--template', '--parent', 'resume-session']);
    writeFileSync(configPath, originalConfig);
    strictEqual(result.status, 0, result.stderr);
    match(result.stdout, /^parent_prompt: resume-session$/m);
    for (const heading of ['Task', 'State', 'Next', 'Evidence', 'Boundaries']) match(result.stdout, new RegExp(`^## ${heading}$`, 'm'));
    ok(!existsSync(path.join(tmpDir, '.runlist')), 'template generation is read-only');
    const draft = path.join(tmpDir, 'child-draft.md');
    writeFileSync(draft, result.stdout.replace('<!-- One sentence: the bounded job and its owning plan or brief. -->', 'Review the document editor.'));
    const saved = run(['baton', '--subagent', 'editor-review', `@${draft}`, '--json']);
    strictEqual(saved.status, 0, saved.stderr);
    strictEqual(JSON.parse(saved.stdout).parentPrompt, 'resume-session');
    match(readFileSync(path.join(docsDir, 'prompts/subagent-editor-review.md'), 'utf8'), /^parent_prompt: resume-session$/m);
    const retry = run(['baton', '--subagent', 'editor-review', `@${draft}`, '--replace', '--json']);
    strictEqual(retry.status, 0, retry.stderr);
    strictEqual(JSON.parse(retry.stdout).disposition, 'already-current');
    ok(!existsSync(path.join(docsDir, 'prompts/archived/subagent-editor-review.md')));
  });

  it('prints a main resume draft without executing configuration or inheriting child parent context', () => {
    writeFileSync(configPath, 'throw new Error("No JavaScript during draft generation");\n');
    const result=run(['baton','--template','--json'],{env:{RUNLIST_PARENT_PROMPT:'invalid-parent-for-main-draft'}});
    strictEqual(result.status,0,result.stderr);
    const draft=JSON.parse(result.stdout);strictEqual(draft.name,'resume');strictEqual(draft.parentPrompt,null);
    match(draft.template,/## State and next move/);match(draft.template,/Outstanding decisions, answers or approvals/);
    ok(!existsSync(path.join(tmpDir,'.runlist')));
    for(const flags of [['--status','paused'],['--force'],['--note','why']]) ok(run(['baton','--template',...flags]).status!==0);
  });

  it('inherits explicit parent context without replacing a retained link or overriding --parent', () => {
    const env = { RUNLIST_PARENT_PROMPT: 'resume-inherited' };
    let result = run(['baton', '--subagent', 'review-env', '--message', 'continue', '--json'], { env });
    strictEqual(result.status, 0, result.stderr);
    strictEqual(JSON.parse(result.stdout).parentPrompt, 'resume-inherited');
    result = run(['baton', '--subagent', 'review-env', '--replace', '--message', 'updated', '--json'], { env: { RUNLIST_PARENT_PROMPT: 'resume-different' } });
    strictEqual(result.status, 0, result.stderr);
    strictEqual(JSON.parse(result.stdout).parentPrompt, 'resume-inherited');
    result = run(['baton', '--subagent', 'review-explicit', '--parent', 'resume-explicit', '--message', 'continue', '--json'], { env });
    strictEqual(result.status, 0, result.stderr);
    strictEqual(JSON.parse(result.stdout).parentPrompt, 'resume-explicit');
  });

  it('rejects an unfilled template parent and explains an unlinked legacy save', () => {
    const draft = run(['baton', '--subagent', '--template']);
    strictEqual(draft.status, 0, draft.stderr);
    const file = path.join(tmpDir, 'unfilled.md');
    writeFileSync(file, draft.stdout);
    ok(run(['baton', '--subagent', 'unfilled', `@${file}`]).status !== 0);
    const legacy = run(['baton', '--subagent', 'unlinked', '--message', 'continue']);
    strictEqual(legacy.status, 0, legacy.stderr);
    match(legacy.stderr, /no parent link/);
  });

  it('refuses child metadata in a main resume draft before saving', () => {
    const result=run(['baton','session','--message','---\nparent_prompt: resume-other\n---\nContinue the work.\n']);
    ok(result.status!==0);match(result.stderr,/parent_prompt requires --subagent/);
    ok(!existsSync(path.join(docsDir,'prompts/resume-session.md')));
  });

  it('--parent binds child prompts before the parent is saved and survives replacement', () => {
    const args = ['baton', '--subagent', 'review', '--parent', 'resume-session.md', '--message', 'continue review'];
    const preview = run([...args, '--dry-run', '--json']);
    strictEqual(preview.status, 0, preview.stderr);
    const prompt = path.join(docsDir, 'prompts', 'subagent-review.md');
    ok(!existsSync(prompt));
    const saved = run(args);
    strictEqual(saved.status, 0, saved.stderr);
    match(readFileSync(prompt, 'utf8'), /^parent_prompt: resume-session$/m);
    strictEqual(run(['baton', 'session', '--message', 'parent work']).status, 0);
    const listed = run(['prompts']);
    strictEqual(listed.status, 0, listed.stderr);
    match(listed.stdout, /resume-session[^\n]*\[\+1 subagent\]/);
    ok(!listed.stdout.includes('subagent-review'));
    const replaced = run(['baton', '--subagent', 'review', '--replace', '--message', 'updated review']);
    strictEqual(replaced.status, 0, replaced.stderr);
    match(readFileSync(prompt, 'utf8'), /^parent_prompt: resume-session$/m);
    const reparented = run(['baton', '--subagent', 'review', '--parent', 'resume-other', '--replace', '--message', 'updated review']);
    strictEqual(reparented.status, 0, reparented.stderr);
    match(readFileSync(prompt, 'utf8'), /^parent_prompt: resume-other$/m);
  });

  it('--parent also binds a child owning a dedicated plan', () => {
    const plan = writePlan('review-plan', { status: 'active' });
    const result = run(['baton', '--subagent', plan, '--parent', 'resume-session', '--message', 'continue', '--json']);
    strictEqual(result.status, 0, result.stderr);
    const source = readFileSync(path.join(tmpDir, JSON.parse(result.stdout).prompt), 'utf8');
    match(source, /^parent_prompt: resume-session$/m);
    match(source, /^plan: docs\/plans\/review-plan.md$/m);
  });

  it('rejects invalid parent names and parent binding without --subagent before writing', () => {
    for (const flags of [
      ['--parent', 'resume-session'],
      ['--subagent', '--parent', '../resume-session.md'],
      ['--subagent', '--parent', 'subagent-task'],
      ['--subagent', '--parent'],
    ]) {
      const result = run(['baton', 'review', '--message', 'continue', ...flags]);
      ok(result.status !== 0, result.stdout);
      match(result.stderr, /--parent/);
    }
    ok(!existsSync(path.join(docsDir, 'prompts', 'subagent-review.md')));
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-review.md')));
  });

  it('--subagent normalizes the saved name before reporting or checking prefixes', () => {
    const r = run(['baton', '--subagent', 'Subagent-Totals_Review', '--message', 'continue', '--json']);
    strictEqual(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    strictEqual(result.savedPrompt, 'subagent-totals-review');
    ok(existsSync(path.join(tmpDir, result.prompt)));
    strictEqual(path.basename(result.prompt, '.md'), result.savedPrompt);
  });

  it('--subagent previews plan and slug names without releasing or writing', () => {
    const plan = writePlan('child-preview');
    const before = readFileSync(plan, 'utf8');
    for (const target of [plan, 'child-task']) {
      const r = run(['baton', '--subagent', target, '--message', 'continue', '--dry-run', '--json']);
      strictEqual(r.status, 0, r.stderr);
      const result = JSON.parse(r.stdout);
      strictEqual(result.savedPrompt, target === plan ? 'subagent-child-preview' : 'subagent-child-task');
      strictEqual(result.dryRun, true);
      ok(!existsSync(path.join(tmpDir, result.prompt)));
    }
    strictEqual(readFileSync(plan, 'utf8'), before);
    ok(!existsSync(path.join(tmpDir, '.runlist', 'handoffs')));
  });

  it('rejects contradictory and nested prefixes before writing', () => {
    for (const [slug, flags] of [
      ['subagent-task', []], ['resume-task', ['--subagent']],
      ['Subagent-task', []], ['Resume-task', ['--subagent']],
      ['resume-resume-task', []], ['subagent-subagent-task', ['--subagent']],
      ['resume-subagent-task', []], ['subagent-resume-task', ['--subagent']],
    ]) {
      const r = run(['baton', slug, ...flags, '--message', 'continue']);
      ok(r.status !== 0, slug);
      match(r.stderr, /Nothing saved:/);
    }
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-subagent-task.md')));
    ok(!existsSync(path.join(docsDir, 'prompts', 'subagent-resume-task.md')));
    const plan = writePlan('resume-conflict');
    const before = readFileSync(plan, 'utf8');
    ok(run(['baton', '--subagent', plan, '--message', 'continue']).status !== 0);
    strictEqual(readFileSync(plan, 'utf8'), before);
  });

  it('--subagent respects a parent claim and task slugs leave it owned', () => {
    const plan = writePlan('parent-work', { status: 'active' });
    strictEqual(run(['use', plan], { sid: 'parent' }).status, 0);
    const before = readFileSync(plan, 'utf8');
    const denied = run(['baton', '--subagent', plan, '--message', 'continue'], { sid: 'child' });
    ok(denied.status !== 0);
    ok(!existsSync(path.join(docsDir, 'prompts', 'subagent-parent-work.md')));
    const child = run(['baton', '--subagent', 'review-task', '--message', 'continue'], { sid: 'child' });
    strictEqual(child.status, 0, child.stderr);
    match(child.stderr, /subagent-review-task/);
    strictEqual(readFileSync(plan, 'utf8'), before);
    const owner = run(['baton', '--message', 'continue parent'], { sid: 'parent' });
    strictEqual(owner.status, 0, owner.stderr);
    ok(existsSync(path.join(docsDir, 'prompts', 'resume-parent-work.md')));
  });

  it('--subagent releases its owned plan and blocks another prefix for that plan', () => {
    const plan = writePlan('child-owned', { status: 'active' });
    writeFileSync(plan, readFileSync(plan, 'utf8').replace('title:', 'next_step: Finish child review\ntitle:'));
    strictEqual(run(['use', plan], { sid: 'child' }).status, 0);
    const r = run(['baton', '--subagent', '--message', 'continue child', '--json'], { sid: 'child' });
    strictEqual(r.status, 0, r.stderr);
    const result = JSON.parse(r.stdout);
    strictEqual(result.savedPrompt, 'subagent-child-owned');
    strictEqual(result.claimRelease.released, true);
    const handoffs = path.join(tmpDir, '.runlist', 'handoffs');
    const pending = readdirSync(handoffs).map(f => JSON.parse(readFileSync(path.join(handoffs, f), 'utf8'))).find(r => r.plan === 'docs/plans/child-owned.md');
    strictEqual(pending.name, result.savedPrompt);
    strictEqual(pending.prompt, result.prompt);
    match(readFileSync(plan, 'utf8'), /^status: active$/m);
    const duplicate = run(['baton', plan, '--message', 'parent attempt']);
    ok(duplicate.status !== 0);
    match(duplicate.stderr, /already pending/);
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-child-owned.md')));
  });

  it('--subagent cannot replace a parent prompt but preserves a legacy alias', () => {
    const plan = writePlan('replacement-work');
    const parent = path.join(docsDir, 'prompts', 'resume-replacement-work.md');
    const old = '---\ntype: prompt\nstatus: pending\nplan: ../plans/replacement-work.md\n---\nold notes\n';
    writeFileSync(parent, old);
    const before = readFileSync(plan, 'utf8');
    for (const flags of [[], ['--replace'], ['--replace', '--dry-run']]) {
      const r = run(['baton', '--subagent', plan, ...flags, '--message', 'new notes']);
      ok(r.status !== 0);
      match(r.stderr, flags.length ? /is a parent handoff/ : /already pending/);
    }
    strictEqual(readFileSync(parent, 'utf8'), old);
    strictEqual(readFileSync(plan, 'utf8'), before);
    ok(!existsSync(path.join(docsDir, 'prompts', 'archived')));
    // A differently named legacy prompt linked to another plan keeps its identity.
    const legacyPlan = writePlan('legacy-work');
    const legacy = path.join(docsDir, 'prompts', 'old-review.md');
    writeFileSync(legacy, old.replace('replacement-work.md', 'legacy-work.md'));
    const replaced = run(['baton', '--subagent', legacyPlan, '--replace', '--message', 'new notes', '--json']);
    strictEqual(replaced.status, 0, replaced.stderr);
    strictEqual(JSON.parse(replaced.stdout).savedPrompt, 'old-review');
    match(readFileSync(legacy, 'utf8'), /new notes/);
    ok(existsSync(path.join(docsDir, 'prompts', 'archived', 'old-review.md')));
    ok(!existsSync(path.join(docsDir, 'prompts', 'subagent-legacy-work.md')));
  });

  it('competing parent and child plan batons publish only one pending handoff', async () => {
    const plan = writePlan('competing-work', { status: 'active' });
    const results = await Promise.all([
      runAsync(['baton', plan, '--message', 'parent draft']),
      runAsync(['baton', '--subagent', plan, '--message', 'child draft']),
    ]);
    strictEqual(results.filter(r => r.status === 0).length, 1, JSON.stringify(results));
    const prompts = ['resume-competing-work.md', 'subagent-competing-work.md'];
    strictEqual(prompts.filter(name => existsSync(path.join(docsDir, 'prompts', name))).length, 1);
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

  it('refuses a plan handoff when its prompt is already pending — nothing mutates', () => {
    writePlan('auth-revamp');
    const older = path.join(docsDir, 'prompts', 'resume-auth-revamp.md');
    writeFileSync(older, '---\ntype: prompt\nstatus: pending\n---\nolder handoff\n');
    const r = run(['baton', 'docs/plans/auth-revamp.md', '--message', 'newer handoff']);
    ok(r.status !== 0, 'refused');
    match(r.stderr, /already pending:\n  docs\/prompts\/resume-auth-revamp\.md/);
    match(r.stderr, /--replace/);
    match(r.stderr, /runlist prompts show resume-auth-revamp/);
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-auth-revamp-2.md')), 'no -2 copy');
    ok(readFileSync(older, 'utf8').includes('older handoff'), 'older prompt untouched');
    ok(readFileSync(path.join(plansDir, 'auth-revamp.md'), 'utf8').includes('status: in-session'), 'plan untouched');
  });

  it('--replace archives one old handoff and refreshes the pending prompt with the plan release', () => {
    const plan = writePlan('replace-plan');
    const prompt = path.join(docsDir, 'prompts', 'resume-replace-plan.md');
    writeFileSync(prompt, '---\ntype: prompt\nstatus: pending\nplan: ../plans/replace-plan.md\n---\nold notes\n');
    const r = run(['baton', plan, '--replace', '--message', 'new notes']);
    strictEqual(r.status, 0, r.stderr);
    match(readFileSync(plan, 'utf8'), /^status: active$/m);
    match(readFileSync(prompt, 'utf8'), /new notes/);
    const archived = readFileSync(path.join(docsDir, 'prompts', 'archived', 'resume-replace-plan.md'), 'utf8');
    match(archived, /^status: archived$/m);
    match(archived, /old notes/);
  });

  it('--replace refuses when there is no pending handoff', () => {
    const plan = writePlan('nothing-to-replace');
    const before = readFileSync(plan, 'utf8');
    const r = run(['baton', plan, '--replace', '--message', 'new notes']);
    ok(r.status !== 0);
    match(r.stderr, /No pending handoff matches this work/);
    strictEqual(readFileSync(plan, 'utf8'), before);
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-nothing-to-replace.md')));
  });

  it('--replace respects a live plan claim and releases it only for the owner', () => {
    writePlan('claimed-replace', { status: 'active' });
    strictEqual(run(['use', 'docs/plans/claimed-replace.md'], { sid: 'owner' }).status, 0);
    const prompt = path.join(docsDir, 'prompts', 'resume-claimed-replace.md');
    writeFileSync(prompt, '---\ntype: prompt\nstatus: pending\nplan: ../plans/claimed-replace.md\n---\nold notes\n');
    const denied = run(['baton', 'docs/plans/claimed-replace.md', '--replace', '--message', 'new notes'], { sid: 'other' });
    ok(denied.status !== 0);
    match(denied.stderr, /busy in another session/);
    match(readFileSync(prompt, 'utf8'), /old notes/);
    ok(!existsSync(path.join(docsDir, 'prompts', 'archived', 'resume-claimed-replace.md')));
    const owner = run(['baton', 'docs/plans/claimed-replace.md', '--replace', '--message', 'new notes'], { sid: 'owner' });
    strictEqual(owner.status, 0, owner.stderr);
    match(readFileSync(prompt, 'utf8'), /new notes/);
    match(readFileSync(path.join(plansDir, 'claimed-replace.md'), 'utf8'), /^status: active$/m);
  });

  it('--replace keeps a differently named pending prompt and refuses ambiguous matches', () => {
    const plan = writePlan('replace-alias');
    const first = path.join(docsDir, 'prompts', 'resume-replace-alias-5.md');
    writeFileSync(first, '---\ntype: prompt\nstatus: pending\nplan: ../plans/replace-alias.md\n---\nold notes\n');
    const replaced = run(['baton', plan, '--replace', '--message', 'new notes']);
    strictEqual(replaced.status, 0, replaced.stderr);
    match(readFileSync(first, 'utf8'), /new notes/);
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-replace-alias.md')));
    const second = path.join(docsDir, 'prompts', 'resume-replace-alias-extra.md');
    writeFileSync(second, '---\ntype: prompt\nstatus: pending\nplan: ../plans/replace-alias.md\n---\nother notes\n');
    const refused = run(['baton', plan, '--replace', '--message', 'third notes']);
    ok(refused.status !== 0);
    match(refused.stderr, /requires exactly one pending handoff/);
    match(readFileSync(first, 'utf8'), /new notes/);
    match(readFileSync(second, 'utf8'), /other notes/);
  });

  it('--replace works in slug mode and an identical retry keeps one archive', () => {
    const old = run(['baton', 'quick-task', '--message', 'first notes']);
    strictEqual(old.status, 0, old.stderr);
    const prompt = path.join(docsDir, 'prompts', 'resume-quick-task.md');
    const replacement = run(['baton', 'quick-task', '--replace', '--message', 'second notes']);
    strictEqual(replacement.status, 0, replacement.stderr);
    match(readFileSync(prompt, 'utf8'), /second notes/);
    const archivedDir = path.join(docsDir, 'prompts', 'archived');
    strictEqual(readFileSync(path.join(archivedDir, 'resume-quick-task.md'), 'utf8').includes('first notes'), true);
    const retry = run(['baton', 'quick-task', '--replace', '--message', 'second notes']);
    strictEqual(retry.status, 0, retry.stderr);
    ok(!existsSync(path.join(archivedDir, 'resume-quick-task-2.md')));
  });

  it('--replace preserves an existing archive name and reports the replacement in JSON', () => {
    const plan = writePlan('collision');
    const prompt = path.join(docsDir, 'prompts', 'resume-collision.md');
    const archivedDir = path.join(docsDir, 'prompts', 'archived');
    mkdirSync(archivedDir, { recursive: true });
    writeFileSync(prompt, '---\ntype: prompt\nstatus: pending\nplan: ../plans/collision.md\n---\nold pending\n');
    writeFileSync(path.join(archivedDir, 'resume-collision.md'), 'historic archive');
    const preview = run(['baton', plan, '--replace', '--message', 'new pending', '--dry-run', '--json']);
    strictEqual(preview.status, 0, preview.stderr);
    const predicted = JSON.parse(preview.stdout);
    strictEqual(predicted.replacement.previousPrompt, 'docs/prompts/resume-collision.md');
    strictEqual(predicted.replacement.archivedPrompt, 'docs/prompts/archived/resume-collision-2.md');
    strictEqual(predicted.replacement.pendingPrompt, 'docs/prompts/resume-collision.md');
    match(readFileSync(prompt, 'utf8'), /old pending/);
    ok(!existsSync(path.join(archivedDir, 'resume-collision-2.md')));

    const applied = run(['baton', plan, '--replace', '--message', 'new pending', '--json']);
    strictEqual(applied.status, 0, applied.stderr);
    const result = JSON.parse(applied.stdout);
    strictEqual(result.replacement.archivedPrompt, 'docs/prompts/archived/resume-collision-2.md');
    ok(result.sessionFiles.includes('docs/prompts/archived/resume-collision-2.md'));
    strictEqual(readFileSync(path.join(archivedDir, 'resume-collision.md'), 'utf8'), 'historic archive');
    match(readFileSync(path.join(archivedDir, 'resume-collision-2.md'), 'utf8'), /old pending/);
  });

  it('--replace rolls the pending prompt, archive copy, and plan back on a transaction failure', async () => {
    const plan = writePlan('replace-rollback');
    const prompt = path.join(docsDir, 'prompts', 'resume-replace-rollback.md');
    const original = '---\ntype: prompt\nstatus: pending\nplan: ../plans/replace-rollback.md\n---\nold pending\n';
    writeFileSync(prompt, original);
    const config = await resolveConfig(tmpDir, configPath);
    await withSessionIdentity(() => rejects(runBaton([plan, '--replace', '--message', 'new pending'], config, {
      testHooks: { afterSetCommit: count => { if (count === 2) throw new Error('abort replacement'); } },
    }), /abort replacement/));
    strictEqual(readFileSync(prompt, 'utf8'), original);
    match(readFileSync(plan, 'utf8'), /^status: in-session$/m);
    ok(!existsSync(path.join(docsDir, 'prompts', 'archived', 'resume-replace-rollback.md')));
  });

  it('--replace in slug mode rolls back and refuses a plan-linked handoff', async () => {
    const first = run(['baton', 'slug-rollback', '--message', 'old pending']);
    strictEqual(first.status, 0, first.stderr);
    const prompt = path.join(docsDir, 'prompts', 'resume-slug-rollback.md');
    const original = readFileSync(prompt, 'utf8');
    const config = await resolveConfig(tmpDir, configPath);
    await withSessionIdentity(() => rejects(runBaton(['slug-rollback', '--replace', '--message', 'new pending'], config, {
      testHooks: { afterSetCommit: count => { if (count === 2) throw new Error('abort slug replacement'); } },
    }), /abort slug replacement/));
    strictEqual(readFileSync(prompt, 'utf8'), original);
    ok(!existsSync(path.join(docsDir, 'prompts', 'archived', 'resume-slug-rollback.md')));

    writeFileSync(prompt, original.replace('status: pending', 'status: pending\nplan: ../plans/some-plan.md'));
    const linked = run(['baton', 'slug-rollback', '--replace', '--message', 'new pending']);
    ok(linked.status !== 0);
    match(linked.stderr, /links a plan/);
    match(readFileSync(prompt, 'utf8'), /old pending/);
  });

  it('--replace with a filed plan links both the refreshed and archived prompts to the final path', () => {
    appendFileSync(configPath, "export const lifecycle = { filedStatuses: { paused: 'held' } };\n");
    writePlan('replace-filed', { status: 'active' });
    strictEqual(run(['use', 'docs/plans/replace-filed.md'], { sid: 'first' }).status, 0);
    const alias = path.join(docsDir, 'prompts', 'resume-replace-filed-5.md');
    writeFileSync(alias, '---\ntype: prompt\nstatus: pending\nplan: ../plans/replace-filed.md\n---\nold pending\n');
    const preview = run(['baton', 'docs/plans/replace-filed.md', '--status', 'paused', '--replace', '--message', 'new pending', '--dry-run', '--json'], { sid: 'first' });
    strictEqual(preview.status, 0, preview.stderr);
    const predicted = JSON.parse(preview.stdout);
    strictEqual(predicted.planMovement.to, 'docs/plans/held/replace-filed.md');
    strictEqual(predicted.claimRelease.wouldRelease, true);
    ok(!existsSync(path.join(plansDir, 'held', 'replace-filed.md')));
    const r = run(['baton', 'docs/plans/replace-filed.md', '--status', 'paused', '--replace', '--message', 'new pending'], { sid: 'first' });
    strictEqual(r.status, 0, r.stderr);
    const archived = path.join(docsDir, 'prompts', 'archived', 'resume-replace-filed-5.md');
    match(readFileSync(alias, 'utf8'), /^plan: docs\/plans\/held\/replace-filed\.md$/m);
    match(readFileSync(archived, 'utf8'), /^plan: docs\/plans\/held\/replace-filed\.md$/m);
    ok(existsSync(path.join(plansDir, 'held', 'replace-filed.md')));
  });

  it('--replace refreshes a filed plan link even when the draft body is unchanged', () => {
    appendFileSync(configPath, "export const lifecycle = { filedStatuses: { paused: 'held' } };\n");
    writePlan('same-body-filed', { status: 'active' });
    strictEqual(run(['use', 'docs/plans/same-body-filed.md'], { sid: 'first' }).status, 0);
    const prompt = path.join(docsDir, 'prompts', 'resume-same-body-filed.md');
    writeFileSync(prompt, '---\ntype: prompt\nstatus: pending\nplan: ../plans/same-body-filed.md\n---\nsame text\n');
    const r = run(['baton', 'docs/plans/same-body-filed.md', '--status', 'paused', '--replace', '--message', 'same text'], { sid: 'first' });
    strictEqual(r.status, 0, r.stderr);
    match(readFileSync(prompt, 'utf8'), /^plan: docs\/plans\/held\/same-body-filed\.md$/m);
  });

  it('concurrent --replace writers leave one complete pending handoff', async () => {
    const plan = writePlan('replace-race', { status: 'awaiting' });
    const prompt = path.join(docsDir, 'prompts', 'resume-replace-race.md');
    writeFileSync(prompt, '---\ntype: prompt\nstatus: pending\nplan: ../plans/replace-race.md\n---\nold notes\n');
    const results = await Promise.all([
      runAsync(['baton', plan, '--replace', '--message', 'writer alpha']),
      runAsync(['baton', plan, '--replace', '--message', 'writer beta']),
    ]);
    ok(results.some(result => result.status === 0), results.map(result => result.stderr).join('\n'));
    const pending = readFileSync(prompt, 'utf8');
    ok(pending.includes('writer alpha') !== pending.includes('writer beta'), 'one whole writer body published');
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-replace-race-2.md')));
  });

  it('refuses a plan handoff when a differently named pending prompt links the same plan', () => {
    writePlan('auth-revamp');
    writeFileSync(path.join(docsDir, 'prompts', 'resume-auth-revamp-5.md'),
      '---\ntype: prompt\nstatus: pending\nplan: ../plans/auth-revamp.md\n---\nolder handoff\n');
    const r = run(['baton', 'docs/plans/auth-revamp.md', '--message', 'newer handoff']);
    ok(r.status !== 0, 'refused');
    match(r.stderr, /docs\/prompts\/resume-auth-revamp-5\.md/);
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-auth-revamp.md')), 'nothing saved');
    ok(readFileSync(path.join(plansDir, 'auth-revamp.md'), 'utf8').includes('status: in-session'), 'plan untouched');
  });

  it('an archived prompt for the same plan does not block a new handoff', () => {
    writePlan('auth-revamp');
    mkdirSync(path.join(docsDir, 'prompts', 'archived'), { recursive: true });
    writeFileSync(path.join(docsDir, 'prompts', 'archived', 'resume-auth-revamp.md'),
      '---\ntype: prompt\nstatus: archived\nplan: docs/plans/auth-revamp.md\n---\nold\n');
    const r = run(['baton', 'docs/plans/auth-revamp.md', '--message', 'newer handoff']);
    strictEqual(r.status, 0, r.stderr);
    ok(readFileSync(path.join(docsDir, 'prompts', 'resume-auth-revamp.md'), 'utf8').includes('newer handoff'));
  });

  it('slug mode refuses when resume-<slug> is already pending', () => {
    const older = path.join(docsDir, 'prompts', 'resume-side-quest.md');
    writeFileSync(older, '---\ntype: prompt\nstatus: pending\n---\nolder handoff\n');
    const r = run(['baton', 'side-quest', '--message', 'newer handoff']);
    ok(r.status !== 0, 'refused');
    match(r.stderr, /already pending:\n  docs\/prompts\/resume-side-quest\.md/);
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-side-quest-2.md')), 'no -2 copy');
    ok(readFileSync(older, 'utf8').includes('older handoff'), 'older prompt untouched');
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
    match(r.stderr, /runlist bulk-tag docs\/plans\/legacy\.md/);
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
    ok(value.sessionFiles.some(item => item.startsWith('.runlist/ownership/')));
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

describe('runlist hud --json owned', () => {
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

describe('runlist baton: the plan update after the prompt, and the name last', () => {
  beforeEach(() => setupProject());

  function writePlanWithNextStep(name, nextStep) {
    const file = path.join(plansDir, `${name}.md`);
    writeFileSync(file, `---\ntype: plan\nstatus: in-session\ntitle: ${name}\nnext_step: ${nextStep}\n---\n# ${name}\n\nbody\n`);
    spawnSync('git', ['add', file], { cwd: tmpDir });
    spawnSync('git', ['commit', '-qm', `add ${name}`], { cwd: tmpDir });
    return file;
  }
  const lastLine = text => text.trim().split('\n').at(-1);

  it('saves the prompt first, then refuses done until next_step changes', () => {
    const plan = writePlanWithNextStep('widget', 'build the frame');
    const r = run(['baton', 'docs/plans/widget.md', '--message', 'resume: the frame is half built']);
    strictEqual(r.status, 0, r.stderr);
    ok(existsSync(path.join(docsDir, 'prompts', 'resume-widget.md')), 'prompt saved before anything else is asked');
    match(r.stderr, /Prompt saved/);
    ok(!/Baton passed/.test(r.stderr), `not reported as a finished handoff:\n${r.stderr}`);
    match(r.stderr, /Handoff not done yet/);
    match(r.stderr, /runlist baton --done docs\/plans\/widget\.md/);
    strictEqual(lastLine(r.stderr), 'Saved prompt: resume-widget');

    const early = run(['baton', '--done', 'docs/plans/widget.md']);
    ok(early.status !== 0, 'done refused while next_step is unchanged');
    match(early.stderr, /Not done: docs\/plans\/widget\.md next_step is the same/);
    strictEqual(lastLine(early.stderr), 'Saved prompt: resume-widget');

    writeFileSync(plan, readFileSync(plan, 'utf8').replace('next_step: build the frame', 'next_step: fit the panels'));
    // Another session (a usage stop, then a fresh one) can confirm it by naming the plan.
    const confirmed = run(['baton', '--done', 'docs/plans/widget.md'], { sid: 'other-sid' });
    strictEqual(confirmed.status, 0, confirmed.stderr);
    match(confirmed.stderr, /Handoff done/);
    strictEqual(lastLine(confirmed.stderr), 'Saved prompt: resume-widget');

    const again = run(['baton', '--done', 'docs/plans/widget.md']);
    ok(again.status !== 0, 'the record is gone once confirmed');
  });

  it('bare --done finds this session\'s handoff', () => {
    const plan = writePlanWithNextStep('gadget', 'first');
    strictEqual(run(['baton', 'docs/plans/gadget.md', '--message', 'resume']).status, 0);
    writeFileSync(plan, readFileSync(plan, 'utf8').replace('next_step: first', 'next_step: second'));
    ok(run(['baton', '--done'], { sid: 'someone-else' }).status !== 0, 'another session has no handoff of its own');
    const r = run(['baton', '--done']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /Handoff done: docs\/plans\/gadget\.md/);
  });

  // Records are found by the plan they name, not by their file name.
  const handoffsDir = () => path.join(tmpDir, '.runlist', 'handoffs');
  const records = () => existsSync(handoffsDir())
    ? readdirSync(handoffsDir()).filter(f => f.endsWith('.json')).map(f => ({ file: path.join(handoffsDir(), f), ...JSON.parse(readFileSync(path.join(handoffsDir(), f), 'utf8')) }))
    : [];
  const recordOf = repoPath => records().find(r => r.plan === repoPath)?.file ?? path.join(handoffsDir(), 'absent');
  const recordFile = name => recordOf(`docs/plans/${name}.md`);
  const writePlanAt = (repoPath, { title, nextStep }) => {
    const file = path.join(tmpDir, repoPath);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `---\ntype: plan\nstatus: in-session\ntitle: ${title}\nnext_step: ${nextStep}\n---\n# ${title}\n\nbody\n`);
    return file;
  };
  const frontmatterOf = file => readFileSync(file, 'utf8').split('\n---\n')[0];

  it('--next-step writes next_step, removes the record and reports the handoff done', () => {
    const plan = writePlanWithNextStep('sprocket', 'cut the blank');
    strictEqual(run(['baton', 'docs/plans/sprocket.md', '--message', 'resume']).status, 0);
    ok(existsSync(recordFile('sprocket')));
    const r = run(['baton', '--done', '--next-step', 'grind: the teeth #2']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /✓ Handoff done: docs\/plans\/sprocket\.md next_step written/);
    strictEqual(lastLine(r.stderr), 'Saved prompt: resume-sprocket');
    ok(!existsSync(recordFile('sprocket')), 'record removed');
    const fm = frontmatterOf(plan);
    match(fm, /^next_step: >\n {2}grind: the teeth #2$/m);
    ok(!fm.includes('cut the blank'), fm);
    match(readFileSync(plan, 'utf8'), /\n# sprocket\n\nbody\n$/, 'body untouched');
    const shown = run(['query', '--type', 'plan', '--json']);
    ok(shown.stdout.includes('"nextStep": "grind: the teeth #2"'), shown.stdout);
  });

  it('refuses a --next-step equal to the saved one and keeps the record', () => {
    const plan = writePlanWithNextStep('pulley', 'mount the axle');
    strictEqual(run(['baton', 'docs/plans/pulley.md', '--message', 'resume']).status, 0);
    const before = readFileSync(plan, 'utf8');
    const r = run(['baton', '--done', '--next-step', '  mount   the axle ']);
    ok(r.status !== 0, 'whitespace-only differences are the same next_step');
    match(r.stderr, /Not done: --next-step repeats the next_step docs\/plans\/pulley\.md had/);
    strictEqual(lastLine(r.stderr), 'Saved prompt: resume-pulley');
    strictEqual(readFileSync(plan, 'utf8'), before, 'nothing written');
    ok(existsSync(recordFile('pulley')), 'record kept');
  });

  it('rejects empty and multi-line values before touching anything', () => {
    const plan = writePlanWithNextStep('lever', 'find the pivot');
    strictEqual(run(['baton', 'docs/plans/lever.md', '--message', 'resume']).status, 0);
    const before = readFileSync(plan, 'utf8');
    for (const args of [['--next-step', '   '], ['--next-step', 'one\ntwo'], ['--next-step', 'ok', '--current-state', 'a\r\nb']]) {
      const r = run(['baton', '--done', ...args]);
      ok(r.status !== 0, `${args.join(' ')} refused`);
      match(r.stderr, /needs a nonempty value|takes one line/);
    }
    strictEqual(readFileSync(plan, 'utf8'), before);
    ok(existsSync(recordFile('lever')));
  });

  it('creates a next_step key the plan lost after the prompt was saved', () => {
    const plan = writePlanWithNextStep('spindle', 'thread it');
    strictEqual(run(['baton', 'docs/plans/spindle.md', '--message', 'resume']).status, 0);
    writeFileSync(plan, readFileSync(plan, 'utf8').replace('next_step: thread it\n', ''));
    const r = run(['baton', '--done', '--next-step', 'balance it']);
    strictEqual(r.status, 0, r.stderr);
    match(frontmatterOf(plan), /^next_step: >\n {2}balance it$/m);
    ok(!existsSync(recordFile('spindle')));
  });

  it('writes --current-state alongside --next-step, replacing a block value whole', () => {
    const plan = writePlanWithNextStep('ratchet', 'set the pawl');
    writeFileSync(plan, readFileSync(plan, 'utf8').replace('next_step: set the pawl\n', 'next_step: set the pawl\ncurrent_state: |\n  first line\n  second line\nowner: someone\n'));
    strictEqual(run(['baton', 'docs/plans/ratchet.md', '--message', 'resume']).status, 0);
    const r = run(['baton', '--done', '--next-step', 'test the click', '--current-state', 'pawl set']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /next_step and current_state written/);
    const fm = frontmatterOf(plan);
    match(fm, /^current_state: >\n {2}pawl set\nowner: someone$/m);
    ok(!fm.includes('second line'), fm);
  });

  it('--current-state alone never counts as done', () => {
    const plan = writePlanWithNextStep('cam', 'shape the lobe');
    strictEqual(run(['baton', 'docs/plans/cam.md', '--message', 'resume']).status, 0);
    const before = readFileSync(plan, 'utf8');
    const refused = run(['baton', '--done', '--current-state', 'lobe roughed']);
    ok(refused.status !== 0);
    match(refused.stderr, /Not done: docs\/plans\/cam\.md next_step is the same/);
    match(refused.stderr, /--next-step "<next move>"/);
    strictEqual(readFileSync(plan, 'utf8'), before, 'current_state not written by a refused call');
    ok(existsSync(recordFile('cam')));

    writeFileSync(plan, before.replace('next_step: shape the lobe', 'next_step: polish the lobe'));
    const r = run(['baton', '--done', '--current-state', 'lobe roughed']);
    strictEqual(r.status, 0, r.stderr);
    match(frontmatterOf(plan), /^current_state: >\n {2}lobe roughed$/m);
    ok(!existsSync(recordFile('cam')));
  });

  it('each flag without --done is rejected', () => {
    writePlanWithNextStep('gear', 'count the teeth');
    for (const flag of ['--next-step', '--current-state']) {
      const r = run(['baton', 'docs/plans/gear.md', '--message', 'resume', flag, 'value']);
      ok(r.status !== 0, `${flag} without --done`);
      match(r.stderr, new RegExp(`${flag} only goes with --done`));
    }
    ok(!existsSync(path.join(docsDir, 'prompts', 'resume-gear.md')), 'no prompt saved');
  });

  it('--dry-run previews the write and the verdict without changing anything', () => {
    const plan = writePlanWithNextStep('flywheel', 'balance the rim');
    strictEqual(run(['baton', 'docs/plans/flywheel.md', '--message', 'resume']).status, 0);
    const before = readFileSync(plan, 'utf8');
    const record = readFileSync(recordFile('flywheel'), 'utf8');
    const r = run(['baton', '--done', '--next-step', 'mount the rim', '--current-state', 'rim balanced', '--dry-run']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /\[dry-run\] Would write docs\/plans\/flywheel\.md:/);
    match(r.stderr, /\[dry-run\] {3}next_step: >\n\[dry-run\] {5}mount the rim/);
    match(r.stderr, /\[dry-run\] {5}rim balanced/);
    match(r.stderr, /Would report the handoff done and remove its record/);
    strictEqual(readFileSync(plan, 'utf8'), before);
    strictEqual(readFileSync(recordFile('flywheel'), 'utf8'), record);

    const json = run(['baton', '--done', '--next-step', 'mount the rim', '--dry-run', '--json']);
    strictEqual(json.status, 0, json.stderr);
    strictEqual(JSON.parse(json.stdout).dryRun, true);
    strictEqual(readFileSync(plan, 'utf8'), before);

    const plain = run(['baton', '--done', '--dry-run']);
    ok(plain.status !== 0, 'plain --done --dry-run keeps its refusal');
    match(plain.stderr, /changes nothing but its own record/);
  });

  it('--json reports the written fields', () => {
    writePlanWithNextStep('bearing', 'press the race');
    strictEqual(run(['baton', 'docs/plans/bearing.md', '--message', 'resume']).status, 0);
    const r = run(['baton', '--done', '--next-step', 'grease it', '--current-state', 'race pressed', '--json']);
    strictEqual(r.status, 0, r.stderr);
    const value = JSON.parse(r.stdout);
    strictEqual(value.operation, 'baton-done');
    strictEqual(value.dryRun, false);
    strictEqual(value.plan, 'docs/plans/bearing.md');
    strictEqual(value.prompt, 'docs/prompts/resume-bearing.md');
    strictEqual(value.name, 'resume-bearing');
    strictEqual(value.nextStepChanged, true);
    strictEqual(JSON.stringify(value.written), JSON.stringify({ next_step: 'grease it', current_state: 'race pressed' }));
  });

  it('a named plan can be finished from a different session', () => {
    const plan = writePlanWithNextStep('linkage', 'pin the joint');
    strictEqual(run(['baton', 'docs/plans/linkage.md', '--message', 'resume']).status, 0);
    ok(run(['baton', '--done', '--next-step', 'oil the joint'], { sid: 'other-sid' }).status !== 0, 'bare --done finds no record of the other session');
    const r = run(['baton', '--done', 'docs/plans/linkage.md', '--next-step', 'oil the joint'], { sid: 'other-sid' });
    strictEqual(r.status, 0, r.stderr);
    match(frontmatterOf(plan), /oil the joint/);
    ok(!existsSync(recordFile('linkage')));
  });

  it('a moved plan is written at the path it was named by', () => {
    const plan = writePlanWithNextStep('crank', 'turn the shaft');
    strictEqual(run(['baton', 'docs/plans/crank.md', '--message', 'resume']).status, 0);
    mkdirSync(path.join(plansDir, 'moved'));
    const moved = path.join(plansDir, 'moved', 'crank.md');
    writeFileSync(moved, readFileSync(plan, 'utf8'));
    rmSync(plan);
    const gone = run(['baton', '--done', '--next-step', 'key the shaft']);
    ok(gone.status !== 0);
    match(gone.stderr, /docs\/plans\/crank\.md is gone/);
    ok(existsSync(recordFile('crank')));
    const r = run(['baton', '--done', 'docs/plans/moved/crank.md', '--next-step', 'key the shaft']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /Handoff done: docs\/plans\/moved\/crank\.md/);
    match(frontmatterOf(moved), /key the shaft/);
    ok(!existsSync(recordFile('crank')));
  });

  it('a plan sharing only a file name with the handed-off one finishes nothing and writes nothing', () => {
    const original = writePlanAt('docs/plans/widget.md', { title: 'widget', nextStep: 'first' });
    const other = writePlanAt('docs/plans/other/widget.md', { title: 'widget', nextStep: 'unrelated' });
    strictEqual(run(['baton', 'docs/plans/widget.md', '--message', 'resume']).status, 0);
    const before = [readFileSync(original, 'utf8'), readFileSync(other, 'utf8')];
    for (const extra of [[], ['--next-step', 'second']]) {
      const r = run(['baton', '--done', 'docs/plans/other/widget.md', ...extra]);
      ok(r.status !== 0, `refused with ${JSON.stringify(extra)}`);
      match(r.stderr, /No handoff waits on docs\/plans\/other\/widget\.md\. The handoff for a plan of the same file name is docs\/plans\/widget\.md, which is still in place/);
    }
    strictEqual(readFileSync(original, 'utf8'), before[0]);
    strictEqual(readFileSync(other, 'utf8'), before[1], 'the unrelated plan is untouched');
    ok(existsSync(recordOf('docs/plans/widget.md')), 'record kept');
  });

  it('two plans sharing a file name keep separate records', () => {
    const a = writePlanAt('docs/plans/a/widget.md', { title: 'widget a', nextStep: 'first' });
    writePlanAt('docs/plans/b/widget.md', { title: 'widget b', nextStep: 'other' });
    strictEqual(run(['baton', 'docs/plans/a/widget.md', '--message', 'resume a']).status, 0);
    strictEqual(run(['use', 'docs/prompts/resume-widget.md', '--no-claim']).status, 0);
    strictEqual(run(['baton', 'docs/plans/b/widget.md', '--message', 'resume b']).status, 0);
    strictEqual(JSON.stringify(records().map(r => r.plan).sort()), JSON.stringify(['docs/plans/a/widget.md', 'docs/plans/b/widget.md']));
    for (const r of records()) ok(!/[*?:"<>|]/.test(path.basename(r.file)), `${path.basename(r.file)} is a legal NTFS name`);
    const r = run(['baton', '--done', 'docs/plans/a/widget.md', '--next-step', 'second']);
    strictEqual(r.status, 0, r.stderr);
    match(frontmatterOf(a), /second/);
    strictEqual(JSON.stringify(records().map(x => x.plan)), JSON.stringify(['docs/plans/b/widget.md']), 'only a\'s record removed');
  });

  it('reads a record written under the old name-only key, for its own plan only', () => {
    writePlanAt('docs/plans/a/widget.md', { title: 'widget a', nextStep: 'first' });
    const b = writePlanAt('docs/plans/b/widget.md', { title: 'widget b', nextStep: 'first' });
    mkdirSync(handoffsDir(), { recursive: true });
    const legacy = path.join(handoffsDir(), 'widget.json');
    writeFileSync(legacy, JSON.stringify({ plan: 'docs/plans/a/widget.md', prompt: 'docs/prompts/resume-widget.md', name: 'resume-widget', savedAt: '2026-01-01T00:00:00Z', nextStep: JSON.stringify('first'), sessionId: 'test-sid' }) + '\n');
    const before = readFileSync(b, 'utf8');
    const wrong = run(['baton', '--done', 'docs/plans/b/widget.md', '--next-step', 'second']);
    ok(wrong.status !== 0, wrong.stderr);
    strictEqual(readFileSync(b, 'utf8'), before);
    ok(existsSync(legacy));
    const r = run(['baton', '--done', '--next-step', 'second']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /Handoff done: docs\/plans\/a\/widget\.md/);
    ok(!existsSync(legacy), 'legacy record removed once done');
  });

  it('a new baton replaces the old name-keyed record for the same plan', () => {
    writePlanWithNextStep('hinge', 'fit the pin');
    mkdirSync(handoffsDir(), { recursive: true });
    const legacy = path.join(handoffsDir(), 'hinge.json');
    writeFileSync(legacy, JSON.stringify({ plan: 'docs/plans/hinge.md', name: 'resume-old', savedAt: '2026-01-01T00:00:00Z', nextStep: JSON.stringify('fit the pin'), sessionId: 'test-sid' }) + '\n');
    strictEqual(run(['baton', 'docs/plans/hinge.md', '--message', 'resume']).status, 0);
    ok(!existsSync(legacy));
    strictEqual(records().filter(r => r.plan === 'docs/plans/hinge.md').length, 1);
  });

  it('a moved plan is found by file name only when one moved record could be meant, and its title matches', () => {
    writePlanAt('docs/plans/x/axle.md', { title: 'axle x', nextStep: 'first' });
    writePlanAt('docs/plans/y/axle.md', { title: 'axle y', nextStep: 'first' });
    strictEqual(run(['baton', 'docs/plans/x/axle.md', '--message', 'resume x']).status, 0);
    strictEqual(run(['use', 'docs/prompts/resume-axle.md', '--no-claim']).status, 0);
    strictEqual(run(['baton', 'docs/plans/y/axle.md', '--message', 'resume y']).status, 0);
    rmSync(path.join(plansDir, 'x'), { recursive: true });
    rmSync(path.join(plansDir, 'y'), { recursive: true });
    const moved = writePlanAt('docs/plans/z/axle.md', { title: 'axle x', nextStep: 'first' });
    const before = readFileSync(moved, 'utf8');
    const ambiguous = run(['baton', '--done', 'docs/plans/z/axle.md', '--next-step', 'second']);
    ok(ambiguous.status !== 0);
    match(ambiguous.stderr, /2 handoffs for moved plans of that file name could be meant/);
    strictEqual(readFileSync(moved, 'utf8'), before);
    strictEqual(records().length, 2);

    rmSync(recordOf('docs/plans/y/axle.md'));
    writeFileSync(moved, before.replace('title: axle x', 'title: some other axle'));
    const stranger = run(['baton', '--done', 'docs/plans/z/axle.md', '--next-step', 'second']);
    ok(stranger.status !== 0);
    match(stranger.stderr, /is not the plan the handoff was saved for/);
    ok(existsSync(recordOf('docs/plans/x/axle.md')));

    writeFileSync(moved, before);
    const r = run(['baton', '--done', 'docs/plans/z/axle.md', '--next-step', 'second']);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(records().length, 0);
  });

  it('plain --done treats a whitespace-only next_step change as unchanged', () => {
    const plan = writePlanWithNextStep('shim', 'first step');
    strictEqual(run(['baton', 'docs/plans/shim.md', '--message', 'resume']).status, 0);
    writeFileSync(plan, readFileSync(plan, 'utf8').replace('next_step: first step', 'next_step: "first   step "'));
    const r = run(['baton', '--done']);
    ok(r.status !== 0, r.stderr);
    match(r.stderr, /Not done: docs\/plans\/shim\.md next_step is the same/);
    ok(existsSync(recordFile('shim')));
  });

  it('decides on the plan as it stands under the lock, so a refused --current-state publishes nothing', async () => {
    const plan = writePlanWithNextStep('cog', 'first');
    strictEqual(run(['baton', 'docs/plans/cog.md', '--message', 'resume']).status, 0);
    const baseline = readFileSync(plan, 'utf8');
    writeFileSync(plan, baseline.replace('next_step: first', 'next_step: second'));
    const locksDir = path.join(tmpDir, '.runlist', 'locks');
    const lockCount = () => existsSync(locksDir) ? readdirSync(locksDir).filter(f => f.endsWith('.lock')).length : 0;
    let child;
    // Hold the plan's lock; once the command holds the record's lock too it is
    // past its unlocked reads and waiting on the plan. A writer restores the
    // saved next_step in that gap.
    withPathLocks([plan], { repoRoot: tmpDir }, () => {
      child = runAsync(['baton', '--done', '--current-state', 'must not be written']);
      const deadline = Date.now() + 10_000;
      while (lockCount() < 2 && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      ok(lockCount() >= 2, 'the command reached the plan lock');
      writeFileSync(plan, baseline);
    });
    const r = await child;
    ok(r.status !== 0, r.stderr);
    match(r.stderr, /Not done: docs\/plans\/cog\.md next_step is the same/);
    strictEqual(readFileSync(plan, 'utf8'), baseline, 'current_state never published');
    ok(existsSync(recordFile('cog')), 'record kept');
  });

  it('a failed write leaves the record in place', () => {
    const plan = writePlanWithNextStep('clutch', 'seat the plate');
    strictEqual(run(['baton', 'docs/plans/clutch.md', '--message', 'resume']).status, 0);
    writeFileSync(plan, '# clutch\n\nfrontmatter stripped\n');
    const r = run(['baton', '--done', '--next-step', 'adjust the plate']);
    ok(r.status !== 0);
    match(r.stderr, /Could not write docs\/plans\/clutch\.md .*the handoff is still pending/);
    strictEqual(readFileSync(plan, 'utf8'), '# clutch\n\nfrontmatter stripped\n');
    ok(existsSync(recordFile('clutch')));
  });

  it('a plan without next_step is handed off in one step, name last', () => {
    writePlan('plain');
    const r = run(['baton', 'docs/plans/plain.md', '--message', 'resume']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /Baton passed/);
    ok(!/Handoff not done/.test(r.stderr), r.stderr);
    strictEqual(lastLine(r.stderr), 'Saved prompt: resume-plain');
  });

  it('slug mode prints the name last', () => {
    const r = run(['baton', 'side-quest', '--message', 'resume']);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(lastLine(r.stderr), 'Saved prompt: resume-side-quest');
  });
});

describe('hud names a handoff this session left unfinished', () => {
  beforeEach(() => setupProject());
  it('prints the not-done line at session start until --done', () => {
    const file = path.join(plansDir, 'unfinished.md');
    writeFileSync(file, '---\ntype: plan\nstatus: in-session\nnext_step: one\n---\n# u\n');
    strictEqual(run(['baton', 'docs/plans/unfinished.md', '--message', 'resume']).status, 0);
    const before = run(['hud']);
    ok(before.stdout.includes('Handoff not done yet') && before.stdout.includes('runlist baton --done docs/plans/unfinished.md'), before.stdout);
    ok(!run(['hud'], { sid: 'other' }).stdout.includes('Handoff not done yet'), 'only the session that saved it');
    writeFileSync(file, readFileSync(file, 'utf8').replace('next_step: one', 'next_step: two'));
    strictEqual(run(['baton', '--done']).status, 0);
    ok(!run(['hud']).stdout.includes('Handoff not done yet'));
  });
});
