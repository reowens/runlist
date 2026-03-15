import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { die, warn } from './util.mjs';

const CONFIG_FILENAMES = ['dotmd.config.mjs', '.dotmd.config.mjs', 'dotmd.config.js'];

const DEFAULTS = {
  root: '.',
  archiveDir: 'archived',
  excludeDirs: [],

  statuses: {
    order: ['active', 'ready', 'planned', 'research', 'blocked', 'reference', 'archived'],
    staleDays: {
      active: 14,
      ready: 14,
      planned: 30,
      blocked: 30,
      research: 30,
    },
  },

  lifecycle: {
    archiveStatuses: ['archived'],
    skipStaleFor: ['archived', 'reference'],
    skipWarningsFor: ['archived'],
  },

  taxonomy: {
    surfaces: null,
    moduleRequiredFor: [],
  },

  index: null,

  context: {
    expanded: ['active'],
    listed: ['ready', 'planned'],
    counted: ['blocked', 'research', 'reference', 'archived'],
    recentDays: 3,
    recentStatuses: ['active', 'ready', 'planned'],
    recentLimit: 10,
    truncateNextStep: 80,
  },

  display: {
    lineWidth: 0,
    truncateTitle: 30,
    truncateNextStep: 80,
  },

  referenceFields: {
    bidirectional: [],
    unidirectional: [],
  },

  presets: {
    stale: ['--status', 'active,ready,planned,blocked,research', '--stale', '--sort', 'updated', '--all'],
    actionable: ['--status', 'active,ready', '--has-next-step', '--sort', 'updated', '--all'],
  },
};

function findConfigFile(startDir) {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (dir !== root) {
    for (const filename of CONFIG_FILENAMES) {
      const candidate = path.join(dir, filename);
      if (existsSync(candidate)) return candidate;
    }
    dir = path.dirname(dir);
  }

  return null;
}

function deepMerge(defaults, overrides) {
  const result = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (value != null && typeof value === 'object' && !Array.isArray(value) &&
        result[key] != null && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export async function resolveConfig(cwd, explicitConfigPath) {
  const configPath = explicitConfigPath
    ? path.resolve(cwd, explicitConfigPath)
    : findConfigFile(cwd);

  let userConfig = {};
  let hooks = {};
  let configDir = cwd;

  if (configPath && existsSync(configPath)) {
    const configUrl = pathToFileURL(configPath).href;
    let mod;
    try {
      mod = await import(configUrl);
    } catch (err) {
      die('Failed to load config: ' + configPath + '\n' + err.message + '\nRun `dotmd init` to create a starter config.');
      // Return defaults so caller can still function
      const defaults = deepMerge(DEFAULTS, {});
      const defaultStatusOrder = defaults.statuses.order;
      return {
        raw: defaults, docsRoot: cwd, repoRoot: cwd, configDir: cwd,
        configPath: configPath ?? null, configFound: Boolean(configPath),
        archiveDir: defaults.archiveDir, excludeDirs: new Set(defaults.excludeDirs),
        docsRootPrefix: '', statusOrder: defaultStatusOrder,
        validStatuses: new Set(defaultStatusOrder), staleDaysByStatus: {},
        lifecycle: { archiveStatuses: new Set(defaults.lifecycle.archiveStatuses), skipStaleFor: new Set(defaults.lifecycle.skipStaleFor), skipWarningsFor: new Set(defaults.lifecycle.skipWarningsFor) },
        validSurfaces: null, moduleRequiredStatuses: new Set(),
        indexPath: null, indexStartMarker: '<!-- GENERATED:dotmd:start -->', indexEndMarker: '<!-- GENERATED:dotmd:end -->', archivedHighlightLimit: 8,
        context: defaults.context, display: defaults.display,
        referenceFields: defaults.referenceFields, presets: defaults.presets, hooks: {},
      };
    }

    configDir = path.dirname(configPath);

    for (const [key, value] of Object.entries(mod)) {
      if (key === 'default') continue;
      if (typeof value === 'function') {
        hooks[key] = value;
      } else {
        userConfig[key] = value;
      }
    }
  }

  // Backwards compat: `readme` config key maps to `index`
  if (userConfig.readme && !userConfig.index) {
    userConfig.index = userConfig.readme;
    delete userConfig.readme;
  }

  const config = deepMerge(DEFAULTS, userConfig);

  const docsRoot = path.resolve(configDir, config.root);

  if (!existsSync(docsRoot)) {
    warn('Docs root does not exist: ' + docsRoot);
  }

  // Find repo root by walking up looking for .git
  let repoRoot = configDir;
  {
    let dir = configDir;
    const fsRoot = path.parse(dir).root;
    while (dir !== fsRoot) {
      if (existsSync(path.join(dir, '.git'))) {
        repoRoot = dir;
        break;
      }
      dir = path.dirname(dir);
    }
  }

  const statusOrder = config.statuses.order;
  const validStatuses = new Set(statusOrder);
  const staleDaysByStatus = {};
  for (const status of statusOrder) {
    staleDaysByStatus[status] = config.statuses.staleDays?.[status] ?? null;
  }

  const validSurfaces = config.taxonomy.surfaces
    ? new Set(config.taxonomy.surfaces)
    : null;
  const moduleRequiredStatuses = new Set(config.taxonomy.moduleRequiredFor);

  const indexPath = config.index?.path
    ? path.resolve(repoRoot, config.index.path)
    : null;

  // Compute docs root relative path for index link stripping
  const docsRootRelative = path.relative(repoRoot, docsRoot).split(path.sep).join('/');
  const docsRootPrefix = docsRootRelative ? docsRootRelative + '/' : '';

  // Lifecycle config
  const lifecycle = config.lifecycle;
  const archiveStatuses = new Set(lifecycle.archiveStatuses);
  const skipStaleFor = new Set(lifecycle.skipStaleFor);
  const skipWarningsFor = new Set(lifecycle.skipWarningsFor);

  return {
    raw: config,

    docsRoot,
    repoRoot,
    configDir,
    configPath: configPath ?? null,
    configFound: Boolean(configPath),
    archiveDir: config.archiveDir,
    excludeDirs: new Set(config.excludeDirs),
    docsRootPrefix,

    statusOrder,
    validStatuses,
    staleDaysByStatus,

    lifecycle: { archiveStatuses, skipStaleFor, skipWarningsFor },

    validSurfaces,
    moduleRequiredStatuses,

    indexPath,
    indexStartMarker: config.index?.startMarker ?? '<!-- GENERATED:dotmd:start -->',
    indexEndMarker: config.index?.endMarker ?? '<!-- GENERATED:dotmd:end -->',
    archivedHighlightLimit: config.index?.archivedLimit ?? 8,

    context: config.context,
    display: config.display,
    referenceFields: config.referenceFields,
    presets: config.presets,
    hooks,
  };
}
