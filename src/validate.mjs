import { existsSync } from 'node:fs';
import path from 'node:path';
import { asString } from './util.mjs';
import { getGitLastModified } from './git.mjs';
import { toRepoPath } from './util.mjs';

const NOW = new Date();

export function validateDoc(doc, frontmatter, headingTitle, config) {
  if (!doc.status) {
    doc.errors.push({ path: doc.path, level: 'error', message: 'Missing frontmatter `status`.' });
  } else if (!config.validStatuses.has(doc.status)) {
    doc.errors.push({ path: doc.path, level: 'error', message: `Invalid status \`${doc.status}\`.` });
  }

  if (!config.lifecycle.skipWarningsFor.has(doc.status) && !doc.updated) {
    doc.errors.push({ path: doc.path, level: 'error', message: 'Missing frontmatter `updated` for non-archived doc.' });
  }

  if (doc.auditLevel && doc.auditLevel !== 'none' && !doc.audited) {
    doc.errors.push({ path: doc.path, level: 'error', message: '`audit_level` is set without `audited`.' });
  }

  if (doc.auditLevel === 'none' && doc.audited) {
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

  if (['active', 'ready', 'planned', 'blocked'].includes(doc.status) && !asString(frontmatter.current_state)) {
    doc.warnings.push({ path: doc.path, level: 'warning', message: 'Missing `current_state`; index output is using a fallback or placeholder.' });
  }

  if (['active', 'ready', 'planned'].includes(doc.status) && !asString(frontmatter.next_step)) {
    doc.warnings.push({ path: doc.path, level: 'warning', message: 'Missing `next_step`; command output will omit a clear immediate action.' });
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
  for (const doc of docs) {
    if (config.lifecycle.skipStaleFor.has(doc.status)) continue;
    if (!doc.updated) continue;

    const gitDate = getGitLastModified(doc.path, config.repoRoot);
    if (!gitDate) continue;

    const gitDay = Math.floor(new Date(gitDate).getTime() / 86400000);
    const fmDay = Math.floor(new Date(doc.updated).getTime() / 86400000);

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
