import { describe, it, beforeEach, afterEach } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveConfig } from '../src/config.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-config-'));
  // Create a .git dir so repoRoot resolves to tmpDir
  mkdirSync(path.join(tmpDir, '.git'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveConfig', () => {
  it('returns defaults when no config file exists', async () => {
    const config = await resolveConfig(tmpDir);
    strictEqual(config.configPath, null);
    deepStrictEqual([...config.validStatuses], ['active', 'ready', 'planned', 'research', 'blocked', 'reference', 'archived']);
    strictEqual(config.archiveDir, 'archived');
    strictEqual(config.indexPath, null);
  });

  it('merges user config over defaults', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = 'plans';
      export const archiveDir = 'done';
    `);
    const config = await resolveConfig(tmpDir);
    strictEqual(config.docsRoot, path.join(tmpDir, 'plans'));
    strictEqual(config.archiveDir, 'done');
    // Default statuses still present
    ok(config.validStatuses.has('active'));
  });

  it('handles readme → index backwards compat alias', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const readme = {
        path: 'docs/README.md',
        startMarker: '<!-- START -->',
        endMarker: '<!-- END -->',
      };
    `);
    const config = await resolveConfig(tmpDir);
    strictEqual(config.indexPath, path.join(tmpDir, 'docs/README.md'));
    strictEqual(config.indexStartMarker, '<!-- START -->');
    strictEqual(config.indexEndMarker, '<!-- END -->');
  });

  it('deep-merges nested objects', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const statuses = {
        staleDays: { active: 7 },
      };
    `);
    const config = await resolveConfig(tmpDir);
    // Overridden value
    strictEqual(config.staleDaysByStatus.active, 7);
    // Defaults preserved for un-overridden keys
    strictEqual(config.staleDaysByStatus.planned, 30);
  });

  it('uses explicit config path', async () => {
    const customPath = path.join(tmpDir, 'custom.config.mjs');
    writeFileSync(customPath, `export const root = 'custom-docs';`);
    const config = await resolveConfig(tmpDir, customPath);
    strictEqual(config.docsRoot, path.join(tmpDir, 'custom-docs'));
  });

  it('extracts function exports as hooks', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export function onStatusChange(doc, meta) { return; }
    `);
    const config = await resolveConfig(tmpDir);
    strictEqual(typeof config.hooks.onStatusChange, 'function');
  });

  it('returns configFound true when config exists', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = '.';`);
    const config = await resolveConfig(tmpDir);
    strictEqual(config.configFound, true);
  });

  it('returns configFound false when no config exists', async () => {
    const config = await resolveConfig(tmpDir);
    strictEqual(config.configFound, false);
  });

  it('handles malformed config gracefully', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = (;`);
    // Capture stderr to verify error message
    const origWrite = process.stderr.write;
    let stderrOutput = '';
    process.stderr.write = (chunk) => { stderrOutput += chunk; return true; };
    const origExitCode = process.exitCode;

    const config = await resolveConfig(tmpDir);

    process.stderr.write = origWrite;
    process.exitCode = origExitCode;

    ok(stderrOutput.includes('Failed to load config'), 'shows error message');
    ok(stderrOutput.includes('dotmd init'), 'suggests dotmd init');
    // Should still return a usable config with defaults
    ok(config.validStatuses.has('active'), 'has default statuses');
    strictEqual(config.configFound, true, 'configFound is true since file was found');
  });

  it('resolves surfaces taxonomy', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const taxonomy = { surfaces: ['web', 'ios', 'api'] };
    `);
    const config = await resolveConfig(tmpDir);
    ok(config.validSurfaces.has('web'));
    ok(config.validSurfaces.has('ios'));
    ok(!config.validSurfaces.has('android'));
  });
});
