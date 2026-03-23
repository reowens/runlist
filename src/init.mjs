import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { green, dim } from './color.mjs';
import { warn } from './util.mjs';
import { scaffoldClaudeCommands } from './claude-commands.mjs';

const STARTER_CONFIG = `// dotmd.config.mjs — document management configuration
// All exports are optional. See dotmd.config.example.mjs for full reference.

export const root = 'docs';

export const index = {
  path: 'docs/docs.md',
  startMarker: '<!-- GENERATED:dotmd:start -->',
  endMarker: '<!-- GENERATED:dotmd:end -->',
  archivedLimit: 8,
};
`;

const STARTER_INDEX = `# Docs

<!-- GENERATED:dotmd:start -->

_No docs yet. Run \`dotmd list\` after creating your first document._

<!-- GENERATED:dotmd:end -->
`;

function scanExistingDocs(dir) {
  const statuses = new Set();
  const surfaces = new Set();
  const modules = new Set();
  const refFieldNames = new Set();
  let docCount = 0;

  function walk(d) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch (err) { warn(`Could not read ${d}: ${err.message}`); return; }
    for (const entry of entries) {
      if (entry.isDirectory()) { walk(path.join(d, entry.name)); continue; }
      if (!entry.name.endsWith('.md')) continue;
      let raw;
      try { raw = readFileSync(path.join(d, entry.name), 'utf8'); } catch (err) { warn(`Could not read ${entry.name}: ${err.message}`); continue; }
      const { frontmatter } = extractFrontmatter(raw);
      if (!frontmatter) continue;
      const parsed = parseSimpleFrontmatter(frontmatter);
      docCount++;
      if (parsed.status) statuses.add(String(parsed.status).toLowerCase());
      if (parsed.surface) surfaces.add(String(parsed.surface));
      if (Array.isArray(parsed.surfaces)) parsed.surfaces.forEach(s => surfaces.add(String(s)));
      if (parsed.module) modules.add(String(parsed.module));
      if (Array.isArray(parsed.modules)) parsed.modules.forEach(m => modules.add(String(m)));
      for (const [key, val] of Object.entries(parsed)) {
        if (Array.isArray(val) && val.some(v => String(v).endsWith('.md'))) {
          refFieldNames.add(key);
        }
      }
    }
  }

  walk(dir);
  return { docCount, statuses, surfaces, modules, refFieldNames };
}

function generateDetectedConfig(scan, rootPath) {
  const lines = [`// dotmd.config.mjs — auto-detected from ${scan.docCount} existing docs`, ''];
  lines.push(`export const root = '${rootPath}';`);
  lines.push('');

  const defaultOrder = ['active', 'ready', 'planned', 'research', 'blocked', 'reference', 'archived'];
  const ordered = defaultOrder.filter(s => scan.statuses.has(s));
  const extra = [...scan.statuses].filter(s => !defaultOrder.includes(s)).sort();
  const allStatuses = [...ordered, ...extra];
  if (allStatuses.length > 0) {
    lines.push('export const statuses = {');
    lines.push(`  order: [${allStatuses.map(s => `'${s}'`).join(', ')}],`);
    lines.push('};');
    lines.push('');
  }

  if (scan.surfaces.size > 0) {
    lines.push('export const taxonomy = {');
    lines.push(`  surfaces: [${[...scan.surfaces].sort().map(s => `'${s}'`).join(', ')}],`);
    lines.push('};');
    lines.push('');
  }

  if (scan.refFieldNames.size > 0) {
    const names = [...scan.refFieldNames].sort();
    lines.push('export const referenceFields = {');
    lines.push(`  bidirectional: [${names.map(n => `'${n}'`).join(', ')}],`);
    lines.push('  unidirectional: [],');
    lines.push('};');
    lines.push('');
  }

  lines.push('export const index = {');
  lines.push(`  path: '${rootPath}/docs.md',`);
  lines.push(`  startMarker: '<!-- GENERATED:dotmd:start -->',`);
  lines.push(`  endMarker: '<!-- GENERATED:dotmd:end -->',`);
  lines.push('};');
  lines.push('');

  return lines.join('\n');
}

export function runInit(cwd, config) {
  const configPath = path.join(cwd, 'dotmd.config.mjs');
  const docsDir = path.join(cwd, 'docs');
  const indexPath = path.join(docsDir, 'docs.md');

  process.stdout.write('\n');

  if (existsSync(configPath)) {
    process.stdout.write(`  ${dim('exists')}  dotmd.config.mjs\n`);
  } else {
    const scan = existsSync(docsDir) ? scanExistingDocs(docsDir) : null;
    if (scan && scan.docCount > 0) {
      writeFileSync(configPath, generateDetectedConfig(scan, 'docs'), 'utf8');
      process.stdout.write(`  ${green('create')}  dotmd.config.mjs (detected ${scan.docCount} docs)\n`);
    } else {
      writeFileSync(configPath, STARTER_CONFIG, 'utf8');
      process.stdout.write(`  ${green('create')}  dotmd.config.mjs\n`);
    }
  }

  if (existsSync(docsDir)) {
    process.stdout.write(`  ${dim('exists')}  docs/\n`);
  } else {
    mkdirSync(docsDir, { recursive: true });
    process.stdout.write(`  ${green('create')}  docs/\n`);
  }

  if (existsSync(indexPath)) {
    process.stdout.write(`  ${dim('exists')}  docs/docs.md\n`);
  } else {
    writeFileSync(indexPath, STARTER_INDEX, 'utf8');
    process.stdout.write(`  ${green('create')}  docs/docs.md\n`);
  }

  // Claude Code integration — auto-detect .claude/ directory
  if (config) {
    const results = scaffoldClaudeCommands(cwd, config);
    for (const r of results) {
      if (r.action === 'created') {
        process.stdout.write(`  ${green('create')}  .claude/commands/${r.name}\n`);
      } else if (r.action === 'current') {
        process.stdout.write(`  ${dim('current')} .claude/commands/${r.name}\n`);
      }
    }
  }

  process.stdout.write(`\nReady. Create your first doc:\n`);
  process.stdout.write(`  dotmd new my-doc\n`);
  process.stdout.write(`  dotmd list\n\n`);
}
