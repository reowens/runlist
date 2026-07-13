import { describe, it } from 'node:test';
import { deepStrictEqual, match, strictEqual, throws } from 'node:assert';
import { allocateOutputIdentities, outputPathToUrl } from '../src/output-identity.mjs';

function doc(path, root = 'docs') {
  return { path, root };
}

describe('allocateOutputIdentities', () => {
  it('preserves top-level paths and nests root-relative documents', () => {
    const identities = allocateOutputIdentities([
      doc('docs/a.md'),
      doc('docs/guides/b.md'),
    ]);
    strictEqual(identities.get('docs/a.md').htmlPath, 'a.html');
    strictEqual(identities.get('docs/guides/b.md').htmlPath, 'guides/b.html');
  });

  it('falls back deterministically for exact multi-root collisions', () => {
    const docs = [doc('docs/a.md'), doc('notes/a.md', 'notes')];
    const forward = allocateOutputIdentities(docs);
    const reverse = allocateOutputIdentities([...docs].reverse());
    for (const item of docs) {
      const htmlPath = forward.get(item.path).htmlPath;
      match(htmlPath, /^__dotmd\/[a-f0-9]{64}\.html$/);
      strictEqual(reverse.get(item.path).htmlPath, htmlPath);
    }
  });

  it('falls back for reserved, case-fold, and file-directory prefix conflicts', () => {
    const docs = [
      doc('docs/index.md'),
      doc('docs/index.html/child.md'),
      doc('docs/__dotmd/own.md'),
      doc('docs/A.md'),
      doc('docs/a.md'),
      doc('docs/foo.md'),
      doc('docs/foo.html/bar.md'),
    ];
    const identities = allocateOutputIdentities(docs);
    for (const item of docs) match(identities.get(item.path).htmlPath, /^__dotmd\//);
    strictEqual(new Set([...identities.values()].map(value => value.htmlPath)).size, docs.length);
  });

  it('uses the most-specific owning root and permits roots outside the repo', () => {
    const identities = allocateOutputIdentities([
      doc('docs/nested/a.md', 'docs/nested'),
      doc('../shared/b.md', '../shared'),
    ]);
    strictEqual(identities.get('docs/nested/a.md').htmlPath, 'a.html');
    strictEqual(identities.get('../shared/b.md').htmlPath, 'b.html');
  });

  it('rejects duplicate identities, malformed ownership, and unsafe paths', () => {
    throws(() => allocateOutputIdentities([doc('docs/a.md'), doc('docs/./a.md')]), /Duplicate document path/);
    throws(() => allocateOutputIdentities([doc('other/a.md')]), /not owned by its root/);
    throws(() => allocateOutputIdentities([doc('docs')]), /not owned|end in \.md/);
    throws(() => allocateOutputIdentities([doc('/docs/a.md', '/docs')]), /must be relative/);
  });

  it('returns identities for the complete corpus before selection', () => {
    const all = [doc('docs/a.md'), doc('notes/a.md', 'notes'), doc('docs/b.md')];
    const identities = allocateOutputIdentities(all);
    deepStrictEqual([...identities.keys()].sort(), all.map(item => item.path).sort());
    match(identities.get('docs/a.md').htmlPath, /^__dotmd\//);
  });

  it('percent-encodes URL segments without encoding separators', () => {
    strictEqual(outputPathToUrl('guides/a b#c.html'), 'guides/a%20b%23c.html');
  });
});
