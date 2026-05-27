import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

const BUILTIN_TEMPLATES = {
  doc: {
    description: 'Reference doc, design note, module overview — build-up shape lite',
    defaultStatus: 'active',
    // Body input optional. When passed (inline / --message / @file / stdin),
    // it lands in the Overview section. Without it, Overview is left blank
    // and the user fills it in.
    acceptsBody: true,
    frontmatter: (s, d, ctx) => [
      'type: doc',
      `status: ${s}`,
      `created: ${d}`,
      `updated: ${d}`,
      '# modules — real module name(s), or `none` for platform/infra docs',
      'modules:',
      '  - none',
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
      '# modules — real module name(s), or `none` for tooling/infra plans',
      'modules:',
      '  - none',
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

function readBodyInput(source) {
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

export async function runNew(argv, config, opts = {}) {
  const { dryRun } = opts;

  // Parse args. Pull out flags first.
  const positional = [];
  let status = null;
  let title = null;
  let rootName = opts.root ?? null;
  let messageFlag = null;
  let showFiles = opts.showFiles ?? false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--status' && argv[i + 1]) { status = argv[++i]; continue; }
    if (argv[i] === '--title' && argv[i + 1]) { title = argv[++i]; continue; }
    if (argv[i] === '--message' && argv[i + 1]) { messageFlag = argv[++i]; continue; }
    if (argv[i] === '--root' && argv[i + 1]) { rootName = argv[++i]; continue; }
    if (argv[i] === '--config') { i++; continue; }
    if (argv[i] === '--show-files') { showFiles = true; continue; }
    if (argv[i] === '--list-templates' || argv[i] === '--list-types') {
      listTemplates(config);
      return;
    }
    // Treat `-` alone (stdin marker) as a positional, not a flag.
    if (!argv[i].startsWith('-') || argv[i] === '-') positional.push(argv[i]);
  }

  // Resolve type vs name:
  //   `dotmd new plan auth-revamp`     → type=plan, name=auth-revamp
  //   `dotmd new auth-revamp`          → type=doc (default), name=auth-revamp
  //   `dotmd new prompt foo "body"`    → type=prompt, name=foo, bodyArg="body"
  const knownTypes = new Set(Object.keys(BUILTIN_TEMPLATES));
  // Also include any custom templates from config
  for (const k of Object.keys(config.raw?.templates ?? {})) knownTypes.add(k);

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
      die(`Usage: dotmd new <type> <name> [body]\n       types: ${[...knownTypes].join(', ')}\n       body: inline text | "-" (stdin) | "@path" (file) | --message "..."`);
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

  // Body input resolution: messageFlag > bodyArg > nothing
  let bodyInput = null;
  let bodyInputSource = null;
  if (messageFlag !== null) { bodyInput = readBodyInput(messageFlag); bodyInputSource = '--message'; }
  else if (bodyArg !== null) {
    bodyInput = readBodyInput(bodyArg);
    bodyInputSource = bodyArg === '-' ? 'stdin (`-`)' : (bodyArg.startsWith('@') ? `file (\`${bodyArg}\`)` : 'inline body argument');
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
    die(`\`${typeName}\` template requires a body. Pass inline, --message "...", - for stdin, or @path for a file.`);
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

  // Generate content
  let content;
  const validSurfaces = config.raw?.taxonomy?.surfaces ?? (config.validSurfaces ? [...config.validSurfaces] : null);
  const tmplCtx = { status, title: docTitle, today, bodyInput, validSurfaces };
  if (typeof template === 'function') {
    content = template(name, tmplCtx);
  } else {
    let fm = template.frontmatter(status, today, tmplCtx);
    if (bodyFrontmatter) fm = mergeBodyFrontmatter(fm, bodyFrontmatter, typeName);
    const body = template.body(docTitle, tmplCtx);
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

  if (dryRun) {
    process.stdout.write(`${dim('[dry-run]')} Would create: ${repoPath}\n`);
    process.stdout.write(`${dim('[dry-run]')} Type: ${typeName}\n`);
    if (rootHint) process.stdout.write(`${dim('[dry-run]')} ${rootHint}`);
    return;
  }

  // Ensure parent dir exists (templates with `dir:` may target a new subdirectory)
  mkdirSync(path.dirname(filePath), { recursive: true });

  writeFileSync(filePath, content, 'utf8');
  process.stdout.write(`${green('Created')}: ${repoPath} ${dim(`(${typeName})`)}\n`);
  if (rootHint) process.stdout.write(dim(rootHint));

  regenIndex(config);

  if (showFiles) {
    const touched = [filePath];
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
