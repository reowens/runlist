import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, throws } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { renderIndexFile, checkIndex, writeIndex } from '../src/index-file.mjs';
import { resolveConfig } from '../src/config.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

const INDEX_CONFIG = `
export const root = 'docs';
export const index = {
  path: 'docs/docs.md',
  startMarker: '<!-- START -->',
  endMarker: '<!-- END -->',
};`;

function setup() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-idxfile-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), INDEX_CONFIG);
  writeFileSync(path.join(tmpDir, 'docs', 'docs.md'), '# Docs\n\n<!-- START -->\n\nold content\n\n<!-- END -->\n');
  return path.join(tmpDir, 'docs');
}

function writeDoc(docsDir, name, frontmatter, body = '') {
  writeFileSync(path.join(docsDir, name), `---\n${frontmatter}\n---\n${body}`);
}

function run(args) {
  return spawnSync('node', [BIN, ...args], {
    cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('renderIndexFile', () => {
  it('renders generated block between markers', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# A\n\n**Status:** Working on it.');
    const config = await resolveConfig(tmpDir);
    const { buildIndex } = await import('../src/index.mjs');
    const index = buildIndex(config);
    const result = renderIndexFile(index, config);
    ok(result.includes('<!-- START -->'));
    ok(result.includes('<!-- END -->'));
    ok(result.includes('A'));
  });

  it('preserves content before start and after end marker', async () => {
    const docsDir = setup();
    writeFileSync(path.join(docsDir, 'docs.md'), 'BEFORE\n<!-- START -->\nold\n<!-- END -->\nAFTER');
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# A\n\n**Status:** ok');
    const config = await resolveConfig(tmpDir);
    const { buildIndex } = await import('../src/index.mjs');
    const index = buildIndex(config);
    const result = renderIndexFile(index, config);
    ok(result.startsWith('BEFORE\n<!-- START -->'));
    ok(result.endsWith('<!-- END -->\nAFTER'));
  });

  it('throws when markers are missing', async () => {
    const docsDir = setup();
    writeFileSync(path.join(docsDir, 'docs.md'), '# Docs\nNo markers here');
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# A');
    const config = await resolveConfig(tmpDir);
    const { buildIndex } = await import('../src/index.mjs');
    const index = buildIndex(config);
    throws(() => renderIndexFile(index, config), /missing generated block markers/i);
  });

  it('groups docs by status as markdown tables', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# Active Doc\n\n**Status:** Working.');
    writeDoc(docsDir, 'b.md', 'status: planned\nupdated: 2025-01-01', '# Planned Doc\n\n**Status:** Later.');
    const config = await resolveConfig(tmpDir);
    const { buildIndex } = await import('../src/index.mjs');
    const index = buildIndex(config);
    const result = renderIndexFile(index, config);
    ok(result.includes('## Active'));
    ok(result.includes('## Planned'));
    ok(result.includes('| Doc | Status |'));
  });

  it('uses status-only snapshots by default to avoid stale current_state mirrors', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01\ncurrent_state: Volatile work note', '# A\n');
    const config = await resolveConfig(tmpDir);
    const { buildIndex } = await import('../src/index.mjs');
    const index = buildIndex(config);
    const result = renderIndexFile(index, config);
    ok(result.includes('| [A](a.md) | Active |'), result);
    ok(!result.includes('Volatile work note'), result);
  });

  it('can opt into current_state snapshots for generated indexes', async () => {
    const docsDir = setup();
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
export const root = 'docs';
export const index = {
  path: 'docs/docs.md',
  startMarker: '<!-- START -->',
  endMarker: '<!-- END -->',
  snapshot: 'state',
};`);
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01\ncurrent_state: Rich work note', '# A\n');
    const config = await resolveConfig(tmpDir);
    const { buildIndex } = await import('../src/index.mjs');
    const index = buildIndex(config);
    const result = renderIndexFile(index, config);
    ok(result.includes('| Doc | Status Snapshot |'), result);
    ok(result.includes('Active: Rich work note'), result);
  });
});

describe('checkIndex', () => {
  it('returns empty when no indexPath configured', async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-idxfile-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    writeDoc(path.join(tmpDir, 'docs'), 'a.md', 'status: active\nupdated: 2025-01-01', '# A');
    const config = await resolveConfig(tmpDir);
    const result = checkIndex([], config);
    strictEqual(result.warnings.length, 0);
    strictEqual(result.errors.length, 0);
  });

  it('returns error when markers are missing', async () => {
    const docsDir = setup();
    writeFileSync(path.join(docsDir, 'docs.md'), '# Docs\nno markers');
    const config = await resolveConfig(tmpDir);
    const result = checkIndex([], config);
    ok(result.errors.some(e => e.message.includes('markers')));
  });

  it('returns error when generated block is stale', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# New Doc\n\n**Status:** Fresh.');
    const config = await resolveConfig(tmpDir);
    const result = checkIndex([/* empty — different from what's on disk */], config);
    ok(result.errors.some(e => e.message.includes('stale')));
  });

  it('returns no error when index is up to date', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# A\n\n**Status:** ok');
    const config = await resolveConfig(tmpDir);
    const { buildIndex } = await import('../src/index.mjs');
    const index = buildIndex(config);
    // Write the up-to-date index
    const rendered = renderIndexFile(index, config);
    writeIndex(rendered, config);
    // Now check — should be clean
    const result = checkIndex(index.docs, config);
    strictEqual(result.errors.length, 0);
  });

  it('auto-heals stale index when buildIndex is called with autoHealIndex: true', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# A\n\n**Status:** ok');
    const config = await resolveConfig(tmpDir);
    const { buildIndex } = await import('../src/index.mjs');
    // Opt in: rewrites the stale on-disk block, returns a warning, no error.
    const index = buildIndex(config, { autoHealIndex: true });
    const expected = renderIndexFile(index, config);
    const onDisk = readFileSync(config.indexPath, 'utf8');
    strictEqual(onDisk, expected, 'buildIndex should leave the file in sync');
    const followUp = checkIndex(index.docs, config, { autoHeal: true });
    strictEqual(followUp.errors.length, 0);
    strictEqual(followUp.warnings.length, 0);
  });

  it('buildIndex without autoHealIndex leaves a drifted file untouched', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# A\n\n**Status:** ok');
    const config = await resolveConfig(tmpDir);
    const { buildIndex } = await import('../src/index.mjs');
    const before = readFileSync(config.indexPath, 'utf8');
    const index = buildIndex(config);
    const after = readFileSync(config.indexPath, 'utf8');
    strictEqual(after, before, 'no opt-in → no mutation');
    ok(index.errors.some(e => /stale/.test(e.message)),
      'should still surface the stale error for callers that want it');
  });

  it('auto-heal rewrites a drifted file and emits a warning', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# A\n\n**Status:** ok');
    const config = await resolveConfig(tmpDir);
    const { buildIndex } = await import('../src/index.mjs');
    const index = buildIndex(config);
    // Drift the file: overwrite the generated block region with a stale stub.
    writeFileSync(config.indexPath, '# Docs\n\n<!-- START -->\n\nold content\n\n<!-- END -->\n', 'utf8');
    const result = checkIndex(index.docs, config, { autoHeal: true });
    strictEqual(result.errors.length, 0, 'should not error');
    ok(result.warnings.some(w => /auto-regenerated/i.test(w.message)),
      'should emit auto-regenerated warning');
    const expected = renderIndexFile(index, config);
    const onDisk = readFileSync(config.indexPath, 'utf8');
    strictEqual(onDisk, expected, 'file should now match the rendered output');
  });
});

describe('writeIndex', () => {
  it('writes content to indexPath', async () => {
    setup();
    const config = await resolveConfig(tmpDir);
    writeIndex('new content', config);
    const content = readFileSync(config.indexPath, 'utf8');
    strictEqual(content, 'new content');
  });
});

describe('index CLI', () => {
  it('updates the index file by default and emits a confirmation line', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# A\n\n**Status:** ok');
    const result = run(['index']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Updated'), `expected confirmation, got: ${result.stdout}`);
    const content = readFileSync(path.join(docsDir, 'docs.md'), 'utf8');
    ok(content.includes('A'));
  });

  it('--print emits rendered index to stdout without writing', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# A\n\n**Status:** ok');
    const before = readFileSync(path.join(docsDir, 'docs.md'), 'utf8');
    const result = run(['index', '--print']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Active'));
    const after = readFileSync(path.join(docsDir, 'docs.md'), 'utf8');
    strictEqual(before, after, 'file should be untouched in --print mode');
  });

  it('--dry-run does not modify the file', () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'status: active\nupdated: 2025-01-01', '# A\n\n**Status:** ok');
    const before = readFileSync(path.join(docsDir, 'docs.md'), 'utf8');
    const result = run(['index', '--dry-run']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('[dry-run]'));
    const after = readFileSync(path.join(docsDir, 'docs.md'), 'utf8');
    strictEqual(before, after);
  });
});
