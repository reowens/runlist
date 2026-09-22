import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildIndex } from '../src/index.mjs';
import { resolveConfig } from '../src/config.mjs';

let tmpDir;

function setup({ stateDir = true } = {}) {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-parse-cache-'));
  mkdirSync(path.join(tmpDir, '.git'));
  if (stateDir) mkdirSync(path.join(tmpDir, '.runlist'));
  const docsDir = path.join(tmpDir, 'docs');
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), `export const root = 'docs';\n`);
  return docsDir;
}

function writeDoc(docsDir, name, body) {
  writeFileSync(path.join(docsDir, name), `---\ntype: doc\nstatus: current\n---\n# ${name}\n\n${body}\n`);
}

const cachePath = () => path.join(tmpDir, '.runlist', 'parse-cache');
const docs = index => JSON.stringify(index.docs);

afterEach(() => {
  delete process.env.RUNLIST_NO_PARSE_CACHE;
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('parse cache', () => {
  it('a warm build returns what an uncached build does, fast and full', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', '> A summary.\n\n- [x] one\n- [ ] two\n\nSee [`b`](b.md) and `[fake](c.md)`.');
    writeDoc(docsDir, 'b.md', '## Next Step\n\nShip it.');
    const config = await resolveConfig(tmpDir);
    for (const fast of [true, false]) {
      process.env.RUNLIST_NO_PARSE_CACHE = '1';
      const uncached = buildIndex(config, { fast });
      delete process.env.RUNLIST_NO_PARSE_CACHE;
      const cold = buildIndex(config, { fast });
      ok(existsSync(cachePath()));
      const warm = buildIndex(config, { fast });
      strictEqual(docs(cold), docs(uncached));
      strictEqual(docs(warm), docs(uncached));
      deepStrictEqual(warm.errors, uncached.errors);
    }
  });

  it('an edited document is parsed again', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', '> First summary.');
    const config = await resolveConfig(tmpDir);
    strictEqual(buildIndex(config, { fast: true }).docs[0].summary, 'First summary.');
    writeDoc(docsDir, 'a.md', '> A longer second summary.');
    strictEqual(buildIndex(config, { fast: true }).docs[0].summary, 'A longer second summary.');
  });

  it('a deleted document leaves the cache', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'one');
    writeDoc(docsDir, 'gone.md', 'two');
    const config = await resolveConfig(tmpDir);
    buildIndex(config, { fast: true });
    ok(readFileSync(cachePath(), 'utf8').includes('gone.md'));
    unlinkSync(path.join(docsDir, 'gone.md'));
    buildIndex(config, { fast: true });
    ok(!readFileSync(cachePath(), 'utf8').includes('gone.md'));
  });

  it('what a caller does to a document never reaches the cache', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'See [b](b.md).');
    const config = await resolveConfig(tmpDir);
    buildIndex(config, { fast: true });
    const first = buildIndex(config, { fast: true });
    first.docs[0].bodyLinks.push({ href: 'injected.md' });
    first.docs[0].checklist.total = 99;
    const second = buildIndex(config, { fast: true });
    strictEqual(second.docs[0].bodyLinks.length, 1);
    strictEqual(second.docs[0].checklist.total, 0);
  });

  it('writes nothing in a repo with no state directory', async () => {
    const docsDir = setup({ stateDir: false });
    writeDoc(docsDir, 'a.md', 'one');
    const config = await resolveConfig(tmpDir);
    buildIndex(config, { fast: true });
    ok(!existsSync(path.join(tmpDir, '.runlist')));
  });

  it('RUNLIST_NO_PARSE_CACHE=1 turns it off', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', 'one');
    process.env.RUNLIST_NO_PARSE_CACHE = '1';
    const config = await resolveConfig(tmpDir);
    buildIndex(config, { fast: true });
    ok(!existsSync(cachePath()));
  });

  it('a damaged cache file is ignored and replaced', async () => {
    const docsDir = setup();
    writeDoc(docsDir, 'a.md', '> Real summary.');
    writeFileSync(cachePath(), 'not a cache\n\x00\t\t{broken');
    const config = await resolveConfig(tmpDir);
    strictEqual(buildIndex(config, { fast: true }).docs[0].summary, 'Real summary.');
    strictEqual(buildIndex(config, { fast: true }).docs[0].summary, 'Real summary.');
  });
});
