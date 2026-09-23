import { describe, it, afterEach } from 'node:test';
import { strictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('closed stdout', () => {
  it('exits 0 with nothing on stderr when the reader stops early', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-epipe-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'));
    mkdirSync(path.join(tmpDir, '.runlist'));
    writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), "export const root = 'docs';\n");
    writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\ntype: doc\nstatus: current\n---\n# A\n');
    // Far more than a pipe buffer holds, so the write after `head` exits fails.
    const events = [];
    for (let i = 1; i <= 3000; i++) {
      events.push(JSON.stringify({
        event: 'add', id: `F${i}`, file: 'docs/a.md', line: 5, severity: 'warn',
        text: `synthetic finding ${i} ${'x'.repeat(80)}`, by: { kind: 'check', name: 'fixture' }, at: '2026-01-01T00:00:00Z',
      }));
    }
    writeFileSync(path.join(tmpDir, '.runlist', 'flags.jsonl'), `${events.join('\n')}\n`);

    const result = spawnSync('bash', ['-c', `set -o pipefail; node "${BIN}" flags --all | head -1 >/dev/null`], {
      cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
    });
    strictEqual(result.stderr, '');
    strictEqual(result.status, 0);
  });
});
