// Phase 1 of docs/plans/dotmd-review-findings-followups.md — dispatcher and
// global-filter correctness. Covers:
//   - global flags work BEFORE the command (not just after)
//   - --root/--type reach early-dispatched commands (plans, runlists, presets)
//   - filtered JSON reflects the active filters (filters echo + countsByType)
import { describe, it, before, after } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

let tmpDir;
let configPath;

function writeDoc(rel, { type, status, title }) {
  const file = path.join(tmpDir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---\ntype: ${type}\nstatus: ${status}\ntitle: ${title}\n---\n# ${title}\n\nbody\n`);
}

// Run the CLI with EXACTLY the args given — no implicit --config appended, so
// tests control flag position (the whole point of this suite).
function run(args) {
  return spawnSync('node', [bin, ...args], { cwd: tmpDir, encoding: 'utf8' });
}

before(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-dispatch-'));
  spawnSync('git', ['init', '-q'], { cwd: tmpDir });
  configPath = path.join(tmpDir, 'dotmd.config.mjs');
  writeFileSync(
    configPath,
    `export const root = 'docs';\nexport const journal = false;\nexport const presets = { everything: [] };\n`,
  );
  writeDoc('docs/plans/p1.md', { type: 'plan', status: 'active', title: 'Plan One' });
  writeDoc('docs/plans/p2.md', { type: 'plan', status: 'planned', title: 'Plan Two' });
  writeDoc('docs/d1.md', { type: 'doc', status: 'reference', title: 'Doc One' });
  writeDoc('docs/prompts/pr1.md', { type: 'prompt', status: 'pending', title: 'Prompt One' });
});

after(() => { rmSync(tmpDir, { recursive: true, force: true }); });

describe('global flags before the command', () => {
  it('resolves the command when --config precedes it', () => {
    const r = run(['--config', configPath, 'list']);
    strictEqual(r.status, 0);
    ok(!/Unknown command/.test(r.stdout + r.stderr), 'should not treat --config as the command');
    ok(/Index/.test(r.stdout), 'list output rendered');
  });

  it('still works when --config follows the command (documented contract preserved)', () => {
    const r = run(['list', '--config', configPath]);
    strictEqual(r.status, 0);
    ok(/Index/.test(r.stdout));
  });

  it('honors a pre-command --type filter', () => {
    const r = run(['--config', configPath, '--type', 'plan', 'json']);
    strictEqual(r.status, 0);
    const idx = JSON.parse(r.stdout);
    deepStrictEqual([...new Set(idx.docs.map(d => d.type))], ['plan']);
  });
});

describe('early-dispatched commands honor --root/--type', () => {
  it('plans --root <unknown> narrows to nothing', () => {
    const r = run(['--config', configPath, 'plans', '--root', 'zzznope']);
    strictEqual(r.status, 0);
    ok(/No plans found/.test(r.stdout), `expected empty plans, got: ${r.stdout}`);
  });

  it('plans --root <real> still lists plans', () => {
    const r = run(['--config', configPath, 'plans', '--root', 'docs']);
    strictEqual(r.status, 0);
    ok(/Plan One|Plan Two|plans/.test(r.stdout), `expected plans, got: ${r.stdout}`);
  });

  it('preset honors a global --type filter via applyIndexFilters', () => {
    const r = run(['--config', configPath, 'everything', '--type', 'plan', '--json']);
    strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout);
    strictEqual(out.count, 2, 'only the two plans remain');
    deepStrictEqual([...new Set(out.docs.map(d => d.type))], ['plan']);
  });

  it('preset honors a global --root filter (unknown root → empty)', () => {
    const r = run(['--config', configPath, 'everything', '--root', 'zzznope', '--json']);
    strictEqual(r.status, 0);
    strictEqual(JSON.parse(r.stdout).count, 0);
  });
});

describe('filtered JSON reflects the active filters', () => {
  it('query --type doc --json echoes filters.types and narrows results', () => {
    const r = run(['--config', configPath, 'query', '--type', 'doc', '--json']);
    strictEqual(r.status, 0);
    const out = JSON.parse(r.stdout);
    deepStrictEqual(out.filters.types, ['doc'], 'filter echo reflects the global --type');
    strictEqual(out.count, 1);
    deepStrictEqual([...new Set(out.docs.map(d => d.type))], ['doc']);
  });

  it('query --root <name> --json echoes filters.root', () => {
    const r = run(['--config', configPath, 'query', '--root', 'docs', '--json']);
    strictEqual(r.status, 0);
    strictEqual(JSON.parse(r.stdout).filters.root, 'docs');
  });

  it('json --type recomputes countsByType to the filtered set', () => {
    const r = run(['--config', configPath, 'json', '--type', 'doc']);
    strictEqual(r.status, 0);
    const idx = JSON.parse(r.stdout);
    deepStrictEqual(Object.keys(idx.countsByType), ['doc'], 'countsByType is no longer corpus-wide');
  });

  it('agent-context --type prompt recomputes countsByType', () => {
    const r = run(['--config', configPath, 'agent-context', '--type', 'prompt']);
    strictEqual(r.status, 0);
    const ctx = JSON.parse(r.stdout);
    deepStrictEqual(Object.keys(ctx.countsByType), ['prompt']);
  });
});
