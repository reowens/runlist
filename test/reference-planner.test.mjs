import { afterEach, describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReferenceIdentitySet, rewriteDocumentReferences } from '../src/reference-planner.mjs';

// Whether two spellings name one file is the same question the resolver asks,
// and it is a property of the filesystem under the test's temp dir — not of the
// platform, so it is probed rather than assumed.
function sameFile(left, right) {
  try {
    const a = statSync(left);
    const b = statSync(right);
    return a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}

function sameFileProbe() {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'dotmd-case-probe-'));
  try {
    writeFileSync(path.join(probe, 'probe.md'), 'x');
    return sameFile(path.join(probe, 'probe.md'), path.join(probe, 'PROBE.MD'));
  } finally { rmSync(probe, { recursive: true, force: true }); }
}

// The rewriter skips the fence-aware walk for documents that cannot name the
// moved file. These cover the ways a document CAN name it without spelling the
// basename literally — each one is a silent missed rewrite if the shortcut is
// wrong, so they assert the rewrite still happens.
describe('reference rewrite candidate prefilter', () => {
  let tmpDir = null;
  afterEach(() => { if (tmpDir) rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; });

  const setup = () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-refplan-'));
    mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
    return tmpDir;
  };
  const doc = body => `---\ntype: doc\nstatus: active\n---\n${body}\n`;

  const rewrite = (root, referrer, content, oldPath, newPath, corpus) => rewriteDocumentReferences(content, {
    sourcePath: referrer,
    repoRoot: root,
    identities: createReferenceIdentitySet(corpus),
    oldPath,
    newPath,
    referenceFields: ['related_docs'],
  });

  it('rewrites a link whose destination escapes spaces in the filename', () => {
    const root = setup();
    const target = path.join(root, 'docs', 'my plan.md');
    const referrer = path.join(root, 'docs', 'a.md');
    writeFileSync(target, doc('# Target'));
    // A space in a link destination has to be escaped, so the raw text never
    // contains "my plan.md" — only "my\ plan.md".
    const content = doc('See [the plan](my\\ plan.md).');
    writeFileSync(referrer, content);
    const moved = rewrite(root, referrer, content, target, path.join(root, 'docs', 'archived', 'my plan.md'), [target, referrer]);
    ok(moved.includes('archived/my\\ plan.md'), `expected the escaped destination to move, got: ${moved}`);
  });

  it('rewrites a link whose case differs, where the filesystem folds case', () => {
    const root = setup();
    const target = path.join(root, 'docs', 'casing.md');
    const referrer = path.join(root, 'docs', 'a.md');
    writeFileSync(target, doc('# Target'));
    const content = doc('See [it](CASING.MD).');
    writeFileSync(referrer, content);
    const newPath = path.join(root, 'docs', 'archived', 'casing.md');
    const moved = rewrite(root, referrer, content, target, newPath, [target, referrer]);
    if (sameFile(target, path.join(root, 'docs', 'CASING.MD'))) {
      // `realpath` hands back the caller's spelling, so an exact compare used to
      // miss this — while `dotmd check` (which resolves with existsSync) called
      // the link perfectly valid. The move stranded it and check then called it
      // broken.
      ok(moved.includes('archived/casing.md'), `expected the differently-cased destination to move, got: ${moved}`);
    } else {
      strictEqual(moved, content, 'a case-sensitive filesystem has no such file, so nothing resolves');
    }
  });

  it('keeps two documents that differ only by case apart', { skip: sameFileProbe() && 'this filesystem folds case, so the two cannot coexist' }, () => {
    const root = setup();
    const lower = path.join(root, 'docs', 'dup.md');
    const upper = path.join(root, 'docs', 'DUP.md');
    const referrer = path.join(root, 'docs', 'a.md');
    writeFileSync(lower, doc('# lower'));
    writeFileSync(upper, doc('# upper'));
    // Each link names a real, distinct file: neither may be dragged along when
    // the other moves, and the shared case fold must not be guessed at.
    const content = doc('[a](dup.md) and [b](DUP.md)');
    writeFileSync(referrer, content);
    const moved = rewrite(root, referrer, content, lower, path.join(root, 'docs', 'archived', 'dup.md'), [lower, upper, referrer]);
    ok(moved.includes('archived/dup.md'), 'the moved document is rewritten');
    ok(moved.includes('(DUP.md)'), `the other document is left alone, got: ${moved}`);
  });

  it('rewrites a link that reaches the document through a symlinked name', { skip: process.platform === 'win32' && 'symlink creation needs elevation on Windows' }, () => {
    const root = setup();
    const target = path.join(root, 'docs', 'real.md');
    const alias = path.join(root, 'docs', 'alias.md');
    const referrer = path.join(root, 'docs', 'a.md');
    writeFileSync(target, doc('# Target'));
    symlinkSync(target, alias);
    // The referrer names the alias; only realpath ties it to the moved file.
    const content = doc('See [it](alias.md).');
    writeFileSync(referrer, content);
    const identities = createReferenceIdentitySet([target, alias, referrer]);
    strictEqual(identities.symlinked, true, 'a symlinked corpus disables the name shortcut');
    const moved = rewriteDocumentReferences(content, {
      sourcePath: referrer, repoRoot: root, identities, oldPath: target,
      newPath: path.join(root, 'docs', 'archived', 'real.md'), referenceFields: ['related_docs'],
    });
    ok(moved.includes('archived/real.md'), `expected the aliased destination to move, got: ${moved}`);
  });

  it('leaves a document that merely discusses the filename in prose alone', () => {
    const root = setup();
    const target = path.join(root, 'docs', 'topic.md');
    const referrer = path.join(root, 'docs', 'a.md');
    writeFileSync(target, doc('# Target'));
    const content = doc('We should write topic.md one day, but there is no link yet.');
    writeFileSync(referrer, content);
    const moved = rewrite(root, referrer, content, target, path.join(root, 'docs', 'archived', 'topic.md'), [target, referrer]);
    strictEqual(moved, content);
  });

  it('agrees with an unfiltered walk across a mixed corpus', () => {
    const root = setup();
    const target = path.join(root, 'docs', 'target.md');
    writeFileSync(target, doc('# Target'));
    const corpus = [target];
    const bodies = [
      'Inline [link](target.md).',
      'Repo-relative [link](/docs/target.md).',
      'Nested [link](../docs/target.md).',
      'Reference definition.\n\n[label]: target.md',
      'Angle <target.md> destination: [x](<target.md>).',
      'With a fragment [x](target.md#section).',
      'Inside a fence:\n\n```\n[x](target.md)\n```\n',
      'Unrelated [link](other.md).',
      'No links at all.',
      'Only prose about target.md.',
    ];
    bodies.forEach((body, index) => {
      const file = path.join(root, 'docs', `ref-${index}.md`);
      writeFileSync(file, doc(body));
      corpus.push(file);
    });
    const newPath = path.join(root, 'docs', 'archived', 'target.md');
    const identities = createReferenceIdentitySet(corpus);
    // Force the slow path by pretending the corpus is symlinked, then compare
    // it against the filtered path document by document.
    const unfiltered = createReferenceIdentitySet(corpus);
    unfiltered.symlinked = true;
    for (const file of corpus.slice(1)) {
      const content = doc(bodies[Number(path.basename(file, '.md').split('-')[1])]);
      const args = { sourcePath: file, repoRoot: root, oldPath: target, newPath, referenceFields: ['related_docs'] };
      strictEqual(
        rewriteDocumentReferences(content, { ...args, identities }),
        rewriteDocumentReferences(content, { ...args, identities: unfiltered }),
        `filtered and unfiltered disagree on ${path.basename(file)}`,
      );
    }
  });
});
