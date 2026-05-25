import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
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
    env: { ...process.env, NO_COLOR: '1', HOME: homeDir },
  });
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
    ok(existsSync(path.join(tmpDir, 'dotmd.config.mjs')));
    ok(existsSync(path.join(tmpDir, 'docs')));
    ok(existsSync(path.join(tmpDir, 'docs', 'docs.md')));
  });

  it('config contains default root', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    run(['init']);
    const content = readFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'utf8');
    ok(content.includes("root = 'docs'"));
  });

  it('index file contains markers', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    run(['init']);
    const content = readFileSync(path.join(tmpDir, 'docs', 'docs.md'), 'utf8');
    ok(content.includes('GENERATED:dotmd:start'));
    ok(content.includes('GENERATED:dotmd:end'));
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
    ok(!existsSync(path.join(tmpDir, 'dotmd.config.mjs')), 'config not written in dry-run');
    ok(!existsSync(path.join(tmpDir, 'docs')), 'docs/ not created in dry-run');
    ok(!existsSync(path.join(tmpDir, '.claude', 'commands')), '.claude/commands/ not created in dry-run');
  });

  it('reports `update` when refreshing a stale slash command', () => {
    // Pre-fix: runInit's report loop only handled `created` and `current`.
    // `updated` (regen from older version banner) was silently dropped — the
    // user saw nothing about a slash-command file rewrite that did happen.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, '.claude', 'commands'), { recursive: true });
    // Seed config so the dispatcher passes a non-null config to runInit
    // (the slash-command scaffold path is gated on `if (config)`).
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n`);
    // Plant a stale slash-command file with an old version banner.
    writeFileSync(
      path.join(tmpDir, '.claude', 'commands', 'plans.md'),
      '<!-- dotmd-generated: 0.0.1 -->\n\nold content\n',
    );
    const r = run(['init']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(/update\s+\.claude\/commands\/plans\.md/.test(r.stdout),
      `output should report an update line for plans.md; got: ${r.stdout}`);
    ok(/v0\.0\.1\s*→/.test(r.stdout),
      `update line should show the version transition; got: ${r.stdout}`);
    // And the actual file should be refreshed.
    const content = readFileSync(path.join(tmpDir, '.claude', 'commands', 'plans.md'), 'utf8');
    ok(!content.includes('dotmd-generated: 0.0.1 '), 'stale marker should be gone');
  });

  it('reports `skip` for slash-command files without a version marker', () => {
    // Pre-fix: `skipped` (user-managed file) was unreported. Now the user
    // sees that dotmd intentionally left it alone.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, '.claude', 'commands'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n`);
    writeFileSync(
      path.join(tmpDir, '.claude', 'commands', 'plans.md'),
      '# my custom plans command, no dotmd marker\n',
    );
    const r = run(['init']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(/skip\s+\.claude\/commands\/plans\.md/.test(r.stdout),
      `output should report a skip line for the user-managed plans.md; got: ${r.stdout}`);
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
    // couldn't have srostered up. Mirror archive/status behavior: regen on
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

    const config = readFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'utf8');
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
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'export const root = "custom";');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('exists'));
    const content = readFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'utf8');
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
    const config = readFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'utf8');
    ok(config.includes('active'));
    ok(config.includes('blocked'));
  });

  it('detects surfaces from existing frontmatter', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\nsurface: web\n---\n# A');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const config = readFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'utf8');
    ok(config.includes('web'));
    ok(config.includes('taxonomy'));
  });

  it('detects reference fields from existing frontmatter', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\nstatus: active\ndepends_on:\n  - b.md\n---\n# A');
    writeFileSync(path.join(tmpDir, 'docs', 'b.md'), '---\nstatus: active\n---\n# B');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const config = readFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'utf8');
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
    const config = readFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'utf8');
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
    ok(result.stdout.includes('1 dotmd-tracked'), `expected count summary in stdout: ${result.stdout}`);
    ok(result.stdout.includes('1 plain .md'), `expected plain-md count: ${result.stdout}`);
  });
});

describe('init gitignore detection', () => {
  it('warns when docs/ is already gitignored', () => {
    // Pre-fix: init silently scaffolded docs/ into a repo where docs/ was
    // already in .gitignore, so every doc dotmd managed was untracked. The
    // user only found out via `git ls-files docs/`. Now: a yellow notice
    // with the `!docs/` exception hint.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    // Need a real git repo for `git check-ignore` to work.
    spawnSync('git', ['init'], { cwd: tmpDir });
    writeFileSync(path.join(tmpDir, '.gitignore'), 'docs/\n');
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('docs/ is gitignored'),
      `expected gitignore notice; got: ${result.stdout}`);
    ok(result.stdout.includes('!docs/'),
      `expected !docs/ exception hint; got: ${result.stdout}`);
    ok(result.stdout.includes(`echo '!docs/' >> .gitignore`),
      `expected copy-pasteable command hint; got: ${result.stdout}`);
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
    ok(result.stdout.includes('mv ./plans/'), 'expected mv hint');
    ok(result.stdout.includes("export const root = ['plans'"), 'expected flat-root hint');
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
    ok(result.stdout.includes('dotmd bulk-tag --dry-run'),
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
  it('scaffolds .claude/commands on fresh init with no pre-existing config', () => {
    // Pre-fix: the dispatcher resolved config BEFORE runInit ran, so on a
    // brand-new repo (no dotmd.config.mjs yet) it passed `null` to runInit.
    // runInit's slash-command block was gated on `if (config)` and silently
    // skipped — first init never scaffolded .claude/commands/, only a second
    // init (after the config already existed) did. runInit now re-resolves
    // from disk after writing STARTER_CONFIG, so first init works too.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, '.claude'));
    // NOTE: no pre-existing dotmd.config.mjs — that's the whole point.
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(existsSync(path.join(tmpDir, 'dotmd.config.mjs')), 'STARTER_CONFIG should be written');
    ok(existsSync(path.join(tmpDir, '.claude', 'commands', 'plans.md')),
      'plans.md should be scaffolded on first init');
    ok(existsSync(path.join(tmpDir, '.claude', 'commands', 'docs.md')),
      'docs.md should be scaffolded on first init');
    // And the scaffold should reflect STARTER_CONFIG (root: 'docs'), not the
    // pre-init DEFAULTS (root: '.'). Re-resolving from disk is what makes this work.
    const docs = readFileSync(path.join(tmpDir, '.claude', 'commands', 'docs.md'), 'utf8');
    ok(docs.includes('docs'), `generated docs.md should reference 'docs' root: ${docs}`);
  });

  it('scaffolds .claude/commands when .claude/ exists and config found', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, '.claude'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(existsSync(path.join(tmpDir, '.claude', 'commands', 'plans.md')));
    ok(existsSync(path.join(tmpDir, '.claude', 'commands', 'docs.md')));
  });

  it('scaffolds baton.md slash-command on fresh init', () => {
    // `/baton` is the canonical agent-facing session-handoff verb (see
    // docs/plans/baton-slash-command.md). Must land in .claude/commands/ on
    // fresh init alongside plans.md and docs.md, otherwise Claude sessions
    // can't invoke it.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, '.claude'));
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const batonPath = path.join(tmpDir, '.claude', 'commands', 'baton.md');
    ok(existsSync(batonPath), 'baton.md should be scaffolded on first init');
    const content = readFileSync(batonPath, 'utf8');
    ok(content.includes('<!-- dotmd-generated:'), 'baton.md should carry the dotmd-generated banner');
  });

  it('skips Claude commands when .claude/ does not exist', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!existsSync(path.join(tmpDir, '.claude', 'commands')));
  });

  it('prints paste-ready SessionStart hook snippet when .claude/ exists and hook is unwired', () => {
    // gmax audit enhancement E: init already called `dotmd hud` "the ideal
    // SessionStart hook" but didn't help the user wire it. Now: when .claude/
    // exists and no SessionStart hook running `dotmd hud` is found in either
    // settings.json or settings.local.json, print a paste-ready JSON snippet
    // plus a merge note so users with existing settings don't blow them away.
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-init-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, '.claude'));
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('SessionStart'),
      `expected SessionStart snippet; got: ${result.stdout}`);
    ok(result.stdout.includes('"command": "dotmd hud"'),
      `expected paste-ready hook command; got: ${result.stdout}`);
    ok(result.stdout.includes('merge into the existing'),
      `expected merge guidance for existing settings.json; got: ${result.stdout}`);
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
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'dotmd hud' }] }] } }),
    );
    const result = run(['init']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!result.stdout.includes('"command": "dotmd hud"'),
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
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'dotmd hud' }] }] } }),
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
        JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'dotmd hud' }] }] } }),
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
