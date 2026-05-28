import path from 'node:path';
import { asString, resolveRefPath, suggestCandidates } from './util.mjs';
import { getGitLastModified, getGitLastModifiedBatch } from './git.mjs';
import { toRepoPath } from './util.mjs';
import { readLeases, isLeaseStale, STALE_LEASE_AGE_HOURS } from './lease.mjs';

const NOW = new Date();

// Type-conventional dirs are the directories where `dotmd new <type>` lands
// live (non-archive) docs of that type. Built-ins use `dir` ('plans'/'prompts')
// and `targetRoot`. In flat-array root configs (e.g. root: ['docs/plans',
// 'docs/prompts']), the root itself is a type-conventional dir; in default
// single-root configs (root: 'docs'), the type-conventional dirs are
// '<root>/plans' and '<root>/prompts'. This helper builds the union so the
// archive-drift check works for both layouts. Custom user templates with
// their own `dir` would extend this; we hard-code the built-in dir names.
const BUILTIN_TYPE_DIR_NAMES = ['plans', 'prompts'];

function liveTypeDirsForRoots(config) {
  const set = new Set();
  const roots = config.docsRoots || (config.docsRoot ? [config.docsRoot] : []);
  for (const root of roots) {
    const rootRel = path.relative(config.repoRoot, root).split(path.sep).join('/');
    // The root itself is a live dir (covers flat-array layouts where the
    // root IS the type-container).
    set.add(rootRel);
    // Each builtin type-dir joined to the root (covers single-root layouts
    // where 'docs' contains 'docs/plans' and 'docs/prompts' subdirs).
    for (const dirName of BUILTIN_TYPE_DIR_NAMES) {
      // Skip if root already ends in this name (no double-nesting like
      // 'docs/prompts/prompts').
      if (path.basename(rootRel) === dirName) continue;
      set.add(rootRel ? `${rootRel}/${dirName}` : dirName);
    }
    // User template dirs from config (extend the set with whatever live
    // dirs custom types declare).
    for (const tmpl of Object.values(config.raw?.templates ?? {})) {
      if (!tmpl || typeof tmpl !== 'object') continue;
      if (tmpl.dir && path.basename(rootRel) !== tmpl.dir) {
        set.add(rootRel ? `${rootRel}/${tmpl.dir}` : tmpl.dir);
      }
    }
  }
  return set;
}

function isValidStatus(status, root, config, type) {
  // When a doc declares a known type, that type's status set is authoritative.
  // Falling through to the global union (across all types) would allow a
  // `type: prompt` doc to carry `status: active` just because `active` is valid
  // for plans — defeating the purpose of type-scoped vocabularies.
  if (type) {
    const typeSet = config.typeStatuses?.get(type);
    if (typeSet) return typeSet.has(status);
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
    // When the doc has a known type, scope the error hint to that type's vocab.
    // Otherwise fall back to root-specific or global validStatuses.
    const hint = typeSet
      ? `valid for type \`${doc.type}\`: ${[...typeSet].join(', ')}`
      : `valid: ${[...(rootSet ?? config.validStatuses)].join(', ')}`;
    doc.errors.push({ path: doc.path, level: 'error', message: `Unknown status \`${doc.status}\`; ${hint}.` });
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

  if (Object.prototype.hasOwnProperty.call(frontmatter, 'blocked_by') && !Array.isArray(frontmatter.blocked_by)) {
    doc.errors.push({ path: doc.path, level: 'error', message: '`blocked_by` must be a YAML list when present.' });
  }

  if (Object.prototype.hasOwnProperty.call(frontmatter, 'surfaces') && !Array.isArray(frontmatter.surfaces)) {
    doc.errors.push({ path: doc.path, level: 'error', message: '`surfaces` must be a YAML list when present.' });
  }

  if (Object.prototype.hasOwnProperty.call(frontmatter, 'modules') && !Array.isArray(frontmatter.modules)) {
    doc.errors.push({ path: doc.path, level: 'error', message: '`modules` must be a YAML list when present.' });
  }

  if (config.moduleRequiredStatuses.has(doc.status) && !doc.modules?.length) {
    doc.errors.push({ path: doc.path, level: 'error', message: '`modules` is required for active/ready/planned/blocked docs; use a real module, `platform`, or `none`.' });
  }

  if (config.validSurfaces && !config.lifecycle.skipWarningsFor.has(doc.status)) {
    for (const surface of doc.surfaces) {
      if (!config.validSurfaces.has(surface)) {
        doc.warnings.push({ path: doc.path, level: 'warning', message: `Unknown surface \`${surface}\`; expected a known surface taxonomy value.` });
      }
    }
  }

  // F18: Singular `module:` / `surface:` are deprecated in favor of plural arrays.
  // The reader still merges singular into plural transparently (back-compat),
  // but new usage should always go through the plural form. The migration
  // target is inlined in the message so `dotmd lint --fix` users see exactly
  // what they'll end up with — and so non-fix readers can hand-migrate.
  // Suppress for archived/terminal docs (same noise-control rule as F2).
  if (!config.lifecycle.skipWarningsFor.has(doc.status)) {
    for (const { singular, plural } of [{ singular: 'module', plural: 'modules' }, { singular: 'surface', plural: 'surfaces' }]) {
      const singularValue = frontmatter[singular];
      if (!singularValue) continue;
      const pluralValue = Array.isArray(frontmatter[plural]) ? frontmatter[plural] : [];
      const merged = [];
      for (const v of [singularValue, ...pluralValue]) {
        if (typeof v === 'string' && v && !merged.includes(v)) merged.push(v);
      }
      const target = `${plural}: [${merged.map(v => `"${v}"`).join(', ')}]`;
      doc.warnings.push({
        path: doc.path,
        level: 'warning',
        message: `\`${singular}:\` (singular) is deprecated — use \`${target}\`. Run \`dotmd lint --fix\` to migrate.`,
      });
    }
  }

  // Prompts are intentionally body-only one-shot artifacts: the slug names the
  // prompt, the body IS the payload. Forcing a `title` or blockquote `summary`
  // is friction the prompt format was designed around.
  const skipTitleSummary = doc.type === 'prompt';

  if (!skipTitleSummary && !headingTitle && !asString(frontmatter.title)) {
    doc.warnings.push({ path: doc.path, level: 'warning', message: 'Missing `title` and no H1 found for fallback.' });
  }

  if (!skipTitleSummary && !config.lifecycle.skipWarningsFor.has(doc.status) && !asString(frontmatter.summary) && !doc.summary) {
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

  // F11: `status: in-session` plans should have a matching live lease. If the
  // lease file has no entry, the previous session crashed without releasing;
  // if the entry is stale (> stale-threshold hours), the holder is gone.
  // Either way the validator is the only place that knows enough to suggest
  // the exact unstuck command, because the lease infrastructure is otherwise
  // invisible to `dotmd check`.
  if (doc.status === 'in-session' && !config.lifecycle.skipWarningsFor.has(doc.status)) {
    const leases = readLeases(config);
    const lease = leases[doc.path];
    if (!lease) {
      doc.warnings.push({
        path: doc.path,
        level: 'warning',
        message: `\`status: in-session\` but no active lease found (last session may have crashed without releasing). Run \`dotmd set active ${doc.path}\` to clear and re-queue.`,
      });
    } else if (isLeaseStale(lease)) {
      const ageHours = Math.floor((Date.now() - new Date(lease.pickedUpAt).getTime()) / (1000 * 60 * 60));
      doc.warnings.push({
        path: doc.path,
        level: 'warning',
        message: `\`status: in-session\` but lease is stale (last touched ${ageHours}h ago, >${STALE_LEASE_AGE_HOURS}h threshold). Run \`dotmd set active ${doc.path}\` to clear and re-queue.`,
      });
    }
  }

  // Archive drift: a doc with an archive-flagged status (`status: archived` by
  // default) whose parent dir is a "live" type-conventional location is
  // misplaced — `dotmd archive` would have moved it under `<that>/archiveDir/`.
  // Without this check, default `dotmd plans` / `dotmd prompts` views silently
  // drop the file (because they exclude archived paths), and the user gets no
  // signal it exists but is invisible. Nested intentional content (e.g.,
  // `docs/plans/audit/<file>.md`) is in a non-conventional subdir and exempt.
  if (config.lifecycle.archiveStatuses.has(doc.status)) {
    const parentDir = path.dirname(doc.path);
    const liveDirs = liveTypeDirsForRoots(config);
    if (liveDirs.has(parentDir)) {
      const expected = `${parentDir}/${config.archiveDir}/${path.basename(doc.path)}`;
      doc.errors.push({
        path: doc.path,
        level: 'error',
        message: `\`status: ${doc.status}\` but file is a direct child of \`${parentDir}/\`, not \`${parentDir}/${config.archiveDir}/\`. Run \`dotmd archive ${doc.path}\` to relocate to \`${expected}\`, or change the status.`,
      });
    }
  }

  // Validate reference fields resolve to existing files. Terminal statuses
  // (archived, deprecated, etc.) document historical state — their refs may
  // legitimately point at moved/deleted targets and shouldn't gate the
  // exit code with a hard error.
  const docDir = path.dirname(path.join(config.repoRoot, doc.path));
  const allRefFields = [...(config.referenceFields.bidirectional || []), ...(config.referenceFields.unidirectional || [])];
  const skipRefValidation = config.lifecycle.terminalStatuses.has(doc.status)
    || config.lifecycle.skipWarningsFor.has(doc.status);
  if (!skipRefValidation) {
    for (const field of allRefFields) {
      for (const relPath of (doc.refFields[field] || [])) {
        if (!resolveRefPath(relPath, docDir, config.repoRoot)) {
          doc.errors.push({
            path: doc.path,
            level: 'error',
            message: `${field} entry \`${relPath}\` does not resolve to an existing file.`,
            meta: { kind: 'ref-resolution', field, relPath },
          });
        }
      }
    }

    // Validate body links resolve to existing files
    for (const link of (doc.bodyLinks || [])) {
      if (!resolveRefPath(link.href, docDir, config.repoRoot)) {
        doc.warnings.push({
          path: doc.path,
          level: 'warning',
          message: `body link \`${link.href}\` does not resolve to an existing file.`,
          meta: { kind: 'ref-resolution', field: 'body-link', relPath: link.href },
        });
      }
    }
  }
}

// Guess which doc type a ref field expects so suggestions don't propose
// nonsense (a `related_plans` ref shouldn't suggest doc filenames). Heuristic:
// match common substrings in the field name. When ambiguous, return null so
// the caller suggests across all types.
function inferRefFieldType(field) {
  if (!field) return null;
  const f = field.toLowerCase();
  if (f.includes('plan')) return 'plan';
  if (f.includes('doc')) return 'doc';
  if (f.includes('prompt')) return 'prompt';
  if (f.includes('research')) return 'research';
  return null;
}

function candidatePathsForType(docs, type) {
  // When the field implies a type, exclude docs that explicitly declare a
  // different type. Untyped docs (no frontmatter `type:`) are kept — we
  // don't know they aren't the target, so suggesting them is still useful.
  const matches = type ? docs.filter(d => !d.type || d.type === type) : docs;
  // Suggest by basename (the friendly handle agents/humans actually type) and
  // by repo-relative path (covers cases where multiple files share a basename
  // and the disambiguator is the directory).
  const out = new Set();
  for (const d of matches) {
    out.add(path.basename(d.path));
    out.add(d.path);
  }
  return [...out];
}

// Post-pass enrichment: walk every doc's errors/warnings for unresolved-ref
// entries and append `Did you mean: a, b, c?` using the full index. Runs
// after parsing so it has the global doc list (validateDoc runs per-file and
// can't see siblings). Filters candidates by ref-field type when the field
// name implies one (e.g. `related_plans` → plans only).
export function enrichRefErrorSuggestions(docs, config) {
  const enrich = (entry) => {
    if (!entry?.meta || entry.meta.kind !== 'ref-resolution') return;
    if (entry._suggested) return;
    const inferred = inferRefFieldType(entry.meta.field);
    const candidates = candidatePathsForType(docs, inferred);
    const suggestions = suggestCandidates(path.basename(entry.meta.relPath), candidates);
    entry._suggested = true;
    if (suggestions.length === 0) return;
    entry.message = `${entry.message} Did you mean: ${suggestions.join(', ')}?`;
  };

  for (const doc of docs) {
    for (const e of (doc.errors || [])) enrich(e);
    for (const w of (doc.warnings || [])) enrich(w);
  }
}

export function checkBidirectionalReferences(docs, config) {
  const warnings = [];
  const biFields = config.referenceFields.bidirectional || [];
  if (!biFields.length) return { warnings, errors: [] };

  // refMap stores `Set<targetPath>` keyed by the source doc path — used to
  // answer "does B reference A?" via .has(). oneWayMap stores the subset of A's
  // outbound refs that opted out of expecting a back-ref (via the `>` prefix in
  // frontmatter, parsed in src/index.mjs:parseDocFile). We split these so the
  // membership check stays cheap (Set.has) while the per-ref directionality
  // filter only consults oneWayMap when iterating outbound edges.
  const refMap = new Map();
  const oneWayMap = new Map();
  for (const doc of docs) {
    const docDir = path.dirname(path.join(config.repoRoot, doc.path));
    const refs = new Set();
    const oneWay = new Set();
    for (const field of biFields) {
      const entries = doc.refFields[field] || [];
      const dirs = doc.refFieldDirections?.[field] || [];
      for (let i = 0; i < entries.length; i++) {
        const relPath = entries[i];
        // Use the same doc-relative-then-repo-root fallback as validateDoc so
        // both styles produce identical refMap keys; otherwise an entry like
        // `docs/foo.md` (repo-root style) gets keyed as
        // `<doc-parent>/docs/foo.md` and never matches the target's repo path.
        const resolved = resolveRefPath(relPath, docDir, config.repoRoot)
          ?? path.resolve(docDir, relPath);
        const targetPath = toRepoPath(resolved, config.repoRoot);
        refs.add(targetPath);
        if (dirs[i] === 'one-way') oneWay.add(targetPath);
      }
    }
    refMap.set(doc.path, refs);
    oneWayMap.set(doc.path, oneWay);
  }

  for (const [docPath, refs] of refMap) {
    const oneWay = oneWayMap.get(docPath);
    for (const targetPath of refs) {
      if (oneWay.has(targetPath)) continue;
      const targetRefs = refMap.get(targetPath);
      if (targetRefs && !targetRefs.has(docPath)) {
        warnings.push({ path: docPath, level: 'warning',
          message: `references \`${targetPath}\` in ${biFields.join('/')}, but that doc does not reference back.` });
      }
    }
  }

  return { warnings, errors: [] };
}

// Runlist back-pointer check: when a hub plan declares a `runlist:` of children,
// each child SHOULD have `parent_plan:` pointing back at the hub. The two
// fields encode complementary information (runlist = ordered execution intent;
// parent_plan = reverse-link the rest of dotmd already uses for related-summary
// rendering), so divergence almost always means the agent forgot the back-link.
// Warning fires on the CHILD (that's the file that needs the edit). Skips
// terminal/archive statuses on either side — runlists referencing closed work
// are a normal history pattern.
export function checkRunlistBackPointers(docs, config) {
  const warnings = [];
  const skipStatuses = new Set([
    ...(config.lifecycle.terminalStatuses ?? []),
    ...(config.lifecycle.skipWarningsFor ?? []),
  ]);
  const byPath = new Map(docs.map(d => [d.path, d]));

  for (const hub of docs) {
    if (skipStatuses.has(hub.status)) continue;
    const runlistRefs = hub.refFields?.runlist ?? [];
    if (runlistRefs.length === 0) continue;
    const hubDir = path.dirname(path.join(config.repoRoot, hub.path));

    for (const ref of runlistRefs) {
      const resolved = resolveRefPath(ref, hubDir, config.repoRoot);
      if (!resolved) continue; // unresolved refs already get their own existence error
      const childPath = toRepoPath(resolved, config.repoRoot);
      const child = byPath.get(childPath);
      if (!child) continue;
      if (skipStatuses.has(child.status)) continue;
      const childParents = (child.refFields?.parent_plan ?? []).map(p => {
        const abs = resolveRefPath(p, path.dirname(path.join(config.repoRoot, child.path)), config.repoRoot);
        return abs ? toRepoPath(abs, config.repoRoot) : p;
      });
      if (childParents.includes(hub.path)) continue;
      warnings.push({
        path: child.path,
        level: 'warning',
        message: `appears in runlist of \`${hub.path}\` but \`parent_plan:\` does not point back at it. Add \`parent_plan: ${hub.path}\` so reverse-link tooling (pickup-card Related:, graph) stays consistent.`,
      });
    }
  }
  return warnings;
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

// Plan-shape lint: soft warnings on convention drift. Plan-only.
// Body is the unparsed plan body (everything after the closing `---`).
export function validatePlanShape(doc, body, frontmatter, config) {
  if (doc.type !== 'plan') return;
  // Skip plans in terminal/archive statuses (closed work shouldn't generate noise)
  if (config.lifecycle.terminalStatuses.has(doc.status) || config.lifecycle.archiveStatuses.has(doc.status)) return;
  if (config.lifecycle.skipWarningsFor.has(doc.status)) return;

  // 1. next_step length cap (300 chars)
  const nextStep = typeof frontmatter.next_step === 'string' ? frontmatter.next_step : '';
  if (nextStep.length > 300) {
    doc.warnings.push({
      path: doc.path,
      level: 'warning',
      message: `\`next_step\` is ${nextStep.length} chars (cap: 300). Long prose belongs in the body — keep next_step as a 1-2 line pointer.`,
    });
  }

  // 2. current_state length cap (1500 chars). Was 500; raised because agents
  // legitimately need ~150-250 words of resume-context (prior incidents, what
  // shipped, what's verified, where to look) and the prior cap forced a
  // truncate-and-move-to-body retry loop on non-trivial plans.
  const currentState = typeof frontmatter.current_state === 'string' ? frontmatter.current_state : '';
  if (currentState.length > 1500) {
    doc.warnings.push({
      path: doc.path,
      level: 'warning',
      message: `\`current_state\` is ${currentState.length} chars (cap: 1500). Long prose belongs in the body.`,
    });
  }

  if (!body) return;

  // 4. Heading drift: case + name variants
  const headingDrift = [
    { wrong: /^##\s+Open questions\s*$/m, right: '## Open Questions' },
    { wrong: /^##\s+(Non-goals|Out of scope|Out of Scope|out of scope)\s*$/m, right: '## Non-Goals' },
    { wrong: /^##\s+open questions\s*$/m, right: '## Open Questions' },
  ];
  for (const { wrong, right } of headingDrift) {
    const m = body.match(wrong);
    if (m) {
      doc.warnings.push({
        path: doc.path,
        level: 'warning',
        message: `Heading drift: \`${m[0].trim()}\` → suggest \`${right}\`.`,
      });
    }
  }

  // 5. Phases section exists but no phase H3 has a status marker
  const phasesIdx = body.search(/^## Phases\s*$/m);
  if (phasesIdx >= 0) {
    // Find the section's body (until next H2 or EOF)
    const after = body.slice(phasesIdx);
    const nextH2 = after.slice(8).search(/^## /m);
    const phasesBody = nextH2 >= 0 ? after.slice(8, 8 + nextH2) : after.slice(8);
    const phaseHeadings = [...phasesBody.matchAll(/^###\s+(.+?)\s*$/gm)].map(m => m[1]);
    if (phaseHeadings.length > 0) {
      const markerRe = /(✅|⏭|🟡|⬜|🚧|☑|✔|◻|☐|⬛|\bshipped\b|\bskip(?:ped)?\b|\bin[-_ ]?(?:progress|flight)\b|\bblocked\b|\btodo\b|\bnot[-_ ]?started\b|\bwip\b|\bdone\b|\bcomplete\b)/i;
      const unmarked = phaseHeadings.filter(h => !markerRe.test(h));
      if (unmarked.length > 0) {
        doc.warnings.push({
          path: doc.path,
          level: 'warning',
          message: `${unmarked.length} of ${phaseHeadings.length} phase heading(s) lack a status marker. Use one of ✅ shipped, ⏭ skipped, 🟡 in-progress, ⬜ todo, 🚧 blocked.`,
        });
      }
    }
  }
}

// Doc-shape lint: soft warnings on convention drift. Doc-only.
// Mirrors validatePlanShape's structure.
export function validateDocShape(doc, body, frontmatter, config) {
  if (doc.type !== 'doc') return;
  if (config.lifecycle.terminalStatuses.has(doc.status) || config.lifecycle.archiveStatuses.has(doc.status)) return;
  if (config.lifecycle.skipWarningsFor.has(doc.status)) return;

  if (!body) return;

  // Heading drift for docs.
  const headingDrift = [
    { wrong: /^##\s+Related Documents\s*$/m, right: '## Related Documentation' },
  ];
  for (const { wrong, right } of headingDrift) {
    const m = body.match(wrong);
    if (m) {
      doc.warnings.push({
        path: doc.path,
        level: 'warning',
        message: `Heading drift: \`${m[0].trim()}\` → suggest \`${right}\`.`,
      });
    }
  }
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
