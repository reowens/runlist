import { afterEach, describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual, throws } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  authorizeManagedDestination,
  authorizeManagedMove,
  authorizeManagedSource,
  authorizeRepoGeneratedPath,
} from '../src/managed-path.mjs';
import { COMMAND_POLICIES, KNOWN_COMMANDS, MUTATION_CAPABLE_COMMANDS } from '../src/commands.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tempDirs = [];

function temp(prefix = 'dotmd-managed-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function config(repoRoot, docsRoots) {
  return { repoRoot, docsRoot: docsRoots[0], docsRoots };
}

function doc(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '---\ntype: doc\nstatus: active\n---\n# Doc\n');
  return file;
}

function setupCli(configBody = "export const root = 'docs';") {
  const repo = temp();
  mkdirSync(path.join(repo, '.git'));
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  writeFileSync(path.join(repo, 'dotmd.config.mjs'), configBody);
  return repo;
}

function run(repo, args) {
  return spawnSync('node', [BIN, ...args, '--config', path.join(repo, 'dotmd.config.mjs')], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('managed path primitive', () => {
  it('rejects absolute and traversal source escapes with configured roots in the error', () => {
    const repo = temp();
    const root = path.join(repo, 'docs');
    mkdirSync(root);
    const outside = doc(path.join(repo, 'outside.md'));
    const cfg = config(repo, [root]);

    for (const candidate of [outside, path.join(root, '..', 'outside.md')]) {
      throws(() => authorizeManagedSource(candidate, cfg), err => {
        match(err.message, /outside configured docs roots/);
        match(err.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        return true;
      });
    }
  });

  it('rejects a source file symlink even when its target is Markdown', () => {
    const repo = temp();
    const root = path.join(repo, 'docs');
    mkdirSync(root);
    const outside = doc(path.join(repo, 'outside.md'));
    const link = path.join(root, 'linked.md');
    symlinkSync(outside, link);
    throws(() => authorizeManagedSource(link, config(repo, [root])), /may not be a symlink/);
  });

  it('rejects absolute, traversal, and sibling-prefix destination escapes', () => {
    const repo = temp();
    const root = path.join(repo, 'docs');
    mkdirSync(root);
    mkdirSync(path.join(repo, 'docs-evil'));
    const cfg = config(repo, [root]);
    const candidates = [
      path.join(repo, 'outside.md'),
      path.join(root, '..', 'outside.md'),
      path.join(repo, 'docs-evil', 'outside.md'),
    ];
    for (const candidate of candidates) {
      throws(() => authorizeManagedDestination(candidate, cfg), /lexically outside/);
    }
  });

  it('rejects destination parent symlink and dangling symlink escapes', () => {
    const repo = temp();
    const root = path.join(repo, 'docs');
    const outside = path.join(repo, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(outside, path.join(root, 'escape'));
    symlinkSync(path.join(repo, 'missing-outside'), path.join(root, 'dangling'));
    const cfg = config(repo, [root]);

    throws(() => authorizeManagedDestination(path.join(root, 'escape', 'new.md'), cfg), /escapes through an existing symlinked parent/);
    throws(() => authorizeManagedDestination(path.join(root, 'dangling', 'new.md'), cfg), /unsafe existing ancestor/);
  });

  it('supports a configured root that is itself a symlink', () => {
    const repo = temp();
    const physical = path.join(repo, 'physical-docs');
    const root = path.join(repo, 'docs');
    mkdirSync(physical);
    symlinkSync(physical, root);
    const source = doc(path.join(root, 'source.md'));
    const cfg = config(repo, [root]);

    const authorized = authorizeManagedSource(source, cfg);
    strictEqual(authorized.root.lexicalPath, root);
    strictEqual(authorizeManagedDestination(path.join(root, 'new.md'), cfg, { root: authorized.root }).root.lexicalPath, root);
  });

  it('supports every configured root but preserves the source root for moves', () => {
    const repo = temp();
    const first = path.join(repo, 'plans');
    const second = path.join(repo, 'docs');
    mkdirSync(first);
    mkdirSync(second);
    const source = doc(path.join(first, 'source.md'));
    const cfg = config(repo, [first, second]);

    ok(authorizeManagedDestination(path.join(second, 'valid.md'), cfg));
    ok(authorizeManagedMove(source, path.join(first, 'moved.md'), cfg));
    throws(() => authorizeManagedMove(source, path.join(second, 'moved.md'), cfg), /Owning docs root/);
  });

  it('rejects a lexical root whose symlinked descendant resolves into another configured root', () => {
    const repo = temp();
    const first = path.join(repo, 'first');
    const second = path.join(repo, 'second');
    mkdirSync(first);
    mkdirSync(second);
    doc(path.join(second, 'source.md'));
    symlinkSync(second, path.join(first, 'portal'));

    throws(
      () => authorizeManagedSource(path.join(first, 'portal', 'source.md'), config(repo, [first, second])),
      /lexically owned by .*first.*resolves outside that root/,
    );
  });

  it('confines repository-generated paths and catches symlink parents', () => {
    const repo = temp();
    const outside = temp('dotmd-index-outside-');
    mkdirSync(path.join(repo, 'generated'));
    symlinkSync(outside, path.join(repo, 'generated', 'escape'));

    ok(authorizeRepoGeneratedPath(path.join(repo, 'generated', 'index.md'), { repoRoot: repo }));
    throws(() => authorizeRepoGeneratedPath(path.join(repo, '..', 'index.md'), { repoRoot: repo }), /outside the repository/);
    throws(() => authorizeRepoGeneratedPath(path.join(repo, 'generated', 'escape', 'index.md'), { repoRoot: repo }), /escapes through an existing symlinked parent/);
  });
});

describe('managed mutation CLI boundaries', () => {
  it('rejects outside and symlink mutation sources', () => {
    const repo = setupCli();
    const outside = doc(path.join(repo, 'outside.md'));
    const linked = path.join(repo, 'docs', 'linked.md');
    symlinkSync(outside, linked);

    const absolute = run(repo, ['set', 'draft', outside]);
    strictEqual(absolute.status, 1);
    match(absolute.stderr, /outside configured docs roots/);

    const traversal = run(repo, ['touch', 'docs/../outside.md']);
    strictEqual(traversal.status, 1);
    match(traversal.stderr, /outside configured docs roots/);

    const symlink = run(repo, ['set', 'draft', linked]);
    strictEqual(symlink.status, 1);
    match(symlink.stderr, /may not be a symlink/);
    match(readFileSync(outside, 'utf8'), /status: active/);
  });

  it('rejects traversal and destination-parent symlink creation', () => {
    const repo = setupCli();
    const outside = temp('dotmd-new-outside-');
    symlinkSync(outside, path.join(repo, 'docs', 'escape'));

    const traversal = run(repo, ['new', 'doc', '../escaped']);
    strictEqual(traversal.status, 1);
    match(traversal.stderr, /lexically outside/);

    const parentLink = run(repo, ['new', 'doc', 'docs/escape/escaped']);
    strictEqual(parentLink.status, 1);
    match(parentLink.stderr, /escapes through an existing symlinked parent/);
    strictEqual(existsSync(path.join(outside, 'escaped.md')), false);
  });

  it('rejects an index destination outside the repository', () => {
    const repo = setupCli("export const root = 'docs';\nexport const index = { path: '../outside-index.md' };");
    const index = path.join(repo, '..', 'outside-index.md');
    writeFileSync(index, '<!-- GENERATED:dotmd:start -->\n<!-- GENERATED:dotmd:end -->\n');
    const result = run(repo, ['index']);
    strictEqual(result.status, 1);
    match(result.stderr, /Generated index destination is outside the repository/);
  });

  it('rejects archiveDir traversal before changing the source or creating a directory', () => {
    const repo = setupCli("export const root = 'docs';\nexport const archiveDir = '../escaped-archive';");
    const source = doc(path.join(repo, 'docs', 'source.md'));
    const before = readFileSync(source, 'utf8');
    const outsideDir = path.join(repo, 'escaped-archive');

    for (const args of [
      ['archive', source, '--no-index'],
      ['status', source, 'archived', '--no-index'],
    ]) {
      const result = run(repo, args);
      strictEqual(result.status, 1);
      match(result.stderr, /(Archive destination|Status move destination) is lexically outside/);
      strictEqual(readFileSync(source, 'utf8'), before);
      strictEqual(existsSync(outsideDir), false);
    }
  });

  it('rejects a filed-directory traversal before changing the source or creating a directory', () => {
    const repo = setupCli(`
export const root = 'docs';
export const types = {
  plan: {
    statuses: {
      active: {},
      backlog: { filed: '../../escaped-filed' },
      archived: { archive: true, terminal: true },
    },
  },
};
`);
    const source = doc(path.join(repo, 'docs', 'plans', 'source.md'));
    writeFileSync(source, readFileSync(source, 'utf8').replace('type: doc', 'type: plan'));
    const before = readFileSync(source, 'utf8');
    const outsideDir = path.join(repo, 'escaped-filed');

    const result = run(repo, ['set', 'backlog', source, '--no-index']);
    strictEqual(result.status, 1);
    match(result.stderr, /Status move destination is lexically outside/);
    strictEqual(readFileSync(source, 'utf8'), before);
    strictEqual(existsSync(outsideDir), false);
  });

  it('preflights every runlist clear-parent child before rewriting the hub', () => {
    const repo = setupCli();
    const outside = doc(path.join(repo, 'outside.md'));
    writeFileSync(outside, readFileSync(outside, 'utf8').replace('---\n# Doc', 'parent_plan: docs/plans/hub.md\n---\n# Doc'));
    const hub = path.join(repo, 'docs', 'plans', 'hub.md');
    mkdirSync(path.dirname(hub), { recursive: true });
    writeFileSync(hub, '---\ntype: plan\nstatus: active\nrunlist:\n  - ../../outside.md\n---\n# Hub\n');
    const before = readFileSync(hub, 'utf8');

    const result = run(repo, ['runlist', 'remove', hub, '../../outside.md', '--clear-parent']);
    strictEqual(result.status, 1);
    match(result.stderr, /Runlist removed child source resolves outside configured docs roots/);
    strictEqual(readFileSync(hub, 'utf8'), before);
  });

  it('retains external @body input and export output paths', () => {
    const repo = setupCli();
    const outside = temp('dotmd-external-io-');
    const body = path.join(outside, 'body.md');
    const output = path.join(outside, 'export.md');
    writeFileSync(body, 'External body input.\n');

    const created = run(repo, ['new', 'doc', 'from-external', `@${body}`]);
    strictEqual(created.status, 0, created.stderr);
    match(readFileSync(path.join(repo, 'docs', 'from-external.md'), 'utf8'), /External body input/);

    const exported = run(repo, ['export', '--output', output]);
    strictEqual(exported.status, 0, exported.stderr);
    ok(existsSync(output));
  });

  it('keeps absolute external docs read-only under use and rejects external plans', () => {
    const repo = setupCli();
    const outside = temp('dotmd-external-use-');
    const externalDoc = doc(path.join(outside, 'reference.md'));
    const externalPlan = path.join(outside, 'plan.md');
    writeFileSync(externalPlan, '---\ntype: plan\nstatus: active\n---\n# External Plan\n');
    const docBefore = readFileSync(externalDoc, 'utf8');
    const planBefore = readFileSync(externalPlan, 'utf8');

    const readResult = run(repo, ['use', externalDoc]);
    strictEqual(readResult.status, 0, readResult.stderr);
    match(readResult.stdout, /# Doc/);
    strictEqual(readFileSync(externalDoc, 'utf8'), docBefore);

    const planResult = run(repo, ['use', externalPlan]);
    strictEqual(planResult.status, 1);
    match(planResult.stderr, /Plan start source resolves outside configured docs roots/);
    strictEqual(readFileSync(externalPlan, 'utf8'), planBefore);
  });
});

it('derives the dispatcher mutation set from the complete command policy registry', () => {
  deepStrictEqual(KNOWN_COMMANDS, Object.keys(COMMAND_POLICIES));
  deepStrictEqual(
    [...MUTATION_CAPABLE_COMMANDS].sort(),
    Object.entries(COMMAND_POLICIES)
      .filter(([, policy]) => policy.mutation !== 'none')
      .map(([command]) => command)
      .sort(),
  );
  for (const command of ['next', 'statuses', 'init', 'ship', 'export', 'update', 'watch', 'guard', 'check', 'index']) {
    ok(MUTATION_CAPABLE_COMMANDS.has(command), `${command} must be classified as mutation-capable`);
    ok(COMMAND_POLICIES[command].pathPolicy, `${command} must name its path/state policy`);
  }
});
