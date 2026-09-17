import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { buildIndex } from './index.mjs';
import { die, warn, suggestCandidates } from './util.mjs';
import { bold, dim, green, yellow } from './color.mjs';

function sectionHeadingRegex(sectionHeading) {
  return new RegExp(`^##\\s+${sectionHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
}

function parseGlossaryTable(content, sectionHeading) {
  const headingRegex = sectionHeadingRegex(sectionHeading);
  const match = content.match(headingRegex);
  if (!match) return { found: false, entries: [] };

  const sectionStart = match.index + match[0].length;
  const nextHeading = content.indexOf('\n## ', sectionStart);
  const section = nextHeading > -1 ? content.slice(sectionStart, nextHeading) : content.slice(sectionStart);

  const entries = [];
  const lines = section.split('\n');
  let headerParsed = false;
  let columns = [];

  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());

    if (!headerParsed) {
      columns = cells.map(c => c.toLowerCase().replace(/\*\*/g, ''));
      headerParsed = true;
      continue;
    }

    if (cells.every(c => /^[-:]+$/.test(c))) continue;

    const term = cells[0]?.replace(/\*\*/g, '').trim();
    if (!term) continue;

    const entry = { term };
    for (let i = 1; i < columns.length; i++) {
      entry[columns[i]] = cells[i] || '';
    }
    entries.push(entry);
  }

  // Schema→UI mappings
  const mappingRegex = /^-\s+`([^`]+)`\s+→\s+"([^"]+)"\s*(?:\(([^)]+)\))?/gm;
  let m;
  while ((m = mappingRegex.exec(section)) !== null) {
    entries.push({ term: m[1], meaning: `UI label: "${m[2]}"${m[3] ? ` (${m[3]})` : ''}`, tiers: 'schema→UI' });
  }

  return { found: true, entries };
}

function loadGlossary(config) {
  const glossaryConfig = config.raw?.glossary;
  if (!glossaryConfig?.path) return null;

  const filePath = path.resolve(config.repoRoot, glossaryConfig.path);
  if (!existsSync(filePath)) {
    warn(`Glossary file not found: ${glossaryConfig.path}`);
    return null;
  }

  const content = readFileSync(filePath, 'utf8');
  const section = glossaryConfig.section ?? 'Terminology';
  const result = parseGlossaryTable(content, section);
  return { ...result, path: glossaryConfig.path, section };
}

function matchTerm(query, entries) {
  const lower = query.toLowerCase();

  // Exact match first
  const exact = entries.filter(e => e.term.toLowerCase() === lower);
  if (exact.length > 0) return exact;

  // Term starts with query
  const startsWith = entries.filter(e => e.term.toLowerCase().startsWith(lower));
  if (startsWith.length > 0) return startsWith;

  // Substring in term
  const termMatch = entries.filter(e => e.term.toLowerCase().includes(lower));
  if (termMatch.length > 0) return termMatch;

  // Substring in meaning (broadest)
  return entries.filter(e => e.meaning?.toLowerCase().includes(lower));
}

function findRelatedDocs(entry, index) {
  const termLower = entry.term.toLowerCase();
  // Split compound terms like "Trail / Summit / Expedition"
  const termParts = entry.term.split(/\s*\/\s*/).map(t => t.trim().toLowerCase());

  return index.docs.filter(d => {
    // Module match (exact)
    if (d.module?.toLowerCase() === termLower) return true;
    if (d.modules?.some(m => m.toLowerCase() === termLower)) return true;
    // Module match on term parts
    if (termParts.some(p => d.module?.toLowerCase() === p || d.modules?.some(m => m.toLowerCase() === p))) return true;
    // Path contains term (for terms like "example-term" that aren't modules)
    if (termParts.some(p => p.length >= 4 && d.path.toLowerCase().includes(p))) return true;
    // Title match
    if (termParts.some(p => p.length >= 4 && d.title?.toLowerCase().includes(p))) return true;
    return false;
  });
}

function findSeeAlso(entry, allEntries) {
  const termLower = entry.term.toLowerCase();
  const parts = entry.term.split(/\s*\/\s*/).map(t => t.trim().toLowerCase());

  return allEntries.filter(other => {
    if (other.term === entry.term) return false;
    const otherLower = other.term.toLowerCase();
    // Other term contains this term or vice versa
    if (otherLower.includes(termLower) || termLower.includes(otherLower)) return true;
    // Other meaning references this term
    if (other.meaning?.toLowerCase().includes(termLower)) return true;
    // Part match
    if (parts.some(p => p.length >= 4 && (otherLower.includes(p) || other.meaning?.toLowerCase().includes(p)))) return true;
    return false;
  });
}

function renderEntry(entry, index, allEntries) {
  const lines = [];
  lines.push(`${green(bold(entry.term))}`);
  if (entry.meaning) lines.push(`  ${entry.meaning}`);
  if (entry.tiers) lines.push(`  ${dim(`Tiers: ${entry.tiers}`)}`);

  const relatedDocs = findRelatedDocs(entry, index);

  if (relatedDocs.length > 0) {
    lines.push('');

    // Module entry point (the main module doc, e.g. ledger.md)
    const entryPoint = relatedDocs.find(d =>
      d.root?.includes('modules') && path.basename(d.path, '.md') === entry.term.toLowerCase()
    );
    if (entryPoint) {
      lines.push(`  ${bold('Entry point:')} ${entryPoint.path}`);
    }

    // Other module docs (count, not list)
    const moduleDocs = relatedDocs.filter(d => d.root?.includes('modules') && d !== entryPoint);
    if (moduleDocs.length > 0) {
      lines.push(`  ${bold('Module docs:')} ${moduleDocs.length} files in ${dim(path.dirname(moduleDocs[0].path))}`);
    }

    // Plans grouped by status
    const planGroups = [
      ['Active', 'active'],
      ['Paused', 'paused'],
      ['Ready', 'ready'],
      ['Planned', 'planned'],
      ['Blocked', 'blocked'],
      ['Research', 'research'],
    ];

    for (const [label, status] of planGroups) {
      const plans = relatedDocs.filter(d => d.type === 'plan' && d.status === status);
      if (plans.length === 0) continue;
      lines.push(`  ${bold(`${label}:`)} ${plans.map(d => path.basename(d.path, '.md')).join(', ')}`);
    }
  }

  // See also: related glossary terms
  const seeAlso = findSeeAlso(entry, allEntries);
  if (seeAlso.length > 0) {
    lines.push(`  ${dim('See also:')} ${seeAlso.map(e => e.term).join(', ')}`);
  }

  lines.push('');
  return lines.join('\n');
}

export function runGlossary(argv, config) {
  const json = argv.includes('--json');
  const listAll = argv.includes('--list');
  const term = argv.find(a => !a.startsWith('-'));

  const result = loadGlossary(config);
  if (!result) die('No glossary configured. Add glossary: { path, section } to your runlist config.');
  if (!result.found) {
    die(`Glossary section "## ${result.section}" not found in ${result.path}. Add the section, or update glossary.section in runlist.config.mjs.`);
  }
  if (result.entries.length === 0) {
    die(`Glossary section "## ${result.section}" found in ${result.path} but contains no recognizable entries (expected markdown table or schema→UI bullets).`);
  }
  const entries = result.entries;

  if (json && listAll) {
    const index = buildIndex(config);
    const enriched = entries.map(entry => ({
      ...entry,
      relatedDocs: findRelatedDocs(entry, index).map(d => ({ path: d.path, status: d.status, type: d.type, title: d.title })),
      seeAlso: findSeeAlso(entry, entries).map(e => e.term),
    }));
    process.stdout.write(JSON.stringify(enriched, null, 2) + '\n');
    return;
  }

  if (listAll) {
    process.stdout.write(bold('Glossary') + dim(` (${entries.length} terms)`) + '\n\n');
    const maxTerm = Math.max(...entries.map(e => e.term.length));
    for (const entry of entries) {
      process.stdout.write(`  ${green(entry.term.padEnd(maxTerm + 2))} ${entry.meaning || ''}\n`);
    }
    return;
  }

  if (!term) die('Usage: runlist glossary <term> | --list | --json');

  const matches = matchTerm(term, entries);

  if (json) {
    const index = buildIndex(config);
    const enriched = matches.map(entry => ({
      ...entry,
      relatedDocs: findRelatedDocs(entry, index).map(d => ({ path: d.path, status: d.status, type: d.type, title: d.title })),
      seeAlso: findSeeAlso(entry, entries).map(e => e.term),
    }));
    process.stdout.write(JSON.stringify(enriched, null, 2) + '\n');
    return;
  }

  if (matches.length === 0) {
    const suggestions = suggestCandidates(term, entries.map(e => e.term));
    const hint = suggestions.length ? ` Did you mean: ${suggestions.join(', ')}?` : '';
    process.stdout.write(dim(`No glossary match for "${term}".${hint}`) + '\n');
    return;
  }

  const index = buildIndex(config);
  for (const entry of matches) {
    process.stdout.write(renderEntry(entry, index, entries));
  }
}

export { loadGlossary };
