import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { COMMAND_SCHEMA, commandPlanning } from '../src/commands.mjs';
import { PLANNING_OFF } from '../src/handoffs-scope.mjs';

// Every command the registry marks with `planning` (src/commands.mjs) is
// stopped by the dispatcher's one gate in a handoffs-only project, and runs as
// it always did in a planning project. Walking the registry means a new plan
// command is covered the moment it opts in.

const bin = path.resolve(import.meta.dirname, '../bin/runlist.mjs');
const pluginRoot = path.resolve(import.meta.dirname, '../plugins/runlist');
let handoffs, planning, home;

function cli(cwd, args) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd, encoding: 'utf8', timeout: 30000,
    env: { ...process.env, RUNLIST_SESSION_ID: 'gate', HOME: home, USERPROFILE: home, NO_COLOR: '1', FORCE_COLOR: '0', CLAUDE_PLUGIN_ROOT: pluginRoot, OPENCODE: '', OPENCODE_PID: '' },
  });
}

function repo(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: dir }).status, 0);
  return dir;
}

// One invocation per form: the command, plus the subcommand that selects the
// form. A command whose every form has a subcommand is also run bare, which
// reaches the command-level flag.
const cases = Object.values(COMMAND_SCHEMA).flatMap(definition => {
  const argvs = definition.forms.map(form => [definition.name, ...form.subcommands.slice(0, 1)]);
  if (definition.forms.every(form => form.subcommands.length)) argvs.push([definition.name]);
  return argvs.flatMap(argv => {
    const planning = commandPlanning(argv[0], argv.slice(1));
    return planning ? [{ argv, requirement: planning.requirement }] : [];
  });
});

before(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'runlist-gate-home-'));
  writeFileSync(path.join(home, 'draft.md'), '# Resume\n\nNext: synthetic step.\n');
  handoffs = repo('runlist-gate-handoffs-');
  assert.equal(cli(handoffs, ['baton', 'exporter', `@${path.join(home, 'draft.md')}`]).status, 0);
  planning = repo('runlist-gate-planning-');
  assert.equal(cli(planning, ['setup', '--yes']).status, 0);
});
after(() => {
  for (const dir of [handoffs, planning, home]) rmSync(dir, { recursive: true, force: true });
});

// Every command and form either carries a `planning` mark or is listed here
// as one that works where planning is off, with the reason. A plan or doc
// command added without a mark fails until it is classified one way or the
// other.
const WORKS_WITHOUT_PLANNING = new Map(Object.entries({
  // Setup, help and host plumbing.
  help: 'answers for handoffs where planning is off', completions: 'shell completion', setup: 'turns planning on',
  config: 'config inspection', 'config show': 'config inspection', 'config get': 'config inspection', 'config set': 'promptTracking only', watch: 'proxy: the child command meets the gate',
  desktop: 'launch only', 'desktop install': 'installs the app', app: 'editor over the prompts; its creation API refuses anything but a prompt here',
  guard: 'hook; where planning is off, only prompts in the prompt folder are saved prompts', hud: 'hook, worded for handoffs', update: 'host refresh', install: 'host install', ship: 'release tooling',
  model: 'local model', 'model status': 'local model', 'model start': 'local model', 'model stop': 'local model',
  'model measure': 'local model', 'model use': 'local model', 'model cap': 'local model', 'self-check': 'internal',
  journal: 'own invocations', errors: 'own errors', misuse: 'own misuse log',
  pickup: 'removed, worded for handoffs', unpickup: 'removed, worded for handoffs', release: 'removed, worded for handoffs',
  finish: 'removed, worded for handoffs', handoff: 'removed, worded for handoffs',
  // The handoff verbs.
  baton: 'saves a handoff; help worded for handoffs', use: 'resumes a prompt; any other file is outside the handoffs', next: 'resumes the oldest prompt',
  prompts: 'lists prompts; help worded for handoffs', 'prompts list': 'lists prompts', 'prompts next': 'resumes a prompt', 'prompts use': 'resumes a prompt',
  'prompts show': 'reads prompts', 'prompts archive': 'archives a prompt', 'prompts link': 'links child handoffs',
  'prompts new': 'saves a prompt', 'prompts hold': 'removed, worded for handoffs', 'prompts unhold': 'removed, worded for handoffs',
  // Reads and changes over the documents the scan finds, which here are the
  // prompts alone; a --type other than prompt meets the gate in the dispatcher.
  list: 'prompts only', json: 'prompts only', briefing: 'ends with the planning-off line', context: 'ends with the planning-off line',
  'agent-context': 'worded for handoffs', query: 'prompts only', grep: 'prompts only', show: 'prompts only',
  diff: 'prompts only', summary: 'prompts only', flags: 'flags log', flag: 'flags log', 'flag add': 'flags log',
  'flag accept': 'flags log', 'flag reject': 'flags log', 'flag resolve': 'flags log', 'flag show': 'flags log', 'flag sync': 'flags log',
  export: 'prompts only; never writes into the root prompts/', status: 'deprecated prompt status, worded for handoffs', set: 'prompt status, worded for handoffs',
  archive: 'archives a prompt, worded for handoffs', bulk: 'prompts only', 'bulk archive': 'archives prompts', touch: 'prompts only',
  new: 'prompts only; other types refuse in runNew; help worded for handoffs',
  lint: 'prompts only', rename: 'prompts only; a prompt stays in the prompt folder', migrate: 'prompts only; a positional type other than prompt meets the gate',
  'fix-refs': 'prompts only', refs: 'code roots, none in a handoffs config', 'refs repair': 'code roots, none in a handoffs config',
  doctor: 'maintenance over the prompts', statuses: 'prompt statuses, worded for handoffs', 'statuses list': 'prompt statuses',
  'statuses add': 'edits the types block; --type other than prompt meets the gate', 'statuses set': 'edits the types block; --type other than prompt meets the gate',
  'statuses remove': 'edits the types block; --type other than prompt meets the gate', 'statuses migrate': 'edits the types block; a positional type other than prompt meets the gate',
  check: 'checks the prompts', index: 'says there is no index here',
}));

describe('the planning gate walks the command registry', () => {
  it('classifies every command: a planning mark, or listed as working without planning', () => {
    const unclassified = [];
    for (const definition of Object.values(COMMAND_SCHEMA)) {
      const argvs = definition.forms.map(form => [definition.name, ...form.subcommands.slice(0, 1)]);
      if (definition.forms.every(form => form.subcommands.length)) argvs.push([definition.name]);
      for (const argv of argvs) {
        const name = argv.join(' ');
        const marked = Boolean(commandPlanning(argv[0], argv.slice(1)));
        if (marked === WORKS_WITHOUT_PLANNING.has(name)) unclassified.push(`${name}: ${marked ? 'marked and allowlisted' : 'neither marked nor allowlisted'}`);
      }
    }
    assert.deepEqual(unclassified, []);
  });

  it('covers the plan views and plan actions', () => {
    const names = new Set(cases.map(item => item.argv.join(' ')));
    for (const name of ['plans', 'health', 'runlists', 'roadmap', 'roadmap next', 'runlist', 'runlist add', 'modules', 'stale', 'bulk-tag', 'sync-status']) {
      assert.ok(names.has(name), name);
    }
    assert.ok(cases.some(item => item.requirement === 'view') && cases.some(item => item.requirement === 'action'));
  });

  for (const { argv, requirement } of cases) {
    it(`${argv.join(' ')}: ${requirement === 'view' ? 'says planning is off and succeeds' : 'refuses'} in a handoffs-only project`, () => {
      const result = cli(handoffs, argv);
      if (requirement === 'view') {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `${PLANNING_OFF}\n`);
        const json = cli(handoffs, [...argv, '--json']);
        assert.equal(json.status, 0, json.stderr);
        assert.deepEqual(JSON.parse(json.stdout), { planning: false, message: PLANNING_OFF });
      } else {
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.match(result.stderr, new RegExp(`\`runlist ${argv.join(' ')}\` needs planning\\. Planning is off in this project; \`runlist setup\` turns it on`));
      }
    });

    // What each one prints there is pinned by its own tests; here it only
    // must not meet the gate.
    it(`${argv.join(' ')}: runs as usual in a planning project`, () => {
      const result = cli(planning, argv);
      assert.doesNotMatch(result.stdout + result.stderr, /Planning is off|needs planning|outside this project's handoffs/);
    });
  }
});

describe('reads filtered to a type other than prompts, and files outside the prompt folder', () => {
  it('a --type other than prompt says planning is off for a read and refuses an action', () => {
    for (const args of [['query', '--type', 'plan'], ['list', '--type', 'doc'], ['stats', '--type', 'plan']]) {
      const result = cli(handoffs, args);
      assert.equal(result.status, 0, args.join(' '));
      assert.equal(result.stdout, `${PLANNING_OFF}\n`, args.join(' '));
    }
    const prompts = cli(handoffs, ['query', '--type', 'prompt']);
    assert.equal(prompts.status, 0);
    assert.match(prompts.stdout, /resume-exporter/);
    const exported = cli(handoffs, ['export', '--type', 'doc']);
    assert.equal(exported.status, 1);
    assert.match(exported.stderr, /`runlist export --type doc` needs planning\./);
  });

  it('a file outside the prompt folder hears that it is outside the handoffs', () => {
    for (const args of [['show', 'docs/plans/sample.md'], ['set', 'archived', 'docs/plans/sample.md'], ['use', 'docs/plans/sample.md']]) {
      const result = cli(handoffs, args);
      assert.equal(result.status, 1, args.join(' '));
      assert.match(result.stderr, /`docs\/plans\/sample\.md` is outside this project's handoffs: planning is off in this project; `runlist setup` turns it on/, args.join(' '));
    }
  });

  it('a positional type other than prompt meets the gate before anything changes', () => {
    const configPath = path.join(handoffs, 'runlist.config.mjs');
    const source = readFileSync(configPath, 'utf8');
    writeFileSync(configPath, `${source}\nexport const types = { plan: { statuses: ['planned', 'active', 'archived'] } };\n`);
    try {
      const before = readFileSync(configPath, 'utf8');
      for (const [args, what] of [[['statuses', 'migrate', 'plan', '--yes'], 'statuses migrate plan'], [['migrate', 'type', 'prompt', 'plan'], 'migrate type prompt plan']]) {
        const result = cli(handoffs, args);
        assert.equal(result.status, 1, args.join(' '));
        assert.equal(result.stdout, '');
        assert.match(result.stderr, new RegExp(`\`runlist ${what}\` needs planning\. Planning is off in this project`));
      }
      assert.equal(readFileSync(configPath, 'utf8'), before);
      assert.match(cli(handoffs, ['prompts']).stdout, /resume-exporter/);
    } finally { writeFileSync(configPath, source); }
  });

  it('both help spellings print the same text, the planning-off line for a planning command', () => {
    // `help statuses` is its own topic (the status vocabulary), as in every mode.
    for (const name of ['plans', 'init', 'runlist', 'health', 'new', 'baton', 'set', 'status', 'prompts', 'archive', 'briefing', 'hud', 'use', 'check']) {
      const spelled = cli(handoffs, ['help', name]);
      const flagged = cli(handoffs, [name, '--help']);
      assert.equal(spelled.status, 0, name);
      assert.equal(spelled.stdout, flagged.stdout, name);
    }
    assert.equal(cli(handoffs, ['help', 'plans']).stdout, `${PLANNING_OFF}\n`);
    for (const name of ['new', 'baton', 'statuses', 'set', 'status', 'prompts', 'archive', 'briefing', 'hud']) {
      const text = cli(handoffs, [name, '--help']).stdout;
      assert.match(text, /planning is off in this project/, name);
      assert.doesNotMatch(text.replace(/(Plans and docs|Plan and doc statuses|Plan statuses|Plan pipelines|Handing off a plan) comes?\s+with\s+planning/g, ''), /\bplans?\b|in-session|\bhub\b|--done/i, name);
    }
    for (const name of ['plans', 'new', 'baton']) assert.equal(cli(planning, ['help', name]).stdout, cli(planning, [name, '--help']).stdout, name);
  });

  it('removed prompt verbs, the deprecated status verb and the briefing views speak of prompts', () => {
    const hold = cli(handoffs, ['prompts', 'hold', 'resume-exporter']);
    assert.equal(hold.status, 1);
    assert.match(hold.stderr, /was removed — a prompt is pending or archived, and nothing else\.\nTo set one aside, `runlist prompts archive <file>`\./);
    assert.doesNotMatch(hold.stderr, /plan/i);
    const status = cli(handoffs, ['status', 'resume-exporter', 'pending', '--dry-run']);
    assert.match(status.stderr, /prefer `runlist set <status> <prompt>`/);
    assert.doesNotMatch(status.stderr, /plan/i);
    assert.ok(cli(handoffs, ['context']).stdout.endsWith(`${PLANNING_OFF}\n`));
    assert.ok(cli(handoffs, ['briefing']).stdout.endsWith(`${PLANNING_OFF}\n`));
  });

  it('flag add still accepts any repository path', () => {
    writeFileSync(path.join(handoffs, 'README.md'), '# Synthetic\n');
    const result = cli(handoffs, ['flag', 'add', 'README.md:1', 'synthetic finding']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(cli(handoffs, ['flags']).stdout, /synthetic finding/);
  });
});
