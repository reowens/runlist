// Phase 3 of docs/plans/dotmd-review-findings-followups.md — lifecycle edge
// cases. Two fixes:
//   1. `dotmd set <archive-status>` preserves a configured custom archive
//      status (e.g. `done` with archive:true) instead of forcing `archived`.
//   2. Archiving rewrites every outbound ref shape from the moved file:
//      inline scalar frontmatter, flow arrays, and body links with #anchors.
import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

function init(configBody) {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-p3-'));
  spawnSync('git', ['init', '-q'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: tmpDir });
  mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), configBody);
}

function writeDoc(rel, content) {
  const file = path.join(tmpDir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function commit() {
  spawnSync('git', ['add', '-A'], { cwd: tmpDir });
  spawnSync('git', ['commit', '-qm', 'init'], { cwd: tmpDir });
}

function run(args) {
  return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')],
    { cwd: tmpDir, encoding: 'utf8' });
}

// Find a file by basename anywhere under docs/ (it has moved to archived/).
function findArchived(basename) {
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === basename && p.includes(`${path.sep}archived${path.sep}`)) hits.push(p);
    }
  };
  walk(path.join(tmpDir, 'docs'));
  return hits[0];
}

describe('set <archive-status> preserves a custom archive status', () => {
  const config = `
export const root = 'docs';
export const journal = false;
export const types = {
  plan: { statuses: {
    active: { context: 'expanded' },
    done: { context: 'counted', archive: true },
  } },
};
`;

  it('writes the exact target status, not a hard-coded "archived"', () => {
    init(config);
    writeDoc('docs/plans/feature.md', `---\ntype: plan\nstatus: active\ntitle: Feature\nupdated: 2026-01-01T00:00:00Z\n---\n# Feature\n`);
    commit();

    const r = run(['set', 'done', 'docs/plans/feature.md']);
    strictEqual(r.status, 0, `set done should succeed: ${r.stderr}`);

    const moved = findArchived('feature.md');
    ok(moved, 'file moved under archived/');
    const content = readFileSync(moved, 'utf8');
    ok(/^status: done$/m.test(content), `status should stay 'done', got:\n${content}`);
    ok(!/^status: archived$/m.test(content), 'must not be rewritten to archived');
  });
});

describe('archiving rewrites all outbound ref shapes from the moved file', () => {
  const config = `export const root = 'docs';\nexport const journal = false;\n`;

  function seed() {
    init(config);
    // Hub points back at the child via a flow array (exercises inbound flow-array
    // rewriting — validated by check since the hub stays active).
    writeDoc('docs/plans/hub.md',
      `---\ntype: plan\nstatus: active\ntitle: Hub\nupdated: 2026-01-01T00:00:00Z\nrelated_plans: [child.md]\n---\n# Hub\n`);
    // Child uses every shape the old code missed.
    writeDoc('docs/plans/child.md',
      `---\ntype: plan\nstatus: active\ntitle: Child\nupdated: 2026-01-01T00:00:00Z\nparent_plan: hub.md\nrelated_plans: [hub.md]\n---\n# Child\n\nSee [the hub](hub.md#goals) for context.\n`);
    commit();
  }

  it('rewrites inline scalar, flow array, and anchored body link', () => {
    seed();
    const r = run(['archive', 'docs/plans/child.md']);
    strictEqual(r.status, 0, `archive should succeed: ${r.stderr}`);

    const moved = findArchived('child.md');
    const content = readFileSync(moved, 'utf8');
    ok(/^parent_plan: \.\.\/plans\/hub\.md$/m.test(content), `inline scalar rewritten, got:\n${content}`);
    ok(/^related_plans: \[\.\.\/plans\/hub\.md\]$/m.test(content), `flow array rewritten, got:\n${content}`);
    ok(/\]\(\.\.\/plans\/hub\.md#goals\)/.test(content), `body link + anchor rewritten, got:\n${content}`);

    // Every rewritten ref must resolve to the real hub from the new location.
    const movedDir = path.dirname(moved);
    ok(existsSync(path.resolve(movedDir, '../plans/hub.md')), 'rewritten refs resolve to the real file');
  });

  it('keeps dotmd check free of broken-reference complaints', () => {
    seed();
    run(['archive', 'docs/plans/child.md']);
    const check = run(['check', '--verbose']);
    ok(!/does not resolve to an existing file/.test(check.stdout + check.stderr),
      `no ref should be left dangling, got:\n${check.stdout}\n${check.stderr}`);
  });

  it('rewrites the inbound flow-array ref in the still-active hub', () => {
    seed();
    run(['archive', 'docs/plans/child.md']);
    const hub = readFileSync(path.join(tmpDir, 'docs', 'plans', 'hub.md'), 'utf8');
    ok(/related_plans: \[\.\.\/archived\/child\.md\]/.test(hub), `hub ref should point at archived child, got:\n${hub}`);
  });

  it('rewrites a quoted scalar ref, preserving the quotes', () => {
    init(config);
    writeDoc('docs/plans/hub.md',
      `---\ntype: plan\nstatus: active\ntitle: Hub\nupdated: 2026-01-01T00:00:00Z\n---\n# Hub\n`);
    writeDoc('docs/plans/child.md',
      `---\ntype: plan\nstatus: active\ntitle: Child\nupdated: 2026-01-01T00:00:00Z\nparent_plan: "hub.md"\n---\n# Child\n`);
    commit();

    const r = run(['archive', 'docs/plans/child.md']);
    strictEqual(r.status, 0, `archive should succeed: ${r.stderr}`);
    const content = readFileSync(findArchived('child.md'), 'utf8');
    ok(/^parent_plan: "\.\.\/plans\/hub\.md"$/m.test(content), `quoted scalar rewritten in place, got:\n${content}`);
  });
});
