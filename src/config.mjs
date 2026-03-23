import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { die, warn } from './util.mjs';

const CONFIG_FILENAMES = ['dotmd.config.mjs', '.dotmd.config.mjs', 'dotmd.config.js'];

const DEFAULTS = {
  root: '.',
  archiveDir: 'archived',
  excludeDirs: [],

  types: {
    plan: {
      statuses: ['in-session', 'active', 'planned', 'blocked', 'done', 'archived'],
      context: { expanded: ['in-session', 'active'], listed: ['planned', 'blocked'], counted: ['done', 'archived'] },
      staleDays: { 'in-session': 1, active: 14, planned: 30, blocked: 30 },
    },
    doc: {
      statuses: ['draft', 'active', 'review', 'reference', 'deprecated', 'archived'],
      context: { expanded: ['active'], listed: ['draft', 'review'], counted: ['reference', 'deprecated', 'archived'] },
      staleDays: { draft: 30, active: 14, review: 14 },
    },
    research: {
      statuses: ['active', 'reference', 'archived'],
      context: { expanded: ['active'], listed: [], counted: ['reference', 'archived'] },
      staleDays: { active: 30 },
    },
  },

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
    terminalStatuses: ['archived', 'deprecated', 'reference', 'done'],
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

  templates: {},

  notion: null,

  presets: {
    plans: ['--type', 'plan', '--sort', 'status', '--all'],
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

const VALID_CONFIG_KEYS = new Set(Object.keys(DEFAULTS));

function validateConfig(userConfig, config, validStatuses, indexPath) {
  const warnings = [];

  // statuses.order must be array
  if (config.statuses && config.statuses.order !== undefined && !Array.isArray(config.statuses.order)) {
    warnings.push('Config: statuses.order must be an array.');
  }

  // archiveDir must be string
  if (config.archiveDir !== undefined && typeof config.archiveDir !== 'string') {
    warnings.push('Config: archiveDir must be a string.');
  }

  // lifecycle.archiveStatuses values must exist in validStatuses
  if (config.lifecycle?.archiveStatuses) {
    for (const s of config.lifecycle.archiveStatuses) {
      if (!validStatuses.has(s)) {
        warnings.push(`Config: lifecycle.archiveStatuses contains unknown status '${s}'.`);
      }
    }
  }

  // staleDays keys must exist in validStatuses
  if (config.statuses?.staleDays) {
    for (const key of Object.keys(config.statuses.staleDays)) {
      if (!validStatuses.has(key)) {
        warnings.push(`Config: statuses.staleDays contains unknown status '${key}'.`);
      }
    }
  }

  // taxonomy.surfaces must be null or array
  if (config.taxonomy?.surfaces !== undefined && config.taxonomy.surfaces !== null && !Array.isArray(config.taxonomy.surfaces)) {
    warnings.push('Config: taxonomy.surfaces must be null or an array.');
  }

  // index path file exists (if configured)
  if (indexPath && !existsSync(indexPath)) {
    warnings.push(`Config: index path does not exist: ${indexPath}`);
  }

  // Unknown top-level user config keys
  for (const key of Object.keys(userConfig)) {
    if (!VALID_CONFIG_KEYS.has(key)) {
      warnings.push(`Config: unknown key '${key}'.`);
    }
  }

  return warnings;
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
      die('Failed to load config: ' + configPath + '\n' + err.message + '\nCheck for syntax errors in your config file.');
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

  const rootPaths = Array.isArray(config.root) ? config.root : [config.root];
  const docsRoots = rootPaths.map(r => path.resolve(configDir, r));
  const docsRoot = docsRoots[0]; // primary root for backwards compat

  const earlyWarnings = [];
  for (const dr of docsRoots) {
    if (!existsSync(dr)) {
      earlyWarnings.push('Config: docs root does not exist: ' + dr);
    }
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

  // Resolve document types
  const typesConfig = config.types ?? {};
  const validTypes = new Set(Object.keys(typesConfig));
  const typeStatuses = new Map();
  const typeContextConfig = new Map();
  for (const [typeName, typeDef] of Object.entries(typesConfig)) {
    typeStatuses.set(typeName, new Set(typeDef.statuses ?? []));
    if (typeDef.context) typeContextConfig.set(typeName, typeDef.context);
  }

  const statusOrder = config.statuses.order;
  const validStatuses = new Set(statusOrder);
  // Merge all type-specific statuses into the global valid set
  for (const typeSet of typeStatuses.values()) {
    for (const s of typeSet) validStatuses.add(s);
  }
  const staleDaysByStatus = {};
  for (const status of statusOrder) {
    staleDaysByStatus[status] = config.statuses.staleDays?.[status] ?? null;
  }
  // Merge type-specific staleDays
  for (const typeDef of Object.values(typesConfig)) {
    if (typeDef.staleDays) {
      for (const [status, days] of Object.entries(typeDef.staleDays)) {
        if (!(status in staleDaysByStatus)) staleDaysByStatus[status] = days;
      }
    }
  }

  // Per-root additional statuses (merged with global validStatuses)
  const rootStatusesRaw = config.statuses.rootStatuses ?? {};
  const rootLabels = new Set(rootPaths.map(r => path.relative(configDir, path.resolve(configDir, r)).split(path.sep).join('/')));
  const rootValidStatuses = new Map();
  for (const [rootKey, extraStatuses] of Object.entries(rootStatusesRaw)) {
    const merged = new Set(validStatuses);
    for (const s of extraStatuses) merged.add(s);
    rootValidStatuses.set(rootKey, merged);
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
  const terminalStatuses = new Set(lifecycle.terminalStatuses);

  // Warn if rootStatuses keys don't match any configured root
  for (const rootKey of Object.keys(rootStatusesRaw)) {
    if (!rootLabels.has(rootKey)) {
      earlyWarnings.push(`Config: statuses.rootStatuses key '${rootKey}' does not match any configured root.`);
    }
  }

  const configWarnings = [...earlyWarnings, ...validateConfig(userConfig, config, validStatuses, indexPath)];

  return {
    raw: config,

    docsRoot,
    docsRoots,
    repoRoot,
    configDir,
    configPath: configPath ?? null,
    configFound: Boolean(configPath),
    archiveDir: config.archiveDir,
    excludeDirs: new Set(config.excludeDirs),
    docsRootPrefix,

    statusOrder,
    validStatuses,
    validTypes,
    typeStatuses,
    typeContextConfig,
    rootValidStatuses,
    staleDaysByStatus,

    lifecycle: { archiveStatuses, skipStaleFor, skipWarningsFor, terminalStatuses },

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
    configWarnings,
  };
}
