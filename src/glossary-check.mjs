import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { suggestCandidates } from './util.mjs';

function sectionHeadingRegex(sectionHeading) {
  return new RegExp(`^##\\s+${sectionHeading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');
}

export function checkGlossaryConfig(config) {
  const glossaryConfig = config.raw?.glossary;
  if (!glossaryConfig?.path) return [];

  const filePath = path.resolve(config.repoRoot, glossaryConfig.path);
  if (!existsSync(filePath)) {
    return [{
      path: glossaryConfig.path,
      level: 'warning',
      message: `Glossary file configured at \`${glossaryConfig.path}\` but the file does not exist.`,
    }];
  }

  const content = readFileSync(filePath, 'utf8');
  const section = glossaryConfig.section ?? 'Terminology';
  if (sectionHeadingRegex(section).test(content)) return [];

  const headings = [...content.matchAll(/^##\s+(.+?)\s*$/gm)].map(m => m[1].trim());
  const suggestions = suggestCandidates(section, headings, 3);
  const nearby = suggestions.length ? suggestions : headings.slice(0, 3);
  const hint = nearby.length ? ` Nearby headings: ${nearby.map(s => `\`${s}\``).join(', ')}.` : '';
  return [{
    path: glossaryConfig.path,
    level: 'warning',
    message: `Glossary config points at section \`## ${section}\`, but that heading is missing in \`${glossaryConfig.path}\`.${hint} Update \`glossary.path\` / \`glossary.section\` or restore the heading.`,
  }];
}
