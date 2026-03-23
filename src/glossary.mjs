import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { buildIndex } from './index.mjs';
import { die, warn } from './util.mjs';
import { bold, dim, green, yellow } from './color.mjs';

function parseGlossaryTable(content, sectionHeading) {
  // Find the section
  const headingRegex = new RegExp(`^##\\s+${sectionHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
  const match = content.match(headingRegex);
  if (!match) return [];

  const sectionStart = match.index + match[0].length;
  // Find next heading or end
  const nextHeading = content.indexOf('\n## ', sectionStart);
  const section = nextHeading > -1 ? content.slice(sectionStart, nextHeading) : content.slice(sectionStart);

  // Parse markdown table rows (skip header + separator)
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

    // Skip separator row
    if (cells.every(c => /^[-:]+$/.test(c))) continue;

    // Strip bold markers from term
    const term = cells[0]?.replace(/\*\*/g, '').trim();
    if (!term) continue;

    const entry = { term };
    for (let i = 1; i < columns.length; i++) {
      entry[columns[i]] = cells[i] || '';
    }
    entries.push(entry);
  }

  // Also parse schema→UI mappings (list items after the table)
  const mappingRegex = /^-\s+`([^`]+)`\s+→\s+"([^"]+)"\s*(?:\(([^)]+)\))?/gm;
  let m;
  while ((m = mappingRegex.exec(section)) !== null) {
    entries.push({ term: m[1], meaning: `UI label: "${m[2]}"${m[3] ? ` (${m[3]})` : ''}`, tiers: 'schema→UI' });
  }

  return entries;
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
  return parseGlossaryTable(content, section);
}

export function runGlossary(argv, config) {
  const json = argv.includes('--json');
  const listAll = argv.includes('--list');
  const term = argv.find(a => !a.startsWith('-'));

  const entries = loadGlossary(config);
  if (!entries) die('No glossary configured. Add glossary: { path, section } to your dotmd config.');
  if (entries.length === 0) die('Glossary section found but no entries parsed.');

  if (json && listAll) {
    process.stdout.write(JSON.stringify(entries, null, 2) + '\n');
    return;
  }

  if (listAll) {
    process.stdout.write(bold('Glossary') + dim(` (${entries.length} terms)`) + '\n\n');
    const maxTerm = Math.max(...entries.map(e => e.term.length));
    for (const entry of entries) {
      const meaning = entry.meaning || '';
      process.stdout.write(`  ${green(entry.term.padEnd(maxTerm + 2))} ${meaning}\n`);
    }
    return;
  }

  if (!term) die('Usage: dotmd glossary <term> | --list | --json');

  // Fuzzy match: case-insensitive substring
  const lower = term.toLowerCase();
  const matches = entries.filter(e =>
    e.term.toLowerCase().includes(lower) ||
    (e.meaning && e.meaning.toLowerCase().includes(lower))
  );

  if (json) {
    const index = buildIndex(config);
    const enriched = matches.map(entry => {
      const termLower = entry.term.toLowerCase();
      const related = index.docs
        .filter(d => d.module?.toLowerCase() === termLower || d.modules?.some(m => m.toLowerCase() === termLower) || d.path.toLowerCase().includes(termLower))
        .map(d => ({ path: d.path, status: d.status, type: d.type, title: d.title }));
      return { ...entry, relatedDocs: related };
    });
    process.stdout.write(JSON.stringify(enriched, null, 2) + '\n');
    return;
  }

  if (matches.length === 0) {
    process.stdout.write(dim(`No glossary match for "${term}".`) + '\n');
    return;
  }

  // Build index for cross-referencing
  const index = buildIndex(config);

  for (const entry of matches) {
    process.stdout.write(`${green(bold(entry.term))}\n`);
    if (entry.meaning) process.stdout.write(`  ${entry.meaning}\n`);
    if (entry.tiers) process.stdout.write(`  ${dim(`Tiers: ${entry.tiers}`)}\n`);

    // Find related docs: module match, path match, or title/summary match
    const termLower = entry.term.toLowerCase();
    const relatedDocs = index.docs.filter(d => {
      if (d.module?.toLowerCase() === termLower) return true;
      if (d.modules?.some(m => m.toLowerCase() === termLower)) return true;
      if (d.path.toLowerCase().includes(termLower)) return true;
      return false;
    });

    if (relatedDocs.length > 0) {
      // Group by type/status
      const moduleDocs = relatedDocs.filter(d => d.root?.includes('modules'));
      const activePlans = relatedDocs.filter(d => d.type === 'plan' && d.status === 'active');
      const pausedPlans = relatedDocs.filter(d => d.type === 'plan' && d.status === 'paused');
      const readyPlans = relatedDocs.filter(d => d.type === 'plan' && d.status === 'ready');
      const plannedPlans = relatedDocs.filter(d => d.type === 'plan' && d.status === 'planned');
      const blockedPlans = relatedDocs.filter(d => d.type === 'plan' && d.status === 'blocked');
      const researchPlans = relatedDocs.filter(d => d.type === 'plan' && d.status === 'research');

      process.stdout.write('\n');

      if (moduleDocs.length > 0) {
        process.stdout.write(`  ${bold('Module docs:')}\n`);
        for (const d of moduleDocs.slice(0, 5)) {
          process.stdout.write(`    ${dim(d.path)}\n`);
        }
        if (moduleDocs.length > 5) process.stdout.write(`    ${dim(`...and ${moduleDocs.length - 5} more`)}\n`);
      }

      const planGroups = [
        ['Active', activePlans],
        ['Paused', pausedPlans],
        ['Ready', readyPlans],
        ['Planned', plannedPlans],
        ['Blocked', blockedPlans],
        ['Research', researchPlans],
      ];

      for (const [label, plans] of planGroups) {
        if (plans.length === 0) continue;
        process.stdout.write(`  ${bold(`${label} plans:`)} `);
        process.stdout.write(plans.map(d => path.basename(d.path, '.md')).join(', ') + '\n');
      }
    }

    process.stdout.write('\n');
  }
}

// Export for use by other modules (e.g. plan generation)
export { loadGlossary };
