import { afterEach, describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let repo;
let externalDir;

function snapshotTree(root) {
  const snapshot = {};
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if (entry.isDirectory()) {
        snapshot[`${rel}/`] = null;
        visit(abs);
      } else {
        snapshot[rel] = readFileSync(abs).toString('base64');
      }
    }
  };
  visit(root);
  return snapshot;
}

function run(args) {
  return spawnSync('node', [BIN, ...args, '--config', path.join(repo, 'dotmd.config.mjs')], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
      DOTMD_JOURNAL: '1',
      TMPDIR: externalDir,
      TMP: externalDir,
      TEMP: externalDir,
    },
  });
}

afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  if (externalDir) rmSync(externalDir, { recursive: true, force: true });
});

describe('passive and dry-run whole-tree invariant', () => {
  it('leaves the worktree byte-identical and invokes no external hooks', () => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'dotmd-passive-tree-'));
    externalDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-passive-external-'));
    const sentinel = path.join(externalDir, 'hook-sentinel');
    mkdirSync(path.join(repo, 'docs', 'plans'), { recursive: true });
    const configPath = path.join(repo, 'dotmd.config.mjs');
    const indexConfig = `export const root = 'docs';\nexport const index = { path: 'docs/docs.md', snapshot: 'state' };\n`;
    writeFileSync(configPath, indexConfig);
    writeFileSync(path.join(repo, 'docs', 'docs.md'), '# Docs\n\n<!-- GENERATED:dotmd:start -->\n<!-- GENERATED:dotmd:end -->\n');
    writeFileSync(path.join(repo, 'docs', 'plans', 'plan.md'), '---\ntype: plan\nstatus: active\nupdated: 2026-07-10\n---\n# Plan\n');
    writeFileSync(path.join(repo, 'docs', 'doc.md'), '---\ntype: doc\nstatus: active\nupdated: 2026-07-10\ntitle: Doc\n---\n# Doc\n\nBody.\n');
    spawnSync('git', ['init'], { cwd: repo });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repo });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
    const indexResult = run(['index']);
    strictEqual(indexResult.status, 0, indexResult.stderr);

    writeFileSync(configPath, `
      import { appendFileSync } from 'node:fs';
      export const root = 'docs';
      export const index = { path: 'docs/docs.md', snapshot: 'state' };
      export const journal = true;
      const mark = (name) => appendFileSync(${JSON.stringify(sentinel)}, name);
      export function validate() { mark('validate'); return {}; }
      export function transformDoc(doc) { mark('transformDoc'); return doc; }
      export function renderCheck(index, fallback) { mark('renderCheck'); return fallback(index); }
      export function formatSnapshot(doc, fallback) { mark('formatSnapshot'); return fallback(doc); }
      export function onPickup() { mark('onPickup'); }
      export function summarizeDoc() { mark('summarizeDoc'); return 'summary'; }
      export const templates = {
        explosive: () => { mark('template'); return '---\\ntype: doc\\nstatus: active\\n---\\n# Preview'; },
      };
    `);
    spawnSync('git', ['add', '.'], { cwd: repo });
    spawnSync('git', ['commit', '-m', 'fixture'], { cwd: repo });

    const before = snapshotTree(repo);
    const externalBefore = snapshotTree(externalDir);
    const commands = [
      ['use', 'docs/plans/plan.md', '--dry-run'],
      ['check', '--json', '--dry-run'],
      ['check', '--dry-run'],
      ['doctor'],
      ['new', 'explosive', 'preview', '--dry-run'],
      ['summary', 'docs/doc.md', '--json', '--dry-run'],
      ['context', '--json', '--summarize', '--dry-run'],
      ['agent-context'],
      ['context', '--json', '--compact'],
      ['hud'],
      ['hud', '--json'],
    ];
    for (const args of commands) {
      const result = run(args);
      strictEqual(result.status, 0, `${args.join(' ')} failed: ${result.stderr}`);
      deepStrictEqual(snapshotTree(repo), before, `${args.join(' ')} mutated the worktree`);
      deepStrictEqual(snapshotTree(externalDir), externalBefore, `${args.join(' ')} left external temporary state`);
    }
    ok(!existsSync(sentinel), 'passive/dry-run commands invoked external hook code');
  });
});
