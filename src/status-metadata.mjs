// Ordered, type-aware view of the effective status configuration. Config loading
// still resolves compatibility overrides; consumers use this module instead of
// reconstructing behavior from several global/type-specific fields.
const CACHE = new WeakMap();

export function resolveStatusMetadata(config) {
  const cached = CACHE.get(config);
  if (cached) return cached;
  const byType = {};
  const typeOrder = [...(config.validTypes ?? [])];

  for (const type of typeOrder) {
    const statuses = [...(config.typeStatuses?.get(type) ?? [])];
    const typeDef = config.raw?.types?.[type] ?? {};
    const context = config.typeContextConfig?.get(type) ?? typeDef.context ?? {};
    const contextByStatus = new Map();
    for (const bucket of ['expanded', 'listed', 'counted']) {
      for (const status of context[bucket] ?? []) {
        if (!contextByStatus.has(status)) contextByStatus.set(status, bucket);
      }
    }

    byType[type] = statuses.map((name, rank) => {
      const skipStale = config.lifecycle.skipStaleFor.has(name);
      const skipWarnings = config.lifecycle.skipsWarnings(name, type);
      const hasTypeStaleDays = Object.prototype.hasOwnProperty.call(typeDef.staleDays ?? {}, name);
      return {
        name,
        rank,
        context: contextByStatus.get(name) ?? 'counted',
        staleDays: hasTypeStaleDays ? typeDef.staleDays[name] : (config.staleDaysByStatus?.[name] ?? null),
        startable: config.lifecycle.startableStatuses.has(name),
        terminal: config.lifecycle.isTerminal?.(name, type) ?? config.lifecycle.terminalStatuses.has(name),
        archive: config.lifecycle.archiveStatuses.has(name),
        filed: config.lifecycle.filedStatuses.get(name) ?? null,
        skipStale,
        skipWarnings,
        quiet: skipStale && skipWarnings,
        requiresModule: config.moduleRequiredStatuses.has(name),
      };
    });
  }

  const resolved = { typeOrder, byType };
  CACHE.set(config, resolved);
  return resolved;
}

export function statusMetadataFor(config, type, status) {
  if (!type || !status) return null;
  return resolveStatusMetadata(config).byType[type]?.find(item => item.name === status) ?? null;
}

export function statusesForContext(config, type, bucket) {
  return (resolveStatusMetadata(config).byType[type] ?? [])
    .filter(item => item.context === bucket)
    .map(item => item.name);
}

export function statusHasContext(config, type, status, bucket) {
  return statusMetadataFor(config, type, status)?.context === bucket;
}

export function actionablePromptStatuses(config) {
  const expanded = statusesForContext(config, 'prompt', 'expanded');
  return new Set(expanded.length > 0 ? expanded : ['pending']);
}

export function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Oldest actionable prompt first. Missing dates sort last; path is the stable
// final tie-breaker shared by HUD, agent-context, and no-arg `dotmd use`.
export function comparePromptDocs(a, b) {
  const aCreated = a.created ?? '';
  const bCreated = b.created ?? '';
  if (aCreated && bCreated && aCreated !== bCreated) return compareStrings(aCreated, bCreated);
  if (aCreated && !bCreated) return -1;
  if (!aCreated && bCreated) return 1;
  const aUpdated = a.updated ?? '';
  const bUpdated = b.updated ?? '';
  if (aUpdated && bUpdated && aUpdated !== bUpdated) return compareStrings(aUpdated, bUpdated);
  if (aUpdated && !bUpdated) return -1;
  if (!aUpdated && bUpdated) return 1;
  return compareStrings(a.path ?? '', b.path ?? '');
}
