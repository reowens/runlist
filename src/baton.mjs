import { readFileSync, fstatSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, die, warn, currentSessionId } from './util.mjs';
import { buildIndex, resolveDocArg } from './index.mjs';
import { readJournalEntries } from './journal.mjs';
import { runNew, readBodyInput } from './new.mjs';
import { runSet } from './lifecycle.mjs';
import { green, dim } from './color.mjs';

// `dotmd baton` is the one-command handoff: save the resume prompt AND release
// the plan in a single atomic-ish verb. It exists because the three-step skill
// version ("save prompt, pick a status, commit") kept expanding in practice —
// sessions turned closeout into repo triage, forgot the prompt body, or got
// tangled in what to commit. Baton does exactly one plan, one prompt, one
// status flip, and then *tells* the agent the exact commit command.

// Does a journal argv doc reference point at this index doc? References come
// from `use <x>` / `set in-session <x>` invocations, so they may be a repo
// path, a bare basename, or a slug without .md.
function matchesDocRef(doc, ref) {
  if (typeof ref !== 'string' || !ref) return false;
  const cleaned = ref.replace(/^\.\//, '');
  if (doc.path === cleaned) return true;
  const base = path.basename(doc.path, '.md');
  if (cleaned === base || cleaned === `${base}.md`) return true;
  return doc.path.endsWith(`/${cleaned}`) || doc.path.endsWith(`/${cleaned}.md`);
}

// Resolve which in-session plan belongs to THIS session. There is no checkout
// or lock — in-session is just frontmatter — so ownership is reconstructed
// from the per-repo journal: the last `use <plan>` / `set in-session <plan>`
// this sid ran whose target is still in-session. Falls back to "the only
// in-session plan" when the journal can't answer (disabled, or another tool
// flipped the status). Returns { plan, via, inSession }; plan is null when
// there's no defensible answer (caller decides how to ask).
export function findOwnedPlan(config, index = null) {
  const idx = index ?? buildIndex(config);
  const inSession = idx.docs.filter(d => d.type === 'plan' && d.status === 'in-session');
  if (inSession.length === 0) return { plan: null, via: null, inSession };

  const sid = currentSessionId();
  let entries = [];
  try { entries = readJournalEntries(config); } catch { entries = []; }
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.sid !== sid || !Array.isArray(e.argv) || (e.exit ?? 0) !== 0) continue;
    const a = e.argv;
    let ref = null;
    if (a[0] === 'use') ref = a.slice(1).find(x => typeof x === 'string' && !x.startsWith('-'));
    else if (a[0] === 'set' && a[1] === 'in-session') ref = a.slice(2).find(x => typeof x === 'string' && !x.startsWith('-'));
    else if (a[0] === 'status' && a.includes('in-session')) ref = a.slice(1).find(x => typeof x === 'string' && !x.startsWith('-') && x !== 'in-session');
    if (!ref) continue;
    const doc = inSession.find(d => matchesDocRef(d, ref));
    if (doc) return { plan: doc, via: 'journal', inSession };
  }

  if (inSession.length === 1) return { plan: inSession[0], via: 'single-in-session', inSession };
  return { plan: null, via: null, inSession };
}

const BODY_USAGE = `dotmd baton needs the resume draft as its body. Write 10–20 lines first — the next concrete decision plus any gotchas, NOT a recap of the plan — then:
  dotmd baton @/tmp/draft.md             # body from file (preferred)
  cat /tmp/draft.md | dotmd baton        # body from stdin
  dotmd baton --message "..."            # one-liner
No plan in-session? Name the handoff instead: dotmd baton <slug> @/tmp/draft.md`;

// Is this positional a filesystem reference (must resolve, typos die) or a
// bare word (may be a plan slug, may be a brand-new handoff name)?
function looksLikePath(arg) {
  return arg.includes('/') || arg.endsWith('.md');
}

export async function runBaton(argv, config, opts = {}) {
  const { dryRun } = opts;

  let status = 'active';
  let statusFlag = false;
  let note = null;
  let bodyFlag = null;
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--status' && argv[i + 1]) { status = argv[++i]; statusFlag = true; continue; }
    if (a === '--note' && argv[i + 1]) { note = argv[++i]; continue; }
    if ((a === '--body' || a === '--message') && argv[i + 1]) { bodyFlag = argv[++i]; continue; }
    if (!a.startsWith('-') || a === '-' || a.startsWith('@')) { positionals.push(a); continue; }
    die(`Unknown flag for \`dotmd baton\`: ${a}`);
  }

  let planArg = null;
  let bodyArg = null;
  for (const p of positionals) {
    if (p === '-' || p.startsWith('@')) { bodyArg = p; continue; }
    if (!planArg) { planArg = p; continue; }
    if (bodyArg === null) bodyArg = p; // trailing inline body
  }

  // Body FIRST — it's the common failure (`new prompt` without a body was the
  // top real-world baton error), and nothing must mutate before it's secured.
  let body = null;
  if (bodyFlag !== null) body = bodyFlag;
  else if (bodyArg !== null) body = readBodyInput(bodyArg);
  else {
    // Auto-consume piped/redirected stdin, same probe as `dotmd new`.
    try {
      const stat = fstatSync(0);
      if (stat.isFIFO() || stat.isFile() || stat.isSocket()) {
        const piped = readFileSync(0, 'utf8');
        if (piped.length > 0) body = piped;
      }
    } catch { /* stdin not introspectable */ }
  }
  if (!body || !body.trim()) die(BODY_USAGE);

  // Resolve what's being handed off. Two modes:
  //   plan mode — a plan is released alongside the prompt (one status flip).
  //   slug mode — no plan involved: "save a resume prompt for what I'm doing
  //   right now". The hallmark use ("update the docs and save a resume prompt
  //   for this") must work mid-anything, claimed plan or not — baton does
  //   nothing but save the prompt in this mode.
  let planPath = null;
  let promptSlug = null;
  if (planArg) {
    if (looksLikePath(planArg)) {
      planPath = resolveDocArg(planArg, config); // typos die loudly — a mistyped path must not silently become a prompt name
    } else {
      // Bare word: a plan slug if it resolves to a plan, else a handoff name.
      const resolved = resolveDocArg(planArg, config, { dieOnMiss: false });
      let resolvedType = null;
      if (resolved) {
        try {
          const { frontmatter: fmProbe } = extractFrontmatter(readFileSync(resolved, 'utf8'));
          resolvedType = fmProbe ? asString(parseSimpleFrontmatter(fmProbe).type) : null;
        } catch { resolvedType = null; }
      }
      if (resolved && resolvedType === 'plan') planPath = resolved;
      else promptSlug = planArg;
    }
  } else {
    const owned = findOwnedPlan(config);
    if (owned.plan) {
      planPath = path.resolve(config.repoRoot, owned.plan.path);
      if (owned.via === 'single-in-session') {
        process.stderr.write(dim(`Handing off the only in-session plan: ${owned.plan.path}\n`));
      }
    } else if (owned.inSession.length > 1) {
      die(`Multiple plans are in-session and the journal can't tell which is this session's — pass yours explicitly:\n${owned.inSession.map(d => '  dotmd baton ' + d.path + ' @/tmp/draft.md').join('\n')}\nNot about a plan? Name the handoff instead: dotmd baton <slug> @/tmp/draft.md`);
    } else {
      die(`No in-session plan, so baton needs a name for the resume prompt:\n  dotmd baton <slug> @/tmp/draft.md      # saves resume-<slug>, touches nothing else\nHanding off a specific plan? dotmd baton <plan-file> @/tmp/draft.md`);
    }
  }

  let repoPath = null;
  let oldStatus = null;
  if (planPath) {
    repoPath = toRepoPath(planPath, config.repoRoot);
    const raw = readFileSync(planPath, 'utf8');
    const { frontmatter: fmRaw } = extractFrontmatter(raw);
    if (!fmRaw) {
      die(`${repoPath} has no frontmatter block — baton can't flip its status.\nFix the doc first (\`dotmd bulk-tag ${repoPath} --type plan --status in-session\`), or save the prompt without a status flip: dotmd baton ${path.basename(planPath, '.md')} @/tmp/draft.md`);
    }
    const fm = parseSimpleFrontmatter(fmRaw);
    const docType = asString(fm.type);
    oldStatus = asString(fm.status) ?? 'unset';
    if (docType && docType !== 'plan') warn(`${repoPath} has type '${docType}', not 'plan'.`);

    // Validate the target status BEFORE creating the prompt so a bad --status
    // doesn't leave a half-done handoff.
    const validStatuses = config.typeStatuses?.get(docType ?? 'plan') ?? config.validStatuses;
    if (validStatuses && validStatuses.size > 0 && !validStatuses.has(status)) {
      die(`Invalid status \`${status}\` for type \`${docType ?? 'plan'}\`\nValid: ${[...validStatuses].join(', ')}`);
    }
  } else {
    if (statusFlag) warn(`--status ignored — no plan involved in this handoff (saving the prompt only).`);
    if (note) warn(`--note ignored — no plan involved in this handoff (notes land in a plan's Version History).`);
  }

  // 1. Save the resume prompt. Collision-safe: resume-<slug>, then -2, -3, …
  // (a pending resume-<slug> from an earlier handoff must never block this one,
  // and bodies are not mergeable).
  const nameBase = planPath ? path.basename(planPath, '.md') : promptSlug;
  const slugBase = nameBase.startsWith('resume-') ? nameBase : `resume-${nameBase}`;
  let createdSlug = null;
  for (let n = 1; n <= 9 && !createdSlug; n++) {
    const slug = n === 1 ? slugBase : `${slugBase}-${n}`;
    try {
      await runNew(['prompt', slug, '--body', body], config, { dryRun });
      createdSlug = slug;
    } catch (err) {
      if (!/File already exists/.test(String(err?.message))) throw err;
    }
  }
  if (!createdSlug) die(`Could not find a free prompt slug for ${slugBase} (tried ${slugBase}-2 … ${slugBase}-9).`);

  // 2. Release the plan — exactly one status flip. Skipped entirely in slug
  // mode: with no plan involved there is nothing to release.
  let archiveResult = null;
  let statusChanged = false;
  if (planPath) {
    if (oldStatus === status) {
      process.stderr.write(dim(`Plan already ${status}: ${repoPath} (no status change)\n`));
    } else {
      const setArgs = [status, planPath];
      if (note) setArgs.push('--note', note);
      archiveResult = await runSet(setArgs, config, { dryRun });
      statusChanged = true;
    }
  }

  // 3. Tell the agent exactly what to commit — and what NOT to. The prompt is
  // session-local (often gitignored); only the plan's frontmatter change is
  // repo state.
  const prefix = dryRun ? dim('[dry-run] ') : '';
  process.stderr.write(`\n${prefix}${green('✓ Baton passed')}: ${createdSlug} (the next session's hud surfaces it — nothing to paste into chat)\n`);
  if (statusChanged) {
    const newRepoPath = archiveResult?.newRepoPath ?? null;
    const pathspec = newRepoPath && newRepoPath !== repoPath ? `${repoPath} ${newRepoPath}` : repoPath;
    let gitignored = false;
    try {
      const { isGitIgnored } = await import('./git.mjs');
      gitignored = isGitIgnored(planPath, config.repoRoot);
    } catch { /* not a git repo — fall through to the hint */ }
    if (gitignored) {
      process.stderr.write(dim(`${repoPath} is gitignored — no commit needed.\n`));
    } else {
      process.stderr.write(`${prefix}Commit the plan's status change (keep the prompt OUT of the pathspec — it's session-local):\n`);
      process.stderr.write(`${prefix}  git commit -m "baton: ${path.basename(planPath, '.md')} ${oldStatus} → ${status}" -- ${pathspec}\n`);
    }
  }
}
