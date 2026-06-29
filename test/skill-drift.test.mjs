import { describe, it, afterEach } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  CANONICAL_MARKERS,
  extractCanonicalBlock,
  checkSkillDrift,
} from '../src/skill-drift.mjs';

// dotmd guarding its own plugin surface: the canonical workflow block must stay
// identical across CLAUDE.md and plugins/dotmd/skills/dotmd/SKILL.md. The guard
// only fires when BOTH files exist AND BOTH carry the block — zero false
// positives in a user repo that has its own CLAUDE.md but no plugin source.

const { start, end } = CANONICAL_MARKERS;
const BLOCK = `${start}\n- **Orient:** \`dotmd briefing\`\n- **Single status verb:** \`dotmd set <status>\`\n${end}`;

let tmpDir;

function setup() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-skill-drift-'));
  return tmpDir;
}

function writeClaude(body) {
  writeFileSync(path.join(tmpDir, 'CLAUDE.md'), body);
}

function writeSkill(body) {
  const dir = path.join(tmpDir, 'plugins', 'dotmd', 'skills', 'dotmd');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), body);
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('extractCanonicalBlock', () => {
  it('returns the inner text between the markers', () => {
    const inner = extractCanonicalBlock(`prefix\n${BLOCK}\nsuffix`);
    strictEqual(inner.includes('dotmd briefing'), true);
    strictEqual(inner.includes(start), false);
    strictEqual(inner.includes(end), false);
  });

  it('returns null when the start marker is absent', () => {
    strictEqual(extractCanonicalBlock(`no markers here`), null);
  });

  it('returns null when the end marker is absent', () => {
    strictEqual(extractCanonicalBlock(`prefix ${start} only the opener`), null);
  });

  it('returns null for non-string input', () => {
    strictEqual(extractCanonicalBlock(null), null);
    strictEqual(extractCanonicalBlock(undefined), null);
  });
});

describe('checkSkillDrift', () => {
  it('returns [] when CLAUDE.md is missing (plugin-only tree)', () => {
    setup();
    writeSkill(BLOCK);
    deepStrictEqual(checkSkillDrift({ repoRoot: tmpDir }), []);
  });

  it('returns [] when SKILL.md is missing (ordinary user repo)', () => {
    setup();
    writeClaude(BLOCK);
    deepStrictEqual(checkSkillDrift({ repoRoot: tmpDir }), []);
  });

  it('returns [] when only one surface carries the block (no false positive)', () => {
    setup();
    writeClaude(BLOCK);
    writeSkill('# SKILL\n\nNo canonical block here.\n');
    deepStrictEqual(checkSkillDrift({ repoRoot: tmpDir }), []);
  });

  it('returns [] when both blocks match', () => {
    setup();
    writeClaude(`# CLAUDE\n\n${BLOCK}\n`);
    writeSkill(`---\nname: dotmd\n---\n\n${BLOCK}\n`);
    deepStrictEqual(checkSkillDrift({ repoRoot: tmpDir }), []);
  });

  it('ignores whitespace-only differences (CRLF, trailing spaces)', () => {
    setup();
    writeClaude(`# CLAUDE\n\n${BLOCK}\n`);
    const crlf = BLOCK.replace(/\n/g, '\r\n').replace(/dotmd briefing`/, 'dotmd briefing`   ');
    writeSkill(`# SKILL\n\n${crlf}\n`);
    deepStrictEqual(checkSkillDrift({ repoRoot: tmpDir }), []);
  });

  it('warns when the blocks have diverged in content', () => {
    setup();
    writeClaude(`# CLAUDE\n\n${BLOCK}\n`);
    const drifted = `${start}\n- **Orient:** \`dotmd briefing\`\n- **Single status verb:** \`dotmd status <status>\`\n${end}`;
    writeSkill(`# SKILL\n\n${drifted}\n`);
    const warnings = checkSkillDrift({ repoRoot: tmpDir });
    strictEqual(warnings.length, 1);
    strictEqual(warnings[0].level, 'warning');
    strictEqual(warnings[0].path, path.join('plugins', 'dotmd', 'skills', 'dotmd', 'SKILL.md'));
    strictEqual(warnings[0].message.includes('drifted'), true);
  });

  it('returns [] when config has no repoRoot', () => {
    deepStrictEqual(checkSkillDrift({}), []);
    deepStrictEqual(checkSkillDrift(null), []);
  });

  it('keeps the real repo block in lockstep (regression guard)', () => {
    // Guards the actual committed CLAUDE.md ⇄ SKILL.md pair in this repo —
    // a normal `npm test` run fails the moment the two surfaces drift.
    const repoRoot = path.resolve(import.meta.dirname, '..');
    deepStrictEqual(checkSkillDrift({ repoRoot }), []);
  });
});
