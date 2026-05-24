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
      // Enriched frontmatter (block-form empty lists — parser treats bare key as [])
      ok(/^modules:\s*$/m.test(content), 'has modules');
      ok(/^surfaces:\s*$/m.test(content), 'has surfaces');
      ok(content.includes('domain:'), 'has domain');
      ok(content.includes('audience: internal'), 'has audience');
      ok(/^related_plans:\s*$/m.test(content), 'has related_plans');
      ok(/^related_docs:\s*$/m.test(content), 'has related_docs');
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

    it('freshly-created prompts pass `dotmd check` cleanly', () => {
      // Pre-fix: `new prompt` produced a doc with 1 error (missing `updated`)
      // and 2 warnings (missing `title`, missing `summary`). The tool's own
      // outputs failed its own validators. Template now sets `updated` and
      // the validator exempts `type: prompt` from title/summary checks.
      setupProject();
      const r = run(['new', 'prompt', 'fresh-prompt', 'body content']);
      strictEqual(r.status, 0, `new failed: ${r.stderr}`);
      const check = run(['check']);
      strictEqual(check.status, 0, `check failed: stdout=${check.stdout}\nstderr=${check.stderr}`);
      ok(!check.stdout.includes('Missing frontmatter `updated`'), 'no updated error');
      ok(!check.stdout.includes('Missing `title`'), 'no title warning');
      ok(!check.stdout.includes('Missing `summary`'), 'no summary warning');
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

  describe('flat-array root routing (issue #7)', () => {
    function setupFlatArrayProject() {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-new-'));
      mkdirSync(path.join(tmpDir, '.git'));
      mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
      mkdirSync(path.join(tmpDir, 'docs', 'prompts'), { recursive: true });
      mkdirSync(path.join(tmpDir, 'docs', 'modules'), { recursive: true });
      writeFileSync(
        path.join(tmpDir, 'dotmd.config.mjs'),
        `export const root = ['docs/plans', 'docs/modules', 'docs/prompts'];`,
      );
    }

    it('builtin `prompt` lands in the `prompts` root, not `docs/plans` (the first root)', () => {
      setupFlatArrayProject();
      const r = run(['new', 'prompt', 'resume-foo', 'body content']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      ok(
        existsSync(path.join(tmpDir, 'docs', 'prompts', 'resume-foo.md')),
        'lands in docs/prompts/',
      );
      ok(
        !existsSync(path.join(tmpDir, 'docs', 'plans', 'resume-foo.md')),
        'does not land in docs/plans/',
      );
      ok(
        !existsSync(path.join(tmpDir, 'docs', 'plans', 'prompts', 'resume-foo.md')),
        'does not nest as docs/plans/prompts/',
      );
    });

    it('builtin `plan` lands in the `plans` root under flat-array config', () => {
      setupFlatArrayProject();
      const r = run(['new', 'plan', 'auth-revamp']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      ok(existsSync(path.join(tmpDir, 'docs', 'plans', 'auth-revamp.md')));
      ok(!existsSync(path.join(tmpDir, 'docs', 'plans', 'plans', 'auth-revamp.md')), 'no double-nesting');
    });

    it('user override declaring `targetRoot` routes correctly under flat-array config', () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-new-'));
      mkdirSync(path.join(tmpDir, '.git'));
      mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true });
      mkdirSync(path.join(tmpDir, 'docs', 'prompts'), { recursive: true });
      writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
        export const root = ['docs/plans', 'docs/prompts'];
        export const templates = {
          prompt: {
            description: 'Project-shape prompt',
            defaultStatus: 'pending',
            requiresBody: true,
            targetRoot: 'prompts',
            frontmatter: (s, d) => \`type: prompt\\nstatus: \${s}\\ncreated: \${d}\\nproject_field: yes\`,
            body: (t, ctx) => \`\\n\${ctx?.bodyInput ?? ''}\\n\`,
          },
        };
      `);
      const r = run(['new', 'prompt', 'override-test', 'body']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      const promptPath = path.join(tmpDir, 'docs', 'prompts', 'override-test.md');
      ok(existsSync(promptPath), 'override lands in docs/prompts/');
      const content = readFileSync(promptPath, 'utf8');
      ok(content.includes('project_field: yes'), 'override frontmatter applied');
    });

    it('--root CLI flag wins over template.targetRoot', () => {
      setupFlatArrayProject();
      const r = run(['new', 'prompt', 'override', 'body', '--root', 'modules']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      ok(existsSync(path.join(tmpDir, 'docs', 'modules', 'override.md')), 'CLI --root wins');
      ok(!existsSync(path.join(tmpDir, 'docs', 'prompts', 'override.md')));
    });

    it('standard config (docsRoot=docs) unchanged — prompt still lands in docs/prompts/ via `dir`', () => {
      // Regression check: no `prompts` root entry exists, so targetRoot misses and falls
      // through to the existing `template.dir` join.
      const docsDir = setupProject();
      const r = run(['new', 'prompt', 'std-config', 'body']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      ok(existsSync(path.join(docsDir, 'prompts', 'std-config.md')));
    });
  });

  describe('body-input on non-body templates fails fast (issue #9)', () => {
    // The CLI accepts `-`, `@path`, and `--message` for any template, but
    // built-in `plan` ignores `ctx.bodyInput` in its body fn — so silent
    // discard was the failure mode. Plan's behavior: error.
    //
    // `doc` USED to be in this rejecting set, but per the gmax audit it was
    // the easy on-ramp — `dotmd new doc x "quick note"` is the natural shape,
    // and the error pointed at "set acceptsBody on your custom template" advice
    // that didn't apply since init scaffolds no custom doc template. `doc` now
    // accepts body and lands it in the Overview section (see "doc accepts
    // body" tests below).

    it('rejects stdin body on `plan` (not on-prompt template)', () => {
      setupProject();
      const r = run(['new', 'plan', 'no-body-please', '-'], { input: 'heredoc content\n' });
      strictEqual(r.status, 1, `should fail. stderr: ${r.stderr}`);
      ok(r.stderr.includes('does not accept body input'), `expected fail-fast error, got: ${r.stderr}`);
      ok(r.stderr.includes('stdin'), 'names the input source');
      ok(r.stderr.includes('prompt'), 'mentions templates that DO accept body');
    });

    it('rejects @path body on `plan`', () => {
      setupProject();
      const srcPath = path.join(tmpDir, 'src.md');
      writeFileSync(srcPath, 'file content\n');
      const r = run(['new', 'plan', 'from-file', `@${srcPath}`]);
      strictEqual(r.status, 1, `should fail. stderr: ${r.stderr}`);
      ok(r.stderr.includes('does not accept body input'));
      ok(r.stderr.includes(`@${srcPath}`));
    });

    it('`doc` accepts inline body and lands it in Overview', () => {
      // gmax audit #7: `dotmd new doc x "body"` errored with advice to set
      // acceptsBody on a custom template — but init scaffolds none. The easy
      // on-ramp now just works: body goes into the Overview section.
      const docsDir = setupProject();
      const r = run(['new', 'doc', 'easy-onramp', 'quick note about X']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      const content = readFileSync(path.join(docsDir, 'easy-onramp.md'), 'utf8');
      ok(content.includes('quick note about X'), `body should be in doc: ${content}`);
      ok(/## Overview\s*\n\s*quick note about X/.test(content),
        `body should land under Overview: ${content}`);
    });

    it('`doc` accepts --message body', () => {
      const docsDir = setupProject();
      const r = run(['new', 'doc', 'from-msg', '--message', 'flag-passed body']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      const content = readFileSync(path.join(docsDir, 'from-msg.md'), 'utf8');
      ok(content.includes('flag-passed body'));
    });

    it('`doc` without body leaves Overview blank (regression)', () => {
      // Inverse: no body input → Overview empty, no `undefined` or `null`
      // leaking into the file.
      const docsDir = setupProject();
      const r = run(['new', 'doc', 'no-body-here']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      const content = readFileSync(path.join(docsDir, 'no-body-here.md'), 'utf8');
      ok(!content.includes('undefined'), 'no undefined leak in body');
      ok(!content.includes('null'), 'no null leak in body');
      ok(content.includes('## Overview'), 'Overview heading still present');
    });

    it('`prompt` still accepts body input (regression)', () => {
      const docsDir = setupProject();
      const r = run(['new', 'prompt', 'still-works', 'body content']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      const content = readFileSync(path.join(docsDir, 'prompts', 'still-works.md'), 'utf8');
      ok(content.includes('body content'));
    });

    it('custom template with acceptsBody:true accepts body without error', () => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-new-'));
      mkdirSync(path.join(tmpDir, '.git'));
      mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
      writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
        export const root = 'docs';
        export const templates = {
          note: {
            description: 'Quick note that includes body',
            defaultStatus: 'active',
            acceptsBody: true,
            frontmatter: (s, d) => \`type: doc\\nstatus: \${s}\\ncreated: \${d}\`,
            body: (t, ctx) => \`\\n# \${t}\\n\\n\${ctx?.bodyInput ?? ''}\\n\`,
          },
        };
      `);
      const r = run(['new', 'note', 'with-body', '--message', 'note body']);
      strictEqual(r.status, 0, `stderr: ${r.stderr}`);
      const content = readFileSync(path.join(tmpDir, 'docs', 'with-body.md'), 'utf8');
      ok(content.includes('note body'), `custom template should receive body: ${content}`);
    });
  });
});
