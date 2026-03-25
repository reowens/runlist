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

  it('replaces staleDays entirely when user provides it', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const statuses = {
        staleDays: { active: 7 },
      };
    `);
    const config = await resolveConfig(tmpDir);
    // Overridden value
    strictEqual(config.staleDaysByStatus.active, 7);
    // Default staleDays keys NOT preserved — user's staleDays is authoritative
    // (planned/ready still in staleDaysByStatus from default statusOrder, but with null threshold)
    strictEqual(config.staleDaysByStatus.planned, null);
    strictEqual(config.staleDaysByStatus.ready, null);
  });

  it('replaces context entirely when user provides it', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const context = {
        expanded: ['active'],
        listed: ['planned'],
        counted: ['archived'],
        recentDays: 7,
        recentStatuses: ['active'],
        recentLimit: 10,
        truncateNextStep: 80,
      };
    `);
    const config = await resolveConfig(tmpDir);
    ok(!config.context.listed?.includes('ready'), 'default ready not in user listed');
    deepStrictEqual(config.context.listed, ['planned']);
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

describe('rich status definitions', () => {
  it('accepts object-form statuses and derives type config', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const types = {
        plan: {
          statuses: {
            'active':   { context: 'expanded', staleDays: 7, requiresModule: true },
            'blocked':  { context: 'listed', staleDays: 30, skipStale: true },
            'archived': { context: 'counted', archive: true, terminal: true, skipStale: true, skipWarnings: true },
          }
        }
      };
    `);
    const config = await resolveConfig(tmpDir);
    // Status names extracted as array
    ok(config.validStatuses.has('active'));
    ok(config.validStatuses.has('blocked'));
    ok(config.validStatuses.has('archived'));
    // Type statuses is a Set of names
    const planStatuses = config.typeStatuses.get('plan');
    ok(planStatuses.has('active'));
    ok(planStatuses.has('blocked'));
    ok(planStatuses.has('archived'));
    strictEqual(planStatuses.size, 3);
  });

  it('derives lifecycle flags from rich statuses', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const types = {
        plan: {
          statuses: {
            'active':   { context: 'expanded', staleDays: 14 },
            'blocked':  { context: 'listed', skipStale: true },
            'done':     { context: 'counted', terminal: true, skipStale: true, skipWarnings: true },
            'archived': { context: 'counted', archive: true, terminal: true, skipStale: true, skipWarnings: true },
          }
        }
      };
    `);
    const config = await resolveConfig(tmpDir);
    ok(config.lifecycle.archiveStatuses.has('archived'), 'archived is archive status');
    ok(!config.lifecycle.archiveStatuses.has('done'), 'done is not archive status');
    ok(config.lifecycle.terminalStatuses.has('done'), 'done is terminal');
    ok(config.lifecycle.terminalStatuses.has('archived'), 'archived is terminal');
    ok(!config.lifecycle.terminalStatuses.has('active'), 'active is not terminal');
    ok(config.lifecycle.skipStaleFor.has('blocked'), 'blocked skips stale');
    ok(config.lifecycle.skipStaleFor.has('done'), 'done skips stale');
    ok(config.lifecycle.skipStaleFor.has('archived'), 'archived skips stale');
    ok(!config.lifecycle.skipStaleFor.has('active'), 'active does not skip stale');
    ok(config.lifecycle.skipWarningsFor.has('done'), 'done skips warnings');
    ok(config.lifecycle.skipWarningsFor.has('archived'), 'archived skips warnings');
    ok(!config.lifecycle.skipWarningsFor.has('blocked'), 'blocked does not skip warnings');
  });

  it('derives staleDays from rich statuses', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const types = {
        plan: {
          statuses: {
            'active':   { context: 'expanded', staleDays: 7 },
            'blocked':  { context: 'listed', staleDays: 30 },
            'archived': { context: 'counted' },
          }
        }
      };
    `);
    const config = await resolveConfig(tmpDir);
    strictEqual(config.staleDaysByStatus.active, 7);
    strictEqual(config.staleDaysByStatus.blocked, 30);
    strictEqual(config.staleDaysByStatus.archived ?? null, null);
  });

  it('derives context display from rich statuses', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const types = {
        plan: {
          statuses: {
            'active':   { context: 'expanded' },
            'planned':  { context: 'listed' },
            'blocked':  { context: 'listed' },
            'archived': { context: 'counted' },
          }
        }
      };
    `);
    const config = await resolveConfig(tmpDir);
    // Type-level context
    const typeCtx = config.typeContextConfig.get('plan');
    deepStrictEqual(typeCtx.expanded, ['active']);
    deepStrictEqual(typeCtx.listed, ['planned', 'blocked']);
    deepStrictEqual(typeCtx.counted, ['archived']);
    // Global context derived
    ok(config.context.expanded.includes('active'));
    ok(config.context.listed.includes('planned'));
    ok(config.context.listed.includes('blocked'));
    ok(config.context.counted.includes('archived'));
  });

  it('derives moduleRequiredFor from rich statuses', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const types = {
        plan: {
          statuses: {
            'active':   { requiresModule: true },
            'blocked':  { requiresModule: true },
            'archived': {},
          }
        }
      };
    `);
    const config = await resolveConfig(tmpDir);
    ok(config.moduleRequiredStatuses.has('active'), 'active requires module');
    ok(config.moduleRequiredStatuses.has('blocked'), 'blocked requires module');
    ok(!config.moduleRequiredStatuses.has('archived'), 'archived does not require module');
  });

  it('derives statusOrder from rich statuses', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const types = {
        plan: {
          statuses: {
            'active':   {},
            'planned':  {},
            'archived': {},
          }
        }
      };
    `);
    const config = await resolveConfig(tmpDir);
    const planIdx = config.statusOrder.indexOf('active');
    const plannedIdx = config.statusOrder.indexOf('planned');
    const archivedIdx = config.statusOrder.indexOf('archived');
    ok(planIdx < plannedIdx, 'active before planned');
    ok(plannedIdx < archivedIdx, 'planned before archived');
  });

  it('explicit user lifecycle overrides derived values', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const types = {
        plan: {
          statuses: {
            'active':   { context: 'expanded' },
            'archived': { context: 'counted', archive: true, terminal: true, skipStale: true },
          }
        }
      };
      export const lifecycle = {
        archiveStatuses: ['archived'],
        terminalStatuses: ['archived'],
        skipStaleFor: ['archived'],
        skipWarningsFor: [],
      };
    `);
    const config = await resolveConfig(tmpDir);
    // User's explicit lifecycle wins
    ok(config.lifecycle.archiveStatuses.has('archived'));
    ok(config.lifecycle.terminalStatuses.has('archived'));
    ok(!config.lifecycle.terminalStatuses.has('active'), 'user did not include active');
    deepStrictEqual([...config.lifecycle.skipWarningsFor], []);
  });

  it('explicit user context overrides derived values', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const types = {
        plan: {
          statuses: {
            'active':   { context: 'expanded' },
            'blocked':  { context: 'listed' },
            'archived': { context: 'counted' },
          }
        }
      };
      export const context = {
        expanded: ['active'],
        listed: [],
        counted: ['blocked', 'archived'],
        recentDays: 5,
        recentStatuses: ['active'],
        recentLimit: 5,
        truncateNextStep: 80,
      };
    `);
    const config = await resolveConfig(tmpDir);
    // User's explicit context wins — blocked moved to counted
    deepStrictEqual(config.context.listed, []);
    ok(config.context.counted.includes('blocked'));
  });

  it('mixed array and object types work together', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const types = {
        plan: {
          statuses: {
            'active':   { context: 'expanded', staleDays: 14 },
            'archived': { context: 'counted', archive: true, skipStale: true, skipWarnings: true },
          }
        },
        doc: {
          statuses: ['draft', 'current', 'deprecated'],
          context: { expanded: [], listed: ['draft'], counted: ['current', 'deprecated'] },
        }
      };
    `);
    const config = await resolveConfig(tmpDir);
    // Plan uses rich form
    ok(config.typeStatuses.get('plan').has('active'));
    ok(config.typeStatuses.get('plan').has('archived'));
    // Doc uses array form
    ok(config.typeStatuses.get('doc').has('draft'));
    ok(config.typeStatuses.get('doc').has('current'));
    // Both contribute to validStatuses
    ok(config.validStatuses.has('active'));
    ok(config.validStatuses.has('draft'));
  });

  it('status with no props defaults to counted context', async () => {
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const types = {
        plan: {
          statuses: {
            'active':   { context: 'expanded' },
            'misc':     {},
          }
        }
      };
    `);
    const config = await resolveConfig(tmpDir);
    const typeCtx = config.typeContextConfig.get('plan');
    ok(typeCtx.counted.includes('misc'), 'bare status defaults to counted');
    ok(!typeCtx.expanded.includes('misc'));
    ok(!typeCtx.listed.includes('misc'));
  });
});
