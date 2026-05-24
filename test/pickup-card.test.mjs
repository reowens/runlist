import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, match } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { walkSections, detectMarker, findActivePhase, summarizePhases } from '../src/section.mjs';

let tmpDir;
const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-card-'));
  spawnSync('git', ['init'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: tmpDir });
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(path.join(docsDir, 'archived'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n`);
  return docsDir;
}

function writeDoc(docsDir, filename, frontmatter, body = '') {
  const filePath = path.join(docsDir, filename);
  writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`);
  spawnSync('git', ['add', filePath], { cwd: tmpDir });
  spawnSync('git', ['commit', '-m', `add ${filename}`], { cwd: tmpDir });
  return filePath;
}

function runCli(args, { session = 'sess-A' } = {}) {
  return spawnSync('node', [bin, ...args, '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: session, PATH: process.env.PATH },
  });
}

afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

describe('walkSections', () => {
  it('extracts H1-H6 with 1-indexed line numbers', () => {
    const body = `\n# Title\n\n## Section A\n\ncontent\n\n## Section B\n\nmore\n`;
    const out = walkSections(body);
    strictEqual(out.length, 3);
    strictEqual(out[0].heading, 'Title');
    strictEqual(out[0].level, 1);
    strictEqual(out[1].heading, 'Section A');
    strictEqual(out[1].lineStart, 4);
    strictEqual(out[2].heading, 'Section B');
  });

  it('ignores headings inside fenced code blocks', () => {
    const body = `# Title\n\n## Real\n\n\`\`\`\n## Fake heading\n\`\`\`\n\n## AlsoReal\n`;
    const out = walkSections(body);
    const headings = out.map(s => s.heading);
    ok(headings.includes('Real'));
    ok(headings.includes('AlsoReal'));
    ok(!headings.includes('Fake heading'), 'must skip headings inside code fence');
  });

  it('computes correct lineEnd by walking until same-or-higher level', () => {
    const body = `# T\n\n## A\nx\n\n### A1\ny\n\n## B\nz\n`;
    const out = walkSections(body);
    const a = out.find(s => s.heading === 'A');
    // A ends right before B at line 9
    strictEqual(a.lineEnd, 8);
  });
});

describe('detectMarker', () => {
  it('recognizes emoji markers', () => {
    strictEqual(detectMarker('Phase 1 — Title ✅'), 'shipped');
    strictEqual(detectMarker('Phase 2 — Title 🟡'), 'in-progress');
    strictEqual(detectMarker('Phase 3 — Title ⬜'), 'todo');
    strictEqual(detectMarker('Phase 4 — Title 🚧'), 'blocked');
    strictEqual(detectMarker('Phase 5 — Title ⏭'), 'skipped');
  });

  it('recognizes text variants for legacy plans', () => {
    strictEqual(detectMarker('Phase 1 — Title shipped 2026-05-12'), 'shipped');
    strictEqual(detectMarker('Phase 2 — Title — SKIPPED'), 'skipped');
    strictEqual(detectMarker('Phase 3 — in-progress'), 'in-progress');
    strictEqual(detectMarker('Phase 4 — Title BLOCKED on legal'), 'blocked');
  });

  it('returns null for unmarked headings', () => {
    strictEqual(detectMarker('Phase 1 — Just a title'), null);
  });
});

describe('findActivePhase', () => {
  it('picks first in-progress phase over later todo', () => {
    const body = `## Phases\n\n### Phase 1 — done ✅\n\n### Phase 2 — wip 🟡\n\n### Phase 3 — todo ⬜\n`;
    const sections = walkSections(body);
    const active = findActivePhase(sections);
    strictEqual(active.heading, 'Phase 2 — wip 🟡');
  });

  it('returns null when all phases are shipped or skipped', () => {
    const body = `## Phases\n\n### Phase 1 — done ✅\n\n### Phase 2 — skip ⏭\n`;
    const sections = walkSections(body);
    strictEqual(findActivePhase(sections), null);
  });

  it('returns first todo when no in-progress exists', () => {
    const body = `### Phase 1 — done ✅\n\n### Phase 2 — todo-a ⬜\n\n### Phase 3 — todo-b ⬜\n`;
    const sections = walkSections(body);
    strictEqual(findActivePhase(sections).heading, 'Phase 2 — todo-a ⬜');
  });
});

describe('pickup card (integration)', () => {
  it('renders pointers not bodies', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01\nnext_step: validate then commit', `# Plan Title

> A short blurb describing the plan.

## Problem

problem body

## Phases

### Phase 1 — old work ✅

shipped already

### Phase 2 — current work 🟡

this is the active phase body — pickup should NOT print this content,
just a pointer to its line range.

### Phase 3 — future ⬜

## Open Questions

- Question one?
- Question two?
- Question three?
`);

    const r = runCli(['pickup', planPath]);
    strictEqual(r.status, 0, `pickup failed: ${r.stderr}`);

    // Card shows ACTIVE phase as pointer, not body
    ok(r.stdout.includes('Active phase: Phase 2 — current work'), 'active phase heading present');
    ok(r.stdout.includes('(lines '), 'line range present');
    ok(!r.stdout.includes('this is the active phase body'), 'active phase BODY should NOT be in card');

    // Open Questions shows count
    ok(/Open Questions: 3\b/.test(r.stdout), `expected 'Open Questions: 3' count, got: ${r.stdout}`);
    ok(!r.stdout.includes('Question one?'), 'individual questions should NOT be in card');

    // Next step from frontmatter
    ok(r.stdout.includes('validate then commit'));

    // Outline includes phase summary
    ok(/## Phases\s+\(3:/.test(r.stdout), 'outline includes phase summary');
  });

  it('--full opts into the full body', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', `# Plan\n\n## Phases\n\n### Phase 1 — active 🟡\n\nFULL_BODY_CONTENT_MARKER\n`);

    const cardResult = runCli(['pickup', planPath]);
    ok(!cardResult.stdout.includes('FULL_BODY_CONTENT_MARKER'), 'card hides phase body');

    // Re-attach via same session with --full
    const fullResult = runCli(['pickup', planPath, '--full']);
    ok(fullResult.stdout.includes('FULL_BODY_CONTENT_MARKER'), 'full prints body');
  });

  it('falls back gracefully on old plans without ## Phases', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'oldplan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', `# Old Plan\n\n## Overview\n\noverview content\n\n## Implementation Plan\n\nimpl content\n\n## Open Questions\n\n- q1\n- q2\n`);

    const r = runCli(['pickup', planPath]);
    strictEqual(r.status, 0, `pickup failed: ${r.stderr}`);
    // No ## Phases → uses last H2 as active section pointer
    ok(r.stdout.includes('Active section:') || r.stdout.includes('Active phase:'), 'shows active section pointer');
    ok(r.stdout.includes('Open Questions: 2'), 'counts open questions');
    ok(r.stdout.includes('Outline:'), 'has outline');
    // Body of any section should NOT be in card
    ok(!r.stdout.includes('overview content'));
    ok(!r.stdout.includes('impl content'));
  });

  it('card output stays well under full body byte size', () => {
    const docsDir = setupProject();
    const bigBody = '# Plan\n\n## Phases\n\n### Phase 1 — active 🟡\n\n' + 'x'.repeat(50000) + '\n\n## Open Questions\n\n' + '- q\n'.repeat(40);
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', bigBody);

    const r = runCli(['pickup', planPath]);
    strictEqual(r.status, 0);
    ok(r.stdout.length < 2000, `card should be tiny vs 50KB body, got ${r.stdout.length} bytes`);
    ok(r.stdout.includes('Open Questions: 40'));
  });

  it('resolves same-dir related_plans basename refs', () => {
    // Pre-fix: pickup-card used `resolveDocPath`, which only tries repo-root
    // and docsRoots-relative paths — never doc-relative. A bare-basename ref
    // like `sibling.md` inside `docs/plans/foo.md`'s `related_plans:` always
    // rendered `(missing)`, even though graph + validate resolve the same ref
    // fine via `resolveRefPath` (which tries doc-relative first). Now matched.
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'plans'), { recursive: true });
    // Sibling first — present so pickup can resolve and read its status.
    const siblingPath = writeDoc(docsDir, 'plans/sibling.md',
      'type: plan\nstatus: planned\nupdated: 2025-01-01', '# Sibling\n');
    // Main plan refs the sibling by bare basename (the natural shorthand).
    const planPath = writeDoc(docsDir, 'plans/foo.md',
      'type: plan\nstatus: active\nupdated: 2025-01-01\nrelated_plans:\n  - sibling.md',
      '# Foo\n');

    const r = runCli(['pickup', planPath]);
    strictEqual(r.status, 0, `pickup failed: ${r.stderr}`);
    ok(r.stdout.includes('Related:'), `expected Related: section, got: ${r.stdout}`);
    ok(!r.stdout.includes('(missing)'),
      `sibling.md should resolve, not show (missing). stdout: ${r.stdout}`);
    // The resolver should also pick up the sibling's status from its frontmatter.
    ok(r.stdout.includes('planned'),
      `Related: line should include sibling status 'planned'. stdout: ${r.stdout}`);
    // Sanity: the ref path printed should be the resolved repo path, not the bare basename.
    ok(r.stdout.includes('docs/plans/sibling.md'),
      `Related: line should show full repo path. stdout: ${r.stdout}`);
    // Keep `siblingPath` used so linters don't drop the write.
    ok(siblingPath.endsWith('sibling.md'));
  });

  it('JSON output includes both card and full body', () => {
    const docsDir = setupProject();
    const planPath = writeDoc(docsDir, 'plan.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', `# Plan\n\n## Phases\n\n### Phase 1 — active 🟡\n\nbody\n`);

    const r = runCli(['pickup', planPath, '--json']);
    strictEqual(r.status, 0);
    const parsed = JSON.parse(r.stdout);
    ok(parsed.card, 'json includes card object');
    ok(parsed.body.includes('body'), 'json includes full body');
    strictEqual(parsed.card.activePhase.heading, 'Phase 1 — active 🟡');
  });
});
