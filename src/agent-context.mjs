import { isArchivedPath, truncate } from './util.mjs';
import { isCoordinationHub } from './runlist.mjs';
import {
  actionablePromptStatuses,
  comparePromptDocs,
  compareStrings,
  resolveStatusMetadata,
  statusMetadataFor,
} from './status-metadata.mjs';

export const AGENT_CONTEXT_SCHEMA = Object.freeze({ name: 'dotmd.agent-context', version: 1 });

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

function compactDoc(doc) {
  const blockers = (doc.blockers ?? []).map(item => truncate(String(item), 160));
  return {
    path: doc.path,
    title: truncate(doc.title ?? '', 160),
    status: doc.status,
    type: doc.type,
    nextStep: doc.nextStep ? truncate(doc.nextStep, 300) : null,
    blockers: boundedCollection(blockers, 3),
    daysSinceUpdate: doc.daysSinceUpdate ?? null,
  };
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

  return {
    schema: AGENT_CONTEXT_SCHEMA,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    scope: {
      roots: options.roots?.length ? [...options.roots] : null,
      types: options.types?.length ? [...options.types] : null,
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
      actionable: boundedCollection(prompts.map(compactDoc), LIMITS.prompts),
      next: prompts[0] ? compactDoc(prompts[0]) : null,
    },
    plans: {
      focus: boundedCollection(focus.map(compactDoc), LIMITS.plans),
      listed: boundedCollection(listed.map(compactDoc), LIMITS.plans),
      stale: boundedCollection(stale.map(compactDoc), LIMITS.plans),
      hubs: boundedCollection(hubs.map(compactDoc), LIMITS.hubs),
    },
    issues: {
      errors: boundedCollection(errors, LIMITS.issues),
      warnings: boundedCollection(warnings, LIMITS.issues),
    },
    ...(options.skippedHooks?.length ? {
      validationPreview: { status: 'built-in-only', skippedHooks: [...options.skippedHooks] },
    } : {}),
  };
}
