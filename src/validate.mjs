import { existsSync } from 'node:fs';
import path from 'node:path';
import { asString } from './util.mjs';
import { getGitLastModified, getGitLastModifiedBatch } from './git.mjs';
import { toRepoPath } from './util.mjs';

const NOW = new Date();

function isValidStatus(status, root, config, type) {
  // Union type-specific + root-specific statuses (a doc can satisfy either)
  if (type) {
    const typeSet = config.typeStatuses?.get(type);
    if (typeSet && typeSet.has(status)) return true;
  }
  const rootSet = config.rootValidStatuses?.get(root);
  if (rootSet) return rootSet.has(status);
  return config.validStatuses.has(status);
}

export function validateDoc(doc, frontmatter, headingTitle, config) {
  // Validate type field
  if (doc.type && config.validTypes && !config.validTypes.has(doc.type)) {
    doc.warnings.push({ path: doc.path, level: 'warning', message: `Unknown type \`${doc.type}\`; expected one of: ${[...config.validTypes].join(', ')}.` });
  }

  if (!doc.status) {
    doc.errors.push({ path: doc.path, level: 'error', message: 'Missing frontmatter `status`.' });
  } else if (!isValidStatus(doc.status, doc.root, config, doc.type)) {
    const typeSet = doc.type && config.typeStatuses?.get(doc.type);
    const rootSet = config.rootValidStatuses?.get(doc.root);
    const combined = new Set([...(typeSet ?? []), ...(rootSet ?? config.validStatuses)]);
    const hint = `valid: ${[...combined].join(', ')}`;
    doc.warnings.push({ path: doc.path, level: 'warning', message: `Unknown status \`${doc.status}\`; ${hint}.` });
  }

  const knownStatus = isValidStatus(doc.status, doc.root, config, doc.type);

  if (knownStatus && !config.lifecycle.skipWarningsFor.has(doc.status) && !doc.updated) {
    doc.errors.push({ path: doc.path, level: 'error', message: 'Missing frontmatter `updated` for non-archived doc.' });
  }

  if (knownStatus && doc.auditLevel && doc.auditLevel !== 'none' && !doc.audited) {
    doc.errors.push({ path: doc.path, level: 'error', message: '`audit_level` is set without `audited`.' });
  }

  if (knownStatus && doc.auditLevel === 'none' && doc.audited) {
    doc.errors.push({ path: doc.path, level: 'error', message: '`audit_level: none` cannot be combined with `audited`.' });
  }

  if (Object.prototype.hasOwnProperty.call(frontmatter, 'blockers') && !Array.isArray(frontmatter.blockers)) {
    doc.errors.push({ path: doc.path, level: 'error', message: '`blockers` must be a YAML list when present.' });
  }

  if (Object.prototype.hasOwnProperty.call(frontmatter, 'surfaces') && !Array.isArray(frontmatter.surfaces)) {
    doc.errors.push({ path: doc.path, level: 'error', message: '`surfaces` must be a YAML list when present.' });
  }

  if (Object.prototype.hasOwnProperty.call(frontmatter, 'modules') && !Array.isArray(frontmatter.modules)) {
    doc.errors.push({ path: doc.path, level: 'error', message: '`modules` must be a YAML list when present.' });
  }

  if (config.moduleRequiredStatuses.has(doc.status) && !doc.module) {
    doc.errors.push({ path: doc.path, level: 'error', message: '`module` is required for active/ready/planned/blocked docs; use a real module, `platform`, or `none`.' });
  }

  if (config.validSurfaces) {
    for (const surface of doc.surfaces) {
      if (!config.validSurfaces.has(surface)) {
        doc.warnings.push({ path: doc.path, level: 'warning', message: `Unknown surface \`${surface}\`; expected a known surface taxonomy value.` });
      }
    }
  }

  if (!headingTitle && !asString(frontmatter.title)) {
    doc.warnings.push({ path: doc.path, level: 'warning', message: 'Missing `title` and no H1 found for fallback.' });
  }

  if (!config.lifecycle.skipWarningsFor.has(doc.status) && !asString(frontmatter.summary) && !doc.summary) {
    doc.warnings.push({ path: doc.path, level: 'warning', message: 'Missing `summary` and no blockquote fallback found.' });
  }

  // Determine which statuses should have current_state and next_step (plans only, not docs/research)
  const isPlanWork = knownStatus && doc.status && (!doc.type || doc.type === 'plan')
    && !config.lifecycle.terminalStatuses.has(doc.status) && !config.lifecycle.skipWarningsFor.has(doc.status);

  if (isPlanWork && !asString(frontmatter.current_state)) {
    doc.warnings.push({ path: doc.path, level: 'warning', message: 'Missing `current_state`; index output is using a fallback or placeholder.' });
  }

  if (isPlanWork && doc.status !== 'blocked' && !asString(frontmatter.next_step)) {
    doc.warnings.push({ path: doc.path, level: 'warning', message: 'Missing `next_step`; command output will omit a clear immediate action.' });
  }

  // Archived plans must have a ## Closeout section
  if (config.lifecycle.archiveStatuses.has(doc.status) && doc.type === 'plan' && !doc.hasCloseout) {
    doc.warnings.push({ path: doc.path, level: 'warning', message: 'Archived plan missing `## Closeout` section.' });
  }

  // Validate reference fields resolve to existing files
  const docDir = path.dirname(path.join(config.repoRoot, doc.path));
  const allRefFields = [...(config.referenceFields.bidirectional || []), ...(config.referenceFields.unidirectional || [])];
  for (const field of allRefFields) {
    for (const relPath of (doc.refFields[field] || [])) {
      const resolved = path.resolve(docDir, relPath);
      if (!existsSync(resolved)) {
        doc.errors.push({ path: doc.path, level: 'error', message: `${field} entry \`${relPath}\` does not resolve to an existing file.` });
      }
    }
  }

  // Validate body links resolve to existing files
  for (const link of (doc.bodyLinks || [])) {
    const resolved = path.resolve(docDir, link.href);
    if (!existsSync(resolved)) {
      doc.warnings.push({ path: doc.path, level: 'warning', message: `body link \`${link.href}\` does not resolve to an existing file.` });
    }
  }
}

export function checkBidirectionalReferences(docs, config) {
  const warnings = [];
  const biFields = config.referenceFields.bidirectional || [];
  if (!biFields.length) return { warnings, errors: [] };

  const refMap = new Map();
  for (const doc of docs) {
    const docDir = path.dirname(path.join(config.repoRoot, doc.path));
    const refs = new Set();
    for (const field of biFields) {
      for (const relPath of (doc.refFields[field] || [])) {
        const resolved = path.resolve(docDir, relPath);
        refs.add(toRepoPath(resolved, config.repoRoot));
      }
    }
    refMap.set(doc.path, refs);
  }

  for (const [docPath, refs] of refMap) {
    for (const targetPath of refs) {
      const targetRefs = refMap.get(targetPath);
      if (targetRefs && !targetRefs.has(docPath)) {
        warnings.push({ path: docPath, level: 'warning',
          message: `references \`${targetPath}\` in ${biFields.join('/')}, but that doc does not reference back.` });
      }
    }
  }

  return { warnings, errors: [] };
}

export function checkGitStaleness(docs, config) {
  const warnings = [];
  const gitDates = getGitLastModifiedBatch(config.repoRoot);
  for (const doc of docs) {
    if (config.lifecycle.skipStaleFor.has(doc.status)) continue;
    if (!doc.updated) continue;

    const gitDate = gitDates.get(doc.path) ?? null;
    if (!gitDate) continue;

    const gitDay = gitDate.slice(0, 10);
    const fmDay = doc.updated.slice(0, 10);

    if (gitDay > fmDay) {
      warnings.push({
        path: doc.path,
        level: 'warning',
        message: `frontmatter \`updated: ${doc.updated}\` is behind git history (last committed ${gitDate.slice(0, 10)}).`,
      });
    }
  }
  return warnings;
}

export function computeDaysSinceUpdate(updated) {
  if (!updated) return null;
  const parsed = new Date(updated);
  if (Number.isNaN(parsed.getTime())) return null;

  const diffMs = NOW.getTime() - parsed.getTime();
  if (diffMs < 0) return 0;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

export function computeIsStale(status, updated, config) {
  const staleAfterDays = config.staleDaysByStatus[status] ?? null;
  if (staleAfterDays == null) return false;

  const daysSinceUpdate = computeDaysSinceUpdate(updated);
  if (daysSinceUpdate == null) return false;
  return daysSinceUpdate > staleAfterDays;
}

export function computeChecklistCompletionRate(checklist) {
  if (!checklist.total) return null;
  return Number((checklist.completed / checklist.total).toFixed(4));
}
