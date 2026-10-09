import { referenceValues } from './reference-values.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { extractFirstHeading, extractSummary, extractStatusSnapshot, extractNextStep, extractChecklistCounts, extractBodyLinks } from './extractors.mjs';
import { asString, normalizeStringList, normalizeBlockers, mergeUniqueStrings, toRepoPath, warn, die, resolveDocPath, suggestCandidates } from './util.mjs';
import { findLexicalDocsRoot } from './managed-path.mjs';
import { openParseCache, fileStamp, stampSize } from './parse-cache.mjs';
import { validateDoc, validatePlanShape, validateDocShape, checkBidirectionalReferences, checkGitStaleness, checkRunlistBackPointers, checkCoordinationHubExecutionMode, checkRoadmapHubExecutionMode, computeDaysSinceUpdate, computeIsStale, computeChecklistCompletionRate, enrichRefErrorSuggestions } from './validate.mjs';
import { checkIndex } from './index-file.mjs';
import { checkClaudeCommands } from './claude-commands.mjs';
import { checkGlossaryConfig } from './glossary-check.mjs';
import { checkSkillDrift } from './skill-drift.mjs';
import { checkHubStatusDrift } from './sync-status.mjs';
import { checkHubMembershipDrift } from './hub-membership.mjs';
import {parseNativeRecord} from './native-record.mjs';
import { readShipsFrontmatter } from './stages.mjs';

// `fast: true` skips every pass that produces warnings/errors — the rendered
// index file consumes only status/title/snapshot/etc., not the validation
// output. Use it from `regenIndex` (post-mutation index refresh) where
// validation has already run elsewhere (or will, next time the user runs
// `runlist check`). Saves the full-repo `git log` scan in `checkGitStaleness`
// plus the bidirectional ref walk + claude-commands check.
//
// `errorsOnly: true` runs every built-in error-producing pass (per-file
// `validateDoc`, `checkIndex`) but skips the warning-only cross-doc
// passes (bidirectional refs, runlist back-pointers, git staleness, claude
// commands). Use it from `runlist hud` — the SessionStart hook only renders the
// error COUNT, so the warning-only passes are pure overhead there. Preserves
// the built-in invariant that HUD's error count matches `runlist check`.
export function buildIndex(config, opts = {}) {
  const { fast = false, errorsOnly = false, autoHealIndex = false } = opts;
  const invokeHooks = opts.invokeHooks ?? !config._execution?.suppressSideEffects;
  const gitStaleness = opts.gitStaleness ?? config._execution?.gitStaleness ?? true;
  const skipWarningOnlyChecks = fast || errorsOnly;
  const cache = openParseCache(config);
  const scanFailures = [];
  const docs = collectDocFiles(config, { onError: (directory, err) => {
    scanFailures.push({ path: null, level: 'error', message: `Could not read scan directory ${toRepoPath(directory, config.repoRoot)}: ${err.message}`, meta: { kind: 'scan-failure' } });
  } }).flatMap(f => {
    try { return [parseDocFile(f, config, { fast, cache })]; }
    catch (err) {
      if (err.code !== 'ENOENT') throw err;
      scanFailures.push({ path: toRepoPath(f, config.repoRoot), level: 'warning', message: 'Document disappeared after discovery; it was not checked.', meta: { kind: 'scan-disappeared' } });
      return [];
    }
  });
  if (cache && !config._execution?.suppressSideEffects) cache.save();
  if (!fast) {
    // Per-file validation (validateDoc) ran during parse without sibling
    // visibility. Now that the full index is materialized, enrich
    // unresolved-ref entries with "Did you mean..." candidates drawn from the
    // index — mutates doc.errors/doc.warnings in place so the aggregations
    // below pick up the enriched messages.
    enrichRefErrorSuggestions(docs, config);
  }
  const warnings = scanFailures.filter(f => f.level === 'warning');
  const errors = scanFailures.filter(f => f.level === 'error');

  for (const doc of docs) {
    warnings.push(...doc.warnings);
    errors.push(...doc.errors);
  }

  if (!fast && invokeHooks && config.hooks.validate) {
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
        const hookError = { path: doc.path, level: 'error', message: `Hook 'validate' threw: ${err.message}`, meta: { kind: 'hook-failure' } };
        scanFailures.push(hookError);
        doc.errors.push(hookError);
        errors.push(hookError);
      }
    }
  }

  const transformedDocs = invokeHooks && config.hooks.transformDoc
    ? docs.map(d => {
        try { return config.hooks.transformDoc(d) ?? d; }
        catch (err) {
          const failure = { path: d.path, level: 'warning', message: `Hook 'transformDoc' threw: ${err.message}`, meta: { kind: 'hook-failure' } };
          warnings.push(failure);
          scanFailures.push(failure);
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

  // Per-type counts (F6): same input docs, keyed by `type` first so callers
  // can distinguish `plan/partial` (work shipped + tail deferred) from
  // `doc/partial` (incomplete reference material). Untyped docs (pre-0.30
  // corpora) land under `unknown` rather than getting dropped silently.
  const countsByType = {};
  for (const doc of transformedDocs) {
    if (!doc.status) continue;
    const type = doc.type || 'unknown';
    if (!countsByType[type]) countsByType[type] = {};
    countsByType[type][doc.status] = (countsByType[type][doc.status] ?? 0) + 1;
  }

  if (!fast && config.indexPath) {
    // `autoHealIndex` is opt-in from the caller (currently `runlist check`).
    // When true, drift triggers an in-place rewrite and a
    // warning instead of the old "Run `runlist index`" error — closing the
    // class of nags produced by mutation paths that skip `regenIndex`
    // (`lint --fix`, direct file edits, etc). `transformedDocs` here is
    // always the canonical full set; CLI-level `--root`/`--type` filtering
    // runs after `buildIndex` returns, so a rewrite is safe. Off by default
    // so dry-run / print modes never mutate disk as a side effect.
    const indexCheck = checkIndex(transformedDocs, config, {
      autoHeal: autoHealIndex && scanFailures.length === 0,
      rebuildDocs: autoHealIndex ? () => buildIndex(config, { fast: true }).docs : null,
      testHooks: opts.testHooks,
    });
    warnings.push(...indexCheck.warnings);
    errors.push(...indexCheck.errors);
  }

  // Hub status drift produces ERRORS (a drifted marked span), so it runs in
  // errorsOnly mode too — that's what keeps `runlist hud`'s error count equal to
  // `runlist check`'s. Its warnings still obey the warning-only gate.
  if (!fast) {
    const hubStatus = checkHubStatusDrift(transformedDocs, config);
    errors.push(...hubStatus.errors);
    if (!skipWarningOnlyChecks) warnings.push(...hubStatus.warnings);
    for (const entry of [...hubStatus.errors, ...(skipWarningOnlyChecks ? [] : hubStatus.warnings)]) {
      const hub = transformedDocs.find(d => d.path === entry.path);
      if (!hub) continue;
      (entry.level === 'error' ? hub.errors : hub.warnings).push(entry);
    }
  }

  if (!skipWarningOnlyChecks) {
    const refCheck = checkBidirectionalReferences(transformedDocs, config);
    warnings.push(...refCheck.warnings);

    const runlistWarnings = checkRunlistBackPointers(transformedDocs, config);
    warnings.push(...runlistWarnings);
    for (const w of runlistWarnings) {
      const child = transformedDocs.find(d => d.path === w.path);
      if (child) child.warnings.push(w);
    }

    const membershipWarnings = checkHubMembershipDrift(transformedDocs, config);
    warnings.push(...membershipWarnings);
    for (const w of membershipWarnings) {
      const owner = transformedDocs.find(d => d.path === w.path);
      if (owner) owner.warnings.push(w);
    }

    const coordHubWarnings = checkCoordinationHubExecutionMode(transformedDocs, config);
    warnings.push(...coordHubWarnings);
    for (const w of coordHubWarnings) {
      const hub = transformedDocs.find(d => d.path === w.path);
      if (hub) hub.warnings.push(w);
    }

    const roadmapHubWarnings = checkRoadmapHubExecutionMode(transformedDocs, config);
    warnings.push(...roadmapHubWarnings);
    for (const w of roadmapHubWarnings) {
      const hub = transformedDocs.find(d => d.path === w.path);
      if (hub) hub.warnings.push(w);
    }

    if (gitStaleness) {
      const gitWarnings = checkGitStaleness(transformedDocs, config, opts.gitMetadataOptions);
      warnings.push(...gitWarnings);
    }

    const claudeWarnings = checkClaudeCommands(config.repoRoot);
    warnings.push(...claudeWarnings);

    const glossaryWarnings = checkGlossaryConfig(config);
    warnings.push(...glossaryWarnings);

    const skillDriftWarnings = checkSkillDrift(config);
    warnings.push(...skillDriftWarnings);
  }

  return {
    generatedAt: new Date().toISOString(),
    docs: transformedDocs,
    countsByStatus,
    countsByType,
    warnings,
    errors,
    scanCoverage: { complete: scanFailures.length === 0, failures: scanFailures },
  };
}

export function collectDocFiles(config, { onError = null } = {}) {
  const files = [];
  const skipPaths = new Set();
  if (config.indexPath) skipPaths.add(config.indexPath);
  const roots = config.docsRoots || [config.docsRoot];
  const seen = new Set();
  for (const root of roots) {
    walkMarkdownFiles(root, files, config.excludeDirs, skipPaths, seen, onError);
  }
  return files.sort((a, b) => a.localeCompare(b));
}

// Shared resolver for CLI file arguments — the single path every file-taking
// verb (`use`, `set`, `archive`, `touch`, `rename`, …) funnels through so
// bare slugs behave identically everywhere. Tries, in order: exact path
// (the resolveDocPath fast path), `<input>.md`, then a unique basename match
// across all doc roots. An ambiguous basename dies listing the candidates
// rather than guessing — a wrong auto-resolved mutation is worse than a
// retry. A full miss dies with did-you-mean suggestions drawn from the doc
// corpus; pass { dieOnMiss: false } to get null instead and keep a custom
// fallback at the call site.
export function resolveDocArg(input, config, { dieOnMiss = true } = {}) {
  if (!input) return null;
  const direct = resolveDocPath(input, config);
  if (direct) return direct;
  if (!input.endsWith('.md')) {
    const withExt = resolveDocPath(input + '.md', config);
    if (withExt) return withExt;
  }

  const slug = input.replace(/\.md$/, '');
  const files = collectDocFiles(config);
  const byBasename = files.filter(f => path.basename(f, '.md') === slug);
  if (byBasename.length === 1) return byBasename[0];
  if (byBasename.length > 1) {
    die(`Multiple docs match "${input}" by basename:\n${byBasename.map(f => '  ' + toRepoPath(f, config.repoRoot)).join('\n')}`);
  }

  if (!dieOnMiss) return null;
  die(docArgMissMessage(input, config, files));
}

// `File not found` + the searched roots + up-to-3 did-you-mean candidates
// matched on basename and printed as repo-relative paths. Exported so verbs
// with their own resolution (e.g. interactive pickers) can reuse the message.
export function docArgMissMessage(input, config, files = collectDocFiles(config)) {
  const roots = config.docsRoots || [config.docsRoot];
  const searched = [toRepoPath(config.repoRoot, config.repoRoot) || '.', ...roots.map(r => toRepoPath(r, config.repoRoot))].join(', ');
  const slug = String(input).split('/').pop().replace(/\.md$/, '');
  const pathsByBase = new Map();
  for (const f of files) {
    const base = path.basename(f, '.md');
    if (!pathsByBase.has(base)) pathsByBase.set(base, toRepoPath(f, config.repoRoot));
  }
  const hits = suggestCandidates(slug, [...pathsByBase.keys()]);
  let msg = `File not found: ${input}\nSearched: ${searched}`;
  if (hits.length) msg += `\nDid you mean: ${hits.map(b => pathsByBase.get(b)).join(', ')}?`;
  return msg;
}

function walkMarkdownFiles(directory, files, excludedDirs, skipPaths, seen = new Set(), onError = null) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (err) {
    onError?.(directory, err);
    warn(`Could not read directory ${directory}: ${err.message}`);
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (excludedDirs && excludedDirs.has(entry.name)) continue;
      walkMarkdownFiles(path.join(directory, entry.name), files, excludedDirs, skipPaths, seen, onError);
      continue;
    }
    const fullPath = path.join(directory, entry.name);
    if (!entry.isFile() || !entry.name.endsWith('.md') || skipPaths.has(fullPath) || seen.has(fullPath)) continue;
    seen.add(fullPath);
    files.push(fullPath);
  }
}

// Everything parseDocFile takes from the file's text alone, with no config and
// no clock, which is what the parse cache may keep.
function extractDocText(frontmatter, body) {
  const fmWarnings = [];
  const parsedFrontmatter = parseSimpleFrontmatter(frontmatter, fmWarnings);
  if (Object.hasOwn(parsedFrontmatter, 'ships')) parsedFrontmatter.ships = readShipsFrontmatter(frontmatter);
  return {
    shipsMetadataVersion: 1,
    parsedFrontmatter,
    fmWarnings: fmWarnings.map(w => ({ message: w.message })),
    headingTitle: extractFirstHeading(body),
    bodySummary: extractSummary(body),
    bodyStatusSnapshot: extractStatusSnapshot(body),
    bodyNextStep: extractNextStep(body),
    checklist: extractChecklistCounts(body),
    bodyLinks: extractBodyLinks(body),
    hasCloseout: /^##\s+Closeout/m.test(body),
  };
}

export function parseDocFile(filePath, config, opts = {}) {
  const { fast = false, cache = null } = opts;
  const relativePath = toRepoPath(filePath, config.repoRoot);
  const stamp = cache && opts.source === undefined ? fileStamp(filePath) : null;
  let text = stamp ? cache.get(relativePath, stamp) : null;
  // Older cache entries cannot distinguish blank ships from an empty YAML list.
  if (text && text.shipsMetadataVersion !== 1) text = null;
  // Validation reads the body itself, so only a fast build can skip the read.
  let body = null;
  let rawSource = null;
  if (!text || !fast) {
    const raw = opts.source ?? readFileSync(filePath, 'utf8');
    rawSource = raw;
    const extracted = extractFrontmatter(raw);
    body = extracted.body;
    // A file rewritten between the stat and the read no longer matches its stamp.
    if (text && Buffer.byteLength(raw) !== stampSize(stamp)) text = null;
    if (!text) {
      text = extractDocText(extracted.frontmatter, body);
      if (stamp) cache.set(relativePath, stamp, text);
    }
  }
  const { parsedFrontmatter, fmWarnings, headingTitle, checklist, bodyLinks, hasCloseout } = text;
  const nativeTitle = parsedFrontmatter.record_schema==='runlist.record/v1' ? asString(parsedFrontmatter.finding)??asString(parsedFrontmatter.question) : null;
  const title = nativeTitle ?? asString(parsedFrontmatter.title) ?? headingTitle ?? path.basename(filePath, '.md');
  const summary = asString(parsedFrontmatter.summary) ?? text.bodySummary ?? null;
  // For terminal-status docs (archived / reference / deprecated by default),
  // skip the body-scrape and the "No current_state set" fallback when the user
  // didn't set `current_state:` in frontmatter explicitly. Body text on a
  // settled doc often contains stale "in progress" / "FIXED (uncommitted)"
  // snapshots from when the doc was live; surfacing those in the index lies
  // about current state. Frontmatter still wins if explicit — the audit's
  // criterion: "should defer to frontmatter when status is terminal."
  const fmCurrentState = asString(parsedFrontmatter.current_state);
  const docStatus = asString(parsedFrontmatter.status);
  const isTerminalDoc = docStatus && (config.lifecycle?.isTerminal?.(docStatus, asString(parsedFrontmatter.type) ?? null)
    ?? config.lifecycle?.terminalStatuses?.has?.(docStatus));
  // Track where currentState came from so renderers can prefix `(auto)` on
  // body-scraped values. Frontmatter wins silently; body-scraped values flag
  // their origin so the user knows the string was inferred (and that adding
  // `current_state:` to frontmatter would override). The placeholder
  // `'No current_state set'` is neither — origin stays null.
  let currentState;
  let currentStateOrigin = null;
  if (fmCurrentState) {
    currentState = fmCurrentState;
    currentStateOrigin = 'frontmatter';
  } else if (isTerminalDoc) {
    currentState = null;
  } else {
    const scraped = text.bodyStatusSnapshot;
    if (scraped) {
      currentState = scraped;
      currentStateOrigin = 'body';
    } else {
      currentState = 'No current_state set';
    }
  }
  const nextStep = asString(parsedFrontmatter.next_step) ?? text.bodyNextStep ?? null;
  // `blocked_by` is accepted as an alias for `blockers` since 0.39.3 — agents
  // filing tickets naturally reach for the JIRA/Linear name. If both are set,
  // they're merged (de-duped via normalizeBlockers → mergeUniqueStrings).
  const blockers = mergeUniqueStrings(
    normalizeBlockers(parsedFrontmatter.blockers),
    normalizeBlockers(parsedFrontmatter.blocked_by),
  );
  const surface = asString(parsedFrontmatter.surface) ?? null;
  const surfaces = normalizeStringList(parsedFrontmatter.surfaces);
  const moduleName = asString(parsedFrontmatter.module) ?? null;
  const modules = normalizeStringList(parsedFrontmatter.modules);
  const domain = asString(parsedFrontmatter.domain) ?? null;
  const audience = asString(parsedFrontmatter.audience) ?? null;
  const executionMode = asString(parsedFrontmatter.execution_mode) ?? null;

  // Dynamic reference field extraction. A leading `>` on a value (e.g.
  // `"> docs/audit-example-project.md"`) marks that single ref as one-way —
  // the prefix is stripped so path resolution still works, and the direction
  // is recorded on a parallel `refFieldDirections[field]` array indexed the
  // same as `refFields[field]`. Bidirectional reciprocity checks consume the
  // directions to skip outbound entries that opted out of expecting a back-ref.
  const refFields = {};
  const refFieldDirections = {};
  for (const field of [...(config.referenceFields.bidirectional || []), ...(config.referenceFields.unidirectional || [])]) {
    const { paths, directions } = referenceValues(parsedFrontmatter[field]);
    refFields[field] = paths;
    refFieldDirections[field] = directions;
  }

  // Tag doc with its root
  const docRoot = findLexicalDocsRoot(filePath, config) ?? config.docsRoot;
  const rootLabel = path.relative(config.repoRoot, docRoot).split(path.sep).join('/');

  const docType = asString(parsedFrontmatter.type) ?? null;

  const doc = {
    path: relativePath,
    root: rootLabel,
    type: docType,
    status: asString(parsedFrontmatter.status) ?? null,
    // Preserve ships without coercing lists/objects into apparently valid stages.
    ships: parsedFrontmatter.ships ?? null,
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
    currentStateOrigin,
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
    refFieldDirections,
    checklistCompletionRate: computeChecklistCompletionRate(checklist),
    hasCloseout,
    hasNextStep: Boolean(nextStep),
    hasBlockers: blockers.length > 0,
    daysSinceUpdate: computeDaysSinceUpdate(asString(parsedFrontmatter.updated) ?? null),
    isStale: computeIsStale(asString(parsedFrontmatter.status), asString(parsedFrontmatter.updated) ?? null, config, docType),
    warnings: [],
    errors: [],
  };

  for (const w of fmWarnings) {
    doc.warnings.push({ path: relativePath, level: 'warning', message: w.message });
  }

  if (!fast) {
    if(parsedFrontmatter.record_schema!==undefined&&['flag','decision'].includes(doc.type)){
      const native=parseNativeRecord(rawSource);
      doc.errors.push(...native.diagnostics.map(d=>({path:relativePath,level:'error',message:`${d.path}: ${d.message}`})));
      return doc;
    }
    validateDoc(doc, parsedFrontmatter, headingTitle, config);
    validatePlanShape(doc, body, parsedFrontmatter, config);
    validateDocShape(doc, body, parsedFrontmatter, config);
  }
  return doc;
}
