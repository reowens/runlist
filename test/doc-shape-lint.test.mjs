import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

let tmpDir;
const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-docshape-'));
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
  return filePath;
}

function checkJson() {
  const r = spawnSync('node', [bin, 'check', '--json', '--config', path.join(tmpDir, 'dotmd.config.mjs')], {
    cwd: tmpDir, encoding: 'utf8',
  });
  return JSON.parse(r.stdout);
}

afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); });

describe('doc-shape lint', () => {
  it('warns on `## Related Documents` (suggests `## Related Documentation`)', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'doc.md', `type: doc\nstatus: active\nupdated: 2026-05-13`, `# D\n\n## Related Documents\n\n- foo.md\n`);

    const idx = checkJson();
    const w = idx.warnings.find(x => x.message.startsWith('Heading drift'));
    ok(w, `expected heading drift warning, got: ${JSON.stringify(idx.warnings)}`);
    ok(w.message.includes('Related Documents'), 'cites the wrong form');
    ok(w.message.includes('Related Documentation'), 'suggests canonical');
  });

  it('does not warn when `## Related Documentation` is correct', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'doc.md', `type: doc\nstatus: active\nupdated: 2026-05-13`, `# D\n\n## Related Documentation\n\n- foo.md\n`);

    const idx = checkJson();
    const w = idx.warnings.find(x => x.message.startsWith('Heading drift'));
    ok(!w, 'should not warn on canonical form');
  });

  it('does not run on non-doc types (plan-typed docs ignored)', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'plan.md', `type: plan\nstatus: active\nupdated: 2026-05-13`, `# P\n\n## Related Documents\n\n- foo.md\n`);

    const idx = checkJson();
    const w = idx.warnings.find(x => x.message.startsWith('Heading drift') && x.message.includes('Related Documents'));
    ok(!w, 'doc-shape lint only applies to type: doc');
  });

  it('does not warn on archived docs', () => {
    const docsDir = setupProject();
    writeDoc(docsDir, 'archived/old.md', `type: doc\nstatus: archived\nupdated: 2026-05-13`, `# D\n\n## Related Documents\n`);

    const idx = checkJson();
    const w = idx.warnings.find(x => x.path.includes('archived/old.md') && x.message.startsWith('Heading drift'));
    ok(!w, 'archived docs should not trigger doc-shape lint');
  });
});
