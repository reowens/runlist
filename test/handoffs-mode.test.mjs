import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { ensureHandoffsConfig, handoffsConfigSource } from '../src/handoffs-mode.mjs';

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
    const unconfigured = await resolveConfig(repo);
    const theirs = "export const root = 'notes';\n";
    put('notes/.gitkeep', '');
    put('runlist.config.mjs', theirs);
    const result = await ensureHandoffsConfig(repo, unconfigured, { home });
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
      assert.match(text, /first handoff here, so baton also creates runlist\.config\.mjs/);
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
    assert.doesNotMatch(save, /first handoff here/);
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
