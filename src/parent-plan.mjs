import { readFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter, replaceFrontmatter } from './frontmatter.mjs';
import { MutationConflictError } from './atomic-mutation.mjs';
import { escapeRegex, normalizeStringList, nowIso, resolveRefPath, toRepoPath } from './util.mjs';

// Replace a top-level frontmatter field (its `key:` line + any indented
// continuation block) with `serialized`, or append it when absent. Shared by
// runlist mutations and the membership back-reference fixer so both paths
// serialize `parent_plan:` identically.
export function upsertFrontmatterField(fm, key, serialized) {
  const re = new RegExp(`^${escapeRegex(key)}:.*(\\n[ \\t]+.*)*`, 'm');
  if (re.test(fm)) return fm.replace(re, serialized);
  return fm.replace(/\s*$/, '') + '\n' + serialized;
}

// Plan an atomic child-side `parent_plan:` update. The caller owns the evidence
// that authorizes the relationship (a runlist entry or body-order row); this
// helper owns the byte-level invariant: never clobber another parent, write a
// child-relative forward-slash ref, bump `updated:`, and compare-and-swap the
// exact child snapshot used to make the decision.
export function planChildParentUpdate(childAbs, hubAbs, config) {
  const raw = readFileSync(childAbs, 'utf8');
  const { frontmatter: fmRaw } = extractFrontmatter(raw);
  if (fmRaw == null) return { wrote: false, reason: 'missing-frontmatter', raw };
  const fm = parseSimpleFrontmatter(fmRaw);
  const childDir = path.dirname(childAbs);
  const existingRefs = normalizeStringList(fm.parent_plan);
  if (existingRefs.length > 0) {
    const resolved = existingRefs.map(ref => resolveRefPath(ref, childDir, config.repoRoot));
    if (existingRefs.length === 1 && resolved[0] === hubAbs) {
      return { wrote: false, reason: 'already-set', raw };
    }
    return { wrote: false, reason: 'different-parent', existing: existingRefs.join(', '), raw };
  }
  const ref = path.relative(childDir, hubAbs).split(path.sep).join('/');
  return {
    wrote: true,
    ref,
    raw,
    update: {
      path: childAbs,
      expectedContent: raw,
      render: current => {
        const { frontmatter: currentFm } = extractFrontmatter(current);
        const currentParsed = parseSimpleFrontmatter(currentFm);
        const currentParents = normalizeStringList(currentParsed.parent_plan);
        if (currentParents.length > 0
          && !(currentParents.length === 1 && resolveRefPath(currentParents[0], childDir, config.repoRoot) === hubAbs)) {
          throw new MutationConflictError(`Child parent_plan changed while the membership mutation was being prepared: ${toRepoPath(childAbs, config.repoRoot)}`);
        }
        let updatedFm = upsertFrontmatterField(currentFm, 'parent_plan', `parent_plan: ${ref}`);
        updatedFm = upsertFrontmatterField(updatedFm, 'updated', `updated: ${nowIso()}`);
        return replaceFrontmatter(current, updatedFm);
      },
    },
  };
}
