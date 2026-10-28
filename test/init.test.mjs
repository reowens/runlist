import { describe, it, afterEach } from 'node:test';
import { deepStrictEqual, strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, readdirSync, readlinkSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function run(args, cwd, opts = {}) {
  // Override HOME so SessionStart-hook detection (which reads ~/.claude/
  // settings.json as a fallback) sees an isolated empty home instead of the
  // dev's real one. Without this, a developer who has `dotmd hud` wired
  // globally would see init's "already wired" branch fire in tests that
  // expected the "print snippet" branch.
  //
  // By default HOME == cwd (a single tmpDir is fine; its `.claude/` would
  // serve as both project and global path, but tests that need to distinguish
  // the two can pass `opts.home` for a separate fake home dir.
  const runCwd = cwd ?? tmpDir;
  const homeDir = opts.home ?? runCwd;
  return spawnSync('node', [BIN, ...args], {
    cwd: runCwd, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', HOME: homeDir, USERPROFILE: homeDir },
  });
}

// Exercise runInit's argv contract independently of the CLI registry, which is
// maintained separately. The existing CLI tests above/below still cover init's
// default dispatch and global dry-run flag.
function init(argv = [], cwd = tmpDir) {
  const script = `
    import { resolveConfig } from ${JSON.stringify(new URL('../src/config.mjs', import.meta.url).href)};
    import { runInit } from ${JSON.stringify(new URL('../src/init.mjs', import.meta.url).href)};
    const argv = process.argv.slice(1);
    try {
      await runInit(process.cwd(), await resolveConfig(process.cwd()), {
        argv, dryRun: argv.includes('--dry-run'),
      });
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script, '--', ...argv], {
    cwd, encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', HOME: cwd, USERPROFILE: cwd },
  });
}

function snapshot(dir = tmpDir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const rel = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) return [[rel, `symlink:${readlinkSync(path.join(dir, entry.name))}`]];
    return entry.isDirectory() ? snapshot(path.join(dir, entry.name), rel) : [[rel, readFileSync(path.join(dir, entry.name)).toString('base64')]];
  }).sort(([a], [b]) => a.localeCompare(b));
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('init basic', () => {
  it('creates config, docs dir, and index file', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(existsSync(path.join(tmpDir, 'runlist.config.mjs')));
    ok(existsSync(path.join(tmpDir, 'docs')));
    ok(existsSync(path.join(tmpDir, 'docs', 'docs.md')));
  });

  it('config contains default root', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    run(['init']);
    const content = readFileSync(path.join(tmpDir, 'runlist.config.mjs'), 'utf8');
    ok(content.includes("root = 'docs'"));
  });

  it('index file contains markers', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    run(['init']);
    const content = readFileSync(path.join(tmpDir, 'docs', 'docs.md'), 'utf8');
    ok(content.includes('GENERATED:runlist:start'));
    ok(content.includes('GENERATED:runlist:end'));
  });

  it('--dry-run does not actually write anything', () => {
    // Pre-fix: runInit took no dryRun param and ignored the global --dry-run
    // flag. `dotmd init -n` would *write* the config, docs/, gitignore, and
    // .claude/commands/* — a silent footgun for anyone running -n to preview.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, '.claude')); // trigger slash-command scaffold path
    const r = run(['init', '--dry-run']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);

    // Output should announce intent with a [dry-run] tag on every line.
    ok(r.stdout.includes('[dry-run]'), `dry-run output should be tagged; got: ${r.stdout}`);

    // Nothing should have actually been created.
    ok(!existsSync(path.join(tmpDir, 'runlist.config.mjs')), 'config not written in dry-run');
    ok(!existsSync(path.join(tmpDir, 'docs')), 'docs/ not created in dry-run');
    ok(!existsSync(path.join(tmpDir, '.claude', 'commands')), '.claude/commands/ not created in dry-run');
  });

  it('preserves existing retired generated slash-command files on init', () => {
    // Setup does not delete existing project files, even legacy generated ones.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), `export const root = 'docs';\n`);
    // Plant a generated slash-command file (dotmd banner present).
    writeFileSync(
      path.join(tmpDir, '.claude', 'commands', 'plans.md'),
      '---\ndescription: x\n---\n<!-- dotmd-generated: 0.0.1 -->\n\nold content\n',
    );
    const r = run(['init']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    strictEqual(readFileSync(path.join(tmpDir, '.claude', 'commands', 'plans.md'), 'utf8'),
      '---\ndescription: x\n---\n<!-- dotmd-generated: 0.0.1 -->\n\nold content\n');
    ok(!r.stdout.includes('removed'), 'init must not delete existing files');
  });

  it('leaves user-managed slash-command files (no banner) untouched on init', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), `export const root = 'docs';\n`);
    const custom = path.join(tmpDir, '.claude', 'commands', 'plans.md');
    writeFileSync(custom, '# my custom plans command, no dotmd marker\n');
    const r = run(['init']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(existsSync(custom), 'user-managed command file must survive init');
    ok(!/plans\.md.*retired/.test(r.stdout),
      `user-managed file should not be reported as retired; got: ${r.stdout}`);
  });

  it('status transitions within the active range regen the index', () => {
    // Pre-fix: only archive-crossing transitions regen'd. A pure
    // `active → planned` left the per-status sections in `docs/docs.md` out
    // of date and the next `dotmd check` errored on stale index, even
    // though the user did nothing wrong.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    run(['init']);
    run(['new', 'plan', 'alpha']);

    const flip = run(['status', 'docs/plans/alpha.md', 'planned']);
    strictEqual(flip.status, 0, `status flip failed: ${flip.stderr}`);

    const check = run(['check']);
    ok(
      !check.stdout.includes('Generated index block is stale'),
      `check should not flag stale index after within-status transition; got: ${check.stdout}`,
    );

    const indexContent = readFileSync(path.join(tmpDir, 'docs', 'docs.md'), 'utf8');
    ok(indexContent.includes('## Planned'), `index should now list a Planned section; got: ${indexContent}`);
    ok(!indexContent.includes('## Active'), `index should no longer list an Active section; got: ${indexContent}`);
  });

  it('init + new plan does not leave a stale index', () => {
    // Pre-fix: `dotmd new` wrote the doc but didn't regen `docs/docs.md`'s
    // generated block, so the very next `dotmd check` failed with
    // "Generated index block is stale" on a brand-new repo the user
    // couldn't have screwed up. Mirror archive/status behavior: regen on
    // any doc-set mutation.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    run(['init']);
    const newR = run(['new', 'plan', 'alpha']);
    strictEqual(newR.status, 0, `new failed: ${newR.stderr}`);

    const check = run(['check']);
    ok(
      !check.stdout.includes('Generated index block is stale'),
      `check should not flag stale index after new; got: ${check.stdout}`,
    );

    // Belt-and-suspenders: docs.md should mention the new plan by slug.
    const indexContent = readFileSync(path.join(tmpDir, 'docs', 'docs.md'), 'utf8');
    ok(indexContent.includes('alpha'), `index should list the new plan; got: ${indexContent}`);
  });

  it('fresh init wires referenceFields for built-in templates', () => {
    // Out-of-box, the default plan template writes `related_plans:`,
    // `related_docs:`, `parent_plan:`. If init scaffolds a config without
    // matching referenceFields, graph/deps/unblocks/pickup-Related: are dead
    // on arrival. Verify the config wires them, and that graph actually sees
    // an edge once two plans cross-reference.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    run(['init']);

    const config = readFileSync(path.join(tmpDir, 'runlist.config.mjs'), 'utf8');
    ok(config.includes('referenceFields'), 'STARTER_CONFIG should declare referenceFields');
    ok(config.includes('related_plans'), 'should track related_plans by default');
    ok(config.includes('related_docs'), 'should track related_docs by default');
    ok(config.includes('parent_plan'), 'should track parent_plan by default');

    run(['new', 'plan', 'alpha']);
    run(['new', 'plan', 'beta']);

    // Wire alpha → beta via related_plans (matches what users would do).
    const alphaPath = path.join(tmpDir, 'docs', 'plans', 'alpha.md');
    const alpha = readFileSync(alphaPath, 'utf8')
      .replace('related_plans:\n', 'related_plans:\n  - beta.md\n');
    writeFileSync(alphaPath, alpha);

    const graph = run(['graph', '--json']);
    strictEqual(graph.status, 0, `graph stderr: ${graph.stderr}`);
    const parsed = JSON.parse(graph.stdout);
    ok(parsed.edges.length >= 1, `expected at least one edge, got: ${JSON.stringify(parsed.edges)}`);
    const edge = parsed.edges.find(e => e.field === 'related_plans');
    ok(edge, `expected a related_plans edge in: ${JSON.stringify(parsed.edges)}`);
  });
});

describe('init idempotency', () => {
  it('skips config file when it already exists', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), 'export const root = "custom";');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('exists'));
    const content = readFileSync(path.join(tmpDir, 'runlist.config.mjs'), 'utf8');
    ok(content.includes('custom'), 'original config preserved');
  });

  it('skips docs dir when it already exists', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'));
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('exists'));
  });

  it('skips index file when it already exists', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'));
    writeFileSync(path.join(tmpDir, 'docs', 'docs.md'), '# Custom Index');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const content = readFileSync(path.join(tmpDir, 'docs', 'docs.md'), 'utf8');
    strictEqual(content, '# Custom Index', 'original index preserved');
  });
});

describe('init scanning', () => {
  it('detects statuses from existing frontmatter', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\n---\n# A');
    writeFileSync(path.join(tmpDir, 'docs', 'b.md'), '---\nstatus: blocked\n---\n# B');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('detected'));
    const config = readFileSync(path.join(tmpDir, 'runlist.config.mjs'), 'utf8');
    ok(config.includes('active'));
    ok(config.includes('blocked'));
  });

  // Onboarding finding #1: the generated config must be internally consistent.
  // Before the fix it emitted statuses.order but no staleDays, so the resolver
  // inherited the default staleDays map (keyed by `ready`/`scoping`) and every
  // command — the hud SessionStart hook included — warned about statuses this
  // repo never uses. Now init emits a staleDays block scoped to detected
  // statuses, and a command run against the generated config is warning-free.
  it('generates an internally consistent config (no staleDays warnings on next command)', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\n---\n# A');
    writeFileSync(path.join(tmpDir, 'docs', 'b.md'), '---\nstatus: wip\n---\n# B');
    strictEqual(run(['init']).status, 0);

    const config = readFileSync(path.join(tmpDir, 'runlist.config.mjs'), 'utf8');
    ok(config.includes('staleDays:'), 'generated config emits a staleDays block');
    ok(!config.includes('ready') && !config.includes('scoping'),
      `generated staleDays must not carry default-only keys; got:\n${config}`);

    const after = run(['list']);
    ok(!/staleDays contains unknown status/.test(after.stdout + after.stderr),
      `next command must be warning-free; got:\n${after.stdout}\n${after.stderr}`);
  });

  it('detects surfaces from existing frontmatter', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\nsurface: web\n---\n# A');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const config = readFileSync(path.join(tmpDir, 'runlist.config.mjs'), 'utf8');
    ok(config.includes('web'));
    ok(config.includes('taxonomy'));
  });

  it('detects modules from existing frontmatter', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\nmodules:\n  - gallery\n---\n# A');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const config = readFileSync(path.join(tmpDir, 'runlist.config.mjs'), 'utf8');
    ok(config.includes('taxonomy'));
    ok(config.includes('modules'));
    ok(config.includes('gallery'));
  });

  it('detects reference fields from existing frontmatter', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\ndepends_on:\n  - b.md\n---\n# A');
    writeFileSync(path.join(tmpDir, 'docs', 'b.md'), '---\nstatus: active\n---\n# B');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const config = readFileSync(path.join(tmpDir, 'runlist.config.mjs'), 'utf8');
    ok(config.includes('referenceFields'));
    ok(config.includes('depends_on'));
  });

  it('preserves known status ordering', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: blocked\n---\n# A');
    writeFileSync(path.join(tmpDir, 'docs', 'b.md'), '---\nstatus: active\n---\n# B');
    run(['init']);
    const config = readFileSync(path.join(tmpDir, 'runlist.config.mjs'), 'utf8');
    const activeIdx = config.indexOf("'active'");
    const blockedIdx = config.indexOf("'blocked'");
    ok(activeIdx < blockedIdx, 'active appears before blocked in status order');
  });

  it('skips files without frontmatter', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'readme.md'), '# Just a readme\nNo frontmatter here.');
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\n---\n# A');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('detected 1 docs'));
  });
});

describe('init type subdirs', () => {
  it('scaffolds docs/plans/ and docs/prompts/ on fresh init', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(existsSync(path.join(tmpDir, 'docs', 'plans')));
    ok(existsSync(path.join(tmpDir, 'docs', 'prompts')));
  });

  it('reports counts for existing docs/plans/ files including plain markdown', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'plans', 'with-fm.md'), '---\nstatus: active\n---\n# A');
    writeFileSync(path.join(tmpDir, 'docs', 'plans', 'plain.md'), '# Just markdown, no frontmatter');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('docs/plans/'));
    ok(result.stdout.includes('1 runlist-tracked'), `expected count summary in stdout: ${result.stdout}`);
    ok(result.stdout.includes('1 plain .md'), `expected plain-md count: ${result.stdout}`);
  });
});

describe('init gitignore detection', () => {
  it('warns when docs/ is already gitignored', () => {
    // Pre-fix: init silently scaffolded docs/ into a repo where docs/ was
    // already in .gitignore, so every doc dotmd managed was untracked. The
    // user only found out via `git ls-files docs/`. Now: a yellow notice
    // with a notice to review the existing rules.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    // Need a real git repo for `git check-ignore` to work.
    spawnSync('git', ['init'], { cwd: tmpDir });
    writeFileSync(path.join(tmpDir, '.gitignore'), 'docs/\n');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('docs/ is gitignored'),
      `expected gitignore notice; got: ${result.stdout}`);
    strictEqual(readFileSync(path.join(tmpDir, '.gitignore'), 'utf8'), 'docs/\n');
    ok(result.stdout.includes('Review the existing ignore rules'));
  });

  it('stays quiet when docs/ is NOT gitignored', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    spawnSync('git', ['init'], { cwd: tmpDir });
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('docs/ is gitignored'),
      `should not warn when docs/ is tracked; got: ${result.stdout}`);
  });
});

describe('init root-level siblings', () => {
  it('warns about root-level plans/ and skips scaffolding docs/plans/', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'plans'));
    writeFileSync(path.join(tmpDir, 'plans', 'my-plan.md'), '# My plan');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('notice'), `expected notice in stdout: ${result.stdout}`);
    ok(result.stdout.includes('plans/'), 'expected plans/ in notice');
    ok(!result.stdout.includes('mv '), 'no destructive move suggestion');
    ok(result.stdout.includes('export const root = ["docs","plans"]'), 'config hint keeps both roots');
    strictEqual(readFileSync(path.join(tmpDir, 'plans', 'my-plan.md'), 'utf8'), '# My plan');
    ok(!existsSync(path.join(tmpDir, 'docs', 'plans')), 'should NOT scaffold docs/plans when root sibling has content');
    // docs/prompts/ has no sibling, so it should still be scaffolded
    ok(existsSync(path.join(tmpDir, 'docs', 'prompts')));
  });

  it('ignores empty root-level plans/ directory', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'plans'));
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('notice'), 'empty root plans/ should not trigger notice');
    ok(existsSync(path.join(tmpDir, 'docs', 'plans')), 'docs/plans should be scaffolded when sibling is empty');
  });
});

describe('init bulk-tag hint', () => {
  it('prints hint when untagged .md files exist in docs/', () => {
    // The brownfield-onboarding gap: init counts pre-existing markdown but
    // historically did nothing about it. Now it points the user at
    // `dotmd bulk-tag --dry-run` so they can tag them all in one shot.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'plans', 'plain.md'), '# Just markdown, no frontmatter');
    writeFileSync(path.join(tmpDir, 'docs', 'partial.md'), '---\ntype: doc\n---\n# Missing status');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('2 untagged .md files found'),
      `expected count + plural; got: ${result.stdout}`);
    ok(result.stdout.includes('runlist bulk-tag --dry-run'),
      `expected command reference in hint; got: ${result.stdout}`);
  });

  it('stays quiet when every existing doc is fully tagged', () => {
    // Inverse — the hint should only fire when there's something actionable.
    // A repo where every file has both `type:` and `status:` should see no
    // hint, otherwise re-running init on a clean repo would nag forever.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'fine.md'),
      '---\ntype: doc\nstatus: active\n---\n# Fine\n');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('untagged'),
      `expected no bulk-tag hint on clean repo; got: ${result.stdout}`);
  });

  it('uses singular form when exactly 1 untagged file', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'lonely.md'), '# Just one untagged');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('1 untagged .md file found'),
      `expected singular form; got: ${result.stdout}`);
  });
});

describe('init Claude integration', () => {
  it('does NOT scaffold .claude/commands on init — points at the plugin instead', () => {
    // Per-repo slash-command scaffolding is retired. The runlist plugin's
    // SKILL.md is the canonical agent-facing workflow now, so init writes the
    // starter config but no .claude/commands/* files; it recommends the plugin.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, '.claude'));
    // NOTE: no pre-existing runlist.config.mjs.
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(existsSync(path.join(tmpDir, 'runlist.config.mjs')), 'STARTER_CONFIG should be written');
    ok(!existsSync(path.join(tmpDir, '.claude', 'commands', 'plans.md')),
      'init must not scaffold plans.md');
    ok(!existsSync(path.join(tmpDir, '.claude', 'commands', 'docs.md')),
      'init must not scaffold docs.md');
    ok(result.stdout.includes('/plugin install runlist'),
      `init should recommend installing the runlist plugin; got: ${result.stdout}`);
  });

  it('does NOT scaffold .claude/commands when .claude/ exists and config found', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, '.claude'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), `export const root = 'docs';`);
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!existsSync(path.join(tmpDir, '.claude', 'commands', 'plans.md')));
    ok(!existsSync(path.join(tmpDir, '.claude', 'commands', 'docs.md')));
  });

  it('skips Claude commands when .claude/ does not exist', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!existsSync(path.join(tmpDir, '.claude', 'commands')));
  });

  it('recommends the plugin in a greenfield repo when only ~/.claude exists', () => {
    // No project .claude/, but the user runs Claude Code elsewhere — the plugin
    // nudge (and the global-install requirement) should still surface.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    const home = mkdtempSync(path.join(os.tmpdir(), 'dotmd-home-'));
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    const result = run(['init'], tmpDir, { home });
    rmSync(home, { recursive: true, force: true });
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!existsSync(path.join(tmpDir, '.claude')), 'init must not create a project .claude/');
    ok(result.stdout.includes('/plugin install runlist'),
      `greenfield Claude user should still get the plugin nudge; got: ${result.stdout}`);
    ok(/npm i -g runlist/.test(result.stdout),
      `should call out the global-install requirement; got: ${result.stdout}`);
  });

  it('stays silent about the plugin when no Claude Code is present anywhere', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    const home = mkdtempSync(path.join(os.tmpdir(), 'dotmd-home-')); // empty home, no .claude
    const result = run(['init'], tmpDir, { home });
    rmSync(home, { recursive: true, force: true });
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('/plugin install runlist'),
      `no Claude anywhere → no plugin nudge; got: ${result.stdout}`);
  });

  it('recommends the plugin (and a manual SessionStart fallback) when .claude/ exists and hook is unwired', () => {
    // Init now leads with the runlist plugin — its bundled hooks + skill travel
    // to every session automatically. The hand-wired `dotmd hud` SessionStart
    // snippet remains as a no-plugin fallback for users who want it.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, '.claude'));
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('/plugin install runlist'),
      `expected plugin-install recommendation; got: ${result.stdout}`);
    ok(result.stdout.includes('SessionStart'),
      `expected SessionStart fallback snippet; got: ${result.stdout}`);
    ok(result.stdout.includes('"command": "runlist hud"'),
      `expected paste-ready hook command; got: ${result.stdout}`);
  });

  it('skips SessionStart hint when hook is already wired in settings.json', () => {
    // Inverse of the above — quiet when already configured. Otherwise a user
    // who's correctly set up the hook would see the same snippet on every
    // `dotmd init` re-run.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, '.claude'));
    writeFileSync(
      path.join(tmpDir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'runlist hud' }] }] } }),
    );
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('"command": "runlist hud"'),
      `should not print snippet when hook already wired; got: ${result.stdout}`);
    ok(result.stdout.includes('already wired'),
      `expected confirmation that hook is wired; got: ${result.stdout}`);
  });

  it('detects SessionStart hook in settings.local.json too', () => {
    // settings.local.json is the per-machine variant — users often put hooks
    // there to keep them out of version control. Detection should find it.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, '.claude'));
    writeFileSync(
      path.join(tmpDir, '.claude', 'settings.local.json'),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'runlist hud' }] }] } }),
    );
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('already wired'),
      `should detect hook in settings.local.json; got: ${result.stdout}`);
  });

  it('detects SessionStart hook in user-global ~/.claude/settings.json', () => {
    // Claude Code merges global hooks into every project. If the user has
    // `dotmd hud` wired globally, this project gets it for free — the snippet
    // would be noise. Detection looks at $HOME/.claude/settings.json too.
    // Uses a separate fake HOME (distinct from cwd) to exercise the global
    // path specifically — without this, HOME==cwd would make the global path
    // and the project's .claude/settings.json the same file.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), 'dotmd-fake-home-'));
    try {
      mkdirSync(path.join(tmpDir, '.git'));
      mkdirSync(path.join(tmpDir, '.claude'));  // project .claude/ exists but is empty
      mkdirSync(path.join(fakeHome, '.claude'));
      writeFileSync(
        path.join(fakeHome, '.claude', 'settings.json'),
        JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'runlist hud' }] }] } }),
      );
      const result = run(['init'], undefined, { home: fakeHome });
      strictEqual(result.status, 0, `stderr: ${result.stderr}`);
      ok(result.stdout.includes('already wired'),
        `should detect global hook; got: ${result.stdout}`);
    } finally {
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('skips SessionStart hint entirely when .claude/ does not exist', () => {
    // No .claude/ → user is not using Claude Code; the hint would be noise.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('SessionStart'),
      `should stay silent about SessionStart when .claude/ is absent; got: ${result.stdout}`);
  });
});

describe('init scaffold survives a clone', () => {
  // A git repo cannot hold an empty directory. Before this, `dotmd init` created
  // docs/plans/ and docs/prompts/ and left nothing in either, so both existed only
  // on the machine that ran init and vanished for the next clone.
  function freshInit() {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    return result;
  }

  it('leaves a committable file in both type subdirs', () => {
    freshInit();
    ok(existsSync(path.join(tmpDir, 'docs', 'plans', 'example-plan.md')));
    ok(existsSync(path.join(tmpDir, 'docs', 'prompts', '.gitkeep')));
  });

  it('the sample plan passes check with no warnings', () => {
    freshInit();
    const check = run(['check']);
    strictEqual(check.status, 0, `stderr: ${check.stderr}`);
    ok(check.stdout.includes('warnings: 0'), `fresh init must be clean: ${check.stdout}`);
  });

  it('renders the index against the sample instead of shipping "no docs yet"', () => {
    freshInit();
    const index = readFileSync(path.join(tmpDir, 'docs', 'docs.md'), 'utf8');
    ok(!index.includes('No docs yet'), `stale placeholder survived: ${index}`);
    ok(index.includes('example-plan'), `index should list the sample: ${index}`);
  });

  it('never drops a sample into a populated plans dir', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'plans', 'real.md'),
      '---\ntype: plan\nstatus: active\ntitle: Real\nupdated: 2026-01-01\n---\n\n# Real\n\n> Real work.\n');
    run(['init']);
    ok(!existsSync(path.join(tmpDir, 'docs', 'plans', 'example-plan.md')),
      'init must not seed a sample into an estate that already has plans');
  });

  it('does not re-create a sample the user deleted', () => {
    freshInit();
    rmSync(path.join(tmpDir, 'docs', 'plans', 'example-plan.md'));
    writeFileSync(path.join(tmpDir, 'docs', 'plans', 'mine.md'),
      '---\ntype: plan\nstatus: active\ntitle: Mine\nupdated: 2026-01-01\n---\n\n# Mine\n\n> Mine.\n');
    run(['init']);
    ok(!existsSync(path.join(tmpDir, 'docs', 'plans', 'example-plan.md')),
      'deleting the sample must stick');
  });
});

describe('init explicit gitignore opt-in', () => {
  it('writes current state, legacy state, and prompt rules on a fresh init', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    init(['--gitignore']);
    const gi = readFileSync(path.join(tmpDir, '.gitignore'), 'utf8').split('\n').map(l => l.trim());
    ok(gi.includes('.runlist/'), gi.join('|'));
    ok(gi.includes('.dotmd/'), gi.join('|'));
    ok(gi.includes('/docs/prompts/*.md'), gi.join('|'));
  });

  // The rule must stop at the directory: archived prompts are the committed record.
  it('ignores the live queue but not archived prompts', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    init(['--gitignore']);
    spawnSync('git', ['init', '-q'], { cwd: tmpDir });
    mkdirSync(path.join(tmpDir, 'docs', 'prompts', 'archived'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'prompts', 'live.md'), 'x');
    writeFileSync(path.join(tmpDir, 'docs', 'prompts', 'archived', 'old.md'), 'x');
    const ignored = (p) => spawnSync('git', ['check-ignore', p], { cwd: tmpDir }).status === 0;
    ok(ignored('docs/prompts/live.md'), 'live queue must be ignored');
    ok(!ignored('docs/prompts/archived/old.md'), 'archived prompts must stay tracked');
  });

  it('appends only the missing rule to an existing .gitignore', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    writeFileSync(path.join(tmpDir, '.gitignore'), 'node_modules/\n.dotmd/\n');
    init(['--gitignore']);
    const gi = readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    strictEqual(gi.split('\n').filter(l => l.trim() === '.dotmd/').length, 1, `no duplicate: ${gi}`);
    strictEqual(gi.split('\n').filter(l => l.trim() === '.runlist/').length, 1, `current state rule: ${gi}`);
    ok(gi.includes('/docs/prompts/*.md'), gi);
  });

  it('is idempotent across repeated inits', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    init(['--gitignore']);
    init(['--gitignore']);
    const gi = readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
    strictEqual(gi.split('\n').filter(l => l.trim() === '/docs/prompts/*.md').length, 1, gi);
  });
});

describe('init preserves Git policy by default', () => {
  it('creates no ignore file and leaves local and configured global exclusions untouched', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    strictEqual(spawnSync('git', ['init', '-q'], { cwd: tmpDir }).status, 0);
    const globalExcludes = path.join(tmpDir, 'global-excludes');
    writeFileSync(globalExcludes, '# user global excludes\n*.secret\n');
    strictEqual(spawnSync('git', ['config', 'core.excludesFile', globalExcludes], { cwd: tmpDir }).status, 0);
    const before = snapshot(path.join(tmpDir, '.git'));
    const result = run(['init']);
    strictEqual(result.status, 0, result.stderr);
    ok(!existsSync(path.join(tmpDir, '.gitignore')));
    deepStrictEqual(snapshot(path.join(tmpDir, '.git')), before, 'init must not write hidden Git state');
    strictEqual(readFileSync(globalExcludes, 'utf8'), '# user global excludes\n*.secret\n');
    const config = readFileSync(path.join(tmpDir, 'runlist.config.mjs'), 'utf8');
    ok(config.includes("export const promptTracking = 'untracked';"));
    ok(result.stdout.includes('reduce commit churn'));
    ok(result.stdout.includes('git add -A'));
    ok(result.stdout.includes('Project initialized. Host integration is separate.'));
  });

  it('preserves an existing .gitignore byte-for-byte through repeated default init', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    const original = '# authored rules\r\nnode_modules/\r\n!keep\r\n# no final newline';
    writeFileSync(path.join(tmpDir, '.gitignore'), original);
    strictEqual(run(['init']).status, 0);
    strictEqual(run(['init']).status, 0);
    strictEqual(readFileSync(path.join(tmpDir, '.gitignore'), 'utf8'), original);
  });

  it('leaves pending prompts eligible for git add -A unless the user opts into ignores', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    strictEqual(spawnSync('git', ['init', '-q'], { cwd: tmpDir }).status, 0);
    strictEqual(run(['init']).status, 0);
    writeFileSync(path.join(tmpDir, 'docs', 'prompts', 'pending.md'), '---\ntype: prompt\nstatus: pending\n---\nWork.\n');
    const stagedBefore = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: tmpDir, encoding: 'utf8' });
    strictEqual(stagedBefore.stdout, '', 'init stages nothing');
    strictEqual(spawnSync('git', ['add', '-A'], { cwd: tmpDir }).status, 0);
    const staged = spawnSync('git', ['diff', '--cached', '--name-only'], { cwd: tmpDir, encoding: 'utf8' });
    ok(staged.stdout.includes('docs/prompts/pending.md'), staged.stdout);
  });

  it('uses untracked in detected configs as well as starter configs', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    mkdirSync(path.join(tmpDir, 'docs'));
    writeFileSync(path.join(tmpDir, 'docs', 'existing.md'), '---\ntype: doc\nstatus: active\n---\n# Existing\n');
    strictEqual(run(['init']).status, 0);
    ok(readFileSync(path.join(tmpDir, 'runlist.config.mjs'), 'utf8').includes("export const promptTracking = 'untracked';"));
    ok(!existsSync(path.join(tmpDir, '.gitignore')));
  });
});

describe('init ignore previews and prompt policy', () => {
  it('previews exact missing rules on dry-run without writing any files', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    writeFileSync(path.join(tmpDir, '.gitignore'), '# authored\r\n.dotmd/');
    const before = snapshot();
    const result = init(['--gitignore', '--dry-run']);
    strictEqual(result.status, 0, result.stderr);
    ok(result.stdout.includes('[dry-run]'));
    ok(result.stdout.includes('.gitignore (+.runlist/, /docs/prompts/*.md)'), result.stdout);
    deepStrictEqual(snapshot(), before);
  });

  it('appends without changing unrelated bytes or duplicating equivalent rules', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    const original = Buffer.from([35, 32, 255, 13, 10, ...Buffer.from('node_modules/\r\n.dotmd\r\ndocs/prompts/*.md')]);
    writeFileSync(path.join(tmpDir, '.gitignore'), original);
    strictEqual(init(['--gitignore']).status, 0);
    deepStrictEqual(readFileSync(path.join(tmpDir, '.gitignore')), Buffer.concat([original, Buffer.from('\r\n.runlist/\r\n')]));
    const once = snapshot();
    strictEqual(init(['--gitignore']).status, 0);
    deepStrictEqual(snapshot(), once);
  });

  for (const policy of ['untracked', 'tracked', 'local']) {
    it(`configures a new project with explicit ${policy} policy`, () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
      const result = run(['init', '--prompt-tracking', policy, '--gitignore']);
      strictEqual(result.status, 0, result.stderr);
      ok(readFileSync(path.join(tmpDir, 'runlist.config.mjs'), 'utf8').includes(`promptTracking = '${policy}'`));
      const ignores = readFileSync(path.join(tmpDir, '.gitignore'), 'utf8');
      strictEqual(ignores.includes('/docs/prompts/*.md'), policy !== 'tracked');
      ok(ignores.includes('.runlist/') && ignores.includes('.dotmd/'));
      if (policy === 'tracked') ok(!result.stdout.includes('Leave pending prompts untracked'));
    });
  }

  it('preserves prompt ignores in tracked mode and previews only state rules', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), "export const root = 'notes';\nexport const promptTracking = 'tracked';\n");
    const original = '# custom prompt ignores\n/notes/prompts/*.md\n';
    writeFileSync(path.join(tmpDir, '.gitignore'), original);
    const preview = init(['--gitignore', '--dry-run']);
    strictEqual(preview.status, 0, preview.stderr);
    ok(preview.stdout.includes('.gitignore (+.runlist/, .dotmd/)'));
    ok(!preview.stdout.includes('/notes/prompts/*.md'));
    strictEqual(init(['--gitignore']).status, 0);
    strictEqual(readFileSync(path.join(tmpDir, '.gitignore'), 'utf8'), original + '.runlist/\n.dotmd/\n');
  });

  for (const argv of [['--prompt-tracking', 'invalid'], ['--prompt-tracking'], ['--prompt-tracking=invalid']]) {
    it(`rejects ${argv.join(' ')} before mutation`, () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
      writeFileSync(path.join(tmpDir, '.gitignore'), '# keep\n');
      const before = snapshot();
      const result = init(['--gitignore', ...argv]);
      strictEqual(result.status, 1);
      ok(result.stderr.includes('must be one of: untracked, tracked, local'), result.stderr);
      deepStrictEqual(snapshot(), before);
    });
  }

  for (const configuredPolicy of [null, 'tracked', 'untracked']) {
    it(`refuses a policy change for existing ${configuredPolicy ?? 'legacy'} config before mutation`, () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
      writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), "export const root = 'notes';\n" + (configuredPolicy ? `export const promptTracking = '${configuredPolicy}';\n` : ''));
      writeFileSync(path.join(tmpDir, '.gitignore'), '# keep\n');
      const before = snapshot();
      const requested = configuredPolicy === 'untracked' ? 'tracked' : 'untracked';
      const result = init(['--prompt-tracking', requested, '--gitignore']);
      strictEqual(result.status, 1);
      ok(result.stderr.includes(`runlist config set promptTracking ${requested}`), result.stderr);
      deepStrictEqual(snapshot(), before);
    });
  }

  it('accepts an equal policy without rewriting authored config or hooks', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    const authored = "// authored JS\nexport const root = 'notes';\nexport const promptTracking = 'tracked';\nexport function onStatusChange() { return 'keep me'; }\n";
    writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), authored);
    const result = init(['--prompt-tracking', 'tracked']);
    strictEqual(result.status, 0, result.stderr);
    strictEqual(readFileSync(path.join(tmpDir, 'runlist.config.mjs'), 'utf8'), authored);
    const once = snapshot();
    strictEqual(init(['--prompt-tracking', 'tracked']).status, 0);
    deepStrictEqual(snapshot(), once);
  });

  it('CLI refuses a conflicting policy on symlinked config with manual-edit guidance', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    writeFileSync(path.join(tmpDir, 'actual.mjs'), "export const root = 'notes';\n");
    try {
      symlinkSync('actual.mjs', path.join(tmpDir, 'runlist.config.mjs'));
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return;
      throw error;
    }
    const before = snapshot();
    const result = run(['init', '--prompt-tracking', 'tracked']);
    strictEqual(result.status, 1, result.stdout + result.stderr);
    ok(result.stderr.includes('requested policy was not applied'), result.stderr);
    ok(result.stderr.includes('edit the promptTracking export manually'), result.stderr);
    deepStrictEqual(snapshot(), before);
  });

  it('CLI rejects an invalid policy before migrating legacy runtime state', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), "export const root = 'notes';\n");
    mkdirSync(path.join(tmpDir, '.dotmd'));
    writeFileSync(path.join(tmpDir, '.dotmd', 'keep.txt'), 'legacy state\n');
    const before = snapshot();
    const result = run(['init', '--prompt-tracking', 'invalid']);
    strictEqual(result.status, 1, result.stdout + result.stderr);
    deepStrictEqual(snapshot(), before);
  });
});

describe('init configured layouts', () => {
  it('uses a custom root and configured index path with custom markers, preserving authored prose', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    const configText = "export const root = 'notes';\nexport const index = { path: 'catalog/overview.md', startMarker: '<!-- start -->', endMarker: '<!-- end -->' };\n";
    writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), configText);
    mkdirSync(path.join(tmpDir, 'catalog'));
    writeFileSync(path.join(tmpDir, 'catalog', 'overview.md'), '# Authored title\n\n<!-- start -->\nold generated content\n<!-- end -->\n\nAuthored footer.\n');
    const result = init(['--gitignore']);
    strictEqual(result.status, 0, result.stderr);
    ok(!existsSync(path.join(tmpDir, 'docs')));
    ok(!existsSync(path.join(tmpDir, 'notes', 'docs.md')));
    ok(existsSync(path.join(tmpDir, 'notes', 'plans', 'example-plan.md')));
    const index = readFileSync(path.join(tmpDir, 'catalog', 'overview.md'), 'utf8');
    ok(index.startsWith('# Authored title\n\n<!-- start -->\n'));
    ok(index.endsWith('<!-- end -->\n\nAuthored footer.\n'));
    ok(index.includes('example-plan'));
    ok(readFileSync(path.join(tmpDir, '.gitignore'), 'utf8').includes('/notes/prompts/*.md'));
    strictEqual(readFileSync(path.join(tmpDir, 'runlist.config.mjs'), 'utf8'), configText);
  });

  it('creates a missing custom index in its configured parent, without creating a default index', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), "export const root = 'notes';\nexport const index = { path: 'catalog/overview.md', startMarker: '<!-- begin -->', endMarker: '<!-- finish -->' };\n");
    const before = snapshot();
    const preview = init(['--dry-run']);
    strictEqual(preview.status, 0, preview.stderr);
    ok(preview.stdout.includes('catalog/overview.md'));
    ok(!preview.stdout.includes('docs/'));
    deepStrictEqual(snapshot(), before);
    strictEqual(init().status, 0);
    const index = readFileSync(path.join(tmpDir, 'catalog', 'overview.md'), 'utf8');
    ok(index.includes('<!-- begin -->') && index.includes('<!-- finish -->'));
    ok(index.includes('example-plan'));
    ok(!existsSync(path.join(tmpDir, 'docs')));
  });

  it('respects an existing custom config without an index', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), "export const root = 'notes';\n");
    strictEqual(init().status, 0);
    ok(!existsSync(path.join(tmpDir, 'docs')));
    ok(!existsSync(path.join(tmpDir, 'notes', 'docs.md')));
  });

  it('uses flat type roots without nested or unused default directories', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), "export const root = ['plans', 'prompts'];\nexport const index = { path: 'INDEX.md' };\n");
    mkdirSync(path.join(tmpDir, 'plans'));
    writeFileSync(path.join(tmpDir, 'plans', 'real.md'), '---\ntype: plan\nstatus: planned\n---\n# Real\n');
    const result = init(['--gitignore']);
    strictEqual(result.status, 0, result.stderr);
    ok(!existsSync(path.join(tmpDir, 'docs')));
    ok(!existsSync(path.join(tmpDir, 'plans', 'plans')));
    ok(!existsSync(path.join(tmpDir, 'plans', 'prompts')));
    ok(!existsSync(path.join(tmpDir, 'prompts', 'prompts')));
    ok(!existsSync(path.join(tmpDir, 'plans', 'example-plan.md')));
    ok(existsSync(path.join(tmpDir, 'prompts', '.gitkeep')));
    ok(readFileSync(path.join(tmpDir, '.gitignore'), 'utf8').includes('/prompts/*.md'));
    ok(!result.stdout.includes('found at repo root'));
    const once = snapshot();
    strictEqual(init(['--gitignore']).status, 0);
    deepStrictEqual(snapshot(), once);
  });

  it('routes prompts to a matching later root instead of under the primary root', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), "export const root = ['notes', 'queue/prompts'];\n");
    const result = init(['--gitignore']);
    strictEqual(result.status, 0, result.stderr);
    ok(existsSync(path.join(tmpDir, 'queue', 'prompts', '.gitkeep')));
    ok(!existsSync(path.join(tmpDir, 'notes', 'prompts')));
    ok(readFileSync(path.join(tmpDir, '.gitignore'), 'utf8').includes('/queue/prompts/*.md'));
  });

  it('uses an authored prompt template directory for both scaffold and opt-in ignores', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), "export const root = 'notes';\nexport const templates = { prompt: { dir: 'queue', targetRoot: null } };\n");
    strictEqual(init(['--gitignore']).status, 0);
    ok(existsSync(path.join(tmpDir, 'notes', 'queue', '.gitkeep')));
    ok(!existsSync(path.join(tmpDir, 'notes', 'prompts')));
    ok(readFileSync(path.join(tmpDir, '.gitignore'), 'utf8').includes('/notes/queue/*.md'));
  });

  it('respects a config found above the current directory without creating a shadow config', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), "export const root = 'notes';\n");
    const nested = path.join(tmpDir, 'src');
    mkdirSync(nested);
    const result = init([], nested);
    strictEqual(result.status, 0, result.stderr);
    ok(existsSync(path.join(tmpDir, 'notes', 'plans', 'example-plan.md')));
    deepStrictEqual(readdirSync(nested), []);
  });

  it('does not preview samples in populated layouts', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'plans', 'real.md'), '# Authored\n');
    const before = snapshot();
    const result = init(['--dry-run']);
    strictEqual(result.status, 0, result.stderr);
    ok(!result.stdout.includes('example-plan.md'), result.stdout);
    deepStrictEqual(snapshot(), before);
  });

  it('excludes generated indexes from repeated init bulk-tag hints, retaining real untagged docs', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    strictEqual(run(['init']).status, 0);
    const before = snapshot();
    const result = run(['init']);
    strictEqual(result.status, 0, result.stderr);
    ok(!result.stdout.includes('untagged'), result.stdout);
    deepStrictEqual(snapshot(), before);
    writeFileSync(path.join(tmpDir, 'docs', 'plain.md'), '# Authored plain markdown\n');
    const after = run(['init']);
    strictEqual(after.status, 0, after.stderr);
    ok(after.stdout.includes('1 untagged .md file found'), after.stdout);
  });
});

describe('init ignore preflight before scaffolding', () => {
  for (const target of ['external', 'internal', 'dangling']) {
    it(`refuses a ${target} .gitignore symlink without any project mutation`, () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
      const outside = mkdtempSync(path.join(os.tmpdir(), 'runlist-ignore-'));
      try {
        writeFileSync(path.join(outside, 'ignore'), '# external authored bytes\n');
        writeFileSync(path.join(tmpDir, 'authored-ignore'), '# internal authored bytes\n');
        const linkTarget = target === 'external' ? path.join(outside, 'ignore')
          : path.join(tmpDir, target === 'internal' ? 'authored-ignore' : 'missing-ignore');
        symlinkSync(linkTarget, path.join(tmpDir, '.gitignore'));
        const before = snapshot();
        for (const argv of [['--gitignore'], ['--gitignore', '--dry-run']]) {
          const result = run(['init', ...argv]);
          strictEqual(result.status, 1, result.stdout + result.stderr);
          ok(/symlink/.test(result.stderr), result.stderr);
          deepStrictEqual(snapshot(), before);
          strictEqual(readFileSync(path.join(outside, 'ignore'), 'utf8'), '# external authored bytes\n');
        }
      } finally { rmSync(outside, { recursive: true, force: true }); }
    });
  }

  it('refuses a directory at .gitignore before creating config or docs', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    mkdirSync(path.join(tmpDir, '.gitignore'));
    const before = snapshot();
    const result = run(['init', '--gitignore']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('regular file'), result.stderr);
    deepStrictEqual(snapshot(), before);
    deepStrictEqual(readdirSync(tmpDir), ['.gitignore']);
  });

  it('refuses an outside prompt rule before creating any scaffold paths', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    const outside = mkdtempSync(path.join(os.tmpdir(), 'runlist-prompts-'));
    try {
      writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), `export const root = ['notes', ${JSON.stringify(path.join(outside, 'prompts'))}];\n`);
      const before = snapshot();
      for (const argv of [['--gitignore'], ['--gitignore', '--dry-run']]) {
        const result = run(['init', ...argv]);
        strictEqual(result.status, 1, result.stdout + result.stderr);
        ok(result.stderr.includes('outside the repository'), result.stderr);
        deepStrictEqual(snapshot(), before);
        deepStrictEqual(readdirSync(outside), []);
      }
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  it('refuses a prompt directory that escapes through a symlink before scaffolding', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
    const outside = mkdtempSync(path.join(os.tmpdir(), 'runlist-prompts-'));
    try {
      writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), "export const root = 'notes';\nexport const templates = { prompt: { dir: '../queue/prompts', targetRoot: null } };\n");
      symlinkSync(outside, path.join(tmpDir, 'queue'));
      const before = snapshot();
      const result = run(['init', '--gitignore']);
      strictEqual(result.status, 1, result.stdout + result.stderr);
      ok(result.stderr.includes('symlink'), result.stderr);
      deepStrictEqual(snapshot(), before);
      deepStrictEqual(readdirSync(outside), []);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });

  for (const dir of ['queue\ninjected-rule', 'queue[local]', 'queue*']) {
    it(`refuses an ambiguous prompt rule for ${JSON.stringify(dir)} before mutation`, () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-init-'));
      writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), `export const root = 'notes';\nexport const templates = { prompt: { dir: ${JSON.stringify(dir)}, targetRoot: null } };\n`);
      const before = snapshot();
      const result = run(['init', '--gitignore']);
      strictEqual(result.status, 1);
      ok(result.stderr.includes('newline or Git pattern characters'), result.stderr);
      deepStrictEqual(snapshot(), before);
    });
  }
});
