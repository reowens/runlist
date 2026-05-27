import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function run(args) {
  return spawnSync('node', [BIN, ...args], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

function setup({ surfaces } = {}) {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-surfaces-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  const taxonomyLine = surfaces ? `export const taxonomy = { surfaces: ${JSON.stringify(surfaces)} };` : '';
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'),
    `export const root = 'docs';\n${taxonomyLine}`);
}

afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

describe('dotmd surfaces — taxonomy discoverability (issue #12 trap 1)', () => {
  it('prints one surface per line when taxonomy is configured', () => {
    setup({ surfaces: ['web', 'api', 'platform', 'docs'] });
    const r = run(['surfaces']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    strictEqual(r.stdout, 'web\napi\nplatform\ndocs\n');
  });

  it('--json emits a structured shape', () => {
    setup({ surfaces: ['web', 'api'] });
    const r = run(['surfaces', '--json']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    ok(Array.isArray(parsed.surfaces), 'has surfaces array');
    strictEqual(parsed.surfaces.length, 2);
    strictEqual(parsed.surfaces[0], 'web');
  });

  it('says "no taxonomy configured" when the project has none', () => {
    setup({ surfaces: null });
    const r = run(['surfaces']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    ok(r.stdout.includes('No surface taxonomy configured'),
      `expected helpful message; got: ${r.stdout}`);
  });

  it('--json returns an empty list when no taxonomy is configured', () => {
    setup({ surfaces: null });
    const r = run(['surfaces', '--json']);
    strictEqual(r.status, 0, `stderr: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    strictEqual(parsed.surfaces.length, 0);
  });
});
