import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('the planning gate walks the command registry', () => {
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

  it('flag add still accepts any repository path', () => {
    writeFileSync(path.join(handoffs, 'README.md'), '# Synthetic\n');
    const result = cli(handoffs, ['flag', 'add', 'README.md:1', 'synthetic finding']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(cli(handoffs, ['flags']).stdout, /synthetic finding/);
  });
});
