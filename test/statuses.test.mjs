import { describe, it, beforeEach, afterEach } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function run(args, opts = {}) {
  return spawnSync('node', [BIN, 'statuses', ...args], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    ...opts,
  });
}

function setupRich(extra = '') {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-statuses-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';

export const types = {
  plan: {
    statuses: {
      'in-session': { context: 'expanded', staleDays: 1, requiresModule: true },
      'active':     { context: 'expanded', staleDays: 14, requiresModule: true },
      'blocked':    { context: 'listed', staleDays: 30, requiresModule: true },
      'archived':   { context: 'counted', archive: true, terminal: true, quiet: true },
    },
  },
  doc: {
    statuses: {
      'draft':    { context: 'listed', staleDays: 30 },
      'partial':  { context: 'listed', staleDays: 30 },
      'archived': { context: 'counted', archive: true, terminal: true, quiet: true },
    },
  },
};
${extra}
`);
}

function setupArrayForm() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-statuses-arr-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';

export const types = {
  plan: {
    statuses: ['in-session', 'active', 'planned', 'blocked', 'archived'],
    context: {
      expanded: ['in-session', 'active'],
      listed: ['planned', 'blocked'],
      counted: ['archived'],
    },
    staleDays: { 'in-session': 1, active: 14, planned: 30, blocked: 30 },
  },
};

export const taxonomy = {
  moduleRequiredFor: ['active', 'planned', 'blocked'],
};
`);
}

function readConfig() {
  return readFileSync(path.join(tmpDir, 'dotmd.config.mjs'), 'utf8');
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('dotmd statuses list', () => {
  it('prints all statuses with flags, per type', () => {
    setupRich();
    const r = run([]);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('type: plan'));
    ok(r.stdout.includes('type: doc'));
    ok(r.stdout.includes('in-session'));
    ok(r.stdout.includes('archived'));
  });

  it('--type plan filters', () => {
    setupRich();
    const r = run(['list', '--type', 'plan']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('type: plan'));
    ok(!r.stdout.includes('type: doc'));
  });

  it('--json emits a `types` object keyed by type', () => {
    setupRich();
    const r = run(['list', '--json']);
    strictEqual(r.status, 0, r.stderr);
    const parsed = JSON.parse(r.stdout);
    ok(parsed.types?.plan, 'has plan');
    ok(parsed.types?.doc, 'has doc');
    strictEqual(parsed.types.plan['in-session'].context, 'expanded');
    strictEqual(parsed.types.plan['archived'].archive, true);
    strictEqual(parsed.types.plan['archived'].terminal, true);
  });

  it('with no config, prints defaults', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-statuses-empty-'));
    const r = run(['list', '--type', 'plan']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('in-session'));
    ok(r.stdout.includes('archived'));
  });

  it('cross-type isolation: `partial` in plan and doc do not conflict', () => {
    // Add `partial` to plan via the CLI; doc/partial pre-exists.
    setupRich();
    const r = run(['add', 'partial', '--type', 'plan', '--like', 'blocked', '--quiet', '--yes']);
    strictEqual(r.status, 0, r.stderr);
    const list = run(['list', '--json']);
    const parsed = JSON.parse(list.stdout);
    ok(parsed.types.plan.partial, 'plan/partial');
    ok(parsed.types.doc.partial, 'doc/partial');
  });
});

describe('dotmd statuses add', () => {
  it('clones from --like and applies user flag overrides', () => {
    setupRich();
    const r = run(['add', 'paused', '--type', 'plan', '--like', 'blocked', '--quiet', '--yes']);
    strictEqual(r.status, 0, r.stderr);
    const cfg = readConfig();
    ok(/'paused':\s*\{[^}]*context:\s*'listed'/.test(cfg), 'inherits context from blocked');
    ok(/'paused':\s*\{[^}]*staleDays:\s*30/.test(cfg), 'inherits staleDays');
    ok(/'paused':\s*\{[^}]*requiresModule:\s*true/.test(cfg), 'inherits requiresModule');
    ok(/'paused':\s*\{[^}]*quiet:\s*true/.test(cfg), 'has quiet from user flag');
  });

  it('inserts before the first terminal entry', () => {
    setupRich();
    run(['add', 'paused', '--type', 'plan', '--like', 'blocked', '--quiet', '--yes']);
    const cfg = readConfig();
    const pausedIdx = cfg.indexOf("'paused':");
    const archivedIdx = cfg.indexOf("'archived':");
    ok(pausedIdx > 0 && pausedIdx < archivedIdx, 'paused before archived');
  });

  it('--quiet causes skipStale + skipWarnings to derive at runtime', async () => {
    setupRich();
    const r = run(['add', 'paused', '--type', 'plan', '--like', 'blocked', '--quiet', '--yes']);
    strictEqual(r.status, 0, r.stderr);
    const { resolveConfig } = await import('../src/config.mjs');
    const cfg = await resolveConfig(tmpDir);
    ok(cfg.lifecycle.skipStaleFor.has('paused'), 'paused in skipStaleFor');
    ok(cfg.lifecycle.skipWarningsFor.has('paused'), 'paused in skipWarningsFor');
  });

  it('--quiet --no-skipStale: explicit override wins', async () => {
    setupRich();
    const r = run(['add', 'paused', '--type', 'plan', '--like', 'blocked', '--quiet', '--no-skipStale', '--yes']);
    strictEqual(r.status, 0, r.stderr);
    const { resolveConfig } = await import('../src/config.mjs');
    const cfg = await resolveConfig(tmpDir);
    ok(!cfg.lifecycle.skipStaleFor.has('paused'), 'paused NOT in skipStaleFor');
    ok(cfg.lifecycle.skipWarningsFor.has('paused'), 'paused still in skipWarningsFor');
  });

  it('refuses when status already exists', () => {
    setupRich();
    const r = run(['add', 'active', '--type', 'plan', '--like', 'blocked', '--yes']);
    ok(r.status !== 0);
    ok(r.stderr.includes('already exists'));
  });

  it('refuses invalid name (uppercase)', () => {
    setupRich();
    const r = run(['add', 'Foo', '--type', 'plan', '--like', 'active', '--yes']);
    ok(r.status !== 0);
    ok(r.stderr.includes('Invalid status name'));
  });

  it('refuses reserved name (terminal)', () => {
    setupRich();
    const r = run(['add', 'terminal', '--type', 'plan', '--like', 'active', '--yes']);
    ok(r.status !== 0);
    ok(r.stderr.includes('flag keyword'));
  });

  it('refuses --like targeting a non-existent status', () => {
    setupRich();
    const r = run(['add', 'foo', '--type', 'plan', '--like', 'nonexistent', '--yes']);
    ok(r.status !== 0);
    ok(r.stderr.includes('not defined'));
  });

  it('refuses --type missing', () => {
    setupRich();
    const r = run(['add', 'foo', '--like', 'active', '--yes']);
    ok(r.status !== 0);
    ok(r.stderr.includes('--type'));
  });

  it('--dry-run prints diff and does not write', () => {
    setupRich();
    const before = readConfig();
    const r = run(['add', 'paused', '--type', 'plan', '--like', 'blocked', '--quiet', '--dry-run', '--yes']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('[dry-run]'));
    strictEqual(readConfig(), before, 'file unchanged');
  });
});

describe('dotmd statuses set', () => {
  it('edits a flag, atomic write succeeds', () => {
    setupRich();
    const r = run(['set', 'blocked', '--type', 'plan', '--staleDays', '60', '--yes']);
    strictEqual(r.status, 0, r.stderr);
    const cfg = readConfig();
    ok(/'blocked':\s*\{[^}]*staleDays:\s*60/.test(cfg));
    ok(!/'blocked':\s*\{[^}]*staleDays:\s*30/.test(cfg));
  });

  it('refuses on non-existent status', () => {
    setupRich();
    const r = run(['set', 'nope', '--type', 'plan', '--staleDays', '60', '--yes']);
    ok(r.status !== 0);
    ok(r.stderr.includes('not defined'));
  });

  it('refuses unknown flag', () => {
    setupRich();
    const r = run(['set', 'active', '--type', 'plan', '--bogus', '--yes']);
    ok(r.status !== 0);
    ok(r.stderr.includes('Unknown flag'));
  });

  it('refuses with no flags given', () => {
    setupRich();
    const r = run(['set', 'active', '--type', 'plan', '--yes']);
    ok(r.status !== 0);
    ok(r.stderr.includes('flag is required'));
  });
});

describe('dotmd statuses remove', () => {
  it('deletes and re-import works', () => {
    setupRich();
    const r = run(['remove', 'blocked', '--type', 'plan', '--yes']);
    strictEqual(r.status, 0, r.stderr);
    const cfg = readConfig();
    ok(!cfg.includes("'blocked':"));
    // Sibling list call still works
    const list = run(['list', '--type', 'plan']);
    strictEqual(list.status, 0);
    ok(!list.stdout.includes('blocked'));
  });

  it('refuses with docs using the status, listing offenders', () => {
    setupRich();
    writeFileSync(path.join(tmpDir, 'docs', 'foo.md'), '---\ntype: plan\nstatus: blocked\nmodule: x\n---\n# Foo\n');
    const r = run(['remove', 'blocked', '--type', 'plan', '--yes']);
    ok(r.status !== 0);
    ok(r.stderr.includes('docs/foo.md'));
    ok(r.stderr.includes('dotmd migrate'));
  });

  it('warns when explicit lifecycle references the name', () => {
    setupRich(`
export const lifecycle = {
  archiveStatuses: ['archived'],
  skipStaleFor: ['archived', 'blocked'],
  skipWarningsFor: ['archived'],
  terminalStatuses: ['archived'],
};`);
    const r = run(['remove', 'blocked', '--type', 'plan', '--yes', '--ignore-lifecycle-override']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stderr.includes('explicit lifecycle export references'));
  });
});

describe('dotmd statuses migrate', () => {
  it('converts array form to rich form, pulling in peer staleDays/context/moduleRequiredFor', async () => {
    setupArrayForm();
    const r = run(['migrate', 'plan', '--yes']);
    strictEqual(r.status, 0, r.stderr);
    const cfg = readConfig();
    // Now object form, with each status carrying the right flags.
    ok(/'in-session':\s*\{[^}]*context:\s*'expanded'[^}]*staleDays:\s*1/.test(cfg));
    ok(/'active':\s*\{[^}]*context:\s*'expanded'[^}]*staleDays:\s*14[^}]*requiresModule:\s*true/.test(cfg));
    ok(/'archived':\s*\{[^}]*context:\s*'counted'/.test(cfg));
    // The runtime still resolves cleanly
    const { resolveConfig } = await import('../src/config.mjs');
    const cfgResolved = await resolveConfig(tmpDir);
    ok(cfgResolved.typeStatuses.get('plan').has('in-session'));
  });

  it('removes peer context/staleDays blocks (they would shadow rich-form flags)', () => {
    setupArrayForm();
    const r = run(['migrate', 'plan', '--yes']);
    strictEqual(r.status, 0, r.stderr);
    const cfg = readConfig();
    // The peer blocks must be gone — otherwise list/add would render incorrectly.
    ok(!/types\.plan[\s\S]*context:\s*\{[\s\S]*expanded/.test(cfg) ||
       /'in-session':\s*\{[^}]*context:\s*'expanded'/.test(cfg) && !/^\s*context:\s*\{/m.test(cfg.split('plan: {')[1] ?? ''));
    // More specific assertion: the inner-type definition no longer has a `context: {` peer.
    const planBlock = cfg.match(/plan:\s*\{[\s\S]*?\n\s{2,4}\},?\n/)?.[0] ?? '';
    ok(!/^\s*context:\s*\{/m.test(planBlock), 'no peer context block inside types.plan');
    ok(!/^\s*staleDays:\s*\{/m.test(planBlock), 'no peer staleDays block inside types.plan');
  });

  it('promotes lifecycle flags (terminal/archive/quiet) onto the appropriate statuses', () => {
    setupArrayForm();
    const r = run(['migrate', 'plan', '--yes']);
    strictEqual(r.status, 0, r.stderr);
    const cfg = readConfig();
    // archived is in the default lifecycle: archive + terminal + quiet.
    ok(/'archived':\s*\{[^}]*archive:\s*true/.test(cfg), 'archived has archive: true');
    ok(/'archived':\s*\{[^}]*terminal:\s*true/.test(cfg), 'archived has terminal: true');
    ok(/'archived':\s*\{[^}]*quiet:\s*true/.test(cfg), 'archived has quiet: true');
  });

  it('no-op with informative message when already rich form', () => {
    setupRich();
    const r = run(['migrate', 'plan', '--yes']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('already in rich'));
  });
});

describe('lifecycle-override warning', () => {
  it('refuses write commands without --ignore-lifecycle-override', () => {
    setupRich(`
export const lifecycle = {
  archiveStatuses: ['archived'],
  skipStaleFor: ['archived'],
  skipWarningsFor: ['archived'],
  terminalStatuses: ['archived'],
};`);
    const r = run(['add', 'paused', '--type', 'plan', '--like', 'blocked', '--quiet', '--yes']);
    ok(r.status !== 0);
    ok(r.stderr.includes('lifecycle'));
    ok(r.stderr.includes('--ignore-lifecycle-override'));
  });

  it('writes when --ignore-lifecycle-override is passed', () => {
    setupRich(`
export const lifecycle = {
  archiveStatuses: ['archived'],
  skipStaleFor: ['archived'],
  skipWarningsFor: ['archived'],
  terminalStatuses: ['archived'],
};`);
    const r = run(['add', 'paused', '--type', 'plan', '--like', 'blocked', '--quiet', '--yes', '--ignore-lifecycle-override']);
    strictEqual(r.status, 0, r.stderr);
    ok(readConfig().includes("'paused':"));
  });
});

describe('write commands without a config', () => {
  it('error with `dotmd init` hint', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-statuses-empty-'));
    const r = run(['add', 'foo', '--type', 'plan', '--like', 'active', '--yes']);
    ok(r.status !== 0);
    ok(r.stderr.includes('dotmd init'));
  });
});
