import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveConfig } from '../src/config.mjs';
import { checkUpgradedConfig, handoffsConfigSource, jsLiteral, planHandoffsConfig, planHandoffsUpgrade, publishHandoffsConfig } from '../src/handoffs-mode.mjs';
import { createFileExclusive } from '../src/atomic-mutation.mjs';

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
    const folder = layout === 'docs' ? 'docs/prompts' : 'prompts';

    const saved = ok(['baton', 'exporter', draft()]);
    const output = saved.stdout + saved.stderr;
    assert.equal(output.match(/Set up runlist for handoffs here/g)?.length, 1, output);
    assert.match(output, new RegExp(`Set up runlist for handoffs here \\(runlist\\.config\\.mjs, prompts in ${folder}/\\)\\. Planning is off; \`runlist setup\` turns it on\\.`));
    assert.doesNotMatch(output, /No runlist config|run `runlist setup`; it carries/);
    assert.match(output, /Saved prompt: resume-exporter\n$/);
    assert.equal(read('runlist.config.mjs'), handoffsConfigSource(folder));
    assert.ok(has(`${folder}/resume-exporter.md`));
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
    assert.match(created.stdout, /Set up runlist for handoffs here \(runlist\.config\.mjs, prompts in prompts\/\)/);
    assert.ok(has('prompts/reminder.md'));
    assert.match(read('runlist.config.mjs'), /^export const mode = 'handoffs';$/m);
  });

  it('dry-run writes nothing and says what it would create; JSON names the setup', () => {
    put('docs/design.md', '# Notes\n');
    const before = snapshot();
    const preview = ok(['baton', 'exporter', draft(), '--dry-run']);
    assert.match(preview.stderr, /\[dry-run\] Would set up runlist for handoffs here \(runlist\.config\.mjs, prompts in docs\/prompts\/\)\. Planning stays off/);
    assert.match(preview.stderr, /\[dry-run\] Would create: docs\/prompts\/resume-exporter\.md/);
    const json = JSON.parse(ok(['baton', 'exporter', draft(), '--dry-run', '--json']).stdout);
    assert.deepEqual(json.handoffsSetup, { config: 'runlist.config.mjs', promptDirectory: 'docs/prompts', created: false });
    assert.equal(json.prompt, 'docs/prompts/resume-exporter.md');
    assert.match(ok(['new', 'prompt', 'reminder', draft(), '-n']).stdout, /Would create: docs\/prompts\/reminder\.md/);
    assert.deepEqual(snapshot(), before);

    const applied = JSON.parse(ok(['baton', 'exporter', draft(), '--json']).stdout);
    assert.deepEqual(applied.handoffsSetup, { config: 'runlist.config.mjs', promptDirectory: 'docs/prompts', created: true });
    const second = JSON.parse(ok(['baton', 'second', draft(), '--json']).stdout);
    assert.equal(second.handoffsSetup, null);
  });

  it('creates the config at the Git toplevel when run from a subfolder', () => {
    put('src/app/index.js', '');
    ok(['baton', 'exporter', draft()], { cwd: at('src/app') });
    assert.ok(has('runlist.config.mjs') && has('prompts/resume-exporter.md'));
    assert.ok(!has('src/app/runlist.config.mjs') && !has('src/app/prompts'));
  });

  it('leaves plans an older version saved at the toplevel to setup, even from a subfolder', () => {
    put('plans/sample.md', '---\ntype: plan\nstatus: planned\n---\n# Sample\n');
    put('src/app/index.js', '');
    const saved = ok(['baton', 'exporter', draft()], { cwd: at('src/app') });
    assert.match(saved.stdout + saved.stderr, /run `runlist setup`; it carries this prompt over/);
    assert.doesNotMatch(saved.stdout + saved.stderr, /Set up runlist for handoffs/);
    assert.ok(!has('runlist.config.mjs'));
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
    assert.equal(read('runlist.config.mjs'), handoffsConfigSource('prompts'));
    assert.ok(has('prompts/resume-first.md') && has('prompts/resume-second.md'));
  });

  it('adopts runlist prompts an older version left in prompts/ in place, even with a docs/ folder', () => {
    const legacy = '---\ntype: prompt\nstatus: pending\ncreated: 2026-10-01\nupdated: 2026-10-01\n---\n\n# Resume\n\nOlder handoff.\n';
    put('prompts/resume-older.md', legacy);
    put('docs/design.md', '# Notes\n');
    ok(['baton', 'exporter', draft()]);
    assert.match(read('runlist.config.mjs'), /^export const root = 'prompts';$/m);
    assert.equal(read('prompts/resume-older.md'), legacy);
    assert.ok(has('prompts/resume-exporter.md') && !has('docs/prompts'));
    const listed = ok(['prompts']).stdout;
    assert.match(listed, /resume-older/);
    assert.match(listed, /resume-exporter/);
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
      assert.match(text, /no runlist config here yet: baton also sets one up for handoffs \(runlist\.config\.mjs and a prompts folder\)/);
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
    assert.match(pickup, /1 pending prompt \(prompts\/resume-exporter\.md\); `\/pickup` or `runlist use <name>` consumes one \(archives the prompt and prints it\)/);
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
    const folder = layout === 'docs' ? 'docs/prompts' : 'prompts';
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
    assert.match(config, layout === 'docs' ? /^export const root = 'docs';$/m : /^export const root = \['docs', 'prompts'\];$/m);
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
    assert.ok(existsSync(path.join(linked, 'runlist.config.mjs')) && existsSync(path.join(linked, 'prompts/resume-exporter.md')));
    assert.ok(!has('runlist.config.mjs'));
  });
});

describe('a handoffs-only project manages only its prompts', () => {
  const foreign = '---\ntype: doc\nstatus: draft\nmodule: []\nsurface: []\nupdated: 2026-10-01\n---\n# User library\n\nUSER_SENTINEL material.\n';
  for (const layout of ['docs/prompts', 'prompts']) it(`ignores and never changes other Markdown in ${layout}/`, () => {
    if (layout === 'docs/prompts') put('docs/design.md', '# Notes\n');
    else put('prompts/resume-older.md', PROMPT);
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
  for (const docsRoot of ["notes'public", 'notes$&', "notes$'tail", 'nötes/ünïcode']) it(`keeps --docs-root ${docsRoot} intact`, () => {
    ok(['baton', 'exporter', draft()]);
    ok(['setup', '--yes', '--docs-root', docsRoot]);
    assert.deepEqual(JSON.parse(ok(['config', 'get', 'root', '--json']).stdout).value, [docsRoot, 'prompts']);
    assert.equal(JSON.parse(ok(['config', 'get', 'index.path', '--json']).stdout).value, path.join(repo, ...docsRoot.split('/'), 'docs.md'));
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
    assert.equal(read('runlist.config.mjs'), handoffsConfigSource('prompts'));
  });

  // Prompt roots come from the config, so these never touch the filesystem.
  for (const promptRoot of ["it's prompts", 'with$&dollar', 'back\\slash', 'ünïcode prompts']) it(`serialises a prompt root of ${JSON.stringify(promptRoot)} to the same value`, { skip: process.platform === 'win32' && promptRoot.includes('\\') }, async () => {
    put('runlist.config.mjs', handoffsConfigSource('prompts').replace("export const root = 'prompts';", () => `export const root = ${JSON.stringify(promptRoot)};`));
    const config = { configPath: at('runlist.config.mjs'), repoRoot: repo, docsRoot: path.join(repo, promptRoot), docsRoots: [path.join(repo, promptRoot)] };
    const upgraded = planHandoffsUpgrade(config, 'docs');
    const loaded = await import(`data:text/javascript,${encodeURIComponent(upgraded.content)}`);
    assert.equal(loaded.mode, 'plans');
    assert.deepEqual(loaded.root, ['docs', promptRoot]);
    assert.equal(loaded.index.path, 'docs/docs.md');
  });

  it('checks generated JavaScript before replacing anything', () => {
    assert.equal(jsLiteral("a'b"), JSON.stringify("a'b"));
    assert.equal(jsLiteral(['docs', 'prompts']), "['docs', 'prompts']");
    assert.throws(() => checkUpgradedConfig("export const root = ['notes'public'];\n", { root: ["notes'public"] }, 'cfg'), /would not load as intended/);
    assert.throws(() => checkUpgradedConfig("export const root = 'other';\n", { root: 'docs' }, 'cfg'), /root reads back as "other"/);
    checkUpgradedConfig("export const root = [\"notes'public\", 'prompts'];\n", { root: ["notes'public", 'prompts'] }, 'cfg');
  });
});

describe('the first baton never hides what was saved before setup', () => {
  it('leaves a nested pre-config plan visible and configures nothing', () => {
    put('plans/team/old.md', PLAN);
    const saved = ok(['baton', 'exporter', draft()]);
    assert.match(saved.stdout + saved.stderr, /run `runlist setup`; it carries this prompt over/);
    assert.ok(!has('runlist.config.mjs'));
    assert.match(ok(['plans']).stdout, /old/);
  });

  it('adopts nested prompts under prompts/ in place, even with docs/', () => {
    put('docs/design.md', '# Notes\n');
    put('prompts/team/resume-old.md', PROMPT);
    ok(['baton', 'exporter', draft()]);
    assert.match(read('runlist.config.mjs'), /^export const root = 'prompts';$/m);
    assert.match(ok(['prompts']).stdout, /resume-old[\s\S]*resume-exporter|resume-exporter[\s\S]*resume-old/);
    assert.match(ok(['use', 'resume-old'], { session: 'handoffs-b' }).stdout, /Earlier synthetic work/);
  });

  it('keeps the unconfigured behaviour when earlier prompts sit outside both prompt folders', () => {
    put('notes/handoffs/resume-old.md', PROMPT);
    const saved = ok(['baton', 'exporter', draft()]);
    assert.match(saved.stdout + saved.stderr, /run `runlist setup`; it carries this prompt over/);
    assert.ok(!has('runlist.config.mjs'));
    assert.match(ok(['use', 'resume-old'], { session: 'handoffs-b' }).stdout, /Earlier synthetic work/);
  });

  it('treats a scan it could not finish as proof of nothing', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    put('locked/inner.md', PLAN);
    chmodSync(at('locked'), 0o000);
    try {
      const saved = ok(['baton', 'exporter', draft()]);
      assert.doesNotMatch(saved.stdout + saved.stderr, /Set up runlist for handoffs/);
      assert.ok(!has('runlist.config.mjs'));
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
    assert.ok(!existsSync(path.join(child, 'prompts')));
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
