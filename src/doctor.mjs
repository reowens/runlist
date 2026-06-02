import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fixBrokenRefs } from './fix-refs.mjs';
import { runLint } from './lint.mjs';
import { runTouch } from './lifecycle.mjs';
import { buildIndex, collectDocFiles } from './index.mjs';
import { renderIndexFile, writeIndex } from './index-file.mjs';
import { renderCheck, renderManualFixes } from './render.mjs';
import { bold, dim, green, yellow } from './color.mjs';
import { checkClaudeCommands, scaffoldClaudeCommands } from './claude-commands.mjs';
import { runMigrateTemplate } from './migrate-template.mjs';
import { runMigratePrompts } from './migrate-prompts.mjs';
import { runFrontmatterFix } from './frontmatter-fix.mjs';
import { toRepoPath } from './util.mjs';

// Tunable thresholds for `dotmd doctor --statuses` conflation detection.
// MIN_BUCKET_SIZE: only flag buckets with at least this many docs (small buckets aren't worth nagging).
// CUE_FLOOR_PCT: a target cue must claim at least this fraction of the bucket to be suggested.
// A bucket is overloaded only when ≥2 distinct target cues each clear the floor.
const MIN_BUCKET_SIZE = 10;
const CUE_FLOOR_PCT = 0.15;

// Cue patterns map keyword groups to candidate target statuses.
// A doc is scored by counting regex hits in its current_state + next_step text;
// the highest-scoring cue (if any) becomes its suggested bucket. Ties broken by
// the iteration order below (deterministic). Patterns are intentionally simple
// and tunable — false positives are fine, false confidence is not.
const CUE_PATTERNS = {
  partial: /\b(shipped|landed|merged|complete|tail|deferred|follow[- ]?up|left[- ]?over|remaining)\b/i,
  paused: /\b(paused?|on hold|set aside|park(?:ed|ing)?|shelv(?:ed|ing)?|frozen|hibernat)/i,
  'queued-after': /\b(after|once|when|depends on|behind|sequenced|wait(?:ing)? for [a-z\- ]+ to (?:ship|land|merge))\b/i,
  awaiting: /\b(awaiting|need(?:s)? (?:input|decision|approval|sign[- ]?off)|pending (?:review|approval)|asked? (?:for|about))\b/i,
  blocked: /\b(hardware|vendor|third[- ]?party|firmware|delivery|arrival|rollout)\b/i,
};

// Human-readable cue lists for the suggestion table.
const CUE_LABELS = {
  partial: '"shipped", "landed", "tail", "deferred"',
  paused: '"paused", "on hold", "set aside"',
  'queued-after': '"after", "once", "depends on", "waiting on <plan>"',
  awaiting: '"awaiting", "needs decision", "pending review"',
  blocked: '"hardware", "vendor", "third-party", "rollout"',
};

export function runDoctor(argv, config, opts = {}) {
  if (argv.includes('--project')) {
    runDoctorProject(config, { json: argv.includes('--json') });
    return;
  }
  if (argv.includes('--statuses')) {
    runDoctorStatuses(config, { json: argv.includes('--json') });
    return;
  }
  if (argv.includes('--migrate-template')) {
    runMigrateTemplate(argv, config, opts);
    return;
  }
  if (argv.includes('--migrate-prompts')) {
    runMigratePrompts(argv, config, opts);
    return;
  }
  if (argv.includes('--frontmatter-fix')) {
    runFrontmatterFix(config, opts);
    return;
  }

  const { dryRun } = opts;
  // 0.37.0 (F4): the mode banner makes it impossible to mistake a preview run
  // for a real one — and tells the user the exact flag that flips it.
  const modeNote = dryRun
    ? dim('[preview — run with --apply to write]')
    : dim('[applying changes]');
  process.stdout.write(bold('dotmd doctor') + ' ' + modeNote + '\n\n');

  // Step 1: Fix broken references
  process.stdout.write(bold('1. Fixing broken references...') + '\n');
  fixBrokenRefs(config, { dryRun });

  // Step 2: Lint --fix
  process.stdout.write('\n' + bold('2. Fixing frontmatter issues...') + '\n');
  runLint(['--fix'], config, { dryRun });

  // Step 3: Sync dates from git
  process.stdout.write('\n' + bold('3. Syncing dates from git...') + '\n');
  runTouch(['--git'], config, { dryRun });

  // Step 4: Regenerate index. Heading always prints so the numbering stays
  // `1,2,3,4,5,6` even when `index.path` isn't configured — pre-fix this was
  // gated on `config.indexPath`, producing `1,2,3,5,6` on repos with no index.
  process.stdout.write('\n' + bold('4. Regenerating index...') + '\n');
  if (!config.indexPath) {
    process.stdout.write('No index path configured (skip).\n');
  } else if (dryRun) {
    process.stdout.write('[dry-run] Would regenerate index.\n');
  } else {
    const index = buildIndex(config);
    writeIndex(renderIndexFile(index, config), config);
    process.stdout.write('Index updated.\n');
  }

  // Step 5: Refresh Claude Code commands. Always print the heading so the
  // numbering stays `1,2,3,4,5,6` — pre-fix it was conditional, so a doctor
  // run where everything was already current printed `1,2,3,4,6` with `5.`
  // silently missing.
  process.stdout.write('\n' + bold('5. Claude Code commands:') + '\n');
  if (dryRun) {
    process.stdout.write('[dry-run] Would refresh .claude/commands/ if outdated.\n');
  } else {
    const claudeResults = scaffoldClaudeCommands(config.repoRoot, config);
    const changes = claudeResults.filter(r => r.action === 'updated' || r.action === 'created');
    if (changes.length === 0) {
      process.stdout.write('Nothing to refresh.\n');
    } else {
      for (const r of changes) {
        if (r.action === 'updated') {
          process.stdout.write(`${green('Updated')} .claude/commands/${r.name} (v${r.from} → v${r.to})\n`);
        } else if (r.action === 'created') {
          process.stdout.write(`${green('Created')} .claude/commands/${r.name}\n`);
        }
      }
    }
  }

  // Step 6: Show remaining check
  process.stdout.write('\n' + bold('6. Remaining issues:') + '\n');
  const freshIndex = buildIndex(config);
  process.stdout.write(renderCheck(freshIndex, config));
  const manual = renderManualFixes(freshIndex);
  if (manual.trim()) {
    process.stdout.write('\n' + bold('Closeout guidance') + '\n');
    process.stdout.write(manual);
  }
}

function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function findDeprecatedCommandMentions(config) {
  const docs = collectDocFiles(config);
  const matches = [];
  for (const filePath of docs) {
    let raw = '';
    try { raw = readFileSync(filePath, 'utf8'); } catch { continue; }
    if (/\bdotmd status\b/.test(raw) || /\bdotmd (pickup|unpickup|release|finish)\b/.test(raw)) {
      matches.push(toRepoPath(filePath, config.repoRoot));
    }
  }
  return matches;
}

function runDoctorProject(config, { json = false } = {}) {
  const cliPackage = readJsonIfPresent(new URL('../package.json', import.meta.url));
  const repoPackage = readJsonIfPresent(path.join(config.repoRoot, 'package.json'));
  const depVersion = repoPackage?.dependencies?.['dotmd-cli']
    ?? repoPackage?.devDependencies?.['dotmd-cli']
    ?? repoPackage?.dependencies?.dotmd
    ?? repoPackage?.devDependencies?.dotmd
    ?? null;
  const claudeCommandWarnings = checkClaudeCommands(config.repoRoot);
  const deprecatedCommandMentions = findDeprecatedCommandMentions(config);
  const result = {
    cliVersion: cliPackage?.version ?? null,
    packageDependency: depVersion,
    claudeCommandWarnings,
    deprecatedCommandMentions,
  };

  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result;
  }

  process.stdout.write(bold('dotmd doctor --project') + '\n\n');
  process.stdout.write(`- running CLI version: ${result.cliVersion ?? 'unknown'}\n`);
  process.stdout.write(`- package dependency: ${result.packageDependency ?? '(none found)'}\n`);
  process.stdout.write(`- stale Claude commands: ${claudeCommandWarnings.length}\n`);
  if (deprecatedCommandMentions.length) {
    process.stdout.write(`- docs mentioning deprecated commands: ${deprecatedCommandMentions.length}\n`);
    for (const file of deprecatedCommandMentions.slice(0, 10)) process.stdout.write(`  - ${file}\n`);
  } else {
    process.stdout.write('- docs mentioning deprecated commands: 0\n');
  }
  return result;
}

export function analyzeStatusBuckets(docs) {
  const buckets = new Map();
  for (const doc of docs) {
    if (!doc.status) continue;
    const key = `${doc.type ?? 'unknown'}::${doc.status}`;
    if (!buckets.has(key)) {
      buckets.set(key, { type: doc.type ?? null, status: doc.status, docs: [] });
    }
    buckets.get(key).docs.push(doc);
  }

  const suggestions = [];

  for (const bucket of buckets.values()) {
    if (bucket.docs.length < MIN_BUCKET_SIZE) continue;
    const floor = Math.max(1, Math.ceil(bucket.docs.length * CUE_FLOOR_PCT));

    const targetCounts = {};
    let unmatchedCount = 0;

    for (const doc of bucket.docs) {
      const text = `${doc.currentState ?? ''}\n${doc.nextStep ?? ''}`;
      let bestCue = null;
      let bestScore = 0;

      for (const [cue, pattern] of Object.entries(CUE_PATTERNS)) {
        if (cue === bucket.status) continue;
        const globalPat = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
        const matches = text.match(globalPat);
        const score = matches ? matches.length : 0;
        if (score > bestScore) {
          bestScore = score;
          bestCue = cue;
        }
      }

      if (bestCue == null) {
        unmatchedCount++;
      } else {
        targetCounts[bestCue] = (targetCounts[bestCue] ?? 0) + 1;
      }
    }

    const aboveFloor = Object.entries(targetCounts)
      .filter(([, n]) => n >= floor)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

    if (aboveFloor.length < 2) continue;

    const splitCount = aboveFloor.reduce((s, [, n]) => s + n, 0);
    const kept = bucket.docs.length - splitCount;

    suggestions.push({
      type: bucket.type,
      status: bucket.status,
      total: bucket.docs.length,
      splits: aboveFloor.map(([target, count]) => ({
        target,
        count,
        cues: CUE_LABELS[target] ?? '',
      })),
      kept,
    });
  }

  suggestions.sort((a, b) => {
    if ((a.type ?? '') !== (b.type ?? '')) return (a.type ?? '').localeCompare(b.type ?? '');
    return a.status.localeCompare(b.status);
  });

  return suggestions;
}

function runDoctorStatuses(config, { json = false } = {}) {
  const index = buildIndex(config);
  const suggestions = analyzeStatusBuckets(index.docs);

  if (json) {
    process.stdout.write(JSON.stringify({
      thresholds: { minBucketSize: MIN_BUCKET_SIZE, cueFloorPct: CUE_FLOOR_PCT },
      suggestions,
    }, null, 2) + '\n');
    return;
  }

  process.stdout.write(bold('dotmd doctor --statuses') + '\n\n');

  if (suggestions.length === 0) {
    process.stdout.write(`No overloaded status buckets detected (min bucket size: ${MIN_BUCKET_SIZE}).\n`);
    return;
  }

  for (const s of suggestions) {
    const typeLabel = s.type ? `${s.type}/` : '';
    const patternCount = s.splits.length + (s.kept > 0 ? 1 : 0);
    process.stdout.write(
      bold(`${s.total} ${typeLabel}${s.status} plans cluster across ${patternCount} patterns — consider splitting:`) + '\n'
    );

    const targetWidth = Math.max(...s.splits.map(x => x.target.length), 'kept'.length);
    for (const split of s.splits) {
      const target = green(split.target.padEnd(targetWidth));
      process.stdout.write(`  ~${String(split.count).padStart(3)} → ${target}  (cues: ${split.cues})\n`);
    }
    if (s.kept > 0) {
      const tail = dim(`(kept in ${s.status} — no clear pattern match)`);
      process.stdout.write(`  ~${String(s.kept).padStart(3)} → ${' '.repeat(targetWidth)}  ${tail}\n`);
    }
    process.stdout.write('\n');
  }

  process.stdout.write(yellow('Heuristic — verify before migrating.') + '\n');
}
