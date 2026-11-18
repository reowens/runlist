import { describe, it, afterEach } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { watchCliPath } from '../src/watch.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('watch command', () => {
  it('resolves the CLI from decoded file URLs with spaces and reserved characters', () => {
    const modulePath = path.join(os.tmpdir(), 'runlist watch # percent%', 'src', 'watch.mjs');
    strictEqual(
      watchCliPath(pathToFileURL(modulePath)),
      path.resolve(path.dirname(modulePath), '..', 'bin', 'runlist.mjs'),
    );
  });

  it('runs immediately and refreshes after two edits during the initial run', async () => {
    tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dotmd-watch-')));

    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

    const docsDir = path.join(tmpDir, 'docs');
    mkdirSync(docsDir, { recursive: true });

    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      import { readFileSync, writeFileSync } from 'node:fs';
      export const root = 'docs';

      if (process.argv[2] === 'list') {
        const doc = new URL('./docs/test.md', import.meta.url);
        const initial = readFileSync(doc, 'utf8');
        if (initial.includes('Initial Watch State')) {
          // Edit after list prints its initial result, while watch is still
          // waiting for that subprocess to exit.
          process.once('beforeExit', () => {
            writeFileSync(doc, initial.replaceAll('Initial Watch State', 'Intermediate Watch State'));
            writeFileSync(doc, initial.replaceAll('Initial Watch State', 'Final Watch State'));
          });
        }
      }
    `);

    const today = new Date().toISOString().slice(0, 10);
    const docPath = path.join(docsDir, 'test.md');
    writeFileSync(docPath, `---\nstatus: active\nupdated: ${today}\ntitle: Initial Watch State\n---\n# Initial Watch State\n`);
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    const output = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(process.execPath, [BIN, 'watch', 'list'], {
        cwd: tmpDir,
        env: { ...process.env, NO_COLOR: '1' },
      });

      const limit = setTimeout(() => child.kill(), 15_000);
      child.stdout.on('data', (d) => {
        stdout += d.toString();
        if (stdout.includes('Final Watch State')) child.kill();
      });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('error', reject);
      child.on('close', () => {
        clearTimeout(limit);
        resolve({ stdout, stderr });
      });
    });

    ok(output.stderr.includes('Watching'), `stderr should mention Watching, got: ${output.stderr}`);
    ok(output.stderr.includes('runlist list'), `stderr should show command, got: ${output.stderr}`);
    ok(output.stdout.includes('Initial Watch State'), `missing initial state: ${output.stdout}`);
    ok(output.stdout.includes('Final Watch State'), `missing final state after two edits: ${output.stdout}`);
  });

  it('--help shows watch help', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-whelp-'));
    const result = spawnSync('node', [BIN, 'watch', '--help'], {
      cwd: tmpDir,
      encoding: 'utf8',
    });
    ok(result.stdout.includes('re-run a command on file changes'), `help output: ${result.stdout}`);
  });
});
