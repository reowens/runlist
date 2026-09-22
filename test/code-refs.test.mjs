import { describe, it, afterEach } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../src/config.mjs';
import {
  archivedPreviousPaths,
  classifyMatch,
  collectCodeFiles,
  fixableCount,
  findCodeReferences,
  globToRegex,
  reportMovedCodeRefs,
  rewriteCodeReferences,
  runRefs,
  scanCodeRefs,
} from '../src/code-refs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, '..', 'bin', 'dotmd.mjs');
let tmpDir;

const CONFIG = `export const root = 'docs';
export const codeRoots = ['packages', 'scripts'];
export const codeRefsUntouched = ['scripts/baseline.json'];
export const codeExtensions = ['.ts', '.mjs', '.sql', '.sh', '.swift', '.py', '.json', 'Dockerfile'];
`;

function setupProject({ config = CONFIG } = {}) {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-code-refs-'));
  spawnSync('git', ['init', '-q'], { cwd: tmpDir });
  mkdirSync(path.join(tmpDir, 'docs', 'plans', 'archived'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'packages', 'atrium', 'src'), { recursive: true });
  mkdirSync(path.join(tmpDir, 'scripts'), { recursive: true });
  writeFileSync(path.join(tmpDir, 'dotmd.config.mjs'), config);
  return tmpDir;
}

function writeDoc(rel, frontmatter, body = '') {
  const file = path.join(tmpDir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `---\n${frontmatter}\n---\n${body}`);
  return file;
}

function writeCode(rel, content) {
  const file = path.join(tmpDir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function collector() {
  const chunks = [];
  return { write: (text) => chunks.push(text), text: () => chunks.join('') };
}

function run(args) {
  return spawnSync('node', [bin, ...args], { cwd: tmpDir, encoding: 'utf8' });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('code-refs matcher', () => {
  const OLD = 'docs/plans/beacon-rollout.md';

  it('matches every form a corpus citation takes, and no bare basename', () => {
    const content = [
      `// see ${OLD} for the shape`,
      `/* block: ${OLD} */`,
      ` * continuation: ${OLD}`,
      `-- sql comment ${OLD}`,
      `# hash comment ${OLD}`,
      `// backticked \`${OLD}\` inline`,
      `// anchored ${OLD} § Phase 2`,
      `// anchored again ${OLD}#phase-2`,
      `const planPath = "${OLD}";`,
      `// unrelated beacon-rollout.md bare basename`,
      `// longer packages/${OLD} path`,
      `// deeper ${OLD}/child.md`,
    ].join('\n');

    const hits = findCodeReferences(content, OLD, '/tmp/example.ts');
    deepStrictEqual(hits.map(hit => hit.line), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    deepStrictEqual(hits.filter(hit => hit.anchored).map(hit => hit.line), [7, 8]);
  });

  it('classifies a comment, a string literal and bare code apart', () => {
    strictEqual(classifyMatch(`// ${OLD}`, 3, 'c'), 'comment');
    strictEqual(classifyMatch(`const p = "${OLD}"; // note`, 11, 'c'), 'string');
    strictEqual(classifyMatch(`import x from ${OLD}`, 14, 'c'), 'code');
    strictEqual(classifyMatch(`-- ${OLD}`, 3, 'sql'), 'comment');
    strictEqual(classifyMatch(`# ${OLD}`, 2, 'hash'), 'comment');
    // `#` does not open a comment in a C-family file.
    strictEqual(classifyMatch(`x(#${OLD})`, 3, 'c'), 'code');
    // A URL is not a comment opener.
    strictEqual(classifyMatch(`fetch("https://a/b"); use(${OLD})`, 26, 'c'), 'code');
  });

  it('replaces the path segment only and leaves the anchor, quotes and backticks alone', () => {
    const content = [
      `// see ${OLD} § Phase 2, and \`${OLD}\` too`,
      `const p = "${OLD}";`,
    ].join('\n');
    const comments = rewriteCodeReferences(content, OLD, 'docs/plans/archived/beacon-rollout.md', '/tmp/example.ts');
    strictEqual(comments.changed, 2);
    match(comments.content, /\/\/ see docs\/plans\/archived\/beacon-rollout\.md § Phase 2, and `docs\/plans\/archived\/beacon-rollout\.md` too/);
    match(comments.content, /const p = "docs\/plans\/beacon-rollout\.md";/);

    const withStrings = rewriteCodeReferences(content, OLD, 'docs/plans/archived/beacon-rollout.md', '/tmp/example.ts', { strings: true });
    strictEqual(withStrings.changed, 3);
    match(withStrings.content, /const p = "docs\/plans\/archived\/beacon-rollout\.md";/);
  });

  it('expands the glob subset it supports', () => {
    ok(globToRegex('**/node_modules/**').test('packages/atrium/node_modules/x/a.ts'));
    ok(globToRegex('**/*.generated.*').test('packages/atrium/src/types.generated.ts'));
    ok(!globToRegex('**/*.generated.*').test('packages/atrium/src/types.ts'));
    ok(globToRegex('**/__generated__/**').test('packages/atrium/src/__generated__/a.ts'));
  });
});

describe('code-refs walking', () => {
  it('honours roots, extensions and excludes', async () => {
    setupProject();
    writeCode('packages/atrium/src/a.ts', '// x');
    writeCode('packages/atrium/src/a.md', '# not code');
    writeCode('packages/atrium/node_modules/dep/index.ts', '// vendored');
    writeCode('packages/atrium/src/types.generated.ts', '// generated');
    writeCode('scripts/run.mjs', '// x');
    writeCode('services/api/main.ts', '// outside a configured root');
    const config = await resolveConfig(tmpDir);
    const found = collectCodeFiles(config).map(file => path.relative(tmpDir, file).split(path.sep).join('/'));
    deepStrictEqual(found, ['packages/atrium/src/a.ts', 'scripts/run.mjs']);
  });

  it('scans nothing when no code root is configured', async () => {
    setupProject({ config: `export const root = 'docs';\n` });
    writeCode('packages/atrium/src/a.ts', '// docs/plans/beacon-rollout.md');
    const config = await resolveConfig(tmpDir);
    const scan = scanCodeRefs(config, 'docs/plans/beacon-rollout.md');
    strictEqual(scan.enabled, false);
    strictEqual(scan.total, 0);
    strictEqual(reportMovedCodeRefs(config, 'docs/plans/beacon-rollout.md', 'docs/plans/archived/beacon-rollout.md'), null);
  });
});

describe('runlist refs', () => {
  const OLD = 'docs/plans/beacon-rollout.md';
  const NEW = 'docs/plans/archived/beacon-rollout.md';

  function fixtureTree() {
    setupProject();
    writeCode('packages/atrium/src/a.ts', `// owner: ${OLD} § Phase 2\nexport const a = 1;\n`);
    writeCode('packages/atrium/src/b.ts', `const plan = "${OLD}";\n// and ${OLD}\n`);
    writeCode('scripts/baseline.json', `{ "${OLD}": 3 }\n`);
    writeCode('scripts/run.sh', `# ${OLD}\n`);
  }

  it('reports by file and line, grouped, counts first, and writes nothing', async () => {
    fixtureTree();
    const config = await resolveConfig(tmpDir);
    const out = collector();
    const result = runRefs([OLD, NEW], config, { out });
    strictEqual(result.scan.total, 5);
    strictEqual(result.changed, 0);
    const text = out.text();
    match(text, /In a comment \(3 in 3 files\)/);
    match(text, /In a string literal \(1 in 1 file\)/);
    match(text, /Never written \(listed in codeRefsUntouched\) \(1 in 1 file\)/);
    match(text, /packages\/atrium\/src\/a\.ts:1/);
    match(text, /3 would be rewritten by --fix\./);
    match(text, /1 carry a section anchor/);
    strictEqual(readFileSync(path.join(tmpDir, 'packages/atrium/src/a.ts'), 'utf8').includes(NEW), false);
  });

  it('--fix rewrites comments only; --strings takes the string literal too', async () => {
    fixtureTree();
    const config = await resolveConfig(tmpDir);
    runRefs([OLD, NEW, '--fix'], config, { out: collector() });
    const b = readFileSync(path.join(tmpDir, 'packages/atrium/src/b.ts'), 'utf8');
    match(b, new RegExp(`const plan = "${OLD.replace(/[/.]/g, '\\$&')}"`));
    match(b, new RegExp(`// and ${NEW.replace(/[/.]/g, '\\$&')}`));
    match(readFileSync(path.join(tmpDir, 'packages/atrium/src/a.ts'), 'utf8'), /archived/);

    runRefs([OLD, NEW, '--fix', '--strings'], config, { out: collector() });
    match(readFileSync(path.join(tmpDir, 'packages/atrium/src/b.ts'), 'utf8'), new RegExp(`const plan = "${NEW.replace(/[/.]/g, '\\$&')}"`));
  });

  it('never writes a file listed in codeRefsUntouched', async () => {
    fixtureTree();
    const config = await resolveConfig(tmpDir);
    const baseline = path.join(tmpDir, 'scripts/baseline.json');
    const before = readFileSync(baseline, 'utf8');
    runRefs([OLD, NEW, '--fix', '--strings'], config, { out: collector() });
    strictEqual(readFileSync(baseline, 'utf8'), before);
    const scan = scanCodeRefs(config, OLD);
    strictEqual(scan.untouchedCount, 1);
    strictEqual(fixableCount(scan, { strings: true }), 0);
  });

  it('refuses a file it cannot write, by name', async () => {
    fixtureTree();
    const config = await resolveConfig(tmpDir);
    const locked = path.join(tmpDir, 'packages/atrium/src/a.ts');
    chmodSync(locked, 0o444);
    try {
      const out = collector();
      runRefs([OLD, NEW, '--fix'], config, { out });
      match(out.text(), /Refused: packages\/atrium\/src\/a\.ts is not writable\./);
      strictEqual(readFileSync(locked, 'utf8').includes(NEW), false);
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  it('says so when no code root is configured', async () => {
    setupProject({ config: `export const root = 'docs';\n` });
    const config = await resolveConfig(tmpDir);
    const out = collector();
    const result = runRefs([OLD, NEW], config, { out });
    strictEqual(result.enabled, false);
    match(out.text(), /No code roots configured/);
  });
});

describe('runlist refs repair', () => {
  it('walks the archived documents and reports each one at its previous path', async () => {
    setupProject();
    writeDoc('docs/plans/archived/beacon-rollout.md', 'type: plan\nstatus: archived\nupdated: 2026-08-01');
    writeDoc('docs/plans/archived/kiosk-intake.md', 'type: plan\nstatus: archived\nupdated: 2026-08-01');
    writeDoc('docs/plans/gallery-live.md', 'type: plan\nstatus: active\nupdated: 2026-08-01');
    writeCode('packages/atrium/src/a.ts', [
      '// see docs/plans/beacon-rollout.md',
      '// and docs/plans/kiosk-intake.md § Phase 1',
      '// live one: docs/plans/gallery-live.md',
    ].join('\n') + '\n');

    const config = await resolveConfig(tmpDir);
    deepStrictEqual(
      archivedPreviousPaths(config).map(pair => pair.previous).sort(),
      ['docs/plans/beacon-rollout.md', 'docs/plans/kiosk-intake.md'],
    );

    const out = collector();
    const result = runRefs(['repair'], config, { out });
    strictEqual(result.documents, 2);
    strictEqual(result.total, 2);
    match(out.text(), /2 stale code reference\(s\) across 2 archived document\(s\)/);
    match(out.text(), /archive directory mapping/);
    strictEqual(readFileSync(path.join(tmpDir, 'packages/atrium/src/a.ts'), 'utf8').includes('archived'), false);

    const fixed = runRefs(['repair', '--fix'], config, { out: collector() });
    strictEqual(fixed.changed, 2);
    const after = readFileSync(path.join(tmpDir, 'packages/atrium/src/a.ts'), 'utf8');
    match(after, /docs\/plans\/archived\/beacon-rollout\.md/);
    match(after, /docs\/plans\/archived\/kiosk-intake\.md § Phase 1/);
    match(after, /docs\/plans\/gallery-live\.md/);
  });

  it('skips a previous path a live document still occupies', async () => {
    setupProject();
    writeDoc('docs/plans/archived/beacon-rollout.md', 'type: plan\nstatus: archived\nupdated: 2026-08-01');
    writeDoc('docs/plans/beacon-rollout.md', 'type: plan\nstatus: active\nupdated: 2026-08-01');
    const config = await resolveConfig(tmpDir);
    deepStrictEqual(archivedPreviousPaths(config), []);
  });
});

describe('archive and rename print the code-reference count', () => {
  it('archive reports the count and takes --fix-refs', async () => {
    setupProject();
    writeDoc('docs/plans/beacon-rollout.md', 'type: plan\nstatus: active\nupdated: 2026-08-01', '# Beacon Rollout\n');
    writeCode('packages/atrium/src/a.ts', '// owner: docs/plans/beacon-rollout.md\n');

    const reported = run(['archive', 'docs/plans/beacon-rollout.md']);
    strictEqual(reported.status, 0, reported.stderr);
    match(reported.stdout, /1 code reference in 1 file still cites the old path/);
    match(reported.stdout, /runlist refs docs\/plans\/beacon-rollout\.md docs\/archived\/beacon-rollout\.md --fix/);
    strictEqual(readFileSync(path.join(tmpDir, 'packages/atrium/src/a.ts'), 'utf8').includes('archived'), false);

    writeDoc('docs/plans/kiosk-intake.md', 'type: plan\nstatus: active\nupdated: 2026-08-01', '# Kiosk Intake\n');
    writeCode('packages/atrium/src/b.ts', '// owner: docs/plans/kiosk-intake.md\n');
    const fixed = run(['archive', 'docs/plans/kiosk-intake.md', '--fix-refs']);
    strictEqual(fixed.status, 0, fixed.stderr);
    match(fixed.stdout, /Rewrote 1 code reference\(s\) in 1 file\(s\)/);
    match(readFileSync(path.join(tmpDir, 'packages/atrium/src/b.ts'), 'utf8'), /docs\/archived\/kiosk-intake\.md/);
  });

  it('rename reports the count and takes --fix-refs', async () => {
    setupProject();
    writeDoc('docs/plans/beacon-rollout.md', 'type: plan\nstatus: active\nupdated: 2026-08-01', '# Beacon Rollout\n');
    writeCode('packages/atrium/src/a.ts', '// owner: docs/plans/beacon-rollout.md\n');

    const reported = run(['rename', 'docs/plans/beacon-rollout.md', 'beacon-wave.md']);
    strictEqual(reported.status, 0, reported.stderr);
    match(reported.stdout, /1 code reference in 1 file still cites the old path/);
    match(readFileSync(path.join(tmpDir, 'packages/atrium/src/a.ts'), 'utf8'), /docs\/plans\/beacon-rollout\.md/);

    writeDoc('docs/plans/kiosk-intake.md', 'type: plan\nstatus: active\nupdated: 2026-08-01', '# Kiosk Intake\n');
    writeCode('packages/atrium/src/b.ts', '// owner: docs/plans/kiosk-intake.md\n');
    const fixed = run(['rename', 'docs/plans/kiosk-intake.md', 'kiosk-desk.md', '--fix-refs']);
    strictEqual(fixed.status, 0, fixed.stderr);
    match(fixed.stdout, /Rewrote 1 code reference\(s\) in 1 file\(s\)/);
    match(readFileSync(path.join(tmpDir, 'packages/atrium/src/b.ts'), 'utf8'), /docs\/plans\/kiosk-desk\.md/);
  });
});
