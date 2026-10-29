import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { resolveConfig } from '../src/config.mjs';
import { checkUpgradedConfig, handoffsConfigSource, jsLiteral, planHandoffsConfig, planHandoffsUpgrade, publishHandoffsConfig } from '../src/handoffs-mode.mjs';
import { createFileExclusive } from '../src/atomic-mutation.mjs';
import { SETUP_PROMPT_ROUTING } from '../src/naming.mjs';

const bin = path.resolve(import.meta.dirname, '../bin/runlist.mjs');
const pluginRoot = path.resolve(import.meta.dirname, '../plugins/runlist');
const DRAFT = '# Resume\n\nNext: compare the synthetic exporter fields.\n';
const PLAN_TALK = /\bplans?\b|--done|in-session/i;
let repo, home;

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'runlist-handoffs-'));
  home = mkdtempSync(path.join(os.tmpdir(), 'runlist-handoffs-home-'));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  writeFileSync(path.join(home, 'draft.md'), DRAFT);
});
afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const at = file => path.join(repo, file);
const has = file => existsSync(at(file));
const read = file => readFileSync(at(file), 'utf8');
function put(file, content) {
  mkdirSync(path.dirname(at(file)), { recursive: true });
  writeFileSync(at(file), content);
}
function env(session, extra = {}) {
  return { ...process.env, RUNLIST_SESSION_ID: session, HOME: home, USERPROFILE: home, NO_COLOR: '1', FORCE_COLOR: '0',
    CLAUDE_PLUGIN_ROOT: pluginRoot, OPENCODE: '', OPENCODE_PID: '', ...extra };
}
function cli(args, { session = 'handoffs-a', cwd = repo, input, extra } = {}) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, input, encoding: 'utf8', timeout: 30000, env: env(session, extra) });
}
function ok(args, opts) {
  const result = cli(args, opts);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return result;
}
const draft = () => `@${path.join(home, 'draft.md')}`;
const hint = (prompt, opts) => ok(['hud', '--prompt-submit'], { input: JSON.stringify({ session_id: 'x', prompt }), ...opts }).stdout;
function snapshot(directory = repo) {
  return readdirSync(directory, { withFileTypes: true }).filter(entry => entry.name !== '.git').flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? [[file, 'dir'], ...snapshot(file)] : [[file, readFileSync(file, 'utf8')]];
  }).sort(([a], [b]) => a.localeCompare(b));
}

describe('zero-setup handoffs: the first baton configures the repository', () => {
  for (const layout of ['docs', 'no-docs']) it(`saves, lists, surfaces and consumes a handoff with no setup step (${layout})`, () => {
    const userDoc = '# Design notes\n\nA user document with no frontmatter.\n';
    if (layout === 'docs') put('docs/design.md', userDoc);
    const folder = 'docs/prompts';

    const saved = ok(['baton', 'exporter', draft()]);
    const output = saved.stdout + saved.stderr;
    assert.equal(output.match(/Set up runlist for handoffs here/g)?.length, 1, output);
    assert.match(output, new RegExp(`Set up runlist for handoffs here \\(runlist\\.config\\.mjs, prompts in ${folder}/\\)\\. Planning is off; \`runlist setup\` turns it on\\.`));
    assert.doesNotMatch(output, /No runlist config|run `runlist setup`; it carries/);
    assert.match(output, /Saved prompt: resume-exporter\n$/);
    assert.equal(read('runlist.config.mjs'), handoffsConfigSource());
    assert.ok(has(`${folder}/resume-exporter.md`));
    assert.ok(!has('prompts'), 'one prompt location: nothing creates a root prompts/');
    assert.ok(!has('docs/docs.md') && !has('docs/plans'), 'no index and no plan scaffolding');
    if (layout === 'docs') assert.equal(read('docs/design.md'), userDoc);

    assert.match(ok(['prompts']).stdout, /resume-exporter/);
    const check = ok(['check']);
    assert.match(check.stdout, /docs scanned: 1/);
    assert.match(check.stdout, /No issues found/);
    assert.doesNotMatch(check.stdout + check.stderr, /design\.md|warnings: [1-9]|errors: [1-9]/);

    const start = ok(['hud'], { session: 'handoffs-b' }).stdout;
    assert.match(start, /1 pending prompt: resume one only when the user asks/);
    assert.doesNotMatch(start, PLAN_TALK);

    const used = ok(['use', 'resume-exporter'], { session: 'handoffs-b' });
    assert.match(used.stdout, /Next: compare the synthetic exporter fields/);
    assert.ok(has(`${folder}/archived/resume-exporter.md`));
    assert.ok(!has(`${folder}/resume-exporter.md`));
  });

  it('runlist new prompt sets up handoffs the same way', () => {
    const created = ok(['new', 'prompt', 'reminder', draft()]);
    assert.match(created.stdout, /Set up runlist for handoffs here \(runlist\.config\.mjs, prompts in docs\/prompts\/\)/);
    assert.ok(has('docs/prompts/reminder.md') && !has('prompts'));
    assert.match(read('runlist.config.mjs'), /^export const mode = 'handoffs';$/m);
  });

  it('dry-run writes nothing and says what it would create; JSON names the setup', () => {
    put('docs/design.md', '# Notes\n');
    const before = snapshot();
    const preview = ok(['baton', 'exporter', draft(), '--dry-run']);
    assert.match(preview.stderr, /\[dry-run\] Would set up runlist for handoffs here \(runlist\.config\.mjs, prompts in docs\/prompts\/\)\. Planning stays off/);
    assert.match(preview.stderr, /\[dry-run\] Would create: docs\/prompts\/resume-exporter\.md/);
    const json = JSON.parse(ok(['baton', 'exporter', draft(), '--dry-run', '--json']).stdout);
    assert.deepEqual(json.handoffsSetup, { config: 'runlist.config.mjs', promptDirectory: 'docs/prompts', moved: [], created: false });
    assert.equal(json.prompt, 'docs/prompts/resume-exporter.md');
    assert.match(ok(['new', 'prompt', 'reminder', draft(), '-n']).stdout, /Would create: docs\/prompts\/reminder\.md/);
    assert.deepEqual(snapshot(), before);

    const applied = JSON.parse(ok(['baton', 'exporter', draft(), '--json']).stdout);
    assert.deepEqual(applied.handoffsSetup, { config: 'runlist.config.mjs', promptDirectory: 'docs/prompts', moved: [], created: true });
    const second = JSON.parse(ok(['baton', 'second', draft(), '--json']).stdout);
    assert.equal(second.handoffsSetup, null);
  });

  it('creates the config at the Git toplevel when run from a subfolder', () => {
    put('src/app/index.js', '');
    ok(['baton', 'exporter', draft()], { cwd: at('src/app') });
    assert.ok(has('runlist.config.mjs') && has('docs/prompts/resume-exporter.md'));
    assert.ok(!has('src/app/runlist.config.mjs') && !has('src/app/docs') && !has('prompts'));
  });

  it('sets up handoffs beside plans an older version saved, leaving them for setup, even from a subfolder', () => {
    const plan = '---\ntype: plan\nstatus: planned\ncreated: 2026-10-01\nupdated: 2026-10-01\n---\n# Sample\n\nNext work.\n';
    put('plans/sample.md', plan);
    put('src/app/index.js', '');
    const saved = ok(['baton', 'exporter', draft()], { cwd: at('src/app') });
    assert.match(saved.stdout + saved.stderr, /Set up runlist for handoffs here/);
    assert.doesNotMatch(saved.stdout + saved.stderr, /run `runlist setup`; it carries this prompt over/);
    assert.equal(read('runlist.config.mjs'), handoffsConfigSource());
    assert.equal(read('plans/sample.md'), plan, 'left where it is');
    assert.equal(ok(['plans']).stdout, 'Planning is off in this project; `runlist setup` turns it on (your prompts stay where they are). 1 runlist document saved before setup is waiting for it.\n');
    assert.deepEqual(JSON.parse(ok(['plans', '--json']).stdout), { planning: false, message: 'Planning is off in this project; `runlist setup` turns it on (your prompts stay where they are). 1 runlist document saved before setup is waiting for it.', waitingForSetup: 1 });
    assert.match(cli(['new', 'plan', 'later']).stderr, /1 runlist document saved before setup is waiting for it\./);
    ok(['setup', '--yes']);
    assert.ok(has('docs/plans/sample.md') && !has('plans/sample.md'), 'setup brings it in');
    assert.match(ok(['plans']).stdout, /sample/);
    assert.match(ok(['prompts']).stdout, /resume-exporter/);
  });

  it('refuses outside a Git repository and in a home directory that is a repository, writing nothing', () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), 'runlist-handoffs-plain-'));
    try {
      const refused = cli(['baton', 'exporter', draft()], { cwd: plain });
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /Not in a Git repository, so there is no project to save a handoff in/);
      assert.deepEqual(readdirSync(plain), []);
    } finally { rmSync(plain, { recursive: true, force: true }); }
    const before = snapshot();
    const homeRepo = cli(['baton', 'exporter', draft()], { extra: { HOME: repo, USERPROFILE: repo } });
    assert.equal(homeRepo.status, 1);
    assert.match(homeRepo.stderr, /home directory is a Git repository/);
    assert.deepEqual(snapshot(), before);
  });

  it('never overwrites an existing config: setup first, then baton uses the configured folders', () => {
    ok(['setup', '--yes']);
    const config = read('runlist.config.mjs');
    const saved = ok(['baton', 'exporter', draft()]);
    assert.doesNotMatch(saved.stdout + saved.stderr, /Set up runlist for handoffs/);
    assert.equal(read('runlist.config.mjs'), config);
    assert.ok(has('docs/prompts/resume-exporter.md'));
  });

  it('uses a config that appears after resolution instead of replacing it', async () => {
    const plan = await planHandoffsConfig(repo, await resolveConfig(repo), { home });
    const theirs = "export const root = 'notes';\n";
    put('notes/.gitkeep', '');
    put('runlist.config.mjs', theirs);
    const result = await publishHandoffsConfig(plan);
    assert.equal(read('runlist.config.mjs'), theirs);
    assert.equal(result.created, null);
    assert.equal(result.config.docsRoot, at('notes'));
  });

  it('two first batons at once create one config and both prompts', async () => {
    const run = slug => new Promise(resolve => {
      const child = spawn(process.execPath, [bin, 'baton', slug, draft()], { cwd: repo, env: env(`race-${slug}`) });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      child.on('close', status => resolve({ status, output }));
    });
    const results = await Promise.all([run('first'), run('second')]);
    for (const result of results) assert.equal(result.status, 0, result.output);
    assert.equal(results.filter(result => /Set up runlist for handoffs here/.test(result.output)).length, 1, results.map(r => r.output).join('\n'));
    assert.equal(read('runlist.config.mjs'), handoffsConfigSource());
    assert.ok(has('docs/prompts/resume-first.md') && has('docs/prompts/resume-second.md'));
  });

  it('leaves a prompts/ folder of non-runlist Markdown alone and uses docs/prompts/', () => {
    put('prompts/library.md', '# A prompt library\n');
    ok(['baton', 'exporter', draft()]);
    assert.match(read('runlist.config.mjs'), /^export const root = 'docs\/prompts';$/m);
    assert.ok(has('docs/prompts/resume-exporter.md'));
    assert.equal(read('prompts/library.md'), '# A prompt library\n');
  });
});

describe('handoffs-only hints and wording', () => {
  it('answers an explicit save request in an unconfigured Git repo; stays silent otherwise', () => {
    for (const prompt of ['save where we are', 'baton', 'ok, baton this']) {
      const text = hint(prompt);
      assert.match(text, /^\[runlist\] Baton: /, prompt);
      assert.match(text, /`runlist baton <slug> @<file>`, choosing a short slug that names the work/);
      assert.match(text, /no runlist config here yet: baton also sets one up for handoffs \(runlist\.config\.mjs, prompts in docs\/prompts\/\)/);
      assert.doesNotMatch(text, PLAN_TALK);
    }
    for (const prompt of ['implement the handoff between services', 'pick up where we left off', 'what does baton do?']) {
      assert.equal(hint(prompt), '', prompt);
    }
    assert.equal(ok(['hud']).stdout, '', 'SessionStart stays silent before the first handoff');
    assert.equal(ok(['hud', '--subagent']).stdout, '');
    const plain = mkdtempSync(path.join(os.tmpdir(), 'runlist-handoffs-plain-'));
    try { assert.equal(hint('save where we are', { cwd: plain }), ''); }
    finally { rmSync(plain, { recursive: true, force: true }); }
  });

  it('speaks only about handoffs once the repository is in handoffs mode', () => {
    ok(['baton', 'exporter', draft()]);
    const save = hint('save where we are');
    assert.match(save, /^\[runlist\] Baton: /);
    assert.doesNotMatch(save, /no runlist config here yet/);
    assert.doesNotMatch(save, PLAN_TALK);
    const pickup = hint('pick up where we left off');
    assert.match(pickup, /1 pending prompt \(docs\/prompts\/resume-exporter\.md\); `\/pickup` or `runlist use <name>` consumes one \(archives the prompt and prints it\)/);
    assert.doesNotMatch(pickup, PLAN_TALK);
    const subagent = ok(['hud', '--subagent']).stdout;
    assert.match(subagent, /planning is off/);
    assert.doesNotMatch(subagent.replace('planning is off', ''), PLAN_TALK);
    const unnamed = cli(['baton', draft()]);
    assert.equal(unnamed.status, 1);
    assert.match(unnamed.stderr, /Baton needs a short name for the handoff/);
    assert.doesNotMatch(unnamed.stderr, PLAN_TALK);
  });

  it('plan views say planning is off and plan verbs refuse', () => {
    ok(['baton', 'exporter', draft()]);
    const off = 'Planning is off in this project; `runlist setup` turns it on (your prompts stay where they are).\n';
    for (const command of ['plans', 'health', 'runlists', 'modules']) assert.equal(ok([command]).stdout, off, command);
    assert.deepEqual(JSON.parse(ok(['plans', '--json']).stdout), { planning: false, message: off.trim() });
    assert.ok(ok(['briefing']).stdout.endsWith(off));
    assert.equal(JSON.parse(ok(['agent-context']).stdout).planning, false);
    for (const args of [['new', 'plan', 'sample'], ['new', 'doc', 'sample'], ['new', 'sample']]) {
      const refused = cli(args);
      assert.equal(refused.status, 1, args.join(' '));
      assert.match(refused.stderr, /needs planning\. Planning is off in this project; `runlist setup` turns it on/);
    }
    assert.equal(JSON.parse(ok(['config', 'get', 'mode', '--json']).stdout).value, 'handoffs');
    const doctor = ok(['doctor']);
    assert.doesNotMatch(doctor.stdout + doctor.stderr, /warning:|error:/i);
  });
});

describe('runlist setup turns planning on', () => {
  for (const layout of ['docs', 'no-docs']) it(`upgrades a handoffs-only repository in place (${layout})`, () => {
    if (layout === 'docs') put('docs/design.md', '# Design notes\n');
    const folder = 'docs/prompts';
    ok(['baton', 'exporter', draft()]);

    const before = snapshot();
    const preview = ok(['setup']);
    assert.match(preview.stdout, new RegExp(`Turn planning on: rewrite mode and root in the handoffs config \\(prompts stay in ${folder}/\\)`));
    assert.match(preview.stdout, /Config after:\n[\s\S]*export const mode = 'plans';/);
    assert.match(preview.stdout, /create {2}docs\/plans\//);
    assert.doesNotMatch(preview.stdout, /Carry over prompts/);
    assert.deepEqual(snapshot(), before, 'setup previews before writing');

    // Planning scans the docs root, so an untagged document there is reported
    // exactly as a fresh setup reports it (attention, with the --adopt route).
    const applied = cli(['setup', '--yes']);
    assert.equal(applied.status, layout === 'docs' ? 1 : 0, applied.stdout + applied.stderr);
    assert.match(applied.stdout, layout === 'docs' ? /^Setup attention \(apply\)[\s\S]*select exact paths with --adopt/ : /^Setup completed \(apply\)/);
    assert.match(applied.stdout, /Completed: 3/);
    const config = read('runlist.config.mjs');
    assert.match(config, /^export const mode = 'plans';$/m);
    assert.match(config, /^export const root = 'docs';$/m);
    assert.match(config, /^export const index = \{$/m);
    assert.ok(has(`${folder}/resume-exporter.md`), 'prompts stay where they are');
    assert.ok(has('docs/plans') && has('docs/docs.md'));
    assert.match(ok(['prompts']).stdout, /resume-exporter/);
    ok(['new', 'plan', 'sample', draft()]);
    assert.ok(has('docs/plans/sample.md'));
    assert.match(ok(['plans']).stdout, /sample/i);
    assert.match(ok(['use', 'resume-exporter'], { session: 'handoffs-b' }).stdout, /Next: compare the synthetic exporter fields/);
    assert.ok(has(`${folder}/archived/resume-exporter.md`));
  });

  it('refuses to rewrite a handoffs config that was edited out of shape', () => {
    ok(['baton', 'exporter', draft()]);
    put('runlist.config.mjs', "export const mode = 'handoffs';\nconst folder = 'prompts';\nexport const root = folder;\n");
    const refused = cli(['setup', '--yes']);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout, /is not the handoffs config runlist writes/);
    assert.match(read('runlist.config.mjs'), /mode = 'handoffs'/);
  });
});

const PROMPT = '---\ntype: prompt\nstatus: pending\ncreated: 2026-10-01\nupdated: 2026-10-01\n---\n# Resume\n\nEarlier synthetic work.\n';
const PLAN = '---\ntype: plan\nstatus: active\ncreated: 2026-10-01\nupdated: 2026-10-01\n---\n# Synthetic\n\nNext work.\n';
const git = (cwd, ...args) => assert.equal(spawnSync('git', args, { cwd, encoding: 'utf8' }).status, 0, args.join(' '));
const gitCommit = cwd => git(cwd, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'synthetic');

describe('the first baton writes only into the Git worktree it is in', () => {
  it('refuses inside a bare repository nested in a worktree, writing nothing anywhere', () => {
    mkdirSync(at('backup.git'));
    git(at('backup.git'), 'init', '-q', '--bare');
    const before = snapshot();
    const refused = cli(['baton', 'exporter', draft()], { cwd: at('backup.git') });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /not inside a Git working tree/);
    assert.deepEqual(snapshot(), before);
  });

  it('refuses a .git file that is not a gitlink', () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), 'runlist-handoffs-fake-'));
    try {
      writeFileSync(path.join(plain, '.git'), 'unrelated file\n');
      const refused = cli(['baton', 'exporter', draft()], { cwd: plain });
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /not inside a Git working tree/);
      assert.deepEqual(readdirSync(plain), ['.git']);
    } finally { rmSync(plain, { recursive: true, force: true }); }
  });

  for (const overrides of ['GIT_DIR', 'GIT_DIR and GIT_WORK_TREE']) it(`refuses when ${overrides} points at another repository`, () => {
    const other = mkdtempSync(path.join(os.tmpdir(), 'runlist-handoffs-other-'));
    try {
      git(other, 'init', '-q');
      const extra = { GIT_DIR: path.join(other, '.git'), ...(overrides.includes('WORK') ? { GIT_WORK_TREE: other } : {}) };
      const before = snapshot();
      const refused = cli(['baton', 'exporter', draft()], { extra });
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /GIT_DIR or GIT_WORK_TREE (is set and )?may point elsewhere/);
      assert.deepEqual(snapshot(), before);
      assert.deepEqual(readdirSync(other), ['.git']);
    } finally { rmSync(other, { recursive: true, force: true }); }
  });

  it('still sets up a linked worktree at its own top', () => {
    put('seed.txt', 'seed\n');
    git(repo, 'add', 'seed.txt');
    gitCommit(repo);
    const linked = path.join(home, 'linked');
    git(repo, 'worktree', 'add', '-q', '-b', 'scratch', linked);
    ok(['baton', 'exporter', draft()], { cwd: linked });
    assert.ok(existsSync(path.join(linked, 'runlist.config.mjs')) && existsSync(path.join(linked, 'docs/prompts/resume-exporter.md')));
    assert.ok(!has('runlist.config.mjs'));
  });
});

describe('a handoffs-only project manages only its prompts', () => {
  const foreign = '---\ntype: doc\nstatus: draft\nmodule: []\nsurface: []\nupdated: 2026-10-01\n---\n# User library\n\nUSER_SENTINEL material.\n';
  for (const layout of ['docs/prompts']) it(`ignores and never changes other Markdown in ${layout}/`, () => {
    put('docs/design.md', '# Notes\n');
    put(`${layout}/library.md`, foreign);
    put(`${layout}/notes/plain.md`, '# Plain notes\n\nUSER_SENTINEL too.\n');
    ok(['baton', 'exporter', draft()]);
    assert.match(read('runlist.config.mjs'), new RegExp(`^export const root = '${layout}';$`, 'm'));
    const check = ok(['check']);
    assert.doesNotMatch(check.stdout + check.stderr, /library|plain\.md|errors: [1-9]|warnings: [1-9]/);
    assert.match(ok(['grep', 'USER_SENTINEL']).stdout, /results: 0/);
    assert.match(ok(['query', '--all']).stdout, /resume-exporter/);
    assert.doesNotMatch(ok(['query', '--all']).stdout, /library|plain/);
    ok(['doctor', '--apply']);
    ok(['check', '--fix']);
    for (const args of [['show', `${layout}/library.md`], ['set', 'archived', `${layout}/library.md`], ['archive', 'library']]) {
      const refused = cli(args);
      assert.equal(refused.status, 1, args.join(' '));
    }
    assert.equal(read(`${layout}/library.md`), foreign, 'never modified');
    assert.equal(read(`${layout}/notes/plain.md`), '# Plain notes\n\nUSER_SENTINEL too.\n');
    assert.match(ok(['prompts']).stdout, /resume-exporter/);
  });
});

describe('runlist setup writes an upgraded config that loads', () => {
  it('widens the root to docs/ and accepts no other docs root', () => {
    ok(['baton', 'exporter', draft()]);
    const refused = cli(['setup', '--yes', '--docs-root', 'notes']);
    assert.equal(refused.status, 1);
    assert.match(refused.stdout + refused.stderr, /This project's prompts are in docs\/prompts\/ and stay there when planning is turned on, so the docs root becomes docs\/, the folder that holds them; --docs-root notes would leave them outside it\./);
    assert.equal(read('runlist.config.mjs'), handoffsConfigSource());
    ok(['setup', '--yes', '--docs-root', 'docs']);
    assert.equal(JSON.parse(ok(['config', 'get', 'root', '--json']).stdout).value, 'docs');
    assert.equal(JSON.parse(ok(['config', 'get', 'index.path', '--json']).stdout).value, path.join(repo, 'docs', 'docs.md'));
    assert.match(ok(['prompts']).stdout, /resume-exporter/);
  });

  it('a fresh setup keeps $& in a docs root as text', () => {
    ok(['setup', '--yes', '--docs-root', 'notes$&']);
    assert.equal(JSON.parse(ok(['config', 'get', 'root', '--json']).stdout).value, 'notes$&');
  });

  it('refuses a backslash in --docs-root', () => {
    ok(['baton', 'exporter', draft()]);
    const refused = cli(['setup', '--yes', '--docs-root', 'notes\\public']);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stdout + refused.stderr, /--docs-root must be a relative project path/);
    assert.equal(read('runlist.config.mjs'), handoffsConfigSource());
  });

  it('refuses to upgrade a handoffs config whose root is not docs/prompts', () => {
    put('runlist.config.mjs', handoffsConfigSource().replace("export const root = 'docs/prompts';", "export const root = 'notes/prompts';"));
    put('notes/prompts/.gitkeep', '');
    const config = { configPath: at('runlist.config.mjs'), repoRoot: repo, docsRoot: at('notes/prompts'), docsRoots: [at('notes/prompts')] };
    assert.throws(() => planHandoffsUpgrade(config), /is not the handoffs config runlist writes/);
  });

  it('checks generated JavaScript before replacing anything', () => {
    assert.equal(jsLiteral("a'b"), JSON.stringify("a'b"));
    assert.equal(jsLiteral('docs'), "'docs'");
    assert.throws(() => checkUpgradedConfig("export const root = 'notes'public';\n", { root: "notes'public" }, 'cfg'), /would not load as intended/);
    assert.throws(() => checkUpgradedConfig("export const root = 'other';\n", { root: 'docs' }, 'cfg'), /root reads back as "other"/);
    checkUpgradedConfig("export const root = \"notes'public\";\n", { root: "notes'public" }, 'cfg');
  });
});

describe('the first baton never hides what was saved before setup', () => {
  it('sets up handoffs beside a nested pre-config plan and leaves it where it is', () => {
    put('plans/team/old.md', PLAN);
    const saved = ok(['baton', 'exporter', draft()]);
    assert.match(saved.stdout + saved.stderr, /Set up runlist for handoffs here/);
    assert.equal(read('plans/team/old.md'), PLAN);
    assert.match(ok(['prompts']).stdout, /resume-exporter/);
  });

  it('carries prompts nested below prompts/ with their folders, sets up handoffs, and setup keeps them in view', () => {
    put('prompts/team/resume-old.md', PROMPT);
    put('prompts/held/parked.md', PROMPT.replace('status: pending', 'status: held'));
    put('prompts/team/notes.md', '# Team notes\n\nNot a runlist prompt.\n');
    const saved = ok(['baton', 'exporter', draft()]);
    assert.match(saved.stderr, /Moved 2 prompts an older runlist saved in prompts\/ to docs\/prompts\/\./);
    assert.match(saved.stderr, /Set up runlist for handoffs here/);
    assert.equal(read('docs/prompts/team/resume-old.md'), PROMPT);
    assert.ok(has('docs/prompts/held/parked.md') && !has('prompts/team/resume-old.md') && !has('prompts/held'));
    assert.equal(read('prompts/team/notes.md'), '# Team notes\n\nNot a runlist prompt.\n', 'what is not a prompt stays');
    assert.match(ok(['prompts']).stdout, /resume-old/);
    rmSync(at('docs/prompts/held'), { recursive: true });
    ok(['setup', '--yes']);
    assert.match(ok(['use', 'resume-old'], { session: 'handoffs-b' }).stdout, /Earlier synthetic work/);
    assert.ok(!has('prompts/team/resume-old.md'));
  });

  it('setup carries nested prompts too', () => {
    put('prompts/team/resume-old.md', PROMPT);
    ok(['setup', '--yes']);
    assert.ok(has('docs/prompts/team/resume-old.md') && !has('prompts/team/resume-old.md'));
    assert.match(ok(['use', 'resume-old'], { session: 'handoffs-b' }).stdout, /Earlier synthetic work/);
  });

  it('sets up handoffs beside a prompt saved outside both prompt folders, which stays put', () => {
    put('notes/handoffs/resume-old.md', PROMPT);
    const saved = ok(['baton', 'exporter', draft()]);
    assert.match(saved.stdout + saved.stderr, /Set up runlist for handoffs here/);
    assert.equal(read('notes/handoffs/resume-old.md'), PROMPT);
    assert.doesNotMatch(ok(['prompts']).stdout, /resume-old/);
  });

  it('an unreadable folder does not stop the first baton', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    put('locked/inner.md', PLAN);
    chmodSync(at('locked'), 0o000);
    try {
      const saved = ok(['baton', 'exporter', draft()]);
      assert.match(saved.stdout + saved.stderr, /Set up runlist for handoffs here/);
      assert.ok(has('runlist.config.mjs'));
    } finally { chmodSync(at('locked'), 0o755); }
  });
});

describe('a refused save leaves no setup behind, and dry-run refuses the same way', () => {
  for (const [label, args, pattern] of [
    ['a conflicting prefix', ['baton', '--subagent', 'resume-child'], /conflicts with --subagent/],
    ['an empty name', ['baton', '???'], /nonempty handoff name/],
    ['a pending duplicate', ['baton', 'exporter'], /already pending/],
    ['a pending duplicate via new prompt', ['new', 'prompt', 'resume-exporter'], /File already exists/],
  ]) it(`refuses ${label}`, () => {
    if (label.includes('duplicate')) put('prompts/resume-exporter.md', PROMPT);
    const before = snapshot();
    for (const extra of [['--dry-run'], []]) {
      const refused = cli([...args, draft(), ...extra]);
      assert.equal(refused.status, 1, `${extra.join(' ')}: ${refused.stdout}${refused.stderr}`);
      assert.match(refused.stderr, pattern);
      assert.doesNotMatch(refused.stdout + refused.stderr, /Set up runlist for handoffs/);
      assert.deepEqual(snapshot(), before);
      assert.ok(!has('.runlist'));
    }
  });
});

describe('config publication cannot leave a broken config behind', () => {
  it('fails closed when hard links are unsupported, even if killed at the fallback', () => {
    const inject = path.join(home, 'inject.mjs');
    writeFileSync(inject, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const link = fs.linkSync, rename = fs.renameSync, target = process.env.SYNTHETIC_TARGET;
fs.linkSync = function (from, to, ...rest) {
  if (to === target) { const error = new Error('synthetic: no hard links'); error.code = 'ENOTSUP'; throw error; }
  return link.call(this, from, to, ...rest);
};
fs.renameSync = function (from, to, ...rest) { if (to === target) process.exit(86); return rename.call(this, from, to, ...rest); };
syncBuiltinESMExports();
`);
    put('docs/design.md', '# Notes\n');
    const before = snapshot();
    const refused = cli(['baton', 'exporter', draft()], { extra: { NODE_OPTIONS: `--import=${pathToFileURL(inject).href}`, SYNTHETIC_TARGET: at('runlist.config.mjs') } });
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /cannot take a new file atomically[\s\S]*export const mode = 'handoffs';/);
    assert.ok(!has('runlist.config.mjs'));
    assert.ok(!has('docs/prompts'), 'the prompt folder it made is taken back');
    assert.deepEqual(snapshot().filter(([file]) => !file.startsWith(at('.runlist'))), before);
    ok(['doctor', '--transactions']);
    ok(['prompts']);
  });

  it('requireAtomicPublish refuses instead of exposing a reservation', () => {
    const target = at('runlist.config.mjs');
    assert.throws(() => createFileExclusive(target, 'export const mode = "handoffs";\n', { repoRoot: repo, requireAtomicPublish: true, testHooks: { forceLinkUnsupported: true } }),
      error => error.code === 'ERUNLIST_ATOMIC_PUBLISH_UNSUPPORTED');
    assert.ok(!existsSync(target));
    assert.deepEqual(readdirSync(repo).filter(name => name.startsWith('.runlist.config') || name.endsWith('.tmp')), []);
  });

  it('a parent config that appears before publication is used, not shadowed', async () => {
    const child = at('child');
    mkdirSync(child);
    git(child, 'init', '-q');
    const plan = await planHandoffsConfig(child, await resolveConfig(child), { home });
    put('notes/.gitkeep', '');
    put('dotmd.config.mjs', "export const root = 'notes';\n");
    const published = await publishHandoffsConfig(plan);
    assert.equal(published.created, null);
    assert.equal(published.config.configPath, at('dotmd.config.mjs'));
    assert.ok(!existsSync(path.join(child, 'runlist.config.mjs')));
  });

  it('a parent config that appears during publication wins, and the child config is taken back', async () => {
    const child = at('child');
    mkdirSync(child);
    git(child, 'init', '-q');
    const plan = await planHandoffsConfig(child, await resolveConfig(child), { home });
    const testHooks = { afterHandoffsConfigPublished: () => { put('notes/.gitkeep', ''); put('dotmd.config.mjs', "export const root = 'notes';\n"); } };
    await assert.rejects(publishHandoffsConfig(plan, { testHooks }), /a runlist config appeared in a parent folder/);
    assert.ok(!existsSync(path.join(child, 'runlist.config.mjs')));
    assert.ok(!existsSync(path.join(child, 'docs')));
  });
});

describe('handoffs-only wording beyond the hook', () => {
  it('bare baton, --done, templates, agent-context and index say nothing about plans', () => {
    ok(['baton', 'exporter', draft()]);
    const bare = cli(['baton'], { input: '' });
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /runlist baton <slug> @\/tmp\/draft\.md/);
    assert.doesNotMatch(bare.stderr, PLAN_TALK);
    const done = cli(['baton', '--done']);
    assert.equal(done.status, 1);
    assert.match(done.stderr, /Nothing to confirm: planning is off/);
    for (const args of [['baton', '--template'], ['baton', '--subagent', '--template', '--parent', 'resume-x']]) {
      assert.doesNotMatch(ok(args).stdout, /\bplans?\b|shared claims/i, args.join(' '));
    }
    assert.deepEqual(Object.keys(JSON.parse(ok(['agent-context']).stdout).statusVocabulary), ['prompt']);
    const index = cli(['index']);
    assert.equal(index.status, 1);
    assert.match(index.stderr, /planning is off in this project\. `runlist setup` turns planning on/);
  });

  it('a planning session that saves under a slug while owning a plan is told the plan stays claimed', () => {
    ok(['setup', '--yes']);
    ok(['new', 'plan', 'renderer', draft()]);
    ok(['use', 'renderer']);
    const saved = ok(['baton', 'renderer-check', draft()]);
    assert.match(saved.stderr, /This session owns docs\/plans\/renderer\.md, which stays in-session[\s\S]*`runlist baton @<draft-file>` with no slug/);
    const child = ok(['baton', '--subagent', 'renderer-task', draft()]);
    assert.doesNotMatch(child.stderr, /stays in-session/);
  });
});

describe('prompts an older runlist saved in a root prompts/ are carried into docs/prompts/', () => {
  const OLDER = '---\ntype: prompt\nstatus: pending\ncreated: 2026-10-01\nupdated: 2026-10-01\nplan: ../plans/old-work.md\n---\n# Resume\n\nOlder synthetic handoff.\n';
  const DONE = '---\ntype: prompt\nstatus: archived\ncreated: 2026-09-01\nupdated: 2026-09-02\n---\n# Done\n\nConsumed earlier.\n';
  const CLOSED = '---\ntype: prompt\nstatus: archived\ncreated: 2026-09-03\nupdated: 2026-09-04\n---\n# Closed\n\nArchived in place.\n';
  const RECORD = '.runlist/handoffs/old-work-0123456789abcdef.json';
  function legacy() {
    put('prompts/resume-older.md', OLDER);
    put('prompts/archived/resume-done.md', DONE);
    put('prompts/resume-closed.md', CLOSED);
    put('prompts/library.md', '# A prompt library\n\nUSER_SENTINEL material.\n');
    put('prompts/notes/plain.md', '---\ntype: doc\nstatus: draft\n---\n# Plain\n\nUSER_SENTINEL too.\n');
    put('notes/reference.md', '---\ntype: doc\nstatus: active\n---\n# Reference\n\nSee [the older handoff](../prompts/resume-older.md).\n');
    put(RECORD, `${JSON.stringify({ id: 'synthetic', plan: 'plans/old-work.md', prompt: 'prompts/resume-older.md', name: 'resume-older', savedAt: '2026-10-01T00:00:00Z', nextStep: '"x"', sessionId: 'old' }, null, 2)}\n`);
  }

  it('carries pending and archived prompts with their references and handoff record, then sets up handoffs', () => {
    legacy();
    const saved = ok(['baton', 'exporter', draft()]);
    const output = saved.stdout + saved.stderr;
    assert.equal(output.match(/Moved 3 prompts an older runlist saved in prompts\/ to docs\/prompts\/\.\n/g)?.length, 1, output);
    assert.ok(output.indexOf('Moved 3 prompts') < output.indexOf('Set up runlist for handoffs here (runlist.config.mjs, prompts in docs/prompts/)'), output);
    assert.equal(read('runlist.config.mjs'), handoffsConfigSource());

    assert.ok(has('docs/prompts/resume-older.md') && has('docs/prompts/resume-exporter.md'));
    assert.ok(has('docs/prompts/archived/resume-done.md'), 'an archived prompt stays archived');
    assert.ok(has('docs/prompts/archived/resume-closed.md'), 'an archive-status prompt goes to the archive');
    assert.ok(!has('prompts/resume-older.md') && !has('prompts/resume-closed.md') && !has('prompts/archived'));
    // Its plan is gone (a plan saved before setup would leave this save
    // unconfigured), so the dangling link is kept as written.
    assert.equal(read('docs/prompts/resume-older.md'), OLDER);
    assert.equal(read('notes/reference.md'), '---\ntype: doc\nstatus: active\n---\n# Reference\n\nSee [the older handoff](../docs/prompts/resume-older.md).\n');
    const record = JSON.parse(read(RECORD));
    assert.equal(record.prompt, 'docs/prompts/resume-older.md');
    assert.equal(record.plan, 'plans/old-work.md');

    assert.equal(read('prompts/library.md'), '# A prompt library\n\nUSER_SENTINEL material.\n', 'foreign files stay');
    assert.equal(read('prompts/notes/plain.md'), '---\ntype: doc\nstatus: draft\n---\n# Plain\n\nUSER_SENTINEL too.\n');
    assert.match(ok(['grep', 'USER_SENTINEL']).stdout, /results: 0/);
    const check = ok(['check']);
    assert.doesNotMatch(check.stdout + check.stderr, /library|plain\.md|errors: [1-9]|warnings: [1-9]/);
    const listed = ok(['prompts']).stdout;
    assert.match(listed, /resume-older/);
    assert.match(listed, /resume-exporter/);
    assert.match(ok(['use', 'resume-older'], { session: 'handoffs-b' }).stdout, /Older synthetic handoff/);
  });

  it('dry-run lists the moves and writes nothing', () => {
    legacy();
    const before = snapshot();
    const preview = ok(['baton', 'exporter', draft(), '--dry-run']);
    assert.match(preview.stderr, /\[dry-run\] Would move 3 prompts an older runlist saved in prompts\/ to docs\/prompts\/:\n/);
    assert.match(preview.stderr, / {2}prompts\/archived\/resume-done\.md → docs\/prompts\/archived\/resume-done\.md\n/);
    assert.match(preview.stderr, / {2}prompts\/resume-closed\.md → docs\/prompts\/archived\/resume-closed\.md\n/);
    assert.match(preview.stderr, / {2}prompts\/resume-older\.md → docs\/prompts\/resume-older\.md\n/);
    assert.match(preview.stderr, /Would create: docs\/prompts\/resume-exporter\.md/);
    const json = JSON.parse(ok(['baton', 'exporter', draft(), '--dry-run', '--json']).stdout);
    assert.deepEqual(json.handoffsSetup.moved.map(move => move.from).sort(), ['prompts/archived/resume-done.md', 'prompts/resume-closed.md', 'prompts/resume-older.md']);
    assert.match(ok(['new', 'prompt', 'reminder', draft(), '-n']).stdout, /Would move 3 prompts/);
    assert.deepEqual(snapshot(), before);
  });

  it('refuses a collision with guidance, moving nothing and writing no config', () => {
    legacy();
    put('docs/prompts/resume-older.md', PROMPT);
    const before = snapshot();
    for (const args of [['baton', 'exporter', draft(), '--dry-run'], ['baton', 'exporter', draft()], ['new', 'prompt', 'reminder', draft()]]) {
      const refused = cli(args);
      assert.equal(refused.status, 1, args.join(' '));
      assert.match(refused.stderr, /Nothing saved: runlist keeps prompts in docs\/prompts\/, and moves the ones an older version saved in prompts\/ there[\s\S]*Carry-over collision: prompts\/resume-older\.md → docs\/prompts\/resume-older\.md; destination exists[\s\S]*Rename or remove one file of each pair, then rerun\./);
      assert.deepEqual(snapshot(), before);
    }
  });

  it('runlist new prompt carries the same way', () => {
    legacy();
    const created = ok(['new', 'prompt', 'reminder', draft()]);
    assert.match(created.stdout, /Moved 3 prompts an older runlist saved in prompts\/ to docs\/prompts\/\.\nSet up runlist for handoffs here/);
    assert.ok(has('docs/prompts/reminder.md') && has('docs/prompts/resume-older.md') && !has('prompts/resume-older.md'));
  });

  it('a save under the name of a prompt about to be carried is the pending duplicate', () => {
    legacy();
    const before = snapshot();
    const refused = cli(['baton', 'older', draft()]);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /already pending:\n {2}prompts\/resume-older\.md/);
    assert.deepEqual(snapshot(), before);
  });

  it('setup turns planning on with the carried prompts in docs/prompts/', () => {
    legacy();
    ok(['baton', 'exporter', draft()]);
    ok(['setup', '--yes']);
    assert.match(read('runlist.config.mjs'), /^export const root = 'docs';$/m);
    assert.match(ok(['prompts']).stdout, /resume-older[\s\S]*resume-exporter|resume-exporter[\s\S]*resume-older/);
    assert.equal(read('prompts/library.md'), '# A prompt library\n\nUSER_SENTINEL material.\n');
  });
});

describe('one prompt location: nothing creates a root prompts/', () => {
  for (const layout of ['docs', 'no-docs']) for (const args of [['baton', 'exporter'], ['new', 'prompt', 'reminder']]) it(`${args.slice(0, 2).join(' ')} in a fresh repository (${layout})`, () => {
    if (layout === 'docs') put('docs/design.md', '# Notes\n');
    ok([...args, draft()]);
    assert.ok(!has('prompts'));
    assert.ok(readdirSync(at('docs/prompts')).length === 1);
  });

  it('an unconfigured save beside plans saved before setup goes to docs/prompts/', () => {
    put('plans/sample.md', PLAN);
    ok(['baton', 'exporter', draft()]);
    ok(['new', 'prompt', 'reminder', draft()]);
    assert.ok(has('docs/prompts/resume-exporter.md') && has('docs/prompts/reminder.md') && !has('prompts'));
    ok(['use', 'resume-exporter'], { session: 'handoffs-b' });
    assert.ok(has('docs/prompts/archived/resume-exporter.md'));
  });

  it('a save outside Git, where earlier handoffs keep working, carries them and goes to docs/prompts/', () => {
    const plain = mkdtempSync(path.join(os.tmpdir(), 'runlist-handoffs-plain-'));
    try {
      mkdirSync(path.join(plain, 'prompts'));
      writeFileSync(path.join(plain, 'prompts', 'resume-old.md'), PROMPT);
      ok(['baton', 'exporter', draft()], { cwd: plain });
      assert.ok(existsSync(path.join(plain, 'docs/prompts/resume-exporter.md')));
      assert.ok(existsSync(path.join(plain, 'docs/prompts/resume-old.md')), 'carried, never adopted in place');
      assert.ok(!existsSync(path.join(plain, 'prompts')));
      assert.ok(!existsSync(path.join(plain, 'runlist.config.mjs')));
    } finally { rmSync(plain, { recursive: true, force: true }); }
  });
});

describe('the setup preview counts what planning brings into view', () => {
  it('names docs/ and the number of Markdown files the handoffs config did not manage', () => {
    put('docs/design.md', '# Design notes\n');
    put('docs/guide/notes.md', '# Notes\n');
    ok(['baton', 'exporter', draft()]);
    put('docs/prompts/library.md', '# A prompt library\n');
    const preview = ok(['setup']).stdout;
    assert.match(preview, /Planning brings docs\/ under runlist: 3 existing Markdown files there will be checked, and any without runlist frontmatter listed as untagged; adopt them with `--adopt <path>` or leave them/);
    const json = JSON.parse(ok(['setup', '--json']).stdout);
    assert.equal(json.actions.find(action => action.id === 'upgrade-info').count, 3);
  });

  it('uses the singular for one file and says nothing when there is none', () => {
    ok(['baton', 'exporter', draft()]);
    assert.doesNotMatch(ok(['setup']).stdout, /Planning brings/);
    put('docs/design.md', '# Design notes\n');
    assert.match(ok(['setup']).stdout, /Planning brings docs\/ under runlist: 1 existing Markdown file there will be checked, and listed as untagged if it has no runlist frontmatter; adopt it with `--adopt <path>` or leave it/);
  });
});

describe('a carry killed part-way is finished before the next save', () => {
  // SIGKILLs the process the moment the carry's transaction manifest reaches
  // the named phase, as a crash would.
  const KILLER = `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const rename = fs.renameSync;
fs.renameSync = function (from, to, ...rest) {
  const result = rename.call(this, from, to, ...rest);
  if (String(to).endsWith('manifest.json')) {
    try {
      const manifest = JSON.parse(fs.readFileSync(to, 'utf8'));
      if (manifest.phase === process.env.RUNLIST_TEST_KILL_PHASE) process.kill(process.pid, 'SIGKILL');
    } catch {}
  }
  return result;
};
syncBuiltinESMExports();
`;
  const manifests = () => {
    const root = at('.runlist/transactions');
    return existsSync(root) ? readdirSync(root).filter(entry => existsSync(path.join(root, entry, 'manifest.json'))) : [];
  };
  for (const phase of ['reservation', 'source-move', 'target-publication', 'canonical-commit', 'completed']) it(`killed at ${phase}`, () => {
    const killer = path.join(home, 'kill.mjs');
    writeFileSync(killer, KILLER);
    put('prompts/older.md', PROMPT);
    const killed = cli(['baton', 'exporter', draft()], { extra: { NODE_OPTIONS: `--import=${pathToFileURL(killer).href}`, RUNLIST_TEST_KILL_PHASE: phase } });
    assert.equal(killed.signal, 'SIGKILL', phase);
    assert.ok(!has('runlist.config.mjs'));
    ok(['baton', 'exporter', draft()]);
    assert.ok(has('runlist.config.mjs'));
    assert.match(ok(['use', 'older'], { session: 'handoffs-b' }).stdout, /Earlier synthetic work/);
    assert.ok(has('docs/prompts/archived/older.md'));
    assert.deepEqual(manifests(), []);
    assert.ok(!has('prompts'), 'nothing left in, or created in, a root prompts/');
  });

  for (const phase of ['reservation', 'source-move']) it(`killed at ${phase}: a dry-run says the unfinished move comes first and stops, changing nothing`, () => {
    const killer = path.join(home, 'kill.mjs');
    writeFileSync(killer, KILLER);
    put('prompts/older.md', PROMPT);
    const killed = cli(['baton', 'exporter', draft()], { extra: { NODE_OPTIONS: `--import=${pathToFileURL(killer).href}`, RUNLIST_TEST_KILL_PHASE: phase } });
    assert.equal(killed.signal, 'SIGKILL', phase);
    const before = snapshot();
    for (const args of [['baton', 'exporter', draft(), '--dry-run'], ['new', 'prompt', 'reminder', draft(), '--dry-run']]) {
      const preview = ok(args);
      assert.match(preview.stdout + preview.stderr, /Would first finish a move an earlier runlist command left unfinished; nothing else is previewed until it is finished\./, args.join(' '));
      assert.doesNotMatch(preview.stdout + preview.stderr, /collision|Nothing saved/, args.join(' '));
    }
    assert.deepEqual(snapshot(), before);
    ok(['baton', 'exporter', draft()]);
    assert.ok(has('runlist.config.mjs') && has('docs/prompts/older.md'));
  });
});

describe('third review: what a handoffs-only project leaves alone', () => {
  it('the guard treats only prompts in the prompt folder as saved prompts', () => {
    ok(['baton', 'exporter', draft()]);
    put('docs/prompts/spec.md', '---\ntype: doc\nstatus: draft\n---\n# Spec\n');
    const guard = (tool, input) => ok(['guard'], { input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: repo, session_id: 'x', hook_event_name: 'PreToolUse' }) }).stdout;
    assert.doesNotMatch(guard('Read', { file_path: at('docs/prompts/spec.md') }), /saved runlist prompt/);
    assert.doesNotMatch(guard('Edit', { file_path: at('docs/prompts/spec.md'), old_string: 'status: draft', new_string: 'status: review' }), /runlist set|deny/);
    assert.match(guard('Read', { file_path: at('docs/prompts/resume-exporter.md') }), /saved runlist prompt/);
    assert.match(guard('Edit', { file_path: at('docs/prompts/resume-exporter.md'), old_string: 'status: pending', new_string: 'status: archived' }), /runlist set/);
  });

  for (const status of ['held', 'shelved', 'claimed']) it(`a prompt carried with the retired status ${status} keeps it, and check warns with the verb that settles it`, () => {
    const saved = PROMPT.replace('status: pending', `status: ${status}`);
    put('prompts/team/old.md', saved);
    ok(['baton', 'exporter', draft()]);
    assert.equal(read('docs/prompts/team/old.md'), saved);
    const check = JSON.parse(ok(['check', '--json']).stdout);
    assert.deepEqual(check.errors, []);
    const remedy = status === 'claimed'
      ? '`runlist prompts archive docs/prompts/team/old.md` sets it aside'
      : '`runlist set pending docs/prompts/team/old.md` makes it pending again, or `runlist prompts archive docs/prompts/team/old.md` sets it aside';
    assert.ok(check.warnings.some(item => item.message === `Retired prompt status \`${status}\`, from an older runlist: ${remedy}.`), JSON.stringify(check.warnings));
    ok([status === 'claimed' ? 'prompts' : 'set', ...(status === 'claimed' ? ['archive', 'docs/prompts/team/old.md'] : ['pending', 'docs/prompts/team/old.md'])]);
    assert.deepEqual(JSON.parse(ok(['check', '--json']).stdout).warnings, []);
  });

  it('the app creates nothing but a prompt where planning is off', async () => {
    ok(['baton', 'exporter', draft()]);
    const config = await resolveConfig(repo);
    const { createAppDocuments } = await import('../src/app-create.mjs');
    const { PLANNING_OFF } = await import('../src/handoffs-scope.mjs');
    const api = createAppDocuments({ config, actor: () => ({ kind: 'human', id: 'tester' }), library: null });
    const catalog = await api.options();
    assert.deepEqual(catalog.templates.filter(item => item.type !== 'prompt'), []);
    assert.equal(catalog.recordError, PLANNING_OFF);
    for (const template of ['plan', 'doc', 'hub', 'flag', 'decision']) {
      await assert.rejects(api.preview({}, { operationId: randomUUID(), template, title: 'Synthetic', folder: 'plans', filename: 'synthetic.md', status: 'planned', body: '' }),
        error => error.code === 'planning-off' && error.message === PLANNING_OFF, template);
    }
    assert.ok(!has('plans') && !has('.runlist/editor'));
  });
});

describe('a refused save moves nothing', () => {
  for (const [verb, args, duplicate, pattern] of [
    ['baton', ['baton', 'exporter'], 'docs/prompts/resume-exporter.md', /already pending:\n {2}docs\/prompts\/resume-exporter\.md/],
    ['new prompt', ['new', 'prompt', 'exporter'], 'docs/prompts/exporter.md', /File already exists: docs\/prompts\/exporter\.md/],
  ]) it(`${verb}: a duplicate already in docs/prompts/ refuses before any prompt is carried, and dry-run agrees`, () => {
    put('prompts/older.md', PROMPT);
    put(duplicate, PROMPT);
    const before = snapshot();
    for (const extra of [['--dry-run'], []]) {
      const refused = cli([...args, draft(), ...extra]);
      assert.equal(refused.status, 1, extra.join(' '));
      assert.match(refused.stdout + refused.stderr, pattern);
      assert.doesNotMatch(refused.stdout + refused.stderr, /Moved|Would move/);
      assert.deepEqual(snapshot(), before);
    }
  });

  for (const folder of ['absent', 'empty']) it(`--replace of a prompt about to be carried previews what apply does (docs/prompts/ ${folder})`, () => {
    put('prompts/resume-exporter.md', PROMPT);
    if (folder === 'empty') mkdirSync(at('docs/prompts'), { recursive: true });
    const before = snapshot();
    const preview = JSON.parse(ok(['baton', 'exporter', draft(), '--replace', '--dry-run', '--json']).stdout);
    assert.deepEqual(snapshot(), before);
    const applied = JSON.parse(ok(['baton', 'exporter', draft(), '--replace', '--json']).stdout);
    const expected = { previousPrompt: 'docs/prompts/resume-exporter.md', archivedPrompt: 'docs/prompts/archived/resume-exporter.md', pendingPrompt: 'docs/prompts/resume-exporter.md', alreadyCurrent: false };
    assert.deepEqual(preview.replacement, expected);
    assert.deepEqual(applied.replacement, expected);
    assert.equal(preview.prompt, applied.prompt);
    assert.equal(read('docs/prompts/archived/resume-exporter.md').includes('Earlier synthetic work'), true);
    assert.ok(!has('prompts'));
  });
});

describe('nothing creates a root prompts/ or a docs/prompts/ below the Git toplevel', () => {
  const rootOnly = () => {
    assert.ok(!has('prompts'), 'no root prompts/');
    const nested = [];
    const walk = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === '.git') continue;
        const file = path.join(directory, entry.name);
        if (entry.name === 'prompts' && path.basename(directory) === 'docs' && directory !== at('docs')) nested.push(file);
        walk(file);
      }
    };
    walk(repo);
    assert.deepEqual(nested, [], 'no docs/prompts/ below the toplevel');
  };

  it('a path-like prompt name outside docs/prompts/ is refused; one inside it is kept', () => {
    for (const name of ['prompts/escape', '../escape', 'notes/escape']) {
      const refused = cli(['new', 'prompt', name, draft()]);
      assert.equal(refused.status, 1, name);
      assert.match(refused.stderr, /Nothing saved: prompts are saved in docs\/prompts\//, name);
    }
    assert.ok(!has('runlist.config.mjs'));
    ok(['new', 'prompt', 'docs/prompts/team/inside', draft()]);
    assert.ok(has('docs/prompts/team/inside.md'));
    const again = cli(['new', 'prompt', 'prompts/escape', draft()]);
    assert.equal(again.status, 1);
    rootOnly();
  });

  for (const args of [['use', 'older'], ['use'], ['next'], ['prompts', 'use', 'older'], ['prompts', 'resume', 'older'], ['prompts', 'next'],
    ['prompts', 'archive', 'older'], ['archive', 'prompts/older.md'], ['set', 'archived', 'prompts/older.md']]) it(`${args.join(' ')} before any config carries the prompt to docs/prompts/ first`, () => {
    put('prompts/older.md', PROMPT);
    put('README.md', '# Synthetic\n\n[Earlier](prompts/older.md)\n');
    const result = ok(args, { session: 'handoffs-b' });
    assert.match(result.stderr, /Moved 1 prompt an older runlist saved in prompts\/ to docs\/prompts\/\./);
    assert.match(result.stderr, /README\.md links to prompts\/older\.md; update it to docs\/prompts\/older\.md/);
    assert.equal(read('README.md'), '# Synthetic\n\n[Earlier](prompts/older.md)\n', 'Markdown runlist does not manage is never edited');
    assert.ok(has('docs/prompts/archived/older.md'));
    rootOnly();
  });

  it('dry-run of such a command lists the carry and changes nothing', () => {
    put('prompts/older.md', PROMPT);
    const before = snapshot();
    const preview = ok(['archive', 'prompts/older.md', '--dry-run']);
    assert.match(preview.stderr, /\[dry-run\] Would move 1 prompt an older runlist saved in prompts\/ to docs\/prompts\/:\n {2}prompts\/older\.md → docs\/prompts\/older\.md/);
    assert.deepEqual(snapshot(), before);
  });

  for (const [root, where] of [['prompts', 'prompts/prompts/, which is in prompts/ at the project root'], ['.', 'prompts/ at the project root'],
    ['./prompts/', 'prompts/prompts/, which is in prompts/ at the project root'], ['prompts/team', 'prompts/team/prompts/, which is in prompts/ at the project root']]) it(`setup refuses --docs-root ${root} before scaffolding anything`, () => {
    const result = cli(['setup', '--yes', '--docs-root', root]);
    assert.notEqual(result.status, 0);
    assert.ok((result.stdout + result.stderr).includes(`--docs-root ${root} would save prompts in ${where}; runlist no longer writes there.`), result.stdout + result.stderr);
    assert.ok(!has('runlist.config.mjs') && !has('prompts'));
    rootOnly();
  });

  it('setup refuses a docs root that leads into prompts/ through a symlink', { skip: process.platform === 'win32' }, () => {
    mkdirSync(at('prompts'));
    symlinkSync(at('prompts'), at('notes'), 'dir');
    const result = cli(['setup', '--yes', '--docs-root', 'notes']);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /--docs-root notes would save prompts in notes\/prompts\/, which leads into prompts\/ at the project root through a symlinked folder/);
    assert.deepEqual(readdirSync(at('prompts')), []);
  });

  it('the first baton refuses when docs/ leads into prompts/, carrying and writing nothing', { skip: process.platform === 'win32' }, () => {
    put('prompts/older.md', PROMPT);
    symlinkSync(at('prompts'), at('docs'), 'dir');
    const before = [readdirSync(repo).sort(), snapshot(at('prompts'))];
    for (const args of [['baton', 'exporter', draft()], ['baton', 'exporter', draft(), '--dry-run'], ['new', 'prompt', 'reminder', draft()]]) {
      const refused = cli(args);
      assert.equal(refused.status, 1, args.join(' '));
      assert.match(refused.stderr, /Nothing saved: docs\/prompts\/ here leads into prompts\/ at the project root through a symlinked folder/);
    }
    assert.deepEqual([readdirSync(repo).sort(), snapshot(at('prompts'))], before);
    assert.ok(!has('runlist.config.mjs'));
  });

  it('a save from a subfolder goes to the toplevel docs/prompts/', () => {
    put('plans/sample.md', PLAN);
    put('src/app.js', '');
    ok(['baton', 'exporter', draft()], { cwd: at('src') });
    ok(['new', 'prompt', 'reminder', draft()], { cwd: at('src') });
    assert.ok(has('docs/prompts/resume-exporter.md') && has('docs/prompts/reminder.md'));
    assert.ok(has('runlist.config.mjs') && has('plans/sample.md'));
    rootOnly();
  });

  for (const format of ['md', 'json', 'html']) for (const configured of [false, true]) it(`export --format ${format} refuses an output in prompts/ ${configured ? 'where planning is off' : 'before any config'}`, () => {
    put('docs/prompts/older.md', PROMPT);
    if (configured) ok(['baton', 'exporter', draft()]);
    for (const output of [format === 'html' ? 'prompts/site' : `prompts/out.${format}`, format === 'html' ? 'prompts/a/b' : `prompts/a/out.${format}`]) {
      const refused = cli(['export', '--format', format, '--output', output]);
      assert.equal(refused.status, 1, output);
      assert.match(refused.stderr, new RegExp(`Export output: ${output.replace(/[.]/g, '\\.')} is in prompts/ at the project root, where runlist no longer writes`));
    }
    assert.ok(!has('prompts'));
    ok(['export', '--format', format, '--output', format === 'html' ? 'site' : `out.${format}`]);
  });

  it('rename keeps a prompt in the toplevel docs/prompts/ before any config', () => {
    put('docs/prompts/older.md', PROMPT);
    const refused = cli(['rename', 'docs/prompts/older.md', 'sub/docs/prompts/moved.md']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Nothing renamed: prompts live in docs\/prompts\/, and sub\/docs\/prompts\/moved\.md is outside it\./);
    assert.ok(has('docs/prompts/older.md') && !has('sub'));
    ok(['rename', 'docs/prompts/older.md', 'docs/prompts/moved.md']);
    assert.ok(has('docs/prompts/moved.md'));
  });

  it('a prompt carried before a change is found from a subfolder', () => {
    put('prompts/older.md', PROMPT);
    put('src/app.js', '');
    const used = ok(['use', 'older'], { cwd: at('src'), session: 'handoffs-b' });
    assert.match(used.stdout, /Earlier synthetic work/);
    assert.ok(has('docs/prompts/archived/older.md') && !has('src/docs'));
  });
});

describe('planning is created by setup and nothing else', () => {
  it('init refuses in a handoffs-only project, writing nothing', () => {
    ok(['baton', 'exporter', draft()]);
    const before = snapshot();
    const refused = cli(['init']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /`runlist init` needs planning\. Planning is off in this project; `runlist setup` turns it on/);
    assert.deepEqual(snapshot(), before);
  });

  it('migrate refuses to give a prompt another type; a prompt stays a prompt', () => {
    ok(['baton', 'exporter', draft()]);
    const before = snapshot();
    for (const type of ['plan', 'doc']) {
      const refused = cli(['migrate', 'type', 'prompt', type]);
      assert.equal(refused.status, 1, type);
      assert.match(refused.stderr, new RegExp(`\`runlist migrate type prompt ${type}\` needs planning\\.`));
    }
    assert.deepEqual(snapshot(), before);
    assert.match(ok(['prompts']).stdout, /resume-exporter/);
  });

  it('with no config at all, planning starts as it always did: new plan, doc and hub create documents', () => {
    ok(['new', 'plan', 'alpha', draft()]);
    ok(['new', 'doc', 'beta', draft()]);
    ok(['new', 'hub', 'gamma']);
    assert.ok(has('plans/alpha.md') && has('beta.md') && has('plans/gamma.md'));
    assert.ok(!has('runlist.config.mjs'));
    assert.match(ok(['plans']).stdout, /alpha/);
    const types = ok(['new', '--list-types']).stdout;
    assert.match(types, /^ {2}plan$/m);
    assert.match(types, /^ {2}doc$/m);
  });

  it('where planning is off, new plan, doc, hub, decision and an implicit doc refuse and create nothing', () => {
    ok(['baton', 'exporter', draft()]);
    const before = snapshot();
    for (const args of [['new', 'plan', 'unexpected', draft()], ['new', 'doc', 'unexpected', draft()], ['new', 'hub', 'unexpected'], ['new', 'unexpected'],
      ['new', 'decision', 'docs/prompts/resume-exporter.md', '--question', 'Which?', draft()]]) {
      const refused = cli(args);
      assert.equal(refused.status, 1, args.join(' '));
      assert.match(refused.stderr, /needs planning\. Planning is off in this project; `runlist setup` turns it on/, args.join(' '));
    }
    assert.deepEqual(snapshot(), before);
    assert.doesNotMatch(ok(['new', '--list-types']).stdout, /^ {2}plan$/m);
  });
});

describe('outside the prompt folder, a prompt is not one of the handoffs', () => {
  it('show, prompts show, use and check refuse a typed prompt elsewhere, and check refuses other paths', () => {
    ok(['baton', 'exporter', draft()]);
    put('notes/outside.md', PROMPT);
    put('docs/plans/sample.md', PLAN);
    for (const args of [['show', 'notes/outside.md'], ['prompts', 'show', 'notes/outside.md'], ['use', 'notes/outside.md'], ['check', 'notes/outside.md'], ['check', 'docs/plans'], ['check', 'docs/plans/sample.md']]) {
      const refused = cli(args);
      assert.equal(refused.status, 1, args.join(' '));
      assert.match(refused.stderr, /is outside this project's handoffs: planning is off in this project/, args.join(' '));
    }
    assert.ok(has('notes/outside.md'));
    assert.match(ok(['check', 'docs/prompts/resume-exporter.md']).stdout, /docs scanned: 1/);
  });
});

describe('handoffs-only output asks for nothing planning would', () => {
  it('a handoff record carried in for a plan that is gone does not make the hook ask for plan work', () => {
    put('prompts/older.md', PROMPT);
    put('.runlist/handoffs/synthetic.json', `${JSON.stringify({ id: 'synthetic', plan: 'plans/gone.md', prompt: 'prompts/older.md', name: 'older', savedAt: '2026-10-01T00:00:00Z', nextStep: '"x"', sessionId: 'handoffs-a' }, null, 2)}\n`);
    ok(['baton', 'exporter', draft()]);
    assert.equal(JSON.parse(read('.runlist/handoffs/synthetic.json')).prompt, 'docs/prompts/older.md', 'the record is kept');
    const start = ok(['hud']).stdout;
    assert.doesNotMatch(start, /Handoff not done|baton --done|plan/i);
  });

  it('statuses, new --list-types, help, removed verbs and the child footer speak of prompts only', () => {
    ok(['baton', 'parent', draft()]);
    const statuses = ok(['statuses']).stdout;
    assert.match(statuses, /type: prompt/);
    assert.doesNotMatch(statuses, /type: (plan|doc)/);
    const types = ok(['new', '--list-types']).stdout;
    assert.match(types, /\n {2}prompt\n/);
    assert.doesNotMatch(types, /\n {2}(plan|doc|hub|decision)\n/);
    for (const args of [['--help'], ['help'], ['help', 'all']]) {
      const help = ok(args).stdout;
      assert.match(help, /session handoffs \(planning is off in this project\)/, args.join(' '));
      assert.doesNotMatch(help.replace(/planning is off|Turn planning on \(plans, docs and an index\)/g, ''), /\bplans?\b|in-session/i, args.join(' '));
    }
    assert.doesNotMatch(ok(['help', 'statuses']).stdout, /in-session|queued-after/);
    assert.equal(ok(['plans', '--help']).stdout, 'Planning is off in this project; `runlist setup` turns it on (your prompts stay where they are).\n');
    for (const command of ['pickup', 'release', 'finish', 'unpickup', 'handoff']) {
      const removed = cli([command]);
      assert.equal(removed.status, 1);
      assert.match(removed.stderr, /was removed\. Handoffs: `runlist baton <slug> @<file>` saves one/);
      assert.doesNotMatch(removed.stderr, /plan|in-session/);
    }
    const unnamed = cli(['set', 'archived']);
    assert.equal(unnamed.status, 1);
    assert.equal(unnamed.stderr, 'Name the prompt to change: runlist set archived <prompt>\n');
    assert.match(ok(['doctor', '--claims']).stdout, /Nothing is claimed\./);
    ok(['baton', '--subagent', 'child', draft(), '--parent', 'resume-parent']);
    const footer = ok(['prompts', 'show', 'resume-parent']).stdout;
    assert.match(footer, /Fold completed results into the parent's work/);
    assert.doesNotMatch(footer, /owning plan/);
  });
});

describe('setup never offers the root prompts/ back', () => {
  it('reports foreign files there as left untouched', () => {
    put('prompts/library.md', '# A prompt library\n');
    put('prompts/older.md', PROMPT);
    const unconfigured = ok(['setup']).stdout;
    assert.match(unconfigured, /prompts\/ \(1 \.md file\) is left untouched: runlist keeps prompts in docs\/prompts\//);
    assert.match(unconfigured, /notice: left untouched in prompts\/[^\n]*\n {4}prompts\/library\.md/);
    assert.doesNotMatch(unconfigured, /export const root = \[[^\]]*"prompts"|include their folders/);
    ok(['baton', 'exporter', draft()]);
    const upgrade = ok(['setup']).stdout;
    assert.match(upgrade, /is left untouched/);
    assert.doesNotMatch(upgrade, /export const root = \[[^\]]*"prompts"/);
    ok(['setup', '--yes']);
    assert.equal(read('prompts/library.md'), '# A prompt library\n');
  });
});

describe('a fresh setup keeps prompts in <docs root>/prompts/ whatever the root is called', () => {
  for (const root of ['review-prompts', 'notes/prompts', 'notes']) it(`routes new and archived prompts under ${root}/prompts/`, async () => {
    const preview = ok(['setup', '--docs-root', root]);
    assert.match(preview.stdout, new RegExp(`create {2}${root}/prompts/`));
    ok(['setup', '--yes', '--docs-root', root]);
    const config = await resolveConfig(repo);
    assert.deepEqual({ ...config.raw.templates.prompt }, { ...SETUP_PROMPT_ROUTING });
    assert.equal(ok(['new', 'prompt', 'after', draft()]).stdout.split('\n')[0], `Created: ${root}/prompts/after.md (prompt)`);
    assert.ok(!has(`${root}/after.md`));
    ok(['prompts', 'archive', 'after']);
    ok(['check']);
  });

  it('leaves a configured root whose name ends in prompts routed as it was', () => {
    put('runlist.config.mjs', "export const root = 'review-prompts';\n");
    mkdirSync(at('review-prompts'));
    assert.equal(ok(['new', 'prompt', 'after', draft()]).stdout.split('\n')[0], 'Created: review-prompts/after.md (prompt)');
  });
});

describe('an interrupted setup upgrade names the command that finishes it', () => {
  it('points a refused mutation at runlist setup --yes, which then finishes the move', () => {
    ok(['baton', 'exporter', draft()]);
    put('plans/old.md', PLAN);
    const script = `
      import { readFileSync } from 'node:fs';
      import { resolveConfig } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../src/config.mjs')).href)};
      import { planHandoffsUpgrade } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../src/handoffs-mode.mjs')).href)};
      import { applySetupCarry, planSetupCarry, preConfigView } from ${JSON.stringify(pathToFileURL(path.resolve(import.meta.dirname, '../src/setup-carry.mjs')).href)};
      const repo = process.argv[1];
      const config = await resolveConfig(repo);
      const upgrade = planHandoffsUpgrade(config);
      const before = await preConfigView(repo);
      const { moves } = planSetupCarry(before, await resolveConfig(repo, undefined, { overrides: upgrade.overrides }));
      applySetupCarry(moves, before, { expectedConfig: { path: config.configPath, content: readFileSync(config.configPath, 'utf8') },
        testHooks: { afterTransactionPhase(phase) { if (phase === 'target-publication') process.kill(process.pid, 'SIGKILL'); } } });
    `;
    const killed = spawnSync(process.execPath, ['--input-type=module', '-e', script, repo], { cwd: repo, encoding: 'utf8', timeout: 20000 });
    assert.notEqual(killed.status, 0, killed.stdout + killed.stderr);
    const refused = cli(['prompts', 'archive', 'resume-exporter']);
    assert.equal(refused.status, 1, refused.stdout + refused.stderr);
    assert.match(refused.stderr, /plans\/old\.md/);
    assert.match(refused.stderr, /`runlist setup` stopped part-way through turning planning on here; run `runlist setup --yes` to finish the upgrade\./);
    ok(['setup', '--yes']);
    assert.equal(read('docs/plans/old.md'), PLAN);
    assert.ok(!has('plans/old.md'));
    ok(['prompts', 'archive', 'resume-exporter']);
  });
});
