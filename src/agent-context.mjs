import { die, isArchivedPath, truncate } from './util.mjs';
import { isCoordinationHub } from './runlist.mjs';
import { readPlanOwnership, ownershipLiveness } from './pickup.mjs';
import {
  actionablePromptStatuses,
  comparePromptDocs,
  compareStrings,
  resolveStatusMetadata,
  statusMetadataFor,
} from './status-metadata.mjs';

export const AGENT_CONTEXT_SCHEMA = Object.freeze({ name: 'dotmd.agent-context', version: 1 });
export const DEFAULT_AGENT_CONTEXT_BYTES = 16 * 1024;
export const AGENT_CONTEXT_SECTIONS = Object.freeze(['statusVocabulary', 'counts', 'prompts', 'plans', 'issues']);

export function parseAgentContextOptions(args) {
  const value = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const rawBudget = value('--max-bytes');
  const maxBytes = rawBudget === undefined ? DEFAULT_AGENT_CONTEXT_BYTES : Number(rawBudget);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2048) die('--max-bytes takes a whole number of bytes, at least 2048.');
  const rawSections = value('--sections');
  const sections = rawSections === undefined ? null : [...new Set(rawSections.split(',').map(s => s.trim()).filter(Boolean))];
  if (sections && (!sections.length || sections.some(s => !AGENT_CONTEXT_SECTIONS.includes(s)))) {
    die(`--sections is a comma-separated selection of ${AGENT_CONTEXT_SECTIONS.join(', ')}.`);
  }
  return { maxBytes, sections };
}

const LIMITS = Object.freeze({ vocabulary: 32, prompts: 8, plans: 12, hubs: 8, issues: 10 });

export function boundedCollection(items, limit) {
  const selected = items.slice(0, limit);
  return {
    total: items.length,
    shown: selected.length,
    truncated: selected.length < items.length,
    items: selected,
  };
}

function compactDoc(doc, config) {
  const blockers = (doc.blockers ?? []).map(item => truncate(String(item), 160));
  const ownership = doc.type === 'plan' ? readPlanOwnership(doc.path, config) : null;
  return {
    path: doc.path,
    title: truncate(doc.title ?? '', 160),
    status: doc.status,
    type: doc.type,
    nextStep: doc.nextStep ? truncate(doc.nextStep, 300) : null,
    blockers: boundedCollection(blockers, 3),
    daysSinceUpdate: doc.daysSinceUpdate ?? null,
    ...(doc.owner ? { owner: doc.owner } : {}),
    ...(ownership ? { claim: ownership.corrupt ? { state: 'unverifiable', reason: ownership.reason } : {
      state: ownership.state, sessionId: ownership.sessionId,
      claimedAt: ownership.claimedAt, liveness: ownershipLiveness(ownership),
    } } : {}),
  };
}

function docCollection(docs, limit, config) {
  return { total: docs.length, shown: Math.min(docs.length, limit), truncated: docs.length > limit, items: docs.slice(0, limit).map(doc => compactDoc(doc, config)) };
}

function enforceByteBudget(context, maxBytes) {
  context.budget = { maxBytes, bytes: 0, truncated: false };
  const measure = () => {
    for (let i = 0; i < 4; i++) context.budget.bytes = Buffer.byteLength(JSON.stringify(context, null, 2) + '\n');
    return context.budget.bytes;
  };
  const collections = [
    context.plans?.stale, context.plans?.listed, context.plans?.hubs,
    context.issues?.warnings,
    ...Object.values(context.statusVocabulary ?? {}).reverse(),
    context.issues?.errors, context.prompts?.actionable, context.plans?.focus,
  ].filter(Boolean);
  const protectedItem = (collection, item, i) => {
    if (collection === context.plans?.focus || collection === context.plans?.listed) {
      if (item.claim?.state === 'owned' || item.claim?.state === 'unverifiable' || item.owner) return true;
      if (collection === context.plans?.focus && i === 0) return true;
    }
    return i === 0 && (collection === context.prompts?.actionable || collection === context.issues?.errors);
  };
  while (measure() > maxBytes) {
    let removed = false;
    for (const collection of collections) {
      const i = collection.items.findLastIndex((item, i) => !protectedItem(collection, item, i));
      if (i < 0) continue;
      collection.items.splice(i, 1);
      collection.shown = collection.items.length;
      collection.truncated = collection.shown < collection.total;
      context.budget.truncated = true;
      removed = true;
      break;
    }
    if (!removed) die(`Agent context needs ${context.budget.bytes} bytes to retain its counts, claims, next prompt and first action; increase --max-bytes or select fewer --sections.`);
  }
  return context;
}

function rankMap(metadata, type) {
  return new Map((metadata.byType[type] ?? []).map(item => [item.name, item.rank]));
}

function compareByStatusAndPath(ranks) {
  return (a, b) => (ranks.get(a.status) ?? Number.MAX_SAFE_INTEGER) - (ranks.get(b.status) ?? Number.MAX_SAFE_INTEGER)
    || compareStrings(a.path, b.path);
}

function issueItem(issue) {
  return { path: issue.path ?? null, message: truncate(issue.message ?? String(issue), 300) };
}

export function buildAgentContext(index, config, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_AGENT_CONTEXT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 2048) die('--max-bytes takes a whole number of bytes, at least 2048.');
  const sections = options.sections ?? AGENT_CONTEXT_SECTIONS;
  if (!Array.isArray(sections) || !sections.length || sections.some(s => !AGENT_CONTEXT_SECTIONS.includes(s))) die('Unknown agent-context section.');
  const metadata = resolveStatusMetadata(config);
  const planRanks = rankMap(metadata, 'plan');
  const closed = (doc) => isArchivedPath(doc.path, config)
    || config.lifecycle.archiveStatuses.has(doc.status)
    || config.lifecycle.terminalStatuses.has(doc.status);
  const livePlans = index.docs.filter(doc => doc.type === 'plan' && !closed(doc));
  const hubs = livePlans.filter(isCoordinationHub).sort((a, b) => compareStrings(a.path, b.path));
  const leaves = livePlans.filter(doc => !isCoordinationHub(doc));
  const focus = leaves
    .filter(doc => statusMetadataFor(config, 'plan', doc.status)?.context === 'expanded')
    .sort(compareByStatusAndPath(planRanks));
  const listed = leaves
    .filter(doc => statusMetadataFor(config, 'plan', doc.status)?.context === 'listed')
    .sort(compareByStatusAndPath(planRanks));
  const stale = leaves
    .filter(doc => doc.isStale && !statusMetadataFor(config, 'plan', doc.status)?.skipStale)
    .sort((a, b) => (b.daysSinceUpdate ?? -1) - (a.daysSinceUpdate ?? -1)
      || compareByStatusAndPath(planRanks)(a, b));

  const promptStatuses = actionablePromptStatuses(config);
  const prompts = index.docs
    .filter(doc => doc.type === 'prompt' && promptStatuses.has(doc.status) && !closed(doc))
    .sort(comparePromptDocs);

  const vocabulary = {};
  const vocabularyTypes = options.types?.length
    ? metadata.typeOrder.filter(type => options.types.includes(type))
    : metadata.typeOrder;
  for (const type of vocabularyTypes) {
    vocabulary[type] = boundedCollection(
      (metadata.byType[type] ?? []).map(item => ({
        name: item.name,
        context: item.context,
        staleDays: item.staleDays,
        startable: item.startable,
        terminal: item.terminal,
        archive: item.archive,
      })),
      LIMITS.vocabulary,
    );
  }

  const issueSort = (a, b) => compareStrings(a.path ?? '', b.path ?? '')
    || compareStrings(a.message ?? '', b.message ?? '');
  const errors = [...index.errors].sort(issueSort).map(issueItem);
  const warnings = [...index.warnings].sort(issueSort).map(issueItem);

  const context = {
    schema: AGENT_CONTEXT_SCHEMA,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    scope: {
      roots: options.roots?.length ? [...options.roots] : null,
      types: options.types?.length ? [...options.types] : null,
      ...(options.sections ? { sections: [...sections] } : {}),
    },
    statusVocabulary: vocabulary,
    counts: {
      documents: index.docs.length,
      byStatus: { ...index.countsByStatus },
      byType: Object.fromEntries(Object.entries(index.countsByType).map(([type, counts]) => [type, { ...counts }])),
      errors: index.errors.length,
      warnings: index.warnings.length,
    },
    prompts: {
      actionable: docCollection(prompts, LIMITS.prompts, config),
      next: prompts[0] ? compactDoc(prompts[0], config) : null,
    },
    plans: {
      focus: docCollection(focus, LIMITS.plans, config),
      listed: docCollection(listed, LIMITS.plans, config),
      stale: docCollection(stale, LIMITS.plans, config),
      hubs: docCollection(hubs, LIMITS.hubs, config),
    },
    issues: {
      errors: boundedCollection(errors, LIMITS.issues),
      warnings: boundedCollection(warnings, LIMITS.issues),
    },
    ...(options.skippedHooks?.length ? {
      validationPreview: { status: 'built-in-only', skippedHooks: [...options.skippedHooks] },
    } : {}),
  };
  for (const section of AGENT_CONTEXT_SECTIONS) if (!sections.includes(section)) delete context[section];
  return enforceByteBudget(context, maxBytes);
}
