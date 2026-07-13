import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter } from './frontmatter.mjs';
import { buildIndex } from './index.mjs';
import { buildGraph } from './graph.mjs';
import { resolveDocPath, resolveRefPath, toRepoPath, capitalize, die } from './util.mjs';
import { allocateOutputIdentities } from './output-identity.mjs';

export function runExport(argv, config, opts = {}) {
  const positional = [];
  let format = 'md';
  let output = null;
  let statusFilter = null;
  let moduleFilter = null;
  let rootFilter = opts.root ?? null;
  let typeFilter = opts.type ?? null;
  const dryRun = opts.dryRun;

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--format' && argv[i + 1]) { format = argv[++i]; continue; }
    if (argv[i] === '--output' && argv[i + 1]) { output = argv[++i]; continue; }
    if (argv[i] === '--status' && argv[i + 1]) { statusFilter = argv[++i]; continue; }
    if (argv[i] === '--module' && argv[i + 1]) { moduleFilter = argv[++i]; continue; }
    if (argv[i] === '--root' && argv[i + 1]) { rootFilter = argv[++i]; continue; }
    if (argv[i] === '--type' && argv[i + 1]) { typeFilter = argv[++i]; continue; }
    if (argv[i] === '--config') { i++; continue; }
    if (argv[i].startsWith('-')) continue;
    positional.push(argv[i]);
  }

  if (!['md', 'html', 'json'].includes(format)) {
    die(`Invalid format: ${format}\nValid: md, html, json`);
  }

  const index = buildIndex(config);
  let docs;

  if (positional[0]) {
    // Single doc + deps mode
    const filePath = resolveDocPath(positional[0], config);
    if (!filePath) die(`File not found: ${positional[0]}`);
    const repoPath = toRepoPath(filePath, config.repoRoot);
    const graph = buildGraph(index, config);
    const depPaths = collectDeps(repoPath, graph);
    docs = index.docs.filter(d => depPaths.has(d.path));
  } else {
    // All docs, filtered
    docs = index.docs;
    if (statusFilter) {
      const statuses = statusFilter.split(',').map(s => s.trim());
      docs = docs.filter(d => statuses.includes(d.status));
    }
    if (moduleFilter) {
      const m = moduleFilter.toLowerCase();
      docs = docs.filter(d => (d.module ?? '').toLowerCase() === m || (d.modules ?? []).some(mod => mod.toLowerCase() === m));
    }
    if (rootFilter) {
      docs = docs.filter(d => d.root === rootFilter || d.root?.endsWith('/' + rootFilter) || d.root?.split('/').pop() === rootFilter);
    }
    if (typeFilter) {
      const types = typeFilter.split(',').map(t => t.trim()).filter(Boolean);
      docs = docs.filter(d => types.includes(d.type));
    }
  }

  if (docs.length === 0) {
    die('No docs to export.');
  }

  // Load bodies
  const docsWithBody = docs.map(d => loadDocWithBody(d, config));

  const prefix = dryRun ? '[dry-run] ' : '';

  if (format === 'md') {
    if (dryRun) {
      process.stdout.write(`${prefix}Would export ${docs.length} docs as markdown`);
      process.stdout.write(output ? ` to ${output}\n` : ' to stdout\n');
    } else {
      const content = exportMarkdown(docsWithBody, config);
      if (output) {
        writeFileSync(output, content, 'utf8');
        process.stdout.write(`Exported ${docs.length} docs to ${output}\n`);
      } else {
        process.stdout.write(content);
      }
    }
  } else if (format === 'json') {
    if (dryRun) {
      process.stdout.write(`${prefix}Would export ${docs.length} docs as JSON`);
      process.stdout.write(output ? ` to ${output}\n` : ' to stdout\n');
    } else {
      const content = exportJson(docsWithBody);
      if (output) {
        writeFileSync(output, content, 'utf8');
        process.stdout.write(`Exported ${docs.length} docs to ${output}\n`);
      } else {
        process.stdout.write(content);
      }
    }
  } else if (format === 'html') {
    const outDir = output ?? 'dotmd-export';
    const identities = allocateOutputIdentities(index.docs);
    exportHtml(docsWithBody, config, outDir, identities, { dryRun });
    if (dryRun) {
      process.stdout.write(`${prefix}Would export ${docs.length} docs as HTML to ${outDir}/\n`);
    } else {
      process.stdout.write(`Exported ${docs.length} docs to ${outDir}/\n`);
    }
  }
}

function loadDocWithBody(doc, config) {
  const raw = readFileSync(path.join(config.repoRoot, doc.path), 'utf8');
  const { body } = extractFrontmatter(raw);
  return { ...doc, body: body ?? '' };
}

function collectDeps(docPath, graph) {
  const visited = new Set();
  const queue = [docPath];
  while (queue.length) {
    const p = queue.shift();
    if (visited.has(p)) continue;
    visited.add(p);
    for (const e of graph.edges) {
      if (e.source === p && !e.broken && !visited.has(e.target)) {
        queue.push(e.target);
      }
    }
  }
  return visited;
}

// ── Markdown export ────────────────────────────────────────────────────

function exportMarkdown(docs, config) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [`# Docs Export (${today})`, '', `${docs.length} documents`, ''];

  const byStatus = {};
  for (const d of docs) {
    const s = d.status ?? 'unknown';
    if (!byStatus[s]) byStatus[s] = [];
    byStatus[s].push(d);
  }

  for (const status of config.statusOrder) {
    const group = byStatus[status];
    if (!group?.length) continue;
    lines.push(`## ${capitalize(status)} (${group.length})`, '');
    for (const doc of group) {
      lines.push(`### ${doc.title}`);
      const meta = [`Status: ${doc.status}`];
      if (doc.updated) meta.push(`Updated: ${doc.updated}`);
      if (doc.modules?.length) meta.push(`Module: ${doc.modules.join(', ')}`);
      if (doc.surfaces?.length) meta.push(`Surface: ${doc.surfaces.join(', ')}`);
      if (doc.owner) meta.push(`Owner: ${doc.owner}`);
      lines.push(`> ${meta.join(' | ')}`, '');
      if (doc.body.trim()) lines.push(doc.body.trim());
      lines.push('', '---', '');
    }
  }

  // Statuses not in config order
  for (const [status, group] of Object.entries(byStatus)) {
    if (config.statusOrder.includes(status)) continue;
    lines.push(`## ${capitalize(status)} (${group.length})`, '');
    for (const doc of group) {
      lines.push(`### ${doc.title}`);
      lines.push(`> Status: ${doc.status}`, '');
      if (doc.body.trim()) lines.push(doc.body.trim());
      lines.push('', '---', '');
    }
  }

  return lines.join('\n').trimEnd() + '\n';
}

// ── JSON export ────────────────────────────────────────────────────────

function exportJson(docs) {
  return JSON.stringify({
    exportedAt: new Date().toISOString(),
    count: docs.length,
    docs: docs.map(d => ({
      path: d.path,
      root: d.root,
      title: d.title,
      status: d.status,
      updated: d.updated,
      created: d.created,
      owner: d.owner,
      module: d.module,
      modules: d.modules,
      surface: d.surface,
      surfaces: d.surfaces,
      domain: d.domain,
      summary: d.summary,
      currentState: d.currentState,
      nextStep: d.nextStep,
      blockers: d.blockers,
      body: d.body,
    })),
  }, null, 2) + '\n';
}

// ── HTML export ────────────────────────────────────────────────────────

const CSS = `
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem 1rem; color: #1a1a1a; line-height: 1.6; }
nav { margin-bottom: 2rem; font-size: 0.9rem; }
nav a { color: #0066cc; text-decoration: none; }
nav a:hover { text-decoration: underline; }
h1 { border-bottom: 2px solid #e0e0e0; padding-bottom: 0.5rem; }
h2 { color: #333; margin-top: 2rem; }
h3 { color: #555; }
table.meta { border-collapse: collapse; margin: 1rem 0; font-size: 0.9rem; }
table.meta td { padding: 0.25rem 1rem 0.25rem 0; }
table.meta td:first-child { font-weight: 600; color: #666; }
.badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 3px; font-size: 0.8rem; font-weight: 600; }
.badge-active { background: #d4edda; color: #155724; }
.badge-ready { background: #cce5ff; color: #004085; }
.badge-planned { background: #fff3cd; color: #856404; }
.badge-blocked { background: #f8d7da; color: #721c24; }
.badge-research { background: #e2d5f1; color: #4a2572; }
.badge-archived { background: #e9ecef; color: #495057; }
article { margin-top: 1rem; }
pre { background: #f5f5f5; padding: 1rem; border-radius: 4px; overflow-x: auto; }
code { background: #f0f0f0; padding: 0.15rem 0.3rem; border-radius: 3px; font-size: 0.9em; }
pre code { background: none; padding: 0; }
blockquote { border-left: 3px solid #ddd; margin-left: 0; padding-left: 1rem; color: #666; }
hr { border: none; border-top: 1px solid #e0e0e0; margin: 2rem 0; }
a { color: #0066cc; }
ul.toc { list-style: none; padding-left: 0; }
ul.toc li { padding: 0.3rem 0; }
ul.toc .status-group { font-weight: 600; margin-top: 1rem; }
`.trim();

function exportHtml(docs, config, outDir, identities, { dryRun = false } = {}) {
  const emittedPaths = new Set(docs.map(doc => doc.path));
  const pages = [{ htmlPath: 'index.html', content: buildIndexPage(docs, config, identities) }];
  for (const doc of docs) {
    const identity = identities.get(doc.path);
    if (!identity) throw new Error(`Missing output identity for ${doc.path}`);
    pages.push({
      htmlPath: identity.htmlPath,
      content: buildDocPage(doc, identity, identities, emittedPaths, config),
    });
  }

  const guard = createOutputGuard(outDir);
  for (const page of pages) guard.validate(page.htmlPath);
  if (dryRun) return;

  for (const page of pages) {
    guard.createParent(page.htmlPath);
    guard.validate(page.htmlPath);
    writeFileSync(path.join(guard.outputRoot, ...page.htmlPath.split('/')), page.content, 'utf8');
  }
}

function buildIndexPage(docs, config, identities) {
  const today = new Date().toISOString().slice(0, 10);
  const byStatus = {};
  for (const d of docs) {
    const s = d.status ?? 'unknown';
    if (!byStatus[s]) byStatus[s] = [];
    byStatus[s].push(d);
  }

  let toc = '';
  for (const status of [...config.statusOrder, ...Object.keys(byStatus).filter(s => !config.statusOrder.includes(s))]) {
    const group = byStatus[status];
    if (!group?.length) continue;
    toc += `<li class="status-group">${capitalize(status)} (${group.length})</li>\n`;
    for (const doc of group) {
      const identity = identities.get(doc.path);
      toc += `<li><a href="${escHtml(identity.htmlUrl)}">${escHtml(doc.title)}</a></li>\n`;
    }
  }

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Docs Export</title>
<style>${CSS}</style>
</head><body>
<h1>Docs Export</h1>
<p>${docs.length} documents &middot; ${today}</p>
<ul class="toc">
${toc}</ul>
</body></html>
`;
}

function buildDocPage(doc, identity, identities, emittedPaths, config) {
  const status = doc.status ?? 'unknown';
  const badgeClass = `badge-${status.replace(/[^a-z0-9_-]/gi, '-')}`;

  let meta = `<table class="meta">`;
  meta += `<tr><td>Status</td><td><span class="badge ${badgeClass}">${escHtml(status)}</span></td></tr>`;
  if (doc.updated) meta += `<tr><td>Updated</td><td>${escHtml(doc.updated)}</td></tr>`;
  if (doc.modules?.length) meta += `<tr><td>Module</td><td>${escHtml(doc.modules.join(', '))}</td></tr>`;
  if (doc.surfaces?.length) meta += `<tr><td>Surface</td><td>${escHtml(doc.surfaces.join(', '))}</td></tr>`;
  if (doc.owner) meta += `<tr><td>Owner</td><td>${escHtml(doc.owner)}</td></tr>`;
  meta += `<tr><td>Path</td><td><code>${escHtml(doc.path)}</code></td></tr>`;
  meta += `</table>`;

  const bodyHtml = mdToHtml(doc.body, href => resolveHtmlLink(href, doc, identity, identities, emittedPaths, config));
  const indexHref = relativeHtmlUrl(identity.htmlPath, 'index.html');

  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(doc.title)}</title>
<style>${CSS}</style>
</head><body>
<nav><a href="${escHtml(indexHref)}">&larr; Index</a></nav>
<article>
<h1>${escHtml(doc.title)}</h1>
${meta}
${bodyHtml}
</article>
</body></html>
`;
}

function mdToHtml(body, resolveLink = href => href) {
  if (!body?.trim()) return '';
  let html = escHtml(body);

  // Fenced code blocks (must be before other replacements)
  html = html.replace(/^```(\w*)\n([\s\S]*?)^```/gm, (_, lang, code) =>
    `<pre><code>${code.trimEnd()}</code></pre>`
  );

  // Headings
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold and italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Inline code (skip already-processed pre/code blocks)
  html = html.replace(/(?<!<code>)`([^`]+)`/g, '<code>$1</code>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, escapedHref) => {
    const href = resolveLink(unescapeHtml(escapedHref));
    return href == null ? label : `<a href="${escHtml(href)}">${label}</a>`;
  });

  // Blockquotes
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');

  // Lists
  html = html.replace(/^- (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');

  // Checklists
  html = html.replace(/<li>\[x\] /gi, '<li>&#9745; ');
  html = html.replace(/<li>\[ \] /g, '<li>&#9744; ');

  // Paragraphs (lines not already wrapped in HTML)
  html = html.replace(/^(?!<[hublopa]|<pre|<li|<hr|<block|$)(.+)$/gm, '<p>$1</p>');

  return html;
}

function escHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function unescapeHtml(text) {
  return text.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}

function encodeRelativeUrl(value) {
  return value.split('/').map(segment => segment === '..' || segment === '.' ? segment : encodeURIComponent(segment)).join('/');
}

function relativeHtmlUrl(from, to) {
  const relative = path.posix.relative(path.posix.dirname(from), to) || path.posix.basename(to);
  return encodeRelativeUrl(relative);
}

function resolveHtmlLink(href, doc, identity, identities, emittedPaths, config) {
  if (!href || href.startsWith('#') || href.startsWith('/') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
    return href;
  }

  const hashAt = href.indexOf('#');
  const targetPart = hashAt === -1 ? href : href.slice(0, hashAt);
  const fragment = hashAt === -1 ? '' : href.slice(hashAt);
  if (!targetPart.toLowerCase().endsWith('.md')) return href;

  const docDir = path.dirname(path.join(config.repoRoot, doc.path));
  const resolved = resolveRefPath(targetPart, docDir, config.repoRoot);
  const targetPath = resolved ? toRepoPath(resolved, config.repoRoot) : null;
  if (!targetPath || !emittedPaths.has(targetPath)) return null;
  return relativeHtmlUrl(identity.htmlPath, identities.get(targetPath).htmlPath) + fragment;
}

function nearestExistingAncestor(value) {
  let current = value;
  while (true) {
    try {
      lstatSync(current);
      return current;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Cannot resolve output ancestor: ${value}`);
    current = parent;
  }
}

function createOutputGuard(outDir) {
  const outputRoot = path.resolve(outDir);
  const initialAncestor = nearestExistingAncestor(outputRoot);
  const initialAncestorPhysical = realpathSync(initialAncestor);
  const outputRootPhysical = existsSync(outputRoot)
    ? realpathSync(outputRoot)
    : path.resolve(initialAncestorPhysical, path.relative(initialAncestor, outputRoot));

  if (existsSync(outputRoot) && !statSync(outputRoot).isDirectory()) {
    throw new Error(`HTML output root is not a directory: ${outputRoot}`);
  }

  function validate(htmlPath) {
    const destination = path.resolve(outputRoot, ...htmlPath.split('/'));
    if (destination === outputRoot || !destination.startsWith(outputRoot + path.sep)) {
      throw new Error(`HTML output escapes destination: ${htmlPath}`);
    }

    const currentAncestor = nearestExistingAncestor(outputRoot);
    const currentPhysical = realpathSync(currentAncestor);
    const currentRootPhysical = existsSync(outputRoot)
      ? realpathSync(outputRoot)
      : path.resolve(currentPhysical, path.relative(currentAncestor, outputRoot));
    if (currentRootPhysical !== outputRootPhysical) {
      throw new Error(`HTML output ancestry changed during export: ${outputRoot}`);
    }

    let current = outputRoot;
    const components = htmlPath.split('/');
    for (let i = 0; i < components.length; i++) {
      const component = components[i];
      current = path.join(current, component);
      let entry;
      try { entry = lstatSync(current); } catch (err) {
        if (err.code === 'ENOENT') break;
        throw err;
      }
      if (entry.isSymbolicLink()) {
        throw new Error(`HTML output path contains a descendant symlink: ${current}`);
      }
      const isDestination = i === components.length - 1;
      if ((!isDestination && !entry.isDirectory()) || (isDestination && entry.isDirectory())) {
        throw new Error(`HTML output path has an incompatible existing entry: ${current}`);
      }
    }
  }

  function createParent(htmlPath) {
    if (!existsSync(outputRoot)) {
      const ancestor = nearestExistingAncestor(outputRoot);
      let current = ancestor;
      for (const component of path.relative(ancestor, outputRoot).split(path.sep).filter(Boolean)) {
        validate(htmlPath);
        current = path.join(current, component);
        if (!existsSync(current)) mkdirSync(current);
      }
    }
    let current = outputRoot;
    const components = htmlPath.split('/').slice(0, -1);
    for (const component of components) {
      validate(htmlPath);
      current = path.join(current, component);
      if (!existsSync(current)) mkdirSync(current);
      if (!statSync(current).isDirectory()) throw new Error(`HTML output parent is not a directory: ${current}`);
    }
  }

  return { outputRoot, validate, createParent };
}
