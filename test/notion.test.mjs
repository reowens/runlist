import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

let tmpDir;

function run(args, env = {}) {
  const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
  return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir, encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('notion: help', () => {
  it('shows help with no subcommand', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-notion-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);

    const result = run(['notion']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('import'), 'shows import subcommand');
    ok(result.stdout.includes('export'), 'shows export subcommand');
    ok(result.stdout.includes('sync'), 'shows sync subcommand');
  });

  it('shows help with --help', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-notion-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);

    const result = run(['notion', '--help']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('NOTION_TOKEN'), 'mentions token requirement');
  });
});

describe('notion: import errors', () => {
  it('fails without token', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-notion-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);

    // Unset NOTION_TOKEN to ensure clean test
    const result = run(['notion', 'import', 'fake-db-id'], { NOTION_TOKEN: '' });
    strictEqual(result.status, 1);
    ok(result.stderr.includes('No Notion token') || result.stderr.includes('NOTION_TOKEN'), 'shows token error');
  });

  it('fails without database ID', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-notion-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);

    const result = run(['notion', 'import'], { NOTION_TOKEN: 'fake-token' });
    strictEqual(result.status, 1);
    ok(result.stderr.includes('No database ID') || result.stderr.includes('database'), 'shows db error');
  });
});

describe('notion: export errors', () => {
  it('fails without token', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-notion-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);

    const result = run(['notion', 'export', 'fake-db-id'], { NOTION_TOKEN: '' });
    strictEqual(result.status, 1);
    ok(result.stderr.includes('No Notion token') || result.stderr.includes('NOTION_TOKEN'), 'shows token error');
  });
});

describe('notion: unknown subcommand', () => {
  it('fails with helpful error', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-notion-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);

    const result = run(['notion', 'banana'], { NOTION_TOKEN: 'fake' });
    strictEqual(result.status, 1);
    ok(result.stderr.includes('Unknown notion subcommand'), 'shows error');
  });
});
