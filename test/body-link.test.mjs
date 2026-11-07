import { describe, it, afterEach } from 'node:test';
import { deepStrictEqual, strictEqual } from 'node:assert';
import fs, { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { bodyLinkRoots, resolveBodyLinkTarget, resolveBodyLinkTargetWithin } from '../src/body-link.mjs';
import { buildIndex } from '../src/index.mjs';
import { resolveConfig } from '../src/config.mjs';

const cleanup = [];
afterEach(() => {
  while (cleanup.length) rmSync(cleanup.pop(), { recursive: true, force: true });
});

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanup.push(dir);
  return dir;
}

// A repo whose one external root is a symlink to a folder outside it, next to
// a sibling folder the symlink does not admit.
function setup() {
  const repo = tempDir('runlist-body-link-');
  const outside = tempDir('runlist-body-link-outside-');
  mkdirSync(path.join(repo, '.git'));
  mkdirSync(path.join(repo, 'docs'));
  mkdirSync(path.join(outside, 'shared'));
  mkdirSync(path.join(outside, 'private'));
  writeFileSync(path.join(outside, 'shared', 'target.md'), '# Target\n');
  writeFileSync(path.join(outside, 'private', 'secret.md'), '# Secret\n');
  symlinkSync(path.join(outside, 'shared'), path.join(repo, 'shared'), 'dir');
  symlinkSync(path.join(outside, 'private'), path.join(repo, 'docs', 'escape'), 'dir');
  writeFileSync(path.join(repo, 'docs', 'local.md'), '# Local\n');
  return { repo, outside, docs: path.join(repo, 'docs'), externalRoots: ['shared'] };
}

const LINKS = ['local.md', '../shared/target.md', '../shared/gone.md', 'escape/secret.md', '../../outside.md'];

function countRealpaths(fn) {
  const original = realpathSync.native;
  const calls = [];
  fs.realpathSync.native = (target, ...args) => { calls.push(String(target)); return original(target, ...args); };
  try { return { result: fn(), calls }; }
  finally { fs.realpathSync.native = original; }
}

describe('body link roots', () => {
  it('accepts links through a symlinked external root and rejects escapes', () => {
    const { docs, repo, externalRoots } = setup();
    const reasons = LINKS.map(href => resolveBodyLinkTarget(href, docs, repo, externalRoots).reason ?? 'ok');
    deepStrictEqual(reasons, ['ok', 'ok', 'missing', 'outside-repo', 'outside-repo']);
    // The symlink is not an allowed root unless the config names it.
    strictEqual(resolveBodyLinkTarget('../shared/target.md', docs, repo).reason, 'outside-repo');
  });

  it('resolves the roots once and then only each target', () => {
    const { docs, repo, externalRoots } = setup();
    const { result: roots, calls: rootCalls } = countRealpaths(() => bodyLinkRoots(repo, externalRoots));
    deepStrictEqual(rootCalls, [repo, path.join(repo, 'shared')]);

    const { result, calls } = countRealpaths(() =>
      [...LINKS, ...LINKS].map(href => resolveBodyLinkTargetWithin(roots, href, docs).reason ?? 'ok'));
    deepStrictEqual(result, ['ok', 'ok', 'missing', 'outside-repo', 'outside-repo',
      'ok', 'ok', 'missing', 'outside-repo', 'outside-repo']);
    strictEqual(calls.filter(entry => entry === repo || entry === path.join(repo, 'shared')).length, 0);
    // Only links that exist inside an allowed lexical root reach the target
    // lookup, and each target only the first time it is linked.
    strictEqual(calls.length, 3);
  });

  it('hands back a fresh result for a target it has already resolved', () => {
    const { docs, repo, externalRoots } = setup();
    const roots = bodyLinkRoots(repo, externalRoots);
    const first = resolveBodyLinkTargetWithin(roots, LINKS[0], docs);
    first.path = 'changed';
    const again = resolveBodyLinkTargetWithin(roots, LINKS[0], docs);
    deepStrictEqual(again, resolveBodyLinkTarget(LINKS[0], docs, repo, externalRoots));
    strictEqual(again.ok, true);
  });

  it('reports links as unreadable when the repository root cannot be resolved', () => {
    const { docs, repo, externalRoots } = setup();
    const roots = { ...bodyLinkRoots(repo, externalRoots), canonicalRoot: null };
    strictEqual(resolveBodyLinkTargetWithin(roots, 'local.md', docs).reason, 'unreadable');
    strictEqual(resolveBodyLinkTargetWithin(roots, 'gone.md', docs).reason, 'missing');
  });

  it('resolves each root once for a whole index build', async () => {
    const { docs, repo } = setup();
    writeFileSync(path.join(repo, 'runlist.config.mjs'),
      "export const root = 'docs';\nexport const externalBodyLinkRoots = ['shared'];\n");
    for (let i = 0; i < 5; i++) {
      writeFileSync(path.join(docs, `doc-${i}.md`),
        `---\ntype: doc\nstatus: active\nupdated: 2025-01-01\n---\n# Doc ${i}\n\n${LINKS.map(href => `[x](${href})`).join(' ')}\n`);
    }
    const config = await resolveConfig(repo);
    const { result: index, calls } = countRealpaths(() => buildIndex(config, { invokeHooks: false }));
    strictEqual(calls.filter(entry => entry === config.repoRoot).length, 1);
    strictEqual(calls.filter(entry => entry === path.join(config.repoRoot, 'shared')).length, 1);
    const reasons = index.errors
      .filter(issue => issue.meta?.kind === 'body-link-resolution')
      .map(issue => `${issue.path} ${issue.meta.relPath} ${issue.meta.reason}`)
      .sort();
    deepStrictEqual(reasons, [0, 1, 2, 3, 4].flatMap(i => [
      `docs/doc-${i}.md ../../outside.md outside-repo`,
      `docs/doc-${i}.md ../shared/gone.md missing`,
      `docs/doc-${i}.md escape/secret.md outside-repo`,
    ]).sort());
  });
});
