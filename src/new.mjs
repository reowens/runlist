import { existsSync, readFileSync, writeFileSync, mkdirSync, fstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toRepoPath, die, warn, nowIso, emitFilesFooter } from './util.mjs';
import { green, dim, bold } from './color.mjs';
import { isInteractive, promptText } from './prompt.mjs';
import { regenIndex } from './lifecycle.mjs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

// Surface-taxonomy hint emitted above the `surfaces:` line in scaffolded docs.
// Discoverable-by-default: the author sees valid values without leaving the file
// and without grepping sibling docs (issue #12 trap 1). When the project has no
// configured taxonomy, fall back to a bare `surfaces:` line.
function surfacesScaffold(ctx) {
  const valid = ctx?.validSurfaces;
  if (Array.isArray(valid) && valid.length > 0) {
    return `# surfaces — valid: ${valid.join(', ')}\nsurfaces:`;
  }
  return 'surfaces:';
}

// Module-taxonomy parallel of surfacesScaffold. When `taxonomy.modules` is set,
// scaffold lists valid values + a `- none` placeholder so the validator's
// modules-required check passes by default and the author can swap to a real
// module from the listed taxonomy. When unset, the project doesn't enumerate
// modules — drop the placeholder entirely so new plans aren't sprinkled with a
// meaningless sentinel.
function modulesScaffold(ctx, kind /* 'doc' | 'plan' */) {
  const valid = ctx?.validModules;
  if (Array.isArray(valid) && valid.length > 0) {
    const comment = kind === 'plan'
      ? `# modules — valid: ${valid.join(', ')} (or \`none\` for tooling/infra plans)`
      : `# modules — valid: ${valid.join(', ')} (or \`none\` for platform/infra docs)`;
    return `${comment}\nmodules:\n  - none`;
  }
  return 'modules:';
}

const BUILTIN_TEMPLATES = {
  doc: {
    description: 'Reference doc, design note, module overview — build-up shape lite',
    defaultStatus: 'active',
    // Body input optional. When passed (inline / --body / @file / stdin),
    // it lands in the Overview section. Without it, Overview is left blank
    // and the user fills it in.
    acceptsBody: true,
    frontmatter: (s, d, ctx) => [
      'type: doc',
      `status: ${s}`,
      `created: ${d}`,
      `updated: ${d}`,
      modulesScaffold(ctx, 'doc'),
      surfacesScaffold(ctx),
      'domain:',
      'audience: internal',
      'related_plans:',
      'related_docs:',
    ].join('\n'),
    body: (t, ctx) => `
# ${t}

> One-line summary of what this doc covers.

## Overview

${ctx?.bodyInput?.trim() ?? ''}

## Version History

- **${ctx?.today ?? ''}** Created.

## Related Documentation

`,
  },
  plan: {
    description: 'Execution plan — build-up shape (Problem → Phases → Closeout) with phase status markers and Version History',
    dir: 'plans',
    targetRoot: 'plans',
    defaultStatus: 'active',
    // Body input lands in the Problem section. Plans don't have an Overview;
    // Problem is the established opening section in the build-up shape.
    acceptsBody: true,
    frontmatter: (s, d, ctx) => [
      'type: plan',
      `status: ${s}`,
      `created: ${d}`,
      `updated: ${d}`,
      surfacesScaffold(ctx),
      modulesScaffold(ctx, 'plan'),
      'domain:',
      'audience: internal',
      'parent_plan:',
      'related_plans:',
      'related_docs:',
      'current_state:',
      'next_step:',
    ].join('\n'),
    body: (t, ctx) => {
      const bodyInput = ctx?.bodyInput?.trim() ?? '';
      // Full-body shortcut: if the input already authors `## Section` headings,
      // it's a complete plan body the user/agent wrote start-to-finish. Drop
      // the scaffold's later sections to avoid duplicate empty `## Goals`,
      // `## Phases`, etc. below the user's already-filled versions. A bare title
      // (`# X`) at the head of the body is honored — we don't double-print the
      // scaffold's title. Otherwise emit the scaffold and slot the body into
      // `## Problem` as before (section-content mode).
      if (/^##\s+\S/m.test(bodyInput)) {
        const hasOwnTitle = /^#\s+\S/.test(bodyInput);
        return hasOwnTitle ? `\n${bodyInput}\n` : `\n# ${t}\n\n${bodyInput}\n`;
      }
      return `
# ${t}

> One-paragraph problem statement: what this plan is for, why now.

## Problem

${bodyInput}

## Goals



## Non-Goals



## What Exists Today



## Constraints



## Decisions



## Open Questions



## Phases

<!--
Status markers (put in heading text):
  ⬜  not started
  🟡  in progress (pickup targets this)
  ✅  shipped (history; pickup skips)
  ⏭  skipped (with reason in body)
  🚧  blocked (link to blocker)
-->

### Phase 1 — <title> ⬜



## Deferred



## Version History

- **${ctx?.today ?? ''}** Created.

## Closeout

<!-- Filled on archive: what shipped, key commits, deferrals dispositioned. -->
`;
    },
  },
  prompt: {
    description: 'Saved prompt to seed a future Claude session — body is required',
    dir: 'prompts',
    targetRoot: 'prompts',
    defaultStatus: 'pending',
    requiresBody: true,
    acceptsBody: true,
    frontmatter: (s, d, ctx) => [
      'type: prompt',
      `status: ${s}`,
      `created: ${d}`,
      `updated: ${d}`,
      `dotmd_version: ${pkg.version}`,
      `context: ${ctx?.title ? `"${ctx.title.replace(/"/g, '\\"')}"` : ''}`,
      'related_plans:',
    ].join('\n'),
    body: (t, ctx) => `\n${ctx?.bodyInput ?? '<!-- prompt body -->'}\n`,
  },
};

// Body inputs from agents often arrive as a full document (frontmatter + body)
// written to a tempfile and passed via `@path` or stdin. Without this split,
// `dotmd new` would prepend its scaffold frontmatter and treat the input's
// frontmatter as literal body content — resulting in two `---` blocks and a
// duplicated title. We instead parse the leading block (if any), merge its
// keys onto the scaffold, and use only what follows as body. See issue #12
// trap 4. Returns `{ frontmatter: object|null, body: string }`.
function splitBodyFrontmatter(rawBody) {
  if (!rawBody || typeof rawBody !== 'string') return { frontmatter: null, body: rawBody };
  if (!rawBody.startsWith('---\n')) return { frontmatter: null, body: rawBody };
  const { frontmatter: fmText, body } = extractFrontmatter(rawBody);
  if (!fmText) return { frontmatter: null, body: rawBody };
  const parsed = parseSimpleFrontmatter(fmText);
  return { frontmatter: parsed, body };
}

// Serialize a single frontmatter key/value pair to a YAML block. Mirrors the
// scaffold's shape so merged output reads naturally next to scaffold defaults.
function serializeFmEntry(key, value) {
  if (value === null || value === undefined || value === '') return `${key}:`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `${key}:`;
    return `${key}:\n${value.map(v => `  - ${v}`).join('\n')}`;
  }
  if (typeof value === 'string' && value.includes('\n')) {
    const indented = value.split('\n').map(l => `  ${l}`).join('\n');
    return `${key}: |\n${indented}`;
  }
  return `${key}: ${value}`;
}

// Replace each key in `overrides` within the scaffold-generated frontmatter
// string. Keys not present in the scaffold are appended. `type:` is never
// overwritten — the CLI's type arg wins (warning emitted on conflict).
function mergeBodyFrontmatter(scaffoldFm, overrides, cliType) {
  if (!overrides || Object.keys(overrides).length === 0) return scaffoldFm;
  let fm = scaffoldFm;
  const appended = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (key === 'type') {
      if (cliType && value && value !== cliType) {
        warn(`Body frontmatter declares \`type: ${value}\` but CLI arg is \`${cliType}\`; using \`${cliType}\`.`);
      }
      continue;
    }
    if (key === 'created' || key === 'updated') continue; // scaffold owns timestamps
    const serialized = serializeFmEntry(key, value);
    // Match `key:` line + any indented continuation (block-array items or
    // block-scalar bodies). Indented lines start with whitespace; scaffold keys
    // never do, so this consumes only the right slice.
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${escaped}:.*(\\n[ \\t]+.*)*`, 'm');
    if (re.test(fm)) {
      fm = fm.replace(re, serialized);
    } else {
      appended.push(serialized);
    }
  }
  if (appended.length > 0) fm = fm + '\n' + appended.join('\n');
  return fm;
}

export function readBodyInput(source) {
  if (source === '-') {
    try { return readFileSync(0, 'utf8'); } catch (err) { die(`Could not read body from stdin: ${err.message}`); }
  }
  if (typeof source === 'string' && source.startsWith('@')) {
    const file = source.slice(1);
    if (!existsSync(file)) die(`Body file not found: ${file}`);
    return readFileSync(file, 'utf8');
  }
  return source;
}

// Slug/title helpers shared by name resolution and runlist child generation.
function slugify(s) {
  return s.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}
function titleize(s) {
  return s.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Resolve one `--runlist` token to a scaffolded child plan: a bare slug becomes
// `<hub>-NN-<slug>.md` (the documented runlist naming convention). `pos` is the
// 1-based position used for the zero-padded NN prefix. Tokens must be bare slugs
// — a path is rejected (wiring an ordered hub to a plan that already lives
// elsewhere needs a hub-relative ref, so it's a hand-edit, not a scaffold).
function planChildFromToken(hubSlug, token, pos) {
  const t = token.trim();
  if (t.includes('/') || t.includes(path.sep)) {
    die(`Runlist child "${token}" must be a bare slug, not a path. To put an existing plan in the runlist, add it to the hub's runlist: by hand.`);
  }
  const childSlug = slugify(t.replace(/\.md$/, ''));
  if (!childSlug) die(`Runlist child token resolves to an empty slug: "${token}"`);
  const nn = String(pos).padStart(2, '0');
  return { file: `${hubSlug}-${nn}-${childSlug}.md`, title: titleize(t.replace(/\.md$/, '')) };
}

// Body for a sprint runlist hub: the children ARE the phases, so the heavy
// generic plan scaffold (Goals/Phases/Deferred/…) is replaced by an ordered
// `## Order of operations` list that mirrors the `runlist:` frontmatter.
function runlistHubBody(title, hubSlug, children, bodyInput, today) {
  const steps = children
    .map((c, i) => `${i + 1}. [${c.title}](${c.file}) ⬜`)
    .join('\n');
  const n = children.length;
  return `
# ${title}

> One-paragraph problem statement: what this runlist sprints toward, why now.

## Problem

${bodyInput?.trim() ?? ''}

## Order of operations

${steps}

Pick up the next child with \`dotmd runlist next ${hubSlug}\` — it targets the
first non-archived child. \`dotmd runlist ${hubSlug}\` shows the sequence + status.

## Version History

- **${today}** Created (runlist hub, ${n} ${n === 1 ? 'child' : 'children'}).
`;
}

// Body for a coordination hub: prose-first domain map with a ranked-queue table.
// Mirrors the `execution_mode: coordination` shape `dotmd runlists` reads.
function coordinationHubBody(title, bodyInput, today) {
  return `
# ${title}

> One-paragraph: the domain this hub coordinates and how to read the queue below.

## Scope

${bodyInput?.trim() ?? ''}

## Ranked queue

<!-- One row per coordinated plan, in pickup order; the gating column explains
dependencies. Wire each plan into related_plans: so the "N related" count and
graph pick it up. -->

| # | Plan | Why / gating | Status |
|---|------|--------------|--------|
| 1 | \`<plan>.md\` | | |

## Version History

- **${today}** Created (coordination hub).
`;
}

// Minimal child plan stub for a scaffolded runlist child. parent_plan points
// back at the hub (same dir) so \`dotmd doctor\` is satisfied and the reverse
// link/graph work; status starts `planned` (queued behind the hub).
function runlistChildContent(childTitle, hubSlug, hubTitle, childStatus, today) {
  return `---
type: plan
status: ${childStatus}
created: ${today}
updated: ${today}
parent_plan: ${hubSlug}.md
related_plans:
current_state:
next_step:
---

# ${childTitle}

> Runlist child of [${hubTitle}](${hubSlug}.md).

## Problem



## Version History

- **${today}** Created (runlist child of ${hubSlug}).
`;
}

export async function runNew(argv, config, opts = {}) {
  const { dryRun } = opts;

  const knownTypes = new Set(Object.keys(BUILTIN_TEMPLATES));
  // Also include any custom templates from config
  for (const k of Object.keys(config.raw?.templates ?? {})) knownTypes.add(k);

  const hasNameForBody = args => {
    if (args.length >= 2 && knownTypes.has(args[0])) return true;
    if (args.length >= 1 && !knownTypes.has(args[0])) return true;
    return false;
  };

  // Parse args. Pull out flags first.
  const positional = [];
  let status = null;
  let title = null;
  let rootName = opts.root ?? null;
  let bodyFlag = null;
  let bodyFlagName = null; // tracks which spelling the caller used, for error attribution
  let showFiles = opts.showFiles ?? false;
  let runlistArg = null;     // --runlist a,b,c  → sprint hub + child stubs
  let coordination = false;  // --coordination   → coordination hub skeleton
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--status' && argv[i + 1]) { status = argv[++i]; continue; }
    if (argv[i] === '--title' && argv[i + 1]) { title = argv[++i]; continue; }
    if (argv[i] === '--runlist' && argv[i + 1]) { runlistArg = argv[++i]; continue; }
    if (argv[i] === '--coordination') { coordination = true; continue; }
    // --body is the canonical flag; --message is a back-compat alias.
    if ((argv[i] === '--body' || argv[i] === '--message') && argv[i + 1]) {
      bodyFlagName = argv[i];
      bodyFlag = argv[++i];
      continue;
    }
    if (argv[i] === '--root' && argv[i + 1]) { rootName = argv[++i]; continue; }
    if (argv[i] === '--config') { i++; continue; }
    if (argv[i] === '--show-files') { showFiles = true; continue; }
    if (argv[i] === '--list-templates' || argv[i] === '--list-types') {
      listTemplates(config);
      return;
    }
    // Treat `-` alone (stdin marker) as a positional, not a flag.
    // Once the type/name have been collected, a positional body may itself
    // start with `---` frontmatter. Preserve it instead of dropping it as an
    // unknown flag; the leading frontmatter merge below will handle it.
    if (!argv[i].startsWith('-') || argv[i] === '-' || hasNameForBody(positional)) positional.push(argv[i]);
  }

  // Resolve type vs name:
  //   `dotmd new plan auth-revamp`     → type=plan, name=auth-revamp
  //   `dotmd new auth-revamp`          → type=doc (default), name=auth-revamp
  //   `dotmd new prompt foo "body"`    → type=prompt, name=foo, bodyArg="body"
  let typeName, name, bodyArg = null;
  if (positional.length >= 1 && knownTypes.has(positional[0])) {
    typeName = positional[0];
    name = positional[1];
    if (positional.length > 2) bodyArg = positional.slice(2).join(' ');
  } else {
    typeName = 'doc';
    name = positional[0];
    if (positional.length > 1) bodyArg = positional.slice(1).join(' ');
  }

  if (!name) {
    if (isInteractive()) {
      name = await promptText(`${typeName} name: `);
      if (!name) die('No name provided.');
    } else {
      die(`Usage: dotmd new <type> <name> [body]\n       types: ${[...knownTypes].join(', ')}\n       body: inline text | piped stdin (auto) | "@path" (file) | --body "..."`);
    }
  }

  // Resolve template (by type name, falls back to lookup)
  const template = resolveTemplate(typeName, config);

  // Validate status. The template's `defaultStatus` is only used when it's
  // actually valid in the user's per-type config — otherwise fall back to the
  // first valid type status. This avoids the "Invalid status `active` for type
  // `doc`" loop when a project overrides doc statuses to exclude 'active'.
  if (!status) {
    const typeStatuses = config.typeStatuses?.get(typeName);
    const tmplDefault = (typeof template === 'object' && template.defaultStatus) ? template.defaultStatus : null;
    if (tmplDefault && (!typeStatuses || typeStatuses.size === 0 || typeStatuses.has(tmplDefault))) {
      status = tmplDefault;
    } else if (typeStatuses && typeStatuses.size > 0) {
      status = [...typeStatuses][0];
    } else {
      status = tmplDefault ?? 'active';
    }
  }
  const effective = config.typeStatuses?.get(typeName) ?? config.validStatuses;
  if (!effective.has(status)) {
    die(`Invalid status \`${status}\` for type \`${typeName}\`\nValid: ${[...effective].join(', ')}`);
  }

  // Runlist/coordination hubs are a plan shape, not a separate type. Guard the
  // flags to type plan and reject the contradictory combination (a sprint
  // `runlist:` array vs a prose-first coordination map are different shapes).
  const isRunlistHub = runlistArg !== null;
  const isCoordinationHub = coordination;
  if ((isRunlistHub || isCoordinationHub) && typeName !== 'plan') {
    die(`--${isRunlistHub ? 'runlist' : 'coordination'} only applies to plans. Use: dotmd new plan <name> --${isRunlistHub ? 'runlist a,b,c' : 'coordination'}`);
  }
  if (isRunlistHub && isCoordinationHub) {
    die('--runlist and --coordination are mutually exclusive: a sprint runlist hub carries an ordered `runlist:` array; a coordination hub is a prose-first map (`execution_mode: coordination`). Pick one.');
  }
  const runlistTokens = isRunlistHub
    ? runlistArg.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  if (isRunlistHub && runlistTokens.length === 0) {
    die('--runlist needs at least one child, e.g. --runlist extract,rewrite,cleanup');
  }

  // Body input resolution: --body flag > positional bodyArg > auto-piped-stdin > nothing
  let bodyInput = null;
  let bodyInputSource = null;
  if (bodyFlag !== null) { bodyInput = readBodyInput(bodyFlag); bodyInputSource = bodyFlagName; }
  else if (bodyArg !== null) {
    bodyInput = readBodyInput(bodyArg);
    bodyInputSource = bodyArg === '-' ? 'stdin (`-`)' : (bodyArg.startsWith('@') ? `file (\`${bodyArg}\`)` : 'inline body argument');
  } else {
    // Auto-consume piped or redirected stdin so agents don't need the `-`
    // placeholder for the most common pattern (`cat draft.md | dotmd new …`,
    // `dotmd new … < draft.md`, or a `<<'EOF'` heredoc). We probe stdin via
    // fstatSync rather than `!isTTY` so a closed/inherited fd doesn't trigger
    // a blocking read of an empty stream. We accept FIFO (shell pipes), regular
    // file (shell redirection / heredoc), and socket (Node spawnSync `input:`
    // delivers stdin as an AF_UNIX socket). Probe this even for templates that
    // don't accept bodies so the fail-fast guard below can reject accidental
    // heredoc/input instead of silently scaffolding without it.
    try {
      const stat = fstatSync(0);
      if (stat.isFIFO() || stat.isFile() || stat.isSocket()) {
        const piped = readFileSync(0, 'utf8');
        if (piped.length > 0) {
          bodyInput = piped;
          bodyInputSource = 'piped stdin';
        }
      }
    } catch { /* stdin not introspectable — skip auto-consume */ }
  }

  // If the body input has a leading `---…---` frontmatter block, lift its keys
  // out so they override scaffold defaults; only the content after the closing
  // `---` is treated as body. The natural agent pattern is to draft a full doc
  // to a tempfile and pass `@path` — without this, the scaffold ends up with
  // two `---` blocks. See issue #12 trap 4.
  let bodyFrontmatter = null;
  if (bodyInput !== null) {
    const split = splitBodyFrontmatter(bodyInput);
    if (split.frontmatter) {
      bodyFrontmatter = split.frontmatter;
      bodyInput = split.body;
    }
  }

  if (template.requiresBody && (!bodyInput || !bodyInput.trim())) {
    die(`\`${typeName}\` template requires a body. Pipe stdin (\`cat draft.md | dotmd new ${typeName} <slug>\`), pass @path, --body "...", or inline text.`);
  }

  // Fail-fast when the user passes body input to a template that doesn't
  // consume it — silently discarding heredoc content is the worst UX.
  // Templates opt in via `acceptsBody: true` or `requiresBody: true`.
  if (bodyInput !== null && !template.acceptsBody && !template.requiresBody) {
    const configTemplates = config.raw?.templates ?? {};
    // Compute the accepting list from the RESOLVED set (config merged over
    // built-ins) so the hint doesn't contradict the rejection.
    const resolvedNames = new Set([...Object.keys(BUILTIN_TEMPLATES), ...Object.keys(configTemplates)]);
    const accepting = [...resolvedNames]
      .filter(n => n !== typeName)
      .filter(n => {
        const t = resolveTemplate(n, config);
        return t.acceptsBody || t.requiresBody;
      });
    const hint = accepting.length > 0
      ? ` Templates that accept body input: ${accepting.join(', ')}.`
      : '';

    // Override-of-builtin diagnosis: the most common cause is a project
    // dotmd.config.mjs that copy-pasted a stripped-down `plan` template
    // and dropped the body-acceptance contract. Name that explicitly so
    // an agent can self-fix without spelunking the config.
    const builtin = BUILTIN_TEMPLATES[typeName];
    const isOverride = Boolean(configTemplates[typeName] && builtin);
    const builtinAccepts = Boolean(builtin && (builtin.acceptsBody || builtin.requiresBody));
    let cause;
    if (isOverride && builtinAccepts) {
      const where = config.configPath ? toRepoPath(config.configPath, config.repoRoot) : 'dotmd.config.mjs';
      cause = `Your config (${where}) overrides the built-in \`${typeName}\` template, and the override drops body acceptance.\nFix: in that override, add \`acceptsBody: true\` AND interpolate \`\${ctx?.bodyInput?.trim() ?? ''}\` into your \`body\` fn (e.g., inside \`## Problem\`). Or drop the override to use the built-in.`;
    } else {
      cause = `Either drop the body, switch to a template that accepts it, or set \`acceptsBody: true\` on your custom \`${typeName}\` template in dotmd.config.mjs.`;
    }
    die(`\`${typeName}\` template does not accept body input, but body was passed via ${bodyInputSource}.${hint}\n${cause}`);
  }

  // If name contains path separators, split into directory prefix and basename
  let nameDir = null;
  let namePart = name;
  if (name.includes('/') || name.includes(path.sep)) {
    nameDir = path.dirname(name);
    namePart = path.basename(name, '.md');
  } else if (name.endsWith('.md')) {
    namePart = name.slice(0, -3);
  }

  // Slugify
  const slug = namePart.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) { die('Name resolves to empty slug: ' + name); }

  // Title
  const docTitle = title ?? namePart.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  // Resolve target root. Precedence: CLI --root > template.targetRoot > config.docsRoot.
  // When the chosen root is a first-class type-container (matched by --root or targetRoot),
  // we skip the `template.dir` join — the root already points at the right directory.
  let targetRoot = config.docsRoot;
  let routedToTypeRoot = false;
  if (rootName) {
    const roots = config.docsRoots || [config.docsRoot];
    const match = roots.find(r => r.endsWith(rootName) || path.basename(r) === rootName);
    if (!match) {
      const available = roots.map(r => path.basename(r)).join(', ');
      die(`Unknown root: ${rootName}\nAvailable: ${available}`);
    }
    targetRoot = match;
    routedToTypeRoot = true;
  } else if (typeof template === 'object' && template.targetRoot) {
    const roots = config.docsRoots || [config.docsRoot];
    const match = roots.find(r => r.endsWith(template.targetRoot) || path.basename(r) === template.targetRoot);
    if (match) {
      targetRoot = match;
      routedToTypeRoot = true;
    }
  }

  // Template-declared subdirectory (e.g., prompt → 'prompts') — only relevant when we
  // didn't already land in a type-specific root via --root or targetRoot.
  if (typeof template === 'object' && template.dir && !nameDir && !routedToTypeRoot) {
    nameDir = path.join(path.relative(config.repoRoot, targetRoot), template.dir);
  }

  // Path — if user provided a directory prefix OR template declared one, resolve relative to repoRoot
  const baseDir = nameDir ? path.resolve(config.repoRoot, nameDir) : targetRoot;
  const filePath = path.join(baseDir, slug + '.md');
  const repoPath = toRepoPath(filePath, config.repoRoot);

  if (existsSync(filePath)) {
    die(`File already exists: ${repoPath}`);
  }

  const today = nowIso();

  // Resolve runlist children from the hub slug (e.g. `extract` → hub-01-extract.md).
  const runlistChildren = runlistTokens.map((tok, i) => planChildFromToken(slug, tok, i + 1));
  const childStatus = effective.has('planned') ? 'planned' : status;

  // Generate content
  let content;
  const validSurfaces = config.raw?.taxonomy?.surfaces ?? (config.validSurfaces ? [...config.validSurfaces] : null);
  const validModules = config.raw?.taxonomy?.modules ?? (config.validModules ? [...config.validModules] : null);
  const tmplCtx = { status, title: docTitle, today, bodyInput, validSurfaces, validModules };
  if (typeof template === 'function') {
    content = template(name, tmplCtx);
  } else {
    let fm = template.frontmatter(status, today, tmplCtx);
    if (bodyFrontmatter) fm = mergeBodyFrontmatter(fm, bodyFrontmatter, typeName);
    // Inject the hub-shape frontmatter (runlist array / coordination marker)
    // on top of the standard plan scaffold, then swap in a purpose-built body.
    if (isRunlistHub) fm = mergeBodyFrontmatter(fm, { runlist: runlistChildren.map(c => c.file) }, typeName);
    if (isCoordinationHub) fm = mergeBodyFrontmatter(fm, { execution_mode: 'coordination' }, typeName);
    let body;
    if (isRunlistHub) body = runlistHubBody(docTitle, slug, runlistChildren, bodyInput, today);
    else if (isCoordinationHub) body = coordinationHubBody(docTitle, bodyInput, today);
    else body = template.body(docTitle, tmplCtx);
    content = `---\n${fm}\n---\n${body}`;
  }

  // When the project has >1 root and `--root` was omitted, surface the choice
  // so agents can see that an alternative root was available. Cheap visibility
  // for the "ended up in docs/plans/ for a doc" foot-gun.
  const allRoots = config.docsRoots ?? [config.docsRoot];
  let rootHint = '';
  if (!rootName && allRoots.length > 1) {
    const chosenLabel = path.basename(targetRoot);
    const others = allRoots
      .filter(r => r !== targetRoot)
      .map(r => path.basename(r));
    rootHint = `Root: ${chosenLabel} (others: ${others.join(', ')} — pass --root <name> to change)\n`;
  }

  const hubKind = isRunlistHub ? ' (runlist hub)' : isCoordinationHub ? ' (coordination hub)' : '';

  if (dryRun) {
    process.stdout.write(`${dim('[dry-run]')} Would create: ${repoPath}\n`);
    process.stdout.write(`${dim('[dry-run]')} Type: ${typeName}${hubKind}\n`);
    for (const c of runlistChildren) {
      process.stdout.write(`${dim('[dry-run]')} Would create child: ${toRepoPath(path.join(baseDir, c.file), config.repoRoot)}\n`);
    }
    if (rootHint) process.stdout.write(`${dim('[dry-run]')} ${rootHint}`);
    return;
  }

  // Ensure parent dir exists (templates with `dir:` may target a new subdirectory)
  mkdirSync(path.dirname(filePath), { recursive: true });

  writeFileSync(filePath, content, 'utf8');
  process.stdout.write(`${green('Created')}: ${repoPath} ${dim(`(${typeName}${hubKind})`)}\n`);
  if (rootHint) process.stdout.write(dim(rootHint));

  // Scaffold runlist child stubs. An existing child file is never clobbered.
  const childPaths = [];
  for (const c of runlistChildren) {
    const childPath = path.join(baseDir, c.file);
    if (existsSync(childPath)) {
      warn(`Runlist child already exists, left as-is: ${toRepoPath(childPath, config.repoRoot)}`);
      continue;
    }
    writeFileSync(childPath, runlistChildContent(c.title, slug, docTitle, childStatus, today), 'utf8');
    childPaths.push(childPath);
    process.stdout.write(`${green('Created')}: ${toRepoPath(childPath, config.repoRoot)} ${dim(`(plan · runlist child, ${childStatus})`)}\n`);
  }

  // Post-create guidance. Prompts are the classic confusion point: agents
  // reflexively `git add && commit` a freshly-created file, but saved prompts
  // are session-local handoff artifacts — the next session consumes them via
  // `dotmd use`, and the prompts dir is often gitignored (the commit then fails
  // confusingly). Tell the agent the next step explicitly, and flag a gitignored
  // target for any type so "why won't this commit" never happens silently.
  if (typeName === 'prompt') {
    process.stdout.write(dim('Session-local — no need to commit. The next session runs `dotmd use` (or `dotmd use ' + repoPath + '`) to consume it.\n'));
  }
  // Teach the field-length contract at the moment the fields get written —
  // learning it from a cap warning later sends sessions into hand-trim /
  // re-check loops.
  if (typeName === 'plan') {
    process.stdout.write(dim('current_state = 2-4 sentence summary (cap 1500 chars); next_step = 1-2 sentence pointer (cap 800). Detail goes in the body, not frontmatter.\n'));
  }
  try {
    const { isGitIgnored } = await import('./git.mjs');
    if (isGitIgnored(filePath, config.repoRoot)) {
      process.stdout.write(dim(`Note: ${repoPath} is gitignored — don't try to git add/commit it.\n`));
    }
  } catch { /* git absent / not a repo — skip the note */ }

  regenIndex(config);

  if (showFiles) {
    const touched = [filePath, ...childPaths];
    if (config.indexPath) touched.push(config.indexPath);
    emitFilesFooter(touched, config);
  }

  try { config.hooks.onNew?.({ path: repoPath, status, title: docTitle, type: typeName }); } catch (err) { warn(`Hook 'onNew' threw: ${err.message}`); }
}

function resolveTemplate(name, config) {
  const configTemplates = config.raw?.templates ?? {};
  const override = configTemplates[name];
  const builtin = BUILTIN_TEMPLATES[name];

  if (override) {
    if (!builtin) return { ...override, _overridesBuiltin: false };
    // Partial-override DX: shallow-merge built-in under override so missing
    // fields (description, dir, targetRoot, defaultStatus, frontmatter, body,
    // acceptsBody, requiresBody) fall back to the built-in. Anything the
    // override explicitly declares wins.
    const merged = { ...builtin, ...override, _overridesBuiltin: true };

    // Body-loss guard: if the override supplies its OWN body fn but doesn't
    // explicitly opt in to body acceptance, the inherited built-in
    // `acceptsBody`/`requiresBody` could let body input flow into a custom
    // body fn that doesn't honor `ctx.bodyInput` — silently discarding the
    // heredoc, the worst-UX bug fix #9 was added to prevent. Strip the
    // inherited flags so the fail-fast guard fires. EXCEPT when the custom
    // body fn references `bodyInput` itself, in which case it's clearly
    // body-aware and inheriting acceptsBody is the agent-first move.
    const overrodeBody = typeof override.body === 'function';
    const declaredAcceptance = override.acceptsBody !== undefined || override.requiresBody !== undefined;
    if (overrodeBody && !declaredAcceptance) {
      const bodyAware = /bodyInput/.test(override.body.toString());
      if (!bodyAware) {
        merged.acceptsBody = undefined;
        merged.requiresBody = undefined;
      }
    }
    return merged;
  }

  if (builtin) return builtin;

  const available = [...new Set([...Object.keys(BUILTIN_TEMPLATES), ...Object.keys(configTemplates)])];
  die(`Unknown type: ${name}\nAvailable: ${available.join(', ')}`);
}

function listTemplates(config) {
  const configTemplates = config.raw?.templates ?? {};
  const all = { ...BUILTIN_TEMPLATES };
  for (const [k, v] of Object.entries(configTemplates)) {
    all[k] = v;
  }

  process.stdout.write(bold('Available types') + '\n\n');
  for (const [name, tmpl] of Object.entries(all)) {
    const desc = typeof tmpl === 'function'
      ? '(custom function)'
      : (tmpl.description ?? '');
    const source = configTemplates[name] ? dim(' (config)') : '';
    process.stdout.write(`  ${name}${source}\n`);
    if (desc) process.stdout.write(`  ${dim(desc)}\n`);
    process.stdout.write('\n');
  }
}
