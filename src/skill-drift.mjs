import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

// dotmd is a drift- and staleness-catcher that didn't, until now, catch drift
// in its OWN plugin surface. Two canonical workflow-doc surfaces are kept in
// lockstep by hand: the repo's CLAUDE.md (its own instructions) and the plugin
// SKILL.md (what every OTHER repo's session learns the workflow from). CLAUDE.md
// literally says "keep it in sync with the guidance below" — this guard makes
// that lockstep mechanical instead of manual.
//
// The comparison unit is a marked block (not a fuzzy phrase heuristic):
// deterministic, robust, and zero false positives. Each surface wraps the
// irreducible workflow contract between the markers below; the guard extracts
// both and compares them whitespace-tolerantly. Editing the contract in one
// surface and forgetting the other is exactly what this catches.

export const CANONICAL_MARKERS = {
  start: '<!-- dotmd:canonical-workflow:start -->',
  end: '<!-- dotmd:canonical-workflow:end -->',
};

const CLAUDE_MD = 'CLAUDE.md';
const SKILL_MD = path.join('plugins', 'dotmd', 'skills', 'dotmd', 'SKILL.md');

// Pull the inner text between the canonical markers. Returns null when the
// markers are absent or malformed — callers treat null as "this surface doesn't
// participate in the lockstep block", which is what keeps a user repo that has
// its own CLAUDE.md (but never adopted the block) from ever tripping the guard.
export function extractCanonicalBlock(text) {
  if (typeof text !== 'string') return null;
  const startIdx = text.indexOf(CANONICAL_MARKERS.start);
  if (startIdx === -1) return null;
  const afterStart = startIdx + CANONICAL_MARKERS.start.length;
  const endIdx = text.indexOf(CANONICAL_MARKERS.end, afterStart);
  if (endIdx === -1 || endIdx < afterStart) return null;
  return text.slice(afterStart, endIdx);
}

// Whitespace-tolerant so a CRLF vs LF or a stray trailing space between the two
// files isn't reported as drift — only meaningful content divergence is.
function normalizeBlock(block) {
  return block
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+$/, ''))
    .join('\n')
    .trim();
}

function readIfPresent(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

// Guard: the canonical workflow block must stay identical across CLAUDE.md and
// the plugin SKILL.md. Returns [] unless BOTH files exist AND BOTH carry the
// block — so it only fires in a repo that has adopted the lockstep convention
// (i.e. the dotmd repo itself), never in a user repo that merely has its own
// CLAUDE.md. That strict gate is the price of zero false positives; the
// trade-off is that deleting the markers from one surface silently disables the
// guard rather than warning (a deliberate, visible act, unlike a content edit).
export function checkSkillDrift(config) {
  const repoRoot = config?.repoRoot;
  if (!repoRoot) return [];

  const claudeText = readIfPresent(path.join(repoRoot, CLAUDE_MD));
  const skillText = readIfPresent(path.join(repoRoot, SKILL_MD));
  if (claudeText === null || skillText === null) return [];

  const claudeBlock = extractCanonicalBlock(claudeText);
  const skillBlock = extractCanonicalBlock(skillText);
  if (claudeBlock === null || skillBlock === null) return [];

  if (normalizeBlock(claudeBlock) === normalizeBlock(skillBlock)) return [];

  return [{
    path: SKILL_MD,
    level: 'warning',
    message: `canonical workflow block drifted from \`${CLAUDE_MD}\`. The block between \`${CANONICAL_MARKERS.start}\` and \`${CANONICAL_MARKERS.end}\` must stay identical in both files — reconcile them so the plugin skill and the repo instructions teach the same workflow.`,
  }];
}
