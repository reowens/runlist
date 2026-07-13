import { afterEach, describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let root;

function run(args, sid, cwd = root) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', DOTMD_SESSION_ID: sid },
  });
}

function setup() {
  root = mkdtempSync(path.join(os.tmpdir(), 'dotmd-bulk-'));
  mkdirSync(path.join(root, 'docs', 'plans'), { recursive: true });
  writeFileSync(path.join(root, 'dotmd.config.mjs'), `
    export const root = 'docs';
    export const index = { path: 'docs/docs.md', startMarker: '<!-- START -->', endMarker: '<!-- END -->' };
  `);
  writeFileSync(path.join(root, 'docs', 'docs.md'), '# Index\n\n<!-- START -->\n\n<!-- END -->\n');
  for (const name of ['good', 'busy']) writeFileSync(path.join(root, 'docs', 'plans', `${name}.md`), `---\ntype: plan\nstatus: active\nupdated: 2026-01-01\n---\n# ${name}\n`);
  spawnSync('git', ['init', '-q'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  spawnSync('git', ['add', '.'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'initial'], { cwd: root });
  strictEqual(run(['use', 'docs/plans/busy.md', '--no-index'], 'owner').status, 0);
}

afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('bulk archive per-item result contract', () => {
  it('returns partial JSON, exits nonzero, and normalizes files from a subdirectory', () => {
    setup();
    const result = run(['bulk', 'archive', '--json', 'plans/good.md', 'plans/busy.md'], 'other', path.join(root, 'docs'));
    strictEqual(result.status, 1, result.stderr);
    const value = JSON.parse(result.stdout || (() => { throw new Error(result.stderr); })());
    strictEqual(value.atomicity, 'per-item');
    strictEqual(value.items.find(item => item.path.endsWith('good.md')).result, 'archived');
    strictEqual(value.items.find(item => item.path.endsWith('busy.md')).result, 'failed');
    ok(value.items.find(item => item.path.endsWith('busy.md')).error.includes('another session'));
    ok(value.repositoryFiles.every(file => !file.startsWith('..') && !path.isAbsolute(file)));
    strictEqual(value.generatedFiles.length, 1);
    ok(existsSync(path.join(root, 'docs', 'archived', 'good.md')));
    ok(existsSync(path.join(root, 'docs', 'plans', 'busy.md')));
  });

  it('returns nonzero and no generated index when every item fails', () => {
    setup();
    const before = readFileSync(path.join(root, 'docs', 'docs.md'));
    const result = run(['bulk', 'archive', '--json', 'docs/plans/busy.md'], 'other');
    strictEqual(result.status, 1, result.stderr);
    const value = JSON.parse(result.stdout || (() => { throw new Error(result.stderr); })());
    strictEqual(value.items[0].result, 'failed');
    strictEqual(value.generatedFiles.length, 0);
    strictEqual(Buffer.compare(readFileSync(path.join(root, 'docs', 'docs.md')), before), 0);
  });

  it('treats index regeneration failure as a structured command failure', () => {
    setup();
    mkdirSync(path.join(root, 'docs', 'index-dir'));
    writeFileSync(path.join(root, 'dotmd.config.mjs'), `
      export const root = 'docs';
      export const index = { path: 'docs/index-dir', startMarker: '<!-- START -->', endMarker: '<!-- END -->' };
    `);
    const result = run(['bulk', 'archive', '--json', 'docs/plans/good.md'], 'other');
    strictEqual(result.status, 1, result.stderr);
    const value = JSON.parse(result.stdout);
    strictEqual(value.items[0].result, 'archived');
    strictEqual(value.index.status, 'failed');
    ok(value.index.error);
    strictEqual(value.generatedFiles.length, 0);
    strictEqual(value.deferredGeneratedFiles.join(','), 'docs/index-dir');
  });
});
