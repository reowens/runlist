import { watch } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { dim } from './color.mjs';

export function runWatch(argv, config) {
  const subCommand = argv.length > 0 ? argv : ['list'];
  const cliPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'dotmd.mjs');

  let lastRun = 0;
  const DEBOUNCE = 300;

  function run() {
    const now = Date.now();
    if (now - lastRun < DEBOUNCE) return;
    lastRun = now;

    // Clear terminal
    process.stdout.write('\x1b[2J\x1b[H');
    process.stderr.write(dim(`[${new Date().toLocaleTimeString()}] dotmd ${subCommand.join(' ')}`) + '\n\n');

    spawnSync(process.execPath, [cliPath, ...subCommand], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
  }

  // Run once immediately
  run();

  process.stderr.write(dim(`\nWatching ${config.docsRoot} for changes... (Ctrl+C to stop)`) + '\n');

  // Watch for changes
  const watcher = watch(config.docsRoot, { recursive: true }, (eventType, filename) => {
    if (filename && filename.endsWith('.md')) {
      run();
    }
  });

  // Clean exit
  process.on('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });

  // Keep alive
  setInterval(() => {}, 1 << 30);
}
