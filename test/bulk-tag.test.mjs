import { describe, it, afterEach } from 'node:test';
import { deepStrictEqual, match, strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import { runBulkTag, inferTypeFromPath } from '../src/bulk-tag.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
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
  it('rejects a missing explicit path before writing other files', () => {
    const docsDir = setup();
    const file = path.join(docsDir, 'valid.md');
    writeFileSync(file, '# Valid\n');
    const result = spawnSync('node', [BIN, 'bulk-tag', 'docs/valid.md', 'docs/missing.md'], {
      cwd: tmpDir, encoding: 'utf8',
    });
    strictEqual(result.status, 1);
    match(result.stderr, /missing\.md/);
    strictEqual(readFileSync(file, 'utf8'), '# Valid\n');
  });

  it('counts repeated spellings of an explicit path once', () => {
    const docsDir = setup();
    writeFileSync(path.join(docsDir, 'valid.md'), '# Valid\n');
    const result = spawnSync('node', [BIN, 'bulk-tag', '--json', 'valid.md', 'docs/valid.md'], {
      cwd: tmpDir, encoding: 'utf8',
    });
    strictEqual(result.status, 0, result.stderr);
    strictEqual(JSON.parse(result.stdout).count, 1);
  });

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

  it('retains the existing status in JSON and on disk when --status conflicts', async () => {
    const docsDir = setup();
    mkdirSync(path.join(docsDir, 'prompts'));
    const filePath = path.join(docsDir, 'prompts', 'orphan.md');
    writeFileSync(filePath, '---\nstatus: pending\n---\n# Orphan\n');

    const config = await resolveConfig(tmpDir);
    captureStdout();
    runBulkTag(['--status', 'active', '--json'], config, {});
    const { candidates } = JSON.parse(releaseStdout());

    strictEqual(candidates.length, 1);
    strictEqual(candidates[0].newType, 'prompt');
    strictEqual(candidates[0].newStatus, 'pending');
    deepStrictEqual(candidates[0].updates, { type: 'prompt' });

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

  it('CLI preserves command-local --type and --status after bulk-tag', () => {
    const docsDir = setup();
    mkdirSync(path.join(docsDir, 'plans'));
    const filePath = path.join(docsDir, 'plans', 'cli.md');
    writeFileSync(filePath, '# CLI\n');

    const result = spawnSync('node', [BIN, 'bulk-tag', '--type', 'doc', '--status', 'active', 'docs/plans/cli.md'], {
      cwd: tmpDir,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });

    strictEqual(result.status, 0, result.stderr);
    const content = readFileSync(filePath, 'utf8');
    ok(content.includes('type: doc'), 'post-command --type reaches bulk-tag');
    ok(content.includes('status: active'), 'post-command --status reaches bulk-tag');
  });

  it('previews and applies the default status for the retained type when --type conflicts', () => {
    const docsDir = setup();
    const filePath = path.join(docsDir, 'partial-plan.md');
    const before = '---\ntype: plan\nowner: alice\n---\n# Partial plan\n';
    writeFileSync(filePath, before);

    const args = [BIN, 'bulk-tag', '--type', 'doc', '--json', 'docs/partial-plan.md'];
    const options = { cwd: tmpDir, encoding: 'utf8' };
    const preview = spawnSync('node', [...args, '--dry-run'], options);
    strictEqual(preview.status, 0, preview.stderr);
    const expected = {
      dryRun: true,
      count: 1,
      candidates: [{
        path: 'docs/partial-plan.md',
        hadFrontmatter: true,
        currentType: 'plan',
        currentStatus: null,
        newType: 'plan',
        newStatus: 'planned',
        updates: { status: 'planned' },
      }],
    };
    deepStrictEqual(JSON.parse(preview.stdout), expected);
    strictEqual(readFileSync(filePath, 'utf8'), before);

    const mutation = spawnSync('node', args, options);
    strictEqual(mutation.status, 0, mutation.stderr);
    deepStrictEqual(JSON.parse(mutation.stdout), { ...expected, dryRun: false, failedPaths: [] });
    const content = readFileSync(filePath, 'utf8');
    strictEqual(content, before.replace('owner: alice\n', 'owner: alice\nstatus: planned\n'));
  });
  for (const format of ['text', 'json']) {
    it(`CLI continues after an apply failure and exits nonzero in ${format} mode`, () => {
      const docsDir = setup();
      const broken = path.join(docsDir, 'broken.md');
      const good = path.join(docsDir, 'good.md');
      const brokenSource = '---\nowner: alice\n# Unclosed frontmatter\n';
      writeFileSync(broken, brokenSource);
      writeFileSync(good, '# Good\n');

      const args = ['bulk-tag', 'docs/broken.md', 'docs/good.md'];
      if (format === 'json') args.push('--json');
      const result = spawnSync(process.execPath, [BIN, ...args], {
        cwd: tmpDir,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
      });

      strictEqual(result.status, 1, result.stderr);
      match(result.stderr, /Failed to tag docs\/broken\.md: .*unclosed frontmatter block/);
      strictEqual(readFileSync(broken, 'utf8'), brokenSource);
      strictEqual(readFileSync(good, 'utf8'), '---\ntype: doc\nstatus: draft\n---\n# Good\n');
      if (format === 'json') {
        const { dryRun, count, candidates, failedPaths } = JSON.parse(result.stdout);
        strictEqual(dryRun, false);
        strictEqual(count, 2);
        deepStrictEqual(candidates.map(candidate => candidate.path), ['docs/broken.md', 'docs/good.md']);
        deepStrictEqual(failedPaths, ['docs/broken.md']);
      } else {
        match(result.stdout, /Tagged 1 file\(s\)\./);
      }
    });
  }

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
    strictEqual(Object.hasOwn(parsed, 'failedPaths'), false);
    strictEqual(readFileSync(filePath, 'utf8'), '# Foo\n');
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

  it('uses the nested plans root for type inference and archive exclusion', async () => {
    const docsDir = setup();
    const plansDir = path.join(docsDir, 'plans');
    const archiveDir = path.join(plansDir, 'archived');
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), `export const root = ['docs', 'docs/plans'];\n`);
    const active = path.join(plansDir, 'active.md');
    const archived = path.join(archiveDir, 'old.md');
    writeFileSync(active, '# Active plan\n');
    writeFileSync(archived, '# Archived plan\n');
    const archivedBefore = readFileSync(archived, 'utf8');

    const config = await resolveConfig(tmpDir);
    captureStdout();
    runBulkTag([], config, {});
    releaseStdout();

    const activeContent = readFileSync(active, 'utf8');
    ok(activeContent.includes('type: plan'), `nested plans root should infer plan: ${activeContent}`);
    ok(activeContent.includes('status: planned'), 'nested plans root should use the plan default status');
    strictEqual(readFileSync(archived, 'utf8'), archivedBefore, 'nested archived file must remain untouched');
  });
});
