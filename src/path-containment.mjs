import path from 'node:path';

// Lexical preflight only. Callers must also check canonical filesystem paths
// when authorizing real files, so symlink/junction parents cannot escape.
export function isPathInside(root, file, paths = path) {
  if (!paths.isAbsolute(root) || !paths.isAbsolute(file)) return false;
  const relative = paths.relative(root, file);
  return relative === '' || (relative !== '..'
    && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative));
}

export function containingRoot(file, roots, paths = path) {
  return roots.filter(root => isPathInside(root, file, paths))
    .sort((a, b) => paths.resolve(b).length - paths.resolve(a).length)[0] ?? null;
}
