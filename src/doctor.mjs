import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fixBrokenRefs } from './fix-refs.mjs';
import { runLint } from './lint.mjs';
import { syncHubStatuses } from './sync-status.mjs';
import { runSet, runTouch } from './lifecycle.mjs';
import { buildIndex, collectDocFiles } from './index.mjs';
import { writeRenderedIndex } from './index-file.mjs';
import { renderCheck, renderManualFixes } from './render.mjs';
import { bold, dim, green, yellow } from './color.mjs';
import { checkClaudeCommands, removeGeneratedSlashCommands } from './claude-commands.mjs';
import { checkSkillDrift } from './skill-drift.mjs';
import { runMigrateTemplate } from './migrate-template.mjs';
import { runMigratePrompts } from './migrate-prompts.mjs';
import { runFrontmatterFix } from './frontmatter-fix.mjs';
import { normalizeEol } from './frontmatter.mjs';
import { die, relTime, toRepoPath } from './util.mjs';
import { inspectTransactions, resolveTransactions } from './atomic-mutation.mjs';
import { availableSessionId, releaseVanishedPlanClaim, surveyOwnershipClaims } from './pickup.mjs';

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

// A wedged repo reports here. One failed-manual manifest makes every `set`,
// `archive`, `use`, `baton`, and `rename` in the repo refuse — and the error
// names a file the command never touched, because recovery sweeps the whole
// transaction root. This is the only surface that can see and clear that state.
function runDoctorTransactions(argv, config, opts = {}) {
  const json = argv.includes('--json');
  // The dispatcher strips --apply/--yes and folds them into opts.dryRun, which
  // for doctor already means "preview unless the user asked to write".
  const apply = !opts.dryRun;
  const report = inspectTransactions(config.repoRoot);

  const cleared = apply ? resolveTransactions(config.repoRoot) : [];
  const clearedIds = new Set(cleared.map(item => item.id));

  if (json) {
    process.stdout.write(JSON.stringify({ transactions: report, cleared }, null, 2) + '\n');
    return;
  }

  if (report.length === 0) {
    process.stdout.write(green('✓') + ' No pending transactions — nothing is wedging mutations.\n');
    return;
  }

  process.stdout.write(bold(`Transactions (${report.length})\n`));
  for (const item of report) {
    if (!item.readable) {
      process.stdout.write(`  ${yellow('?')} ${item.id} — ${item.reason}\n`);
      continue;
    }
    const blocking = item.status === 'failed-manual';
    const mark = clearedIds.has(item.id) ? green('✓') : blocking ? yellow('!') : dim('·');
    const note = clearedIds.has(item.id)
      ? 'cleared'
      : item.resolvable ? 'resolvable' : (item.reason ?? item.status);
    process.stdout.write(`  ${mark} ${item.id} [${item.status}] ${item.operation} — owner ${item.ownerLiveness}, ${note}\n`);
    for (const participant of item.participants) {
      process.stdout.write(dim(`      ${participant.state.padEnd(9)} ${toRepoPath(participant.path, config.repoRoot)}\n`));
    }
    for (const retained of item.retainedGitPaths) {
      process.stdout.write(dim(`      retained  ${retained}\n`));
    }
  }

  const resolvable = report.filter(item => item.resolvable && !clearedIds.has(item.id));
  if (cleared.length) {
    process.stdout.write(green(`\n✓ Cleared ${cleared.length} transaction${cleared.length === 1 ? '' : 's'} whose files already agreed on one generation.\n`));
  }
  if (resolvable.length) {
    process.stdout.write(`\n${resolvable.length} resolvable — the canonical files already agree on one generation.\n`);
    process.stdout.write(dim('Run `dotmd doctor --transactions --apply` to clear them (no document content is touched).\n'));
  }
  const stuck = report.filter(item => !item.resolvable && !clearedIds.has(item.id) && (item.status === 'failed-manual' || !item.readable));
  if (stuck.length) {
    process.stdout.write(yellow(`\n${stuck.length} need manual review — generations disagree, so clearing them could lose work.\n`));
    process.stdout.write(dim('Inspect the participant paths above against the artifacts in each transaction directory.\n'));
  }
}

function parseOlderThan(argv) {
  const idx = argv.indexOf('--older-than');
  if (idx === -1) return null;
  const raw = argv[idx + 1];
  const match = /^(\d+)([hd])$/.exec(raw ?? '');
  if (!match) die('--older-than takes a duration like 24h or 3d');
  return Number(match[1]) * (match[2] === 'h' ? 3600_000 : 86_400_000) ;
}

// The counterpart to --transactions: a claim nobody will ever release wedges
// `set`, `archive`, `baton` and `rename` on that plan forever, and until now
// nothing in the tool could even show you the claims, let alone end one.
//
// Two tiers, because two very different things are being asked. A claim whose
// session process is provably gone is released by --apply on its own: that is
// dotmd observing a fact, the same bar a forced hook-delivery takeover uses.
// A claim dotmd *cannot* judge — written before it recorded the owning process,
// taken from a plain terminal, or held on another machine — is never released
// by a plain --apply, because "I can't see the owner" is not evidence the owner
// left. Releasing those needs --older-than, which is the user supplying the
// judgement dotmd doesn't have, as a policy rather than a guess.
async function runDoctorClaims(argv, config, opts = {}) {
  const json = argv.includes('--json');
  const apply = !opts.dryRun;
  const olderThanMs = parseOlderThan(argv);
  const claims = surveyOwnershipClaims(config);

  const dead = claims.filter(claim => !claim.corrupt && claim.liveness === 'dead');
  const aged = olderThanMs === null ? [] : claims.filter(claim =>
    !claim.corrupt && claim.liveness !== 'dead' && claim.ageMs !== null && claim.ageMs >= olderThanMs);
  const targets = [...dead, ...aged];

  const released = [];
  // The repair runs under whatever identity the shell has, and a shell with none
  // is a normal place to run it from — this is the command you reach for when the
  // sessions are gone. Mirrors the synthetic id `set --dry-run` already uses.
  const operator = availableSessionId() ?? 'doctor:claims-repair';
  if (apply) {
    for (const claim of targets) {
      try {
        // Two shapes of release, because a vanished plan has no file to write a
        // status into. Deciding by existence here rather than by catching
        // runSet's "File not found" keeps the bypass narrow and explicit.
        if (existsSync(path.resolve(config.repoRoot, claim.plan))) {
          await runSet(['active', claim.plan], config, { force: true, sessionId: operator, note: 'Claim released by `dotmd doctor --claims` — the owning session was gone.' });
        } else {
          releaseVanishedPlanClaim(claim, config);
          claim.vanished = true;
        }
        released.push(claim.plan);
      } catch (err) {
        claim.error = err.message.split('\n')[0];
      }
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify({ claims, released }, null, 2) + '\n');
    return;
  }
  if (claims.length === 0) {
    process.stdout.write(green('✓') + ' No plans are claimed — nothing can be wedged by ownership.\n');
    return;
  }

  const releasedSet = new Set(released);
  process.stdout.write(bold(`Plan claims (${claims.length})\n`));
  for (const claim of claims) {
    if (claim.corrupt) {
      process.stdout.write(`  ${yellow('?')} ${path.basename(claim.recordPath)} — ${claim.reason}\n`);
      continue;
    }
    const mark = releasedSet.has(claim.plan) ? green('✓') : claim.liveness === 'dead' ? yellow('!') : dim('·');
    const age = claim.since ? relTime(claim.since) : 'age unknown';
    const note = releasedSet.has(claim.plan)
      ? (claim.vanished ? 'released (plan no longer exists)' : 'released')
      : claim.error ?? `owner ${claim.liveness}`;
    process.stdout.write(`  ${mark} ${claim.plan} — ${age}, session ${claim.sessionId}, ${note}\n`);
  }

  if (released.length) {
    // Only the claims with a plan behind them came back as `active`; saying so
    // of a vanished one would promise a file the next command cannot open.
    const vanished = targets.filter(claim => claim.vanished && releasedSet.has(claim.plan)).length;
    const revived = released.length - vanished;
    const parts = [];
    if (revived) parts.push(`${revived} plan${revived === 1 ? ' is' : 's are'} active again`);
    if (vanished) parts.push(`${vanished} pinned a plan that no longer exists`);
    process.stdout.write(green(`\n✓ Released ${released.length} claim${released.length === 1 ? '' : 's'}; ${parts.join(', ')}.\n`));
  }
  const pendingDead = dead.filter(claim => !releasedSet.has(claim.plan));
  if (pendingDead.length) {
    process.stdout.write(yellow(`\n${pendingDead.length} held by a session whose process is gone.\n`));
    process.stdout.write(dim('Run `dotmd doctor --claims --apply` to release them.\n'));
  }
  const unjudgeable = claims.filter(claim =>
    !claim.corrupt && claim.liveness !== 'dead' && !releasedSet.has(claim.plan));
  if (unjudgeable.length && olderThanMs === null) {
    process.stdout.write(dim(`\n${unjudgeable.length} cannot be judged from here — no owning process was recorded, or it is on another machine.\n`));
    process.stdout.write(dim('If you know those sessions are over: `dotmd doctor --claims --apply --older-than 24h`.\n'));
  }
}

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
  if (argv.includes('--transactions')) {
    runDoctorTransactions(argv, config, opts);
    return;
  }
  if (argv.includes('--claims')) {
    return runDoctorClaims(argv, config, opts);
  }

  const { dryRun, testHooks } = opts;
  // 0.37.0 (F4): the mode banner makes it impossible to mistake a preview run
  // for a real one — and tells the user the exact flag that flips it.
  const modeNote = dryRun
    ? dim('[preview — run with --apply to write]')
    : dim('[applying changes]');
  process.stdout.write(bold('dotmd doctor') + ' ' + modeNote + '\n\n');
  if (dryRun) {
    const skippedHooks = ['validate', 'transformDoc', 'formatSnapshot', 'renderCheck']
      .filter(name => typeof config.hooks?.[name] === 'function');
    if (skippedHooks.length > 0) {
      process.stdout.write(dim(`[preview] Custom ${skippedHooks.join(', ')} hook${skippedHooks.length === 1 ? '' : 's'} skipped; diagnostics and rendering below use built-in behavior only.\n\n`));
    }
  }

  // Step 1: Fix broken references
  process.stdout.write(bold('1. Fixing broken references...') + '\n');
  fixBrokenRefs(config, { dryRun });

  // Step 2: Lint --fix
  process.stdout.write('\n' + bold('2. Fixing frontmatter issues...') + '\n');
  runLint(['--fix'], config, { dryRun });

  // Step 3: Move over-cap status prose into body sections.
  process.stdout.write('\n' + bold('3. Fixing long frontmatter...') + '\n');
  runFrontmatterFix(config, { dryRun });

  // Step 4: Rewrite hub rows whose printed status drifted from the plan they
  // link to. Tokens only — adding markers is a content edit to prose the user
  // wrote, so it stays opt-in behind `dotmd sync-status --adopt`.
  process.stdout.write('\n' + bold('4. Syncing hub status rows...') + '\n');
  const hubSync = syncHubStatuses(config, { docs: buildIndex(config).docs, dryRun });
  if (hubSync.fixed === 0 && hubSync.adopted === 0 && hubSync.unreadable === 0) {
    process.stdout.write('Hub status rows are in sync.\n');
  }

  // Step 5: Sync dates from git
  process.stdout.write('\n' + bold('5. Syncing dates from git...') + '\n');
  runTouch(['--git'], config, { dryRun });

  // Step 6: Regenerate index. Heading always prints so numbering remains
  // contiguous even when `index.path` isn't configured.
  process.stdout.write('\n' + bold('6. Regenerating index...') + '\n');
  if (!config.indexPath) {
    process.stdout.write('No index path configured (skip).\n');
  } else if (dryRun) {
    process.stdout.write('[dry-run] Would regenerate index.\n');
  } else {
    writeRenderedIndex(() => buildIndex(config, { fast: true }), config, { testHooks });
    process.stdout.write('Index updated.\n');
  }

  // Step 7: Clean up retired Claude Code command scaffolding. The per-repo
  // `.claude/commands/{plans,docs}.md` files are superseded by the dotmd plugin
  // skill; doctor sweeps any leftover banner-stamped (dotmd-generated) files.
  // Always print the heading so the numbering remains contiguous.
  process.stdout.write('\n' + bold('7. Claude Code commands:') + '\n');
  if (dryRun) {
    const wouldRemove = removeGeneratedSlashCommands(config.repoRoot, { dryRun: true });
    if (wouldRemove.length === 0) {
      process.stdout.write('[dry-run] No retired slash-command files to remove.\n');
    } else {
      for (const r of wouldRemove) {
        process.stdout.write(`[dry-run] Would remove retired .claude/commands/${r.name} (guidance now ships via the dotmd plugin).\n`);
      }
    }
  } else {
    const removed = removeGeneratedSlashCommands(config.repoRoot);
    if (removed.length === 0) {
      process.stdout.write('Nothing to clean up.\n');
    } else {
      for (const r of removed) {
        process.stdout.write(`${green('Removed')} retired .claude/commands/${r.name} (guidance now ships via the dotmd plugin)\n`);
      }
    }
  }

  // Step 8: Show remaining check
  const issueLabel = dryRun ? '8. Remaining issues in current tree (preview fixes above were not applied):' : '8. Remaining issues:';
  process.stdout.write('\n' + bold(issueLabel) + '\n');
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

// Workflow-drift checks: configurations and docs that make the agent-facing
// verbs (`use`, `set`, `baton`) blow up at the worst moment — mid-handoff.
// Both failure modes came from real sessions: a repo whose plan vocab dropped
// `in-session` (every `dotmd use` died), and a repo full of docs without
// frontmatter blocks (every `dotmd set` died during closeout).
function findWorkflowDrift(config) {
  const docsWithoutFrontmatter = [];
  for (const filePath of collectDocFiles(config)) {
    let raw = '';
    try { raw = readFileSync(filePath, 'utf8'); } catch { continue; }
    if (!normalizeEol(raw).startsWith('---\n')) docsWithoutFrontmatter.push(toRepoPath(filePath, config.repoRoot));
  }

  const planStatusGaps = [];
  const planStatuses = config.typeStatuses?.get('plan');
  if (planStatuses && planStatuses.size > 0) {
    for (const required of ['in-session', 'active']) {
      if (!planStatuses.has(required)) planStatusGaps.push(required);
    }
  }

  return { docsWithoutFrontmatter, planStatusGaps };
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
  const { docsWithoutFrontmatter, planStatusGaps } = findWorkflowDrift(config);
  const skillDriftWarnings = checkSkillDrift(config);
  const result = {
    cliVersion: cliPackage?.version ?? null,
    packageDependency: depVersion,
    claudeCommandWarnings,
    deprecatedCommandMentions,
    docsWithoutFrontmatter,
    planStatusGaps,
    skillDriftWarnings,
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
  if (docsWithoutFrontmatter.length) {
    process.stdout.write(yellow(`- docs without a frontmatter block: ${docsWithoutFrontmatter.length} — every status verb (\`set\`, \`archive\`, \`baton\`) dies on these. Fix: dotmd bulk-tag <file> --type <type> --status <status>`) + '\n');
    for (const file of docsWithoutFrontmatter.slice(0, 10)) process.stdout.write(`  - ${file}\n`);
  } else {
    process.stdout.write('- docs without a frontmatter block: 0\n');
  }
  if (planStatusGaps.length) {
    process.stdout.write(yellow(`- plan status vocab missing: ${planStatusGaps.join(', ')} — \`dotmd use\` and \`dotmd baton\` depend on these; add them to types.plan.statuses in dotmd.config.mjs`) + '\n');
  } else {
    process.stdout.write('- plan status vocab: ok\n');
  }
  if (skillDriftWarnings.length) {
    process.stdout.write(yellow(`- canonical workflow block: drifted — CLAUDE.md and the plugin SKILL.md teach different workflows. Reconcile the block between the \`dotmd:canonical-workflow\` markers in both files.`) + '\n');
  } else {
    process.stdout.write('- canonical workflow block: in sync\n');
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
