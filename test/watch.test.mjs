import { describe, it, afterEach } from 'node:test';
import { ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('watch command', () => {
  it('runs the subcommand once immediately then watches', async () => {
    tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'dotmd-watch-')));

    spawnSync('git', ['init'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

    const docsDir = path.join(tmpDir, 'docs');
    mkdirSync(docsDir, { recursive: true });

    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = 'docs';
    `);

    const today = new Date().toISOString().slice(0, 10);
    const docPath = path.join(docsDir, 'test.md');
    writeFileSync(docPath, `---\nstatus: active\nupdated: ${today}\ntitle: Watch Test\n---\n# Watch Test\n`);
    spawnSync('git', ['add', '.'], { cwd: tmpDir });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: tmpDir });

    // Spawn watch as a child process, collect output, kill after a short delay
    const output = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const child = spawn('node', [BIN, 'watch', 'list'], {
        cwd: tmpDir,
        env: { ...process.env, NO_COLOR: '1' },
      });

      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      // Give it enough time to run the initial command
      setTimeout(() => {
        child.kill('SIGTERM');
        resolve({ stdout, stderr });
      }, 2000);

      child.on('error', reject);
    });

    // The initial run should have produced list output
    // stderr should mention "Watching" and show the timestamp
    ok(output.stderr.includes('Watching'), `stderr should mention Watching, got: ${output.stderr}`);
    ok(output.stderr.includes('dotmd list'), `stderr should show command, got: ${output.stderr}`);
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
