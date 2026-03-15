import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { extractFirstHeading, extractSummary, extractStatusSnapshot, extractNextStep, extractChecklistCounts } from './extractors.mjs';
import { asString, normalizeStringList, normalizeBlockers, mergeUniqueStrings, toRepoPath } from './util.mjs';
import { validateDoc, checkBidirectionalReferences, checkGitStaleness, computeDaysSinceUpdate, computeIsStale, computeChecklistCompletionRate } from './validate.mjs';
import { checkIndex } from './index-file.mjs';

export function buildIndex(config) {
  const docs = collectDocFiles(config).map(f => parseDocFile(f, config));
  const warnings = [];
  const errors = [];

  for (const doc of docs) {
    warnings.push(...doc.warnings);
    errors.push(...doc.errors);
  }

  if (config.hooks.validate) {
    const ctx = { config, allDocs: docs, repoRoot: config.repoRoot };
    for (const doc of docs) {
      const result = config.hooks.validate(doc, ctx);
      if (result?.errors) {
        doc.errors.push(...result.errors);
        errors.push(...result.errors);
      }
      if (result?.warnings) {
        doc.warnings.push(...result.warnings);
        warnings.push(...result.warnings);
      }
    }
  }

  const transformedDocs = config.hooks.transformDoc
    ? docs.map(d => config.hooks.transformDoc(d) ?? d)
    : docs;

  const countsByStatus = Object.fromEntries(config.statusOrder.map(status => [
    status,
    transformedDocs.filter(doc => doc.status === status).length,
  ]));

  if (config.indexPath) {
    const indexCheck = checkIndex(transformedDocs, config);
    warnings.push(...indexCheck.warnings);
    errors.push(...indexCheck.errors);
  }

  const refCheck = checkBidirectionalReferences(transformedDocs, config);
  warnings.push(...refCheck.warnings);

  const gitWarnings = checkGitStaleness(transformedDocs, config);
  warnings.push(...gitWarnings);

  return {
    generatedAt: new Date().toISOString(),
    docs: transformedDocs,
    countsByStatus,
    warnings,
    errors,
  };
}

export function collectDocFiles(config) {
  const files = [];
  const skipPaths = new Set();
  if (config.indexPath) skipPaths.add(config.indexPath);
  walkMarkdownFiles(config.docsRoot, files, config.excludeDirs, skipPaths);
  return files.sort((a, b) => a.localeCompare(b));
}

function walkMarkdownFiles(directory, files, excludedDirs, skipPaths) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (excludedDirs && excludedDirs.has(entry.name)) continue;
      walkMarkdownFiles(path.join(directory, entry.name), files, excludedDirs, skipPaths);
      continue;
    }
    const fullPath = path.join(directory, entry.name);
    if (!entry.isFile() || !entry.name.endsWith('.md') || skipPaths.has(fullPath)) continue;
    files.push(fullPath);
  }
}

export function parseDocFile(filePath, config) {
  const relativePath = toRepoPath(filePath, config.repoRoot);
  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter, body } = extractFrontmatter(raw);
  const parsedFrontmatter = parseSimpleFrontmatter(frontmatter);
  const headingTitle = extractFirstHeading(body);
  const title = asString(parsedFrontmatter.title) ?? headingTitle ?? path.basename(filePath, '.md');
  const summary = asString(parsedFrontmatter.summary) ?? extractSummary(body) ?? null;
  const currentState = asString(parsedFrontmatter.current_state) ?? extractStatusSnapshot(body) ?? 'No current_state set';
  const nextStep = asString(parsedFrontmatter.next_step) ?? extractNextStep(body) ?? null;
  const blockers = normalizeBlockers(parsedFrontmatter.blockers);
  const surface = asString(parsedFrontmatter.surface) ?? null;
  const surfaces = normalizeStringList(parsedFrontmatter.surfaces);
  const moduleName = asString(parsedFrontmatter.module) ?? null;
  const modules = normalizeStringList(parsedFrontmatter.modules);
  const domain = asString(parsedFrontmatter.domain) ?? null;
  const audience = asString(parsedFrontmatter.audience) ?? null;
  const executionMode = asString(parsedFrontmatter.execution_mode) ?? null;
  const checklist = extractChecklistCounts(body);

  // Dynamic reference field extraction
  const refFields = {};
  for (const field of [...(config.referenceFields.bidirectional || []), ...(config.referenceFields.unidirectional || [])]) {
    refFields[field] = normalizeStringList(parsedFrontmatter[field]);
  }

  const doc = {
    path: relativePath,
    status: asString(parsedFrontmatter.status) ?? null,
    owner: asString(parsedFrontmatter.owner) ?? null,
    surface,
    surfaces: mergeUniqueStrings(surface ? [surface] : [], surfaces),
    module: moduleName,
    modules: mergeUniqueStrings(moduleName ? [moduleName] : [], modules),
    domain,
    audience,
    executionMode,
    title,
    summary,
    currentState,
    nextStep,
    blockers,
    updated: asString(parsedFrontmatter.updated) ?? null,
    created: asString(parsedFrontmatter.created) ?? null,
    audited: asString(parsedFrontmatter.audited) ?? null,
    auditLevel: asString(parsedFrontmatter.audit_level) ?? null,
    sourceOfTruth: asString(parsedFrontmatter.source_of_truth) ?? null,
    checklist,
    refFields,
    checklistCompletionRate: computeChecklistCompletionRate(checklist),
    hasNextStep: Boolean(nextStep),
    hasBlockers: blockers.length > 0,
    daysSinceUpdate: computeDaysSinceUpdate(asString(parsedFrontmatter.updated) ?? null),
    isStale: computeIsStale(asString(parsedFrontmatter.status), asString(parsedFrontmatter.updated) ?? null, config),
    warnings: [],
    errors: [],
  };

  validateDoc(doc, parsedFrontmatter, headingTitle, config);
  return doc;
}
