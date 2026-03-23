import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

const GLOSSARY_TABLE = `# Domain Glossary

## Terminology

| **Term** | **Meaning** | **Tiers** |
|----------|-------------|-----------|
| **Widget** | A reusable UI component | all |
| **Gizmo** | Backend processing unit | premium |
| **Thingamajig** | Legacy adapter layer | deprecated |
`;

function setup(configExtra = '') {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-gloss-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
export const root = 'docs';
export const glossary = {
  path: 'docs/glossary.md',
  section: 'Terminology',
};
${configExtra}`);
  writeFileSync(path.join(tmpDir, 'docs', 'glossary.md'), GLOSSARY_TABLE);
  return path.join(tmpDir, 'docs');
}

function run(args) {
  return spawnSync('node', [BIN, ...args], {
    cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' },
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('glossary matching', () => {
  it('exact match returns single result', () => {
    setup();
    const result = run(['glossary', 'Widget']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Widget'));
    ok(result.stdout.includes('reusable UI component'));
  });

  it('case-insensitive match', () => {
    setup();
    const result = run(['glossary', 'widget']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Widget'));
  });

  it('startsWith match for partial term', () => {
    setup();
    const result = run(['glossary', 'Wid']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Widget'));
  });

  it('substring-in-meaning match', () => {
    setup();
    const result = run(['glossary', 'adapter']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Thingamajig'));
  });

  it('no match prints dim message', () => {
    setup();
    const result = run(['glossary', 'nonexistent']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('No glossary match'));
  });
});

describe('glossary --list', () => {
  it('lists all terms with meanings', () => {
    setup();
    const result = run(['glossary', '--list']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Widget'));
    ok(result.stdout.includes('Gizmo'));
    ok(result.stdout.includes('Thingamajig'));
    ok(result.stdout.includes('3 terms'));
  });
});

describe('glossary --json', () => {
  it('produces valid JSON for a term match', () => {
    setup();
    const result = run(['glossary', '--json', 'Widget']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    ok(Array.isArray(json));
    strictEqual(json[0].term, 'Widget');
    ok('relatedDocs' in json[0]);
    ok('seeAlso' in json[0]);
  });

  it('--json --list produces enriched JSON for all entries', () => {
    setup();
    const result = run(['glossary', '--json', '--list']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const json = JSON.parse(result.stdout);
    strictEqual(json.length, 3);
    ok(json.every(e => 'relatedDocs' in e));
    ok(json.every(e => 'seeAlso' in e));
  });
});

describe('glossary errors', () => {
  it('exits with error when no glossary configured', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-gloss-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
    const result = run(['glossary', 'test']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('No glossary configured'));
  });

  it('exits with error when no term given without --list', () => {
    setup();
    const result = run(['glossary']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('Usage'));
  });

  it('exits with error when glossary section has no entries', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-gloss-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
export const root = 'docs';
export const glossary = { path: 'docs/glossary.md', section: 'Terminology' };`);
    writeFileSync(path.join(tmpDir, 'docs', 'glossary.md'), '# Glossary\n\n## Terminology\n\nNo table here.\n');
    const result = run(['glossary', 'test']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('no entries'));
  });
});
