import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { green, dim } from './color.mjs';

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

export function runInit(cwd) {
  const configPath = path.join(cwd, 'dotmd.config.mjs');
  const docsDir = path.join(cwd, 'docs');
  const indexPath = path.join(docsDir, 'docs.md');

  process.stdout.write('\n');

  if (existsSync(configPath)) {
    process.stdout.write(`  ${dim('exists')}  dotmd.config.mjs\n`);
  } else {
    writeFileSync(configPath, STARTER_CONFIG, 'utf8');
    process.stdout.write(`  ${green('create')}  dotmd.config.mjs\n`);
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

  const today = new Date().toISOString().slice(0, 10);
  process.stdout.write(`\nReady. Create your first doc:\n`);
  process.stdout.write(`  printf '---\\nstatus: active\\nupdated: ${today}\\n---\\n\\n# My Doc\\n' > docs/my-doc.md\n`);
  process.stdout.write(`  dotmd list\n\n`);
}

