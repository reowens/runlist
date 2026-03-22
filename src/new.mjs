import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { toRepoPath, die, warn } from './util.mjs';
import { green, dim, bold } from './color.mjs';
import { isInteractive, promptText } from './prompt.mjs';

const BUILTIN_TEMPLATES = {
  default: {
    description: 'Minimal document with status and updated date',
    frontmatter: (s, d) => `type: doc\nstatus: ${s}\nupdated: ${d}`,
    body: (t) => `\n# ${t}\n`,
  },
  plan: {
    description: 'Execution plan with module, surface, and cross-references',
    frontmatter: (s, d) => `type: plan\nstatus: ${s}\nupdated: ${d}\nsurface:\nmodule:\ncurrent_state:\nrelated_plans:`,
    body: (t) => `\n# ${t}\n\n## Overview\n\n\n\n## Implementation Plan\n\n- [ ] \n\n## Open Questions\n\n\n`,
  },
  adr: {
    description: 'Architecture Decision Record',
    frontmatter: (s, d) => `type: doc\nstatus: ${s}\nupdated: ${d}\ndecision_date:\ndeciders:`,
    body: (t) => `\n# ${t}\n\n## Context\n\n\n\n## Decision\n\n\n\n## Consequences\n\n\n`,
  },
  rfc: {
    description: 'Request for Comments',
    frontmatter: (s, d) => `type: doc\nstatus: ${s}\nupdated: ${d}\nowner:\nreviewers:`,
    body: (t) => `\n# ${t}\n\n## Summary\n\n\n\n## Motivation\n\n\n\n## Detailed Design\n\n\n\n## Alternatives\n\n\n\n## Open Questions\n\n\n`,
  },
  audit: {
    description: 'Codebase audit or research investigation',
    frontmatter: (s, d) => `type: research\nstatus: active\nupdated: ${d}\naudited: ${d}\naudit_level: pass1\nmodule:\nsource_of_truth: code\nsupports_plans:`,
    body: (t) => `\n# ${t}\n\n## Scope\n\n\n\n## Findings\n\n\n\n## Recommendations\n\n\n`,
  },
  design: {
    description: 'Design document with goals, non-goals, and implementation plan',
    frontmatter: (s, d) => `type: doc\nstatus: ${s}\nupdated: ${d}\nowner:\nsurface:\nmodule:\nrelated_plans:`,
    body: (t) => `\n# ${t}\n\n## Overview\n\n\n\n## Goals\n\n\n\n## Non-Goals\n\n\n\n## Design\n\n\n\n## Implementation Plan\n\n- [ ] \n`,
  },
};

export async function runNew(argv, config, opts = {}) {
  const { dryRun } = opts;

  // Parse args
  const positional = [];
  let status = 'active';
  let title = null;
  let templateName = null;
  let rootName = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--status' && argv[i + 1]) { status = argv[++i]; continue; }
    if (argv[i] === '--title' && argv[i + 1]) { title = argv[++i]; continue; }
    if (argv[i] === '--template' && argv[i + 1]) { templateName = argv[++i]; continue; }
    if (argv[i] === '--root' && argv[i + 1]) { rootName = argv[++i]; continue; }
    if (argv[i] === '--config') { i++; continue; }
    if (argv[i] === '--list-templates') {
      listTemplates(config);
      return;
    }
    if (!argv[i].startsWith('-')) positional.push(argv[i]);
  }

  let name = positional[0];
  if (!name) {
    if (isInteractive()) {
      name = await promptText('Document name: ');
      if (!name) die('No name provided.');
    } else {
      die('Usage: dotmd new <name> [--template <t>] [--status <s>] [--title <t>]\n       dotmd new --list-templates');
    }
  }

  // Validate status
  if (!config.validStatuses.has(status)) {
    die(`Invalid status: ${status}\nValid: ${[...config.validStatuses].join(', ')}`);
  }

  // Resolve template
  const template = resolveTemplate(templateName ?? 'default', config);

  // Slugify
  const slug = name.toLowerCase().replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!slug) { die('Name resolves to empty slug: ' + name); }

  // Title
  const docTitle = title ?? name.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  // Resolve target root
  let targetRoot = config.docsRoot;
  if (rootName) {
    const roots = config.docsRoots || [config.docsRoot];
    const match = roots.find(r => r.endsWith(rootName) || path.basename(r) === rootName);
    if (!match) {
      const available = roots.map(r => path.basename(r)).join(', ');
      die(`Unknown root: ${rootName}\nAvailable: ${available}`);
    }
    targetRoot = match;
  }

  // Path
  const filePath = path.join(targetRoot, slug + '.md');
  const repoPath = toRepoPath(filePath, config.repoRoot);

  if (existsSync(filePath)) {
    die(`File already exists: ${repoPath}`);
  }

  const today = new Date().toISOString().slice(0, 10);

  // Generate content
  let content;
  if (typeof template === 'function') {
    content = template(name, { status, title: docTitle, today });
  } else {
    const fm = template.frontmatter(status, today);
    const body = template.body(docTitle);
    content = `---\n${fm}\n---\n${body}`;
  }

  if (dryRun) {
    process.stdout.write(`${dim('[dry-run]')} Would create: ${repoPath}\n`);
    if (templateName) process.stdout.write(`${dim('[dry-run]')} Template: ${templateName}\n`);
    return;
  }

  writeFileSync(filePath, content, 'utf8');
  process.stdout.write(`${green('Created')}: ${repoPath}`);
  if (templateName) process.stdout.write(` ${dim(`(template: ${templateName})`)}`);
  process.stdout.write('\n');

  try { config.hooks.onNew?.({ path: repoPath, status, title: docTitle, template: templateName }); } catch (err) { warn(`Hook 'onNew' threw: ${err.message}`); }
}

function resolveTemplate(name, config) {
  // Config templates take priority
  const configTemplates = config.raw?.templates ?? {};
  if (configTemplates[name]) return configTemplates[name];
  if (BUILTIN_TEMPLATES[name]) return BUILTIN_TEMPLATES[name];

  const available = [...new Set([...Object.keys(BUILTIN_TEMPLATES), ...Object.keys(configTemplates)])];
  die(`Unknown template: ${name}\nAvailable: ${available.join(', ')}`);
}

function listTemplates(config) {
  const configTemplates = config.raw?.templates ?? {};
  const all = { ...BUILTIN_TEMPLATES };
  for (const [k, v] of Object.entries(configTemplates)) {
    all[k] = v;
  }

  process.stdout.write(bold('Available templates') + '\n\n');
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
