import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import { runBulkTag, inferTypeFromPath } from '../src/bulk-tag.mjs';

let tmpDir;
let stdoutChunks;
let originalWrite;

function setup(configExtra = '') {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-bulktag-'));
  spawnSync('git', ['init'], { cwd: tmpDir });
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  mkdirSync(path.join(docsDir, 'archived'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = 'docs';\n${configExtra}`);
  return docsDir;
}

function captureStdout() {
  stdoutChunks = [];
  originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { stdoutChunks.push(String(chunk)); return true; };
}
function releaseStdout() {
  process.stdout.write = originalWrite;
  return stdoutChunks.join('');
}

afterEach(() => {
  if (originalWrite) { process.stdout.write = originalWrite; originalWrite = null; }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('inferTypeFromPath', () => {
  it('infers type: plan for files under plans/', () => {
    strictEqual(inferTypeFromPath('/repo/docs/plans/foo.md', '/repo/docs'), 'plan');
  });
  it('infers type: prompt for files under prompts/', () => {
    strictEqual(inferTypeFromPath('/repo/docs/prompts/bar.md', '/repo/docs'), 'prompt');
  });
  it('falls back to type: doc for root-level files', () => {
    strictEqual(inferTypeFromPath('/repo/docs/baz.md', '/repo/docs'), 'doc');
  });
  it('falls back to type: doc for unrecognized subdirs', () => {
    strictEqual(inferTypeFromPath('/repo/docs/notes/qux.md', '/repo/docs'), 'doc');
  });
});

describe('runBulkTag', () => {
  it('tags a file with no frontmatter under plans/ as type: plan, status: planned', async () => {
    const docsDir = setup();
    mkdirSync(path.join(docsDir, 'plans'));
    const filePath = path.join(docsDir, 'plans', 'old-plan.md');
    writeFileSync(filePath, '# Old plan\n\nSome body.\n');

    const config = await resolveConfig(tmpDir);
    captureStdout();
    runBulkTag([], config, {});
    releaseStdout();

    const content = readFileSync(filePath, 'utf8');
    ok(content.startsWith('---\n'), `expected frontmatter block; got:\n${content}`);
    ok(content.includes('type: plan'), 'inferred type: plan');
    ok(content.includes('status: planned'), 'default plan status: planned');
    ok(content.includes('# Old plan'), 'body preserved');
  });

  it('fills in only missing fields when frontmatter has type but no status', async () => {
    const docsDir = setup();
    const filePath = path.join(docsDir, 'partial.md');
    writeFileSync(filePath, '---\ntype: doc\nowner: alice\n---\n# Partial\n');

    const config = await resolveConfig(tmpDir);
    captureStdout();
    runBulkTag([], config, {});
    releaseStdout();

    const content = readFileSync(filePath, 'utf8');
    ok(content.includes('type: doc'), 'existing type preserved');
    ok(content.includes('owner: alice'), 'unrelated field preserved');
    ok(content.includes('status: draft'), 'status added with doc default');
  });

  it('fills in only missing fields when frontmatter has status but no type', async () => {
    const docsDir = setup();
    mkdirSync(path.join(docsDir, 'prompts'));
    const filePath = path.join(docsDir, 'prompts', 'orphan.md');
    writeFileSync(filePath, '---\nstatus: pending\n---\n# Orphan\n');

    const config = await resolveConfig(tmpDir);
    captureStdout();
    runBulkTag([], config, {});
    releaseStdout();

    const content = readFileSync(filePath, 'utf8');
    ok(content.includes('status: pending'), 'existing status preserved');
    ok(content.includes('type: prompt'), 'type added from subdir inference');
  });

  it('skips files that already have both type and status', async () => {
    const docsDir = setup();
    const filePath = path.join(docsDir, 'tagged.md');
    writeFileSync(filePath, '---\ntype: doc\nstatus: active\n---\n# Tagged\n');
    const before = readFileSync(filePath, 'utf8');

    const config = await resolveConfig(tmpDir);
    captureStdout();
    runBulkTag([], config, {});
    const out = releaseStdout();

    const after = readFileSync(filePath, 'utf8');
    strictEqual(after, before, 'fully-tagged file should not be modified');
    ok(out.includes('No untagged files found'), `expected quiet exit; got: ${out}`);
  });

  it('--dry-run lists candidates but writes nothing', async () => {
    const docsDir = setup();
    const filePath = path.join(docsDir, 'pending.md');
    writeFileSync(filePath, '# Pending\n');
    const before = readFileSync(filePath, 'utf8');

    const config = await resolveConfig(tmpDir);
    captureStdout();
    runBulkTag([], config, { dryRun: true });
    const out = releaseStdout();

    const after = readFileSync(filePath, 'utf8');
    strictEqual(after, before, 'dry-run must not mutate files');
    ok(out.includes('1 untagged file'), `expected count line; got: ${out}`);
    ok(out.includes('[dry-run] No changes made'), `expected dry-run footer; got: ${out}`);
    ok(out.includes('pending.md'), 'file path in output');
  });

  it('--type and --status flags override inference for every candidate', async () => {
    const docsDir = setup();
    mkdirSync(path.join(docsDir, 'plans'));
    const a = path.join(docsDir, 'plans', 'a.md');
    const b = path.join(docsDir, 'b.md');
    writeFileSync(a, '# A\n');
    writeFileSync(b, '# B\n');

    const config = await resolveConfig(tmpDir);
    captureStdout();
    runBulkTag(['--type', 'doc', '--status', 'active'], config, {});
    releaseStdout();

    const aContent = readFileSync(a, 'utf8');
    const bContent = readFileSync(b, 'utf8');
    ok(aContent.includes('type: doc'), 'plans/a.md type overridden to doc');
    ok(aContent.includes('status: active'), 'plans/a.md status overridden');
    ok(bContent.includes('type: doc'), 'b.md type overridden to doc');
    ok(bContent.includes('status: active'), 'b.md status overridden');
  });

  it('--json emits a structured candidate list', async () => {
    const docsDir = setup();
    const filePath = path.join(docsDir, 'foo.md');
    writeFileSync(filePath, '# Foo\n');

    const config = await resolveConfig(tmpDir);
    captureStdout();
    runBulkTag(['--json'], config, { dryRun: true });
    const out = releaseStdout();

    const parsed = JSON.parse(out);
    strictEqual(parsed.dryRun, true);
    strictEqual(parsed.count, 1);
    strictEqual(parsed.candidates.length, 1);
    strictEqual(parsed.candidates[0].newType, 'doc');
    strictEqual(parsed.candidates[0].newStatus, 'draft');
    strictEqual(parsed.candidates[0].hadFrontmatter, false);
  });

  it('skips files under the archive directory', async () => {
    const docsDir = setup();
    const archived = path.join(docsDir, 'archived', 'old.md');
    writeFileSync(archived, '# Old archived doc with no frontmatter\n');
    const before = readFileSync(archived, 'utf8');

    const config = await resolveConfig(tmpDir);
    captureStdout();
    runBulkTag([], config, {});
    const out = releaseStdout();

    const after = readFileSync(archived, 'utf8');
    strictEqual(after, before, 'archived file must not be tagged');
    ok(out.includes('No untagged files found'), `archived-only repo should report no candidates; got: ${out}`);
  });
});
