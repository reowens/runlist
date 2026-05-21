import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toRepoPath, die, warn, nowIso } from './util.mjs';
import { green, dim, bold } from './color.mjs';
import { isInteractive, promptText } from './prompt.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const BUILTIN_TEMPLATES = {
  doc: {
    description: 'Reference doc, design note, module overview — build-up shape lite',
    defaultStatus: 'active',
    frontmatter: (s, d) => [
      'type: doc',
      `status: ${s}`,
      `created: ${d}`,
      `updated: ${d}`,
      'modules:',
      'surfaces:',
      'domain:',
      'audience: internal',
      'related_plans:',
      'related_docs:',
    ].join('\n'),
    body: (t, ctx) => `
# ${t}

> One-line summary of what this doc covers.

## Overview



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
    frontmatter: (s, d) => [
      'type: plan',
      `status: ${s}`,
      `created: ${d}`,
      `updated: ${d}`,
      'surfaces:',
      'modules:',
      'domain:',
      'audience: internal',
      'parent_plan:',
      'related_plans:',
      'related_docs:',
      'current_state:',
      'next_step:',
    ].join('\n'),
    body: (t, ctx) => `
# ${t}

> One-paragraph problem statement: what this plan is for, why now.

## Problem



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
`,
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
      `dotmd_version: ${pkg.version}`,
      `context: ${ctx?.title ? `"${ctx.title.replace(/"/g, '\\"')}"` : ''}`,
      'related_plans:',
    ].join('\n'),
    body: (t, ctx) => `\n${ctx?.bodyInput ?? '<!-- prompt body -->'}\n`,
  },
};

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
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--status' && argv[i + 1]) { status = argv[++i]; continue; }
    if (argv[i] === '--title' && argv[i + 1]) { title = argv[++i]; continue; }
    if (argv[i] === '--message' && argv[i + 1]) { messageFlag = argv[++i]; continue; }
    if (argv[i] === '--root' && argv[i + 1]) { rootName = argv[++i]; continue; }
    if (argv[i] === '--config') { i++; continue; }
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

  // Validate status (template default first, then per-type list, then 'active')
  if (!status) {
    if (typeof template === 'object' && template.defaultStatus) {
      status = template.defaultStatus;
    } else {
      const typeStatuses = config.typeStatuses?.get(typeName);
      status = typeStatuses && typeStatuses.size > 0 ? [...typeStatuses][0] : 'active';
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

  if (template.requiresBody && (!bodyInput || !bodyInput.trim())) {
    die(`\`${typeName}\` template requires a body. Pass inline, --message "...", - for stdin, or @path for a file.`);
  }

  // Fail-fast when the user passes body input to a template that doesn't
  // consume it — silently discarding heredoc content is the worst UX.
  // Templates opt in via `acceptsBody: true` or `requiresBody: true`. Built-in
  // `prompt` is the only template that consumes body by default.
  if (bodyInput !== null && !template.acceptsBody && !template.requiresBody) {
    const accepting = Object.entries(BUILTIN_TEMPLATES)
      .filter(([, t]) => t.acceptsBody || t.requiresBody)
      .map(([n]) => n);
    const hint = accepting.length > 0
      ? ` Templates that accept body input: ${accepting.join(', ')}.`
      : '';
    die(`\`${typeName}\` template does not accept body input, but body was passed via ${bodyInputSource}.${hint}\nEither drop the body, switch to a template that accepts it, or set \`acceptsBody: true\` on your custom \`${typeName}\` template in dotmd.config.mjs.`);
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
  const tmplCtx = { status, title: docTitle, today, bodyInput };
  if (typeof template === 'function') {
    content = template(name, tmplCtx);
  } else {
    const fm = template.frontmatter(status, today, tmplCtx);
    const body = template.body(docTitle, tmplCtx);
    content = `---\n${fm}\n---\n${body}`;
  }

  if (dryRun) {
    process.stdout.write(`${dim('[dry-run]')} Would create: ${repoPath}\n`);
    process.stdout.write(`${dim('[dry-run]')} Type: ${typeName}\n`);
    return;
  }

  // Ensure parent dir exists (templates with `dir:` may target a new subdirectory)
  mkdirSync(path.dirname(filePath), { recursive: true });

  writeFileSync(filePath, content, 'utf8');
  process.stdout.write(`${green('Created')}: ${repoPath} ${dim(`(${typeName})`)}\n`);

  try { config.hooks.onNew?.({ path: repoPath, status, title: docTitle, type: typeName }); } catch (err) { warn(`Hook 'onNew' threw: ${err.message}`); }
}

function resolveTemplate(name, config) {
  // Config templates take priority
  const configTemplates = config.raw?.templates ?? {};
  if (configTemplates[name]) return configTemplates[name];
  if (BUILTIN_TEMPLATES[name]) return BUILTIN_TEMPLATES[name];

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
