// F13 (0.37.0): collapse high-frequency auto-fixable `dotmd check` warnings
// into one-line remediation hints. Without this, bulk-fixable noise (43
// `updated behind git history`, N singular-key deprecations) drowns out
// structural findings in the per-doc list — and forces the reader to
// reconstruct the fix command per category.
//
// Each category names the message regex to match, a short label for the
// summary line, and the exact `dotmd …` command that bulk-fixes it.

const COLLAPSE_THRESHOLD = 3;

const CATEGORIES = [
  {
    key: 'updated-behind-git',
    match: /^frontmatter `updated:.*` is behind git history/,
    label: 'docs have `updated` behind git history',
    fix: 'dotmd touch --git',
  },
  {
    key: 'singular-module',
    match: /^`module:` \(singular\) is deprecated/,
    label: 'docs use deprecated singular `module:`',
    fix: 'dotmd lint --fix',
  },
  {
    key: 'singular-surface',
    match: /^`surface:` \(singular\) is deprecated/,
    label: 'docs use deprecated singular `surface:`',
    fix: 'dotmd lint --fix',
  },
];

function categoryFor(message) {
  for (const cat of CATEGORIES) {
    if (cat.match.test(message)) return cat;
  }
  return null;
}

// Split warnings into per-doc passthrough lines and collapsed summary buckets.
// A category that hits ≥COLLAPSE_THRESHOLD warnings is summarized; below the
// threshold each warning falls through as a normal per-doc line (small counts
// don't gain from collapse and lose path information).
export function categorizeWarnings(warnings) {
  const buckets = new Map();
  const orphans = [];

  for (const w of warnings) {
    const cat = categoryFor(w.message);
    if (!cat) {
      orphans.push(w);
      continue;
    }
    if (!buckets.has(cat.key)) buckets.set(cat.key, { cat, items: [] });
    buckets.get(cat.key).items.push(w);
  }

  const collapsed = [];
  const passthrough = [...orphans];

  for (const { cat, items } of buckets.values()) {
    if (items.length >= COLLAPSE_THRESHOLD) {
      collapsed.push({ key: cat.key, label: cat.label, fix: cat.fix, count: items.length });
    } else {
      passthrough.push(...items);
    }
  }

  passthrough.sort((a, b) => a.path.localeCompare(b.path));
  collapsed.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return { passthrough, collapsed };
}

export const _internalForTest = { COLLAPSE_THRESHOLD, CATEGORIES };
