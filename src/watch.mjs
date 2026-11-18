import { watch } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dim } from './color.mjs';

export function watchCliPath(moduleUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', 'bin', 'runlist.mjs');
}

export function runWatch(argv, config) {
  const subCommand = argv.length > 0 ? argv : ['list'];
  const cliPath = watchCliPath();

  let refreshTimer;
  const DEBOUNCE = 300;

  function run() {
    // Clear terminal
    process.stdout.write('\x1b[2J\x1b[H');
    process.stderr.write(dim(`[${new Date().toLocaleTimeString()}] runlist ${subCommand.join(' ')}`) + '\n\n');

    spawnSync(process.execPath, [cliPath, ...subCommand], {
      stdio: 'inherit',
      cwd: process.cwd(),
    });
  }

  const roots = config.docsRoots || [config.docsRoot];
  // Subscribe before the initial run so edits during it are queued.
  const watchers = roots.map(root =>
    watch(root, { recursive: true }, (eventType, filename) => {
      if (filename && filename.endsWith('.md')) {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(run, DEBOUNCE);
      }
    })
  );

  run();
  process.stderr.write(dim(`\nWatching ${roots.length} root(s) for changes... (Ctrl+C to stop)`) + '\n');

  // Clean exit
  process.on('SIGINT', () => {
    clearTimeout(refreshTimer);
    for (const w of watchers) w.close();
    process.exit(0);
  });

  // Keep alive
  setInterval(() => {}, 1 << 30);
}
