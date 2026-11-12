import { describe, it, afterEach } from 'node:test';
import { strictEqual, deepStrictEqual, match, ok } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import { excludedRecordsNaming } from '../src/record-dirs.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'runlist.mjs');
let tmpDir;

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

function git(...args) {
  const r = spawnSync('git', args, { cwd: tmpDir, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

function write(rel, text) {
  mkdirSync(path.dirname(path.join(tmpDir, rel)), { recursive: true });
  writeFileSync(path.join(tmpDir, rel), text);
}

function commit(message) {
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', message);
  return git('rev-parse', '--short', 'HEAD').trim();
}

function run(args) {
  return spawnSync('node', [BIN, ...args], { cwd: tmpDir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
}

const plan = (title, extra = '', body = '') => `---
type: plan
status: active
updated: 2025-01-01
${extra}---

# ${title}

${body}
`;

// A lamp plan with a records folder the index excludes, a shelf plan that
// says the lamp plan supersedes it, an archived bulb plan it replaces, and a
// record of the lamp plan kept in another plan's folder.
function setup() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-history-'));
  git('init', '-q');
  write('runlist.config.mjs', "export const root = 'docs/plans';\nexport const excludeDirs = ['assets'];\n");
  write('docs/plans/lamp.md', plan('Lamp', '', [
    'Replaces the [bulb plan](archived/bulb.md).',
    '',
    '## Phase 1',
    '',
    'The brass fitting holds a warm bulb.',
    '',
    '## Decisions',
    '',
    '### D1  Which shade?',
    '',
    'Disposition: OPEN.',
    '',
    '### D2  Which cord?',
    '',
    'Disposition: RULED 2025-02-01: the cloth one.',
  ].join('\n')));
  write('docs/plans/shelf.md', plan('Shelf', '', 'Superseded by [the lamp](lamp.md).'));
  write('docs/plans/archived/bulb.md', plan('Bulb').replace('status: active', 'status: archived'));
  commit('lamp plan');
}

describe('a lifecycle move and records in an excluded folder', () => {
  it('archive repoints a record header link, and its dry run names the record', () => {
    setup();
    write('docs/plans/assets/lamp/fittings.md', '# Fittings\n\nRecord of [Lamp](../../lamp.md).\n');
    write('docs/plans/assets/lamp/other.md', '# Other\n\nNothing about it.\n');
    write('docs/plans/assets/lamp/cased.md', '# Cased\n\nSee [Lamp](../../LAMP.md).\n');
    commit('record');

    const dry = run(['archive', 'docs/plans/lamp.md', '-n']);
    strictEqual(dry.status, 0, dry.stderr);
    match(dry.stdout, /Would repoint links in record docs\/plans\/assets\/lamp\/fittings\.md/);
    ok(!dry.stdout.includes('other.md'));
    match(readFileSync(path.join(tmpDir, 'docs/plans/assets/lamp/fittings.md'), 'utf8'), /\(\.\.\/\.\.\/lamp\.md\)/, 'a dry run writes nothing');

    const r = run(['archive', 'docs/plans/lamp.md']);
    strictEqual(r.status, 0, r.stderr);
    match(readFileSync(path.join(tmpDir, 'docs/plans/assets/lamp/fittings.md'), 'utf8'), /\[Lamp\]\(\.\.\/\.\.\/archived\/lamp\.md\)/);
    strictEqual(readFileSync(path.join(tmpDir, 'docs/plans/assets/lamp/other.md'), 'utf8'), '# Other\n\nNothing about it.\n');
    if (existsSync(path.join(tmpDir, 'docs/plans/LAMP.md')) || existsSync(path.join(tmpDir, 'docs/plans/archived/LAMP.md'))) {
      // A case-folding filesystem resolves the other spelling to the plan.
      match(readFileSync(path.join(tmpDir, 'docs/plans/assets/lamp/cased.md'), 'utf8'), /archived\//);
    }
  });

  it('repoints only a record\'s header, and leaves a link further down byte for byte', () => {
    setup();
    const body = ['# Snapshot', '', 'Record of [Lamp](../../lamp.md).', '', '1', '2', '3', '4', '5', 'Copied text: [Lamp](../../lamp.md).', ''].join('\n');
    write('docs/plans/assets/lamp/snapshot.md', body);
    commit('record');
    const r = run(['archive', 'docs/plans/lamp.md']);
    strictEqual(r.status, 0, r.stderr);
    const after = readFileSync(path.join(tmpDir, 'docs/plans/assets/lamp/snapshot.md'), 'utf8');
    match(after.split('\n')[2], /\(\.\.\/\.\.\/archived\/lamp\.md\)/);
    strictEqual(after.split('\n').slice(8).join('\n'), body.split('\n').slice(8).join('\n'));
  });

  it('rename repoints a record header link, names it in a dry run, and leaves lines below the header alone', () => {
    setup();
    const body = ['# Snapshot', '', 'Record of [Lamp](../../lamp.md).', '', '1', '2', '3', '4', '5', 'Copied text: [Lamp](../../lamp.md).', ''].join('\n');
    write('docs/plans/assets/lamp/snapshot.md', body);
    write('docs/plans/assets/lamp/other.md', '# Other\n\nNothing about it.\n');
    commit('record');

    const dry = run(['rename', 'docs/plans/lamp.md', 'lantern', '-n']);
    strictEqual(dry.status, 0, dry.stderr);
    match(dry.stdout, /Would repoint links in record docs\/plans\/assets\/lamp\/snapshot\.md/);
    ok(!dry.stdout.includes('other.md'));
    strictEqual(readFileSync(path.join(tmpDir, 'docs/plans/assets/lamp/snapshot.md'), 'utf8'), body, 'a dry run writes nothing');

    const r = run(['rename', 'docs/plans/lamp.md', 'lantern']);
    strictEqual(r.status, 0, r.stderr);
    ok(existsSync(path.join(tmpDir, 'docs/plans/lantern.md')));
    const after = readFileSync(path.join(tmpDir, 'docs/plans/assets/lamp/snapshot.md'), 'utf8');
    match(after.split('\n')[2], /\[Lamp\]\(\.\.\/\.\.\/lantern\.md\)/);
    strictEqual(after.split('\n').slice(8).join('\n'), body.split('\n').slice(8).join('\n'));
    strictEqual(readFileSync(path.join(tmpDir, 'docs/plans/assets/lamp/other.md'), 'utf8'), '# Other\n\nNothing about it.\n');
  });

  it('reads records as loosely as the reference rewriter does', async () => {
    setup();
    write('docs/plans/assets/lamp/cased.md', '# Cased\n\nSee [Lamp](../../LAMP.md).\n');
    write('docs/plans/assets/lamp/encoded.md', '# Encoded\n\nSee [Lamp](../../la%6Dp.md).\n');
    write('docs/plans/assets/lamp/other.md', '# Other\n\nNothing about it.\n');
    const config = await resolveConfig(tmpDir);
    const found = excludedRecordsNaming(path.join(tmpDir, 'docs/plans/lamp.md'), config).map(f => path.basename(f)).sort();
    deepStrictEqual(found, ['cased.md', 'encoded.md']);
  });
});
