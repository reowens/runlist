import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Markdown body links are filesystem paths relative to the document that
// contains them. They deliberately do not inherit frontmatter references'
// repo-root fallback: that fallback can make a broken Markdown link look valid.
export function resolveBodyLinkTarget(href, docDir, repoRoot) {
  if (!href) return { ok: false, reason: 'missing' };

  const root = path.resolve(repoRoot);
  const candidate = path.resolve(docDir, href);
  if (!isWithin(root, candidate)) return { ok: false, reason: 'outside-repo' };
  if (!existsSync(candidate)) return { ok: false, reason: 'missing' };

  let canonicalRoot;
  let canonicalTarget;
  try {
    canonicalRoot = realpathSync(root);
    canonicalTarget = realpathSync(candidate);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (!isWithin(canonicalRoot, canonicalTarget)) return { ok: false, reason: 'outside-repo' };

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
