import { describe, it, beforeEach, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmpDir;

function run(args, opts = {}) {
  return spawnSync('node', [BIN, ...args], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    ...opts,
  });
}

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-new-'));
  mkdirSync(path.join(tmpDir, '.git'));
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';`);
  return docsDir;
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('dotmd new', () => {
  it('creates a document and verifies content', () => {
    const docsDir = setupProject();
    const result = run(['new', 'my-feature']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Created'), 'shows Created message');

    const content = readFileSync(path.join(docsDir, 'my-feature.md'), 'utf8');
    ok(content.includes('status: active'), 'has default status');
    ok(content.includes('# My Feature'), 'has title');
    ok(content.startsWith('---\n'), 'starts with frontmatter');
  });

  it('slugifies names with spaces and special chars', () => {
    const docsDir = setupProject();
    const result = run(['new', 'My Cool Feature!']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(existsSync(path.join(docsDir, 'my-cool-feature.md')), 'slugified filename');
  });

  it('--status flag sets the status', () => {
    const docsDir = setupProject();
    const result = run(['new', 'planned-thing', '--status', 'planned']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const content = readFileSync(path.join(docsDir, 'planned-thing.md'), 'utf8');
    ok(content.includes('status: planned'), 'has planned status');
  });

  it('--title flag overrides the title', () => {
    const docsDir = setupProject();
    const result = run(['new', 'slug-name', '--title', 'Custom Title']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const content = readFileSync(path.join(docsDir, 'slug-name.md'), 'utf8');
    ok(content.includes('# Custom Title'), 'has custom title');
  });

  it('refuses to overwrite existing file', () => {
    const docsDir = setupProject();
    writeFileSync(path.join(docsDir, 'exists.md'), '---\nstatus: active\n---\n# Exists\n');

    const result = run(['new', 'exists']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('already exists'), 'shows error');
  });

  it('--dry-run does not create file', () => {
    const docsDir = setupProject();
    const result = run(['new', 'dry-test', '--dry-run']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Would create'), 'shows dry-run message');
    ok(!existsSync(path.join(docsDir, 'dry-test.md')), 'file not created');
  });

  it('rejects invalid status', () => {
    setupProject();
    const result = run(['new', 'bad-status', '--status', 'nonsense']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('Invalid status'), 'shows invalid status error');
  });

  it('--template adr creates ADR scaffold', () => {
    const docsDir = setupProject();
    const result = run(['new', 'my-decision', '--template', 'adr']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const content = readFileSync(path.join(docsDir, 'my-decision.md'), 'utf8');
    ok(content.includes('## Context'), 'has Context section');
    ok(content.includes('## Decision'), 'has Decision section');
    ok(content.includes('## Consequences'), 'has Consequences section');
    ok(content.includes('decision_date:'), 'has decision_date field');
  });

  it('--template rfc creates RFC scaffold', () => {
    const docsDir = setupProject();
    const result = run(['new', 'my-proposal', '--template', 'rfc']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const content = readFileSync(path.join(docsDir, 'my-proposal.md'), 'utf8');
    ok(content.includes('## Summary'), 'has Summary section');
    ok(content.includes('## Motivation'), 'has Motivation section');
    ok(content.includes('## Detailed Design'), 'has Detailed Design section');
    ok(content.includes('## Alternatives'), 'has Alternatives section');
    ok(content.includes('owner:'), 'has owner field');
  });

  it('--template plan creates plan scaffold', () => {
    const docsDir = setupProject();
    const result = run(['new', 'my-plan', '--template', 'plan']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const content = readFileSync(path.join(docsDir, 'my-plan.md'), 'utf8');
    ok(content.includes('## Implementation Plan'), 'has Implementation Plan section');
    ok(content.includes('module:'), 'has module field');
    ok(content.includes('surface:'), 'has surface field');
    ok(content.includes('related_plans:'), 'has related_plans field');
  });

  it('--template audit creates audit scaffold', () => {
    const docsDir = setupProject();
    const result = run(['new', 'my-audit', '--template', 'audit']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const content = readFileSync(path.join(docsDir, 'my-audit.md'), 'utf8');
    ok(content.includes('## Findings'), 'has Findings section');
    ok(content.includes('audit_level:'), 'has audit_level field');
    ok(content.includes('source_of_truth:'), 'has source_of_truth field');
  });

  it('--template design creates design doc scaffold', () => {
    const docsDir = setupProject();
    const result = run(['new', 'my-design', '--template', 'design']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);

    const content = readFileSync(path.join(docsDir, 'my-design.md'), 'utf8');
    ok(content.includes('## Goals'), 'has Goals section');
    ok(content.includes('## Non-Goals'), 'has Non-Goals section');
    ok(content.includes('## Design'), 'has Design section');
  });

  it('default template matches original behavior', () => {
    const docsDir = setupProject();
    run(['new', 'no-template']);
    const content = readFileSync(path.join(docsDir, 'no-template.md'), 'utf8');
    ok(content.includes('status: active'), 'has status');
    ok(content.includes('# No Template'), 'has title');
    ok(!content.includes('## Context'), 'no extra sections');
  });

  it('rejects unknown template', () => {
    setupProject();
    const result = run(['new', 'foo', '--template', 'nonexistent']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('Unknown template'), 'shows error');
    ok(result.stderr.includes('Available'), 'lists available templates');
  });

  it('--list-templates shows available templates', () => {
    setupProject();
    const result = run(['new', '--list-templates']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('default'), 'lists default');
    ok(result.stdout.includes('adr'), 'lists adr');
    ok(result.stdout.includes('rfc'), 'lists rfc');
    ok(result.stdout.includes('plan'), 'lists plan');
    ok(result.stdout.includes('audit'), 'lists audit');
    ok(result.stdout.includes('design'), 'lists design');
  });

  it('--template with --status overrides status', () => {
    const docsDir = setupProject();
    run(['new', 'planned-rfc', '--template', 'rfc', '--status', 'planned']);
    const content = readFileSync(path.join(docsDir, 'planned-rfc.md'), 'utf8');
    ok(content.includes('status: planned'), 'status is planned');
  });

  it('config templates override builtins', () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-new-'));
    mkdirSync(path.join(tmpDir, '.git'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
      export const root = 'docs';
      export const templates = {
        spike: {
          description: 'Timeboxed investigation',
          frontmatter: (s, d) => \`status: \${s}\\nupdated: \${d}\\ntimebox: 2d\`,
          body: (t) => \`\\n# \${t}\\n\\n## Hypothesis\\n\\n\\n\`,
        },
      };
    `);

    const result = run(['new', 'my-spike', '--template', 'spike']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    const content = readFileSync(path.join(tmpDir, 'docs', 'my-spike.md'), 'utf8');
    ok(content.includes('timebox: 2d'), 'has custom field');
    ok(content.includes('## Hypothesis'), 'has custom section');
  });
});
