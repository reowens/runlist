import { describe, it, afterEach } from 'node:test';
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

describe('dotmd new — type-first CLI', () => {
  describe('type defaults', () => {
    it('`dotmd new <name>` (no type) defaults to doc with enriched template', () => {
      const docsDir = setupProject();
      const r = run(['new', 'my-feature']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      const content = readFileSync(path.join(docsDir, 'my-feature.md'), 'utf8');
      ok(content.includes('type: doc'), 'type is doc');
      ok(content.includes('# My Feature'));
      // Enriched frontmatter
      ok(content.includes('modules: []'), 'has modules array');
      ok(content.includes('surfaces: []'), 'has surfaces array');
      ok(content.includes('domain:'), 'has domain');
      ok(content.includes('audience: internal'), 'has audience');
      ok(content.includes('related_plans: []'), 'has related_plans');
      ok(content.includes('related_docs: []'), 'has related_docs');
      // Body skeleton
      ok(content.includes('> One-line summary'), 'has blurb placeholder');
      ok(content.includes('## Overview'), 'has Overview');
      ok(content.includes('## Version History'), 'has Version History');
      ok(content.includes('## Related Documentation'), 'has Related Documentation');
      // First Version History entry references the create timestamp
      ok(/\*\*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\*\* Created\./.test(content), 'VH seeded');
    });

    it('`dotmd new doc <name>` explicit doc — same enriched shape', () => {
      const docsDir = setupProject();
      const r = run(['new', 'doc', 'auth-notes']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      const content = readFileSync(path.join(docsDir, 'auth-notes.md'), 'utf8');
      ok(content.includes('type: doc'));
      ok(content.includes('## Overview'));
      ok(content.includes('## Version History'));
    });

    it('`dotmd new plan <name>` creates a plan under docs/plans/', () => {
      const docsDir = setupProject();
      const r = run(['new', 'plan', 'auth-revamp']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      const planPath = path.join(docsDir, 'plans', 'auth-revamp.md');
      ok(existsSync(planPath), 'saved under docs/plans/');
      const content = readFileSync(planPath, 'utf8');
      ok(content.includes('type: plan'));
      ok(content.includes('status: active'), 'defaults to active (not in-session)');
      ok(content.includes('## Phases'));
      ok(content.includes('## Version History'));
      ok(/created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/.test(content), 'ISO timestamp');
    });

  });

  describe('prompt type', () => {
    it('`dotmd new prompt <name> "body"` creates prompt with inline body', () => {
      const docsDir = setupProject();
      const r = run(['new', 'prompt', 'quick-thought', 'look at X tomorrow']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      // Default destination is docs/prompts/<name>.md
      const promptPath = path.join(docsDir, 'prompts', 'quick-thought.md');
      ok(existsSync(promptPath), 'prompt saved under docs/prompts/');
      const content = readFileSync(promptPath, 'utf8');
      ok(content.includes('type: prompt'));
      ok(content.includes('status: pending'));
      ok(content.includes('dotmd_version:'), 'has dotmd_version stamp');
      ok(content.includes('look at X tomorrow'), 'body content present');
      ok(/created: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/.test(content), 'ISO timestamp');
    });

    it('refuses to create prompt without body', () => {
      setupProject();
      const r = run(['new', 'prompt', 'no-body']);
      strictEqual(r.status, 1);
      ok(r.stderr.includes('requires a body'), 'reports missing body');
    });

    it('accepts body via --message', () => {
      const docsDir = setupProject();
      const r = run(['new', 'prompt', 'flag-body', '--message', 'message-flag content']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      const content = readFileSync(path.join(docsDir, 'prompts', 'flag-body.md'), 'utf8');
      ok(content.includes('message-flag content'));
    });

    it('accepts body via - (stdin)', () => {
      const docsDir = setupProject();
      const r = run(['new', 'prompt', 'stdin-body', '-'], { input: 'piped\nbody\n' });
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      const content = readFileSync(path.join(docsDir, 'prompts', 'stdin-body.md'), 'utf8');
      ok(content.includes('piped'));
      ok(content.includes('body'));
    });

    it('accepts body via @path', () => {
      const docsDir = setupProject();
      const srcPath = path.join(tmpDir, 'src-body.md');
      writeFileSync(srcPath, 'from-file content\n');
      const r = run(['new', 'prompt', 'file-body', `@${srcPath}`]);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      const content = readFileSync(path.join(docsDir, 'prompts', 'file-body.md'), 'utf8');
      ok(content.includes('from-file content'));
    });

    it('prompts get pending status by default', () => {
      const docsDir = setupProject();
      run(['new', 'prompt', 'default-status', 'body']);
      const content = readFileSync(path.join(docsDir, 'prompts', 'default-status.md'), 'utf8');
      ok(content.includes('status: pending'));
    });
  });

  describe('flags + edge cases', () => {
    it('slugifies names with spaces and special chars', () => {
      const docsDir = setupProject();
      run(['new', 'doc', 'My Cool Feature!']);
      ok(existsSync(path.join(docsDir, 'my-cool-feature.md')));
    });

    it('--status flag sets status (per-type valid value)', () => {
      const docsDir = setupProject();
      run(['new', 'doc', 'review-thing', '--status', 'review']);
      const content = readFileSync(path.join(docsDir, 'review-thing.md'), 'utf8');
      ok(content.includes('status: review'));
    });

    it('rejects --status that is not valid for the type', () => {
      setupProject();
      const r = run(['new', 'doc', 'bad', '--status', 'planned']);
      strictEqual(r.status, 1);
      ok(r.stderr.includes('Invalid status'), 'reports type-specific rejection');
    });

    it('--title overrides auto-derived title', () => {
      const docsDir = setupProject();
      run(['new', 'doc', 'slug-name', '--title', 'Custom Title']);
      const content = readFileSync(path.join(docsDir, 'slug-name.md'), 'utf8');
      ok(content.includes('# Custom Title'));
    });

    it('refuses to overwrite existing file', () => {
      const docsDir = setupProject();
      writeFileSync(path.join(docsDir, 'exists.md'), '---\nstatus: active\n---\n# Exists\n');
      const r = run(['new', 'doc', 'exists']);
      strictEqual(r.status, 1);
      ok(r.stderr.includes('already exists'));
    });

    it('--dry-run does not create file', () => {
      const docsDir = setupProject();
      const r = run(['new', 'doc', 'dry-test', '--dry-run']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      ok(r.stdout.includes('Would create'));
      ok(!existsSync(path.join(docsDir, 'dry-test.md')));
    });

    it('rejects entirely unknown status', () => {
      setupProject();
      const r = run(['new', 'doc', 'bad-status', '--status', 'nonsense']);
      strictEqual(r.status, 1);
      ok(r.stderr.includes('Invalid status'));
    });

    it('rejects unknown type-name-shaped argument as the name fallback', () => {
      // If the first positional isn't a known type, it's treated as the doc name.
      const docsDir = setupProject();
      run(['new', 'not-a-type']);
      ok(existsSync(path.join(docsDir, 'not-a-type.md')));
    });

    it('--list-types shows registered types', () => {
      setupProject();
      const r = run(['new', '--list-types']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      ok(r.stdout.includes('plan'));
      ok(r.stdout.includes('doc'));
      ok(r.stdout.includes('prompt'));
    });

    it('handles path input by creating in the specified directory', () => {
      const docsDir = setupProject();
      mkdirSync(path.join(docsDir, 'plans'), { recursive: true });
      const r = run(['new', 'plan', 'docs/plans/feature']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      ok(existsSync(path.join(docsDir, 'plans', 'feature.md')));
    });

    it('config-registered custom types still work', () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-new-'));
      mkdirSync(path.join(tmpDir, '.git'));
      mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
        export const root = 'docs';
        export const templates = {
          spike: {
            description: 'Timeboxed investigation',
            frontmatter: (s, d) => \`type: doc\\nstatus: \${s}\\nupdated: \${d}\\ntimebox: 2d\`,
            body: (t) => \`\\n# \${t}\\n\\n## Hypothesis\\n\\n\\n\`,
          },
        };
      `);
      const r = run(['new', 'spike', 'my-spike']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      const content = readFileSync(path.join(tmpDir, 'docs', 'my-spike.md'), 'utf8');
      ok(content.includes('timebox: 2d'));
      ok(content.includes('## Hypothesis'));
    });
  });
});
