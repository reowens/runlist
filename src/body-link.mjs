import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonical(entry) {
  try { return realpathSync.native(entry); } catch { return null; }
}

// The roots a body link may resolve inside, canonicalized once. A caller that
// checks many links (a whole index build) resolves them here and passes the
// result to resolveBodyLinkTargetWithin, instead of canonicalizing the same
// roots again for every link.
export function bodyLinkRoots(repoRoot, externalRoots = []) {
  const root = path.resolve(repoRoot);
  const allowedRoots = externalRoots.map(entry => path.resolve(root, entry));
  return {
    root,
    allowedRoots,
    canonicalRoot: canonical(root),
    canonicalAllowedRoots: allowedRoots.map(canonical).filter(entry => entry !== null),
  };
}

// Markdown body links are filesystem paths relative to the document that
// contains them. They deliberately do not inherit frontmatter references'
// repo-root fallback: that fallback can make a broken Markdown link look valid.
export function resolveBodyLinkTarget(href, docDir, repoRoot, externalRoots = []) {
  return resolveBodyLinkTargetWithin(bodyLinkRoots(repoRoot, externalRoots), href, docDir);
}

export function resolveBodyLinkTargetWithin(roots, href, docDir) {
  if (!href) return { ok: false, reason: 'missing' };

  const { root, allowedRoots, canonicalRoot, canonicalAllowedRoots } = roots;
  const candidate = path.resolve(docDir, href);
  const allowedLexically = isWithin(root, candidate) || allowedRoots.some(entry => isWithin(entry, candidate));
  if (!allowedLexically) return { ok: false, reason: 'outside-repo' };
  if (!existsSync(candidate)) return { ok: false, reason: 'missing' };

  if (canonicalRoot === null) return { ok: false, reason: 'unreadable' };
  const canonicalTarget = canonical(candidate);
  if (canonicalTarget === null) return { ok: false, reason: 'unreadable' };
  if (!isWithin(canonicalRoot, canonicalTarget)
    && !canonicalAllowedRoots.some(entry => isWithin(entry, canonicalTarget))) {
    return { ok: false, reason: 'outside-repo' };
  }

  try {
    const stat = statSync(canonicalTarget);
    if (!stat.isFile() && !stat.isDirectory()) return { ok: false, reason: 'unsupported-target' };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  // Return the authored lexical route after using the canonical route only for
  // containment. Callers index documents by their repo-relative spelling (and
  // may intentionally include an in-repo symlink alias).
  return { ok: true, path: candidate, realPath: canonicalTarget };
}
