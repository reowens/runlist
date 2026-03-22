import { describe, it, beforeEach, afterEach } from 'node:test';
import { strictEqual, deepStrictEqual, ok, rejects } from 'node:assert';
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
    // validStatuses is union of global order + all type-specific statuses
    ok(config.validStatuses.has('active'));
    ok(config.validStatuses.has('archived'));
    ok(config.validStatuses.has('in-session')); // plan-specific
    ok(config.validStatuses.has('done'));        // plan-specific
    ok(config.validStatuses.has('draft'));       // doc-specific
    ok(config.validStatuses.has('review'));      // doc-specific
    ok(config.validStatuses.has('deprecated')); // doc-specific
    ok(config.validTypes.has('plan'));
    ok(config.validTypes.has('doc'));
    ok(config.validTypes.has('research'));
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

  it('handles malformed config by throwing', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = (;`);
    await rejects(
      () => resolveConfig(tmpDir),
      (err) => {
        ok(err.message.includes('Failed to load config'), 'shows error message');
        ok(err.message.includes('syntax errors'), 'suggests checking syntax');
        return true;
      }
    );
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

  it('warns on unknown top-level config key', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = '.';
      export const banana = 'yellow';
    `);
    const config = await resolveConfig(tmpDir);
    ok(config.configWarnings.length > 0, 'has config warnings');
    ok(config.configWarnings.some(w => w.includes("unknown key 'banana'")), 'warns about banana');
  });

  it('warns when taxonomy.surfaces is not null or array', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const taxonomy = { surfaces: 'web' };
    `);
    const config = await resolveConfig(tmpDir);
    ok(config.configWarnings.some(w => w.includes('taxonomy.surfaces')), 'warns about surfaces type');
  });

  it('warns when lifecycle.archiveStatuses has unknown status', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const lifecycle = { archiveStatuses: ['archived', 'nonexistent'] };
    `);
    const config = await resolveConfig(tmpDir);
    ok(config.configWarnings.some(w => w.includes("'nonexistent'")), 'warns about unknown status');
  });

  it('returns empty configWarnings for valid config', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = '.';
      export const archiveDir = 'archived';
    `);
    const config = await resolveConfig(tmpDir);
    strictEqual(config.configWarnings.length, 0, 'no warnings');
  });

  it('parses rootStatuses into rootValidStatuses Map', async () => {
    mkdirSync(path.join(tmpDir, 'plans'), { recursive: true });
    mkdirSync(path.join(tmpDir, 'modules'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = ['plans', 'modules'];
      export const statuses = {
        rootStatuses: {
          'modules': ['implemented', 'partial'],
        },
      };
    `);
    const config = await resolveConfig(tmpDir);
    ok(config.rootValidStatuses instanceof Map, 'is a Map');
    strictEqual(config.rootValidStatuses.size, 1, 'one root entry');
    const modSet = config.rootValidStatuses.get('modules');
    ok(modSet.has('implemented'), 'has root-specific status');
    ok(modSet.has('partial'), 'has root-specific status');
    ok(modSet.has('active'), 'includes global statuses');
    ok(!config.rootValidStatuses.has('plans'), 'plans not in rootStatuses');
  });

  it('returns empty rootValidStatuses when not configured', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = '.';`);
    const config = await resolveConfig(tmpDir);
    ok(config.rootValidStatuses instanceof Map, 'is a Map');
    strictEqual(config.rootValidStatuses.size, 0, 'empty');
  });

  it('warns when rootStatuses key does not match any root', async () => {
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = 'docs';
      export const statuses = {
        rootStatuses: { 'nonexistent': ['implemented'] },
      };
    `);
    const config = await resolveConfig(tmpDir);
    ok(config.configWarnings.some(w => w.includes("'nonexistent'")), 'warns about unknown root key');
  });
});
