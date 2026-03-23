import { fixBrokenRefs } from './fix-refs.mjs';
import { runLint } from './lint.mjs';
import { runTouch } from './lifecycle.mjs';
import { buildIndex } from './index.mjs';
import { renderIndexFile, writeIndex } from './index-file.mjs';
import { renderCheck } from './render.mjs';
import { bold, dim, green, yellow } from './color.mjs';
import { scaffoldClaudeCommands } from './claude-commands.mjs';

export function runDoctor(argv, config, opts = {}) {
  const { dryRun } = opts;
  process.stdout.write(bold('dotmd doctor') + '\n\n');

  // Step 1: Fix broken references
  process.stdout.write(bold('1. Fixing broken references...') + '\n');
  fixBrokenRefs(config, { dryRun });

  // Step 2: Lint --fix
  process.stdout.write('\n' + bold('2. Fixing frontmatter issues...') + '\n');
  runLint(['--fix'], config, { dryRun });

  // Step 3: Sync dates from git
  process.stdout.write('\n' + bold('3. Syncing dates from git...') + '\n');
  runTouch(['--git'], config, { dryRun });

  // Step 4: Regenerate index
  if (config.indexPath) {
    process.stdout.write('\n' + bold('4. Regenerating index...') + '\n');
    if (!dryRun) {
      const index = buildIndex(config);
      writeIndex(renderIndexFile(index, config), config);
      process.stdout.write('Index updated.\n');
    } else {
      process.stdout.write('[dry-run] Would regenerate index.\n');
    }
  }

  // Step 5: Refresh Claude Code commands
  const claudeResults = dryRun ? [] : scaffoldClaudeCommands(config.repoRoot, config);
  if (claudeResults.some(r => r.action !== 'current' && r.action !== 'skipped')) {
    process.stdout.write('\n' + bold('5. Claude Code commands:') + '\n');
    for (const r of claudeResults) {
      if (r.action === 'updated') {
        process.stdout.write(`${green('Updated')} .claude/commands/${r.name} (v${r.from} → v${r.to})\n`);
      } else if (r.action === 'created') {
        process.stdout.write(`${green('Created')} .claude/commands/${r.name}\n`);
      }
    }
  }

  // Step 6: Show remaining check
  process.stdout.write('\n' + bold('6. Remaining issues:') + '\n');
  const freshIndex = buildIndex(config);
  process.stdout.write(renderCheck(freshIndex, config));
}
