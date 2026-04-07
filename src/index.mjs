import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { extractFirstHeading, extractSummary, extractStatusSnapshot, extractNextStep, extractChecklistCounts, extractBodyLinks } from './extractors.mjs';
import { asString, normalizeStringList, normalizeBlockers, mergeUniqueStrings, toRepoPath, warn } from './util.mjs';
import { validateDoc, checkBidirectionalReferences, checkGitStaleness, computeDaysSinceUpdate, computeIsStale, computeChecklistCompletionRate } from './validate.mjs';
import { checkIndex } from './index-file.mjs';
import { checkClaudeCommands } from './claude-commands.mjs';

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
      try {
        const result = config.hooks.validate(doc, ctx);
        if (result?.errors) {
          doc.errors.push(...result.errors);
          errors.push(...result.errors);
        }
        if (result?.warnings) {
          doc.warnings.push(...result.warnings);
          warnings.push(...result.warnings);
        }
      } catch (err) {
        const hookError = { path: doc.path, level: 'error', message: `Hook 'validate' threw: ${err.message}` };
        doc.errors.push(hookError);
        errors.push(hookError);
      }
    }
  }

  const transformedDocs = config.hooks.transformDoc
    ? docs.map(d => {
        try { return config.hooks.transformDoc(d) ?? d; }
        catch (err) {
          warnings.push({ path: d.path, level: 'warning', message: `Hook 'transformDoc' threw: ${err.message}` });
          return d;
        }
      })
    : docs;

  const countsByStatus = Object.fromEntries(config.statusOrder.map(status => [
    status,
    transformedDocs.filter(doc => doc.status === status).length,
  ]));
  const knownStatuses = new Set(config.statusOrder);
  for (const doc of transformedDocs) {
    if (doc.status && !knownStatuses.has(doc.status)) {
      countsByStatus[doc.status] = (countsByStatus[doc.status] ?? 0) + 1;
    }
  }

  if (config.indexPath) {
    const indexCheck = checkIndex(transformedDocs, config);
    warnings.push(...indexCheck.warnings);
    errors.push(...indexCheck.errors);
  }

  const refCheck = checkBidirectionalReferences(transformedDocs, config);
  warnings.push(...refCheck.warnings);

  const gitWarnings = checkGitStaleness(transformedDocs, config);
  warnings.push(...gitWarnings);

  const claudeWarnings = checkClaudeCommands(config.repoRoot);
  warnings.push(...claudeWarnings);

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
  const roots = config.docsRoots || [config.docsRoot];
  const seen = new Set();
  for (const root of roots) {
    walkMarkdownFiles(root, files, config.excludeDirs, skipPaths, seen);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

function walkMarkdownFiles(directory, files, excludedDirs, skipPaths, seen = new Set()) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (err) {
    warn(`Could not read directory ${directory}: ${err.message}`);
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (excludedDirs && excludedDirs.has(entry.name)) continue;
      walkMarkdownFiles(path.join(directory, entry.name), files, excludedDirs, skipPaths, seen);
      continue;
    }
    const fullPath = path.join(directory, entry.name);
    if (!entry.isFile() || !entry.name.endsWith('.md') || skipPaths.has(fullPath) || seen.has(fullPath)) continue;
    seen.add(fullPath);
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
  const bodyLinks = extractBodyLinks(body);
  const hasCloseout = /^##\s+Closeout/m.test(body);

  // Dynamic reference field extraction
  const refFields = {};
  for (const field of [...(config.referenceFields.bidirectional || []), ...(config.referenceFields.unidirectional || [])]) {
    refFields[field] = normalizeStringList(parsedFrontmatter[field]);
  }

  // Tag doc with its root
  const roots = config.docsRoots || [config.docsRoot];
  const docRoot = roots.find(r => filePath.startsWith(r + '/')) ?? config.docsRoot;
  const rootLabel = path.relative(config.repoRoot, docRoot).split(path.sep).join('/');

  const docType = asString(parsedFrontmatter.type) ?? null;

  const doc = {
    path: relativePath,
    root: rootLabel,
    type: docType,
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
    bodyLinks,
    refFields,
    checklistCompletionRate: computeChecklistCompletionRate(checklist),
    hasCloseout,
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
