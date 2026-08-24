import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import { runRename } from '../src/rename.mjs';

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
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-rename-'));

  // Init git repo so git mv works
  spawnSync('git', ['init'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `
    export const root = 'docs';
    export const referenceFields = {
      bidirectional: ['related_plans'],
      unidirectional: ['supports_plans'],
    };
  `);
  return docsDir;
}

function writeDoc(docsDir, filename, frontmatter, body = '') {
  const filePath = path.join(docsDir, filename);
  writeFileSync(filePath, `---\n${frontmatter}\n---\n${body}`);
  spawnSync('git', ['add', filePath], { cwd: tmpDir });
  spawnSync('git', ['commit', '-m', `add ${filename}`], { cwd: tmpDir });
  return filePath;
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('dotmd rename', () => {
  it('renames a doc via git mv', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'old-name.md', 'status: active\nupdated: 2025-01-01', '# Old\n');

    const result = run(['rename', path.join(docsDir, 'old-name.md'), 'new-name']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Renamed'), 'shows Renamed');

    ok(!existsSync(path.join(docsDir, 'old-name.md')), 'old file gone');
    ok(existsSync(path.join(docsDir, 'new-name.md')), 'new file exists');
  });

  it('updates references in other docs', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'old-name.md', 'status: active\nupdated: 2025-01-01', '# Old\n');
    writeDoc(docsDir, 'referrer.md', 'status: active\nupdated: 2025-01-01\nrelated_plans:\n  - old-name.md', '# Referrer\n');

    const result = run(['rename', path.join(docsDir, 'old-name.md'), 'new-name']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Updated references'), 'reports updated references');

    const referrerContent = readFileSync(path.join(docsDir, 'referrer.md'), 'utf8');
    ok(referrerContent.includes('new-name.md'), 'reference updated to new name');
    ok(!referrerContent.includes('old-name.md'), 'old reference removed');
  });

  it('--dry-run previews without modifying files', () => {
    const docsDir = setupProject();
    const oldPath = writeDoc(docsDir, 'old-name.md', 'status: active\nupdated: 2025-01-01', '# Old\n');
    writeDoc(docsDir, 'referrer.md', 'status: active\nupdated: 2025-01-01\nrelated_plans:\n  - old-name.md', '# Referrer\n');

    const result = run(['rename', path.join(docsDir, 'old-name.md'), 'new-name', '--dry-run']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('[dry-run]'), 'shows dry-run prefix');

    // Files should not have changed
    ok(existsSync(oldPath), 'old file still exists');
    ok(!existsSync(path.join(docsDir, 'new-name.md')), 'new file not created');
    ok(!existsSync(path.join(tmpDir, '.runlist')), 'no transaction, lock, or temp state created');
  });

  it('errors when target already exists', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'old-name.md', 'status: active\nupdated: 2025-01-01', '# Old\n');
    writeDoc(docsDir, 'new-name.md', 'status: active\nupdated: 2025-01-01', '# New\n');

    const result = run(['rename', path.join(docsDir, 'old-name.md'), 'new-name']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('already exists'), 'shows error');
  });

  it('updates references in body of other docs', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'old-name.md', 'status: active\nupdated: 2025-01-01', '# Old\n');
    writeDoc(docsDir, 'referrer.md', 'status: active\nupdated: 2025-01-01', '# Referrer\nSee [old plan](old-name.md) and old-name.md for details.\n');

    const result = run(['rename', path.join(docsDir, 'old-name.md'), 'new-name']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(result.stdout.includes('Updated references'), 'reports updated references');

    const referrerContent = readFileSync(path.join(docsDir, 'referrer.md'), 'utf8');
    ok(referrerContent.includes('new-name.md'), 'body reference updated to new name');
    ok(referrerContent.includes('[old plan](new-name.md)'), 'Markdown link updated');
    ok(referrerContent.includes('and old-name.md for details'), 'bare prose is intentionally untouched');
  });

  it('errors when source file not found', () => {
    setupProject();

    const result = run(['rename', 'nonexistent.md', 'new-name']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('not found'), 'shows not found error');
  });

  it('supports cross-directory moves', () => {
    const docsDir = setupProject();
    const subDir = path.join(docsDir, 'modules');
    mkdirSync(subDir, { recursive: true });
    writeDoc(docsDir, 'old-name.md', 'status: active\nupdated: 2025-01-01', '# Old\n');

    const result = run(['rename', path.join(docsDir, 'old-name.md'), 'docs/modules/old-name.md']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(!existsSync(path.join(docsDir, 'old-name.md')), 'old file gone');
    ok(existsSync(path.join(subDir, 'old-name.md')), 'file moved to subdirectory');
  });

  it('adds .md extension automatically', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'old-name.md', 'status: active\nupdated: 2025-01-01', '# Old\n');

    const result = run(['rename', path.join(docsDir, 'old-name.md'), 'new-name']);
    strictEqual(result.status, 0, `stderr: ${result.stderr}`);
    ok(existsSync(path.join(docsDir, 'new-name.md')), 'new file with .md exists');
  });

  it('rewrites only canonical refs across directories and preserves syntax exclusions', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'other'), { recursive: true });
    mkdirSync(path.join(docsDir, 'modules'), { recursive: true });
    writeDoc(docsDir, 'old-name.md', `status: active
updated: 2025-01-01
related_plans: ["old-name.md#self", 'sibling.md']`, '[self](old-name.md#top)\n[sibling](sibling.md#part)\n');
    writeDoc(docsDir, 'sibling.md', 'status: active\nupdated: 2025-01-01', '# Sibling\n');
    writeDoc(docsDir, 'grandchild.md', 'status: active\nupdated: 2025-01-01', '# Grandchild\n');
    writeDoc(docsDir, 'referrer.md', `status: active
updated: 2025-01-01
summary: old-name.md is prose
related_plans:
  - "old-name.md#front" # old-name.md comment`, `# Referrer
[target](old-name.md#body "Title")
[angle](<old-name.md#angle> 'Angle title')
[reference]: old-name.md#definition "Definition title"
old-name.md prose
[external](https://example.test/old-name.md#x)
[suffix](grandchild.md)

\`\`\`\`md
[code](old-name.md)
\`\`\`
[still code](old-name.md)
\`\`\`\` not-a-closing-fence
[still fenced](old-name.md)
> \`\`\`\`
[top fence survives quoted closer](old-name.md)
\`\`\`\`
\`\`[inline code](old-name.md)\`\`
    \`\`\`\`
    [four-space non-fence](old-name.md)
after indented [normal](old-name.md)
\`[multiline code](old-name.md)
still multiline [code](old-name.md)
closing\` [after multiline](old-name.md)
> \`\`\`\`md
> [blockquote code](old-name.md)
\`\`\`\`
> [blockquote survives incompatible closer](old-name.md)
> \`\`\`\`
- \`\`\`\`md
  [list code](old-name.md)
  \`\`\`\`
>     [blockquote indented code](old-name.md)
> after indented [blockquote normal](old-name.md)
-     [list indented code](old-name.md)
- after indented [list normal](old-name.md)
\\[escaped opener](old-name.md)
\\\\[even escaped opener](old-name.md)
<!-- [comment code](old-name.md)
[comment code two](old-name.md) -->
<pre>
[pre code](old-name.md)
</pre   >
[after spaced pre](old-name.md)
<code>
[code tag content](old-name.md)
</code >
[after spaced code](old-name.md)
<style>
[style tag content](old-name.md)
</style   >
[after spaced style](old-name.md)
<script>[script code](old-name.md)</script   >
[after spaced script](old-name.md)
<div>
[html block](old-name.md)
</div>

<custom-tag>[uncertain html](old-name.md)</custom-tag>
[after html](old-name.md)
\` unmatched [outside code](old-name.md) \`\`[later code](old-name.md)\`\`
`);
    writeDoc(docsDir, 'other/old-name.md', 'status: active\nupdated: 2025-01-01', '# Duplicate\n');
    writeDoc(docsDir, 'other/local.md', 'status: active\nupdated: 2025-01-01\nrelated_plans: [old-name.md]', '[local](old-name.md#same)\n');

    const result = run(['rename', 'docs/old-name.md', 'docs/modules/new-name.md']);
    strictEqual(result.status, 0, result.stderr);
    const referrer = readFileSync(path.join(docsDir, 'referrer.md'), 'utf8');
    ok(referrer.includes('modules/new-name.md#front'));
    ok(referrer.includes('summary: old-name.md is prose'));
    ok(referrer.includes('# old-name.md comment'));
    ok(referrer.includes('[target](modules/new-name.md#body "Title")'));
    ok(referrer.includes("[angle](<modules/new-name.md#angle> 'Angle title')"));
    ok(referrer.includes('[reference]: modules/new-name.md#definition "Definition title"'));
    ok(referrer.includes('old-name.md prose'));
    ok(referrer.includes('https://example.test/old-name.md#x'));
    ok(referrer.includes('[suffix](grandchild.md)'));
    ok(referrer.includes('[code](old-name.md)'));
    ok(referrer.includes('[still code](old-name.md)'));
    ok(referrer.includes('[still fenced](old-name.md)'));
    ok(referrer.includes('[top fence survives quoted closer](old-name.md)'));
    ok(referrer.includes('``[inline code](old-name.md)``'));
    ok(referrer.includes('` unmatched [outside code](old-name.md) ``[later code](old-name.md)``'));
    ok(referrer.includes('[four-space non-fence](old-name.md)'));
    ok(referrer.includes('after indented [normal](modules/new-name.md)'));
    ok(referrer.includes('`[multiline code](old-name.md)\nstill multiline [code](old-name.md)\nclosing` [after multiline](modules/new-name.md)'));
    ok(referrer.includes('> [blockquote code](old-name.md)'));
    ok(referrer.includes('> [blockquote survives incompatible closer](old-name.md)'));
    ok(referrer.includes('  [list code](old-name.md)'));
    ok(referrer.includes('>     [blockquote indented code](old-name.md)'));
    ok(referrer.includes('> after indented [blockquote normal](modules/new-name.md)'));
    ok(referrer.includes('-     [list indented code](old-name.md)'));
    ok(referrer.includes('- after indented [list normal](modules/new-name.md)'));
    ok(referrer.includes('\\[escaped opener](old-name.md)'));
    ok(referrer.includes('\\\\[even escaped opener](modules/new-name.md)'));
    ok(referrer.includes('[comment code](old-name.md)') && referrer.includes('[comment code two](old-name.md)'));
    ok(referrer.includes('[pre code](old-name.md)'));
    ok(referrer.includes('[after spaced pre](modules/new-name.md)'));
    ok(referrer.includes('[code tag content](old-name.md)'));
    ok(referrer.includes('[after spaced code](modules/new-name.md)'));
    ok(referrer.includes('[style tag content](old-name.md)'));
    ok(referrer.includes('[after spaced style](modules/new-name.md)'));
    ok(referrer.includes('[script code](old-name.md)'));
    ok(referrer.includes('[after spaced script](modules/new-name.md)'));
    ok(referrer.includes('[html block](old-name.md)'));
    ok(referrer.includes('[uncertain html](old-name.md)'));
    ok(referrer.includes('[after html](modules/new-name.md)'));
    const local = readFileSync(path.join(docsDir, 'other/local.md'), 'utf8');
    ok(local.includes('[old-name.md]') && local.includes('(old-name.md#same)'), 'duplicate basename resolves locally and is untouched');
    const moved = readFileSync(path.join(docsDir, 'modules/new-name.md'), 'utf8');
    ok(moved.includes('new-name.md#self'));
    ok(moved.includes('../sibling.md'));
    ok(moved.includes('[self](new-name.md#top)'));
    ok(moved.includes('[sibling](../sibling.md#part)'));
  });

  it('migrates same-session ownership and rejects another owner', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'owned.md', 'type: plan\nstatus: active\nupdated: 2025-01-01', '# Owned\n');
    const env = { ...process.env, NO_COLOR: '1', DOTMD_SESSION_ID: 'owner-a' };
    strictEqual(run(['use', 'docs/owned.md', '--no-index'], { env }).status, 0);
    const renamed = run(['rename', 'docs/owned.md', 'renamed.md'], { env });
    strictEqual(renamed.status, 0, renamed.stderr);
    const records = readdirSync(path.join(tmpDir, '.runlist', 'ownership')).filter(name => name.endsWith('.json'));
    strictEqual(records.length, 1);
    const record = JSON.parse(readFileSync(path.join(tmpDir, '.runlist', 'ownership', records[0]), 'utf8'));
    strictEqual(record.plan, 'docs/renamed.md');
    strictEqual(record.sessionId, 'owner-a');

    const rejected = run(['rename', 'docs/renamed.md', 'forbidden.md'], {
      env: { ...process.env, NO_COLOR: '1', DOTMD_SESSION_ID: 'owner-b' },
    });
    strictEqual(rejected.status, 1);
    ok(rejected.stderr.includes('another session'));
    ok(existsSync(path.join(docsDir, 'renamed.md')));
  });

  it('rejects a spelling whose document-relative and repository-relative identities differ', () => {
    const docsDir = setupProject();
    mkdirSync(path.join(docsDir, 'sub', 'docs'), { recursive: true });
    writeDoc(docsDir, 'old.md', 'status: active\nupdated: 2025-01-01', '# Root target\n');
    writeDoc(docsDir, 'sub/docs/old.md', 'status: active\nupdated: 2025-01-01', '# Local target\n');
    writeDoc(docsDir, 'sub/ref.md', 'status: active\nupdated: 2025-01-01\nrelated_plans: [docs/old.md]', '[ambiguous](docs/old.md)\n');
    const result = run(['rename', 'docs/old.md', 'root-new.md']);
    strictEqual(result.status, 1);
    ok(result.stderr.includes('Ambiguous reference'));
    ok(existsSync(path.join(docsDir, 'old.md')));
    ok(!existsSync(path.join(docsDir, 'root-new.md')));
  });

  it('preserves escaped and angle whitespace destinations while rewriting their path', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'old name.md', 'status: active\nupdated: 2025-01-01', '# Spaced\n');
    writeDoc(docsDir, 'spaced-ref.md', `status: active
updated: 2025-01-01
related_plans: ["old name.md#flow", 'old name.md']
supports_plans:
  - "old name.md#block" # preserve comment`, '[escaped](old\\ name.md#x "T")\n[angle](<old name.md#y>)\n');
    writeDoc(docsDir, 'scalar-ref.md', 'status: active\nupdated: 2025-01-01\nrelated_plans: "old name.md" # scalar comment');
    const result = run(['rename', 'docs/old name.md', 'new name.md']);
    strictEqual(result.status, 0, result.stderr);
    const content = readFileSync(path.join(docsDir, 'spaced-ref.md'), 'utf8');
    ok(content.includes('[escaped](new\\ name.md#x "T")'));
    ok(content.includes('[angle](<new name.md#y>)'));
    ok(content.includes('related_plans: ["new name.md#flow", \'new name.md\']'));
    ok(content.includes('- "new name.md#block" # preserve comment'), content);
    ok(readFileSync(path.join(docsDir, 'scalar-ref.md'), 'utf8').includes('related_plans: "new name.md" # scalar comment'));
  });

  it('replans every scanned document from its locked generation', async () => {
    const docsDir = setupProject();
    const source = writeDoc(docsDir, 'race-old.md', 'status: active\nupdated: 2025-01-01', '# Source\n');
    const referrer = writeDoc(docsDir, 'race-ref.md', 'status: active\nupdated: 2025-01-01', '# Initially unrelated\n');
    const config = await resolveConfig(tmpDir, path.join(tmpDir, 'dotmd.config.mjs'));
    await runRename([source, 'race-new.md'], config, {
      testHooks: { beforeMoveSnapshot: () => writeFileSync(referrer, '---\nstatus: active\nupdated: 2025-01-01\nrelated_plans: [race-old.md]\n---\n[new](race-old.md#x)\n') },
    });
    const content = readFileSync(referrer, 'utf8');
    ok(content.includes('race-new.md'));
    ok(!content.includes('race-old.md'));
  });
});
