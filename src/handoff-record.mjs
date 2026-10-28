import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter, replaceFrontmatter } from './frontmatter.mjs';
import { replaceFrontmatterField } from './frontmatter-fix.mjs';
import { renderLifecycleMutation } from './lifecycle.mjs';
import { mutateFile, withPathLocks } from './atomic-mutation.mjs';
import { commitRename } from './durable-rename.mjs';
import { authorizeManagedSource } from './managed-path.mjs';
import { DotmdError, die, isArchivedPath, nowIso, shellQuote, toRepoPath } from './util.mjs';
import { stateDir } from './naming.mjs';
import { docArgMissMessage, resolveDocArg } from './index.mjs';
import { authoritativeSessionId } from './pickup.mjs';
import { dim, green } from './color.mjs';

// A baton that releases an in-session plan saves the prompt first, so a usage
// stop partway through the handoff loses nothing. The plan update that follows
// is the part sessions skipped: they saved the prompt, reported the handoff
// done, and left next_step saying what it said before the work. So baton leaves
// a record of the plan's next_step as it stood when the prompt was saved, and
// `runlist baton --done` reports the handoff done only once next_step differs.
// `--next-step` writes the new value in the same call.
// The record is local state under the runlist state directory, one per plan,
// so a later session (or this one after a compaction) can still confirm it.

function recordsDir(config) {
  return path.join(stateDir(config.repoRoot), 'handoffs');
}

// Keyed by the plan's whole repo path: two plans sharing a file name in
// different directories each keep their own record. The hash keeps the name
// legal on every filesystem; the file name in front is only for a human
// listing the directory. Records written before this were keyed by the file
// name alone (`widget.json`); they are still read, and matched by the `plan`
// they carry, never by their name.
function recordPath(config, planRepoPath) {
  const key = createHash('sha256').update(planRepoPath).digest('hex').slice(0, 16);
  return path.join(recordsDir(config), `${path.basename(planRepoPath, '.md')}-${key}.json`);
}

function frontmatterOf(content) {
  const { frontmatter } = extractFrontmatter(content);
  return frontmatter ? parseSimpleFrontmatter(frontmatter) : null;
}

function nextStepOf(content) {
  const fm = frontmatterOf(content);
  if (!fm || !Object.prototype.hasOwnProperty.call(fm, 'next_step')) return { present: false, value: null };
  return { present: true, value: JSON.stringify(fm.next_step ?? null) };
}

// Called by baton after the prompt and the plan release are published. Returns
// the record when the plan carries a next_step to wait on, else null (a repo
// whose plans have no next_step field has nothing for --done to check).
export function recordPendingHandoff(config, { planRepoPath, promptRepoPath, promptName }) {
  const content = readFileSync(path.resolve(config.repoRoot, planRepoPath), 'utf8');
  const { present, value } = nextStepOf(content);
  if (!present) return null;
  // `id` names this generation of the record: savedAt has one-second
  // resolution, so two batons for one plan within a second share it.
  const record = {
    id: randomUUID(),
    plan: planRepoPath,
    prompt: promptRepoPath,
    name: promptName,
    savedAt: nowIso(),
    nextStep: value,
    sessionId: authoritativeSessionId() ?? null,
  };
  const file = recordPath(config, planRepoPath);
  // An older record for this same plan (the name-keyed form) is replaced, not
  // left beside the new one to be finished separately.
  const superseded = listPendingHandoffs(config).filter(r => r.plan === planRepoPath && r.recordFile !== file).map(r => r.recordFile);
  mkdirSync(recordsDir(config), { recursive: true });
  // Under the record's lock, like `--done`, so a confirmation that checked
  // the previous record can never remove this one.
  withPathLocks([file, ...superseded], { repoRoot: config.repoRoot }, () => {
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(record, null, 2) + '\n');
    try { commitRename(temp, file); }
    catch (err) { rmSync(temp, { force: true }); throw err; }
    for (const stale of superseded) rmSync(stale, { force: true });
  });
  return record;
}

export function listPendingHandoffs(config) {
  const dir = recordsDir(config);
  if (!existsSync(dir)) return [];
  const records = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try { records.push({ ...JSON.parse(readFileSync(path.join(dir, name), 'utf8')), recordFile: path.join(dir, name) }); }
    catch { /* a torn record is not a handoff to wait on */ }
  }
  return records;
}

export function pendingHandoffsForSession(config, sessionId = authoritativeSessionId()) {
  if (!sessionId) return [];
  return listPendingHandoffs(config).filter(record => record.sessionId === sessionId);
}

// The frontmatter half of the update is a flag on --done, so the guidance never
// asks for a hand edit of next_step: the body is prose the session writes, the
// two fields are what this verb writes.
export function handoffNotDoneLine(record, doneCommand = 'runlist baton --done') {
  return `Handoff not done yet: the prompt is saved, and ${record.plan} still needs bringing up to date. Update the plan body first, then run \`${doneCommand} --next-step "<next move>"\` (add \`--current-state "<where it stands>"\` if that changed): it writes the frontmatter and confirms the handoff.`;
}

// Whitespace runs collapse to one space: that is what the folded scalar the
// writer emits reads back as, so a value differing only in spacing is the same
// next_step and must not pass the gate.
function normalizeFieldValue(value) {
  return value.replace(/\s+/g, ' ').trim();
}

// Every completion path compares the same way: a string next_step after
// whitespace normalisation, anything else (a list, a boolean) as parsed.
function comparableNextStep(json) {
  let value;
  try { value = JSON.parse(json); } catch { return undefined; }
  return JSON.stringify(typeof value === 'string' ? normalizeFieldValue(value) : value);
}

function stillAsRecorded(record, content) {
  const { present, value } = nextStepOf(content);
  return present && comparableNextStep(value) === comparableNextStep(record.nextStep);
}

// One line of prose per field. A newline is refused rather than folded away:
// the writer emits a folded scalar, which would silently join the lines, and a
// next_step that needs several lines belongs in the plan body.
function checkedFieldValue(flag, value) {
  if (typeof value !== 'string' || !value.trim()) die(`${flag} needs a nonempty value, e.g. ${flag} "<text>".`);
  if (/[\r\n]/.test(value)) die(`${flag} takes one line; put anything longer in the plan body.`);
  return normalizeFieldValue(value);
}

function renderFieldUpdates(raw, fields) {
  const { frontmatter } = extractFrontmatter(raw);
  if (!frontmatter) throw new Error('the plan has no frontmatter block');
  let next = frontmatter;
  for (const [key, value] of Object.entries(fields)) next = replaceFrontmatterField(next, key, value);
  return renderLifecycleMutation(replaceFrontmatter(raw, next), { updated: nowIso() }, null);
}


function readRecord(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch { return null; }
}

// Whether the record on disk is still the generation this call read. A record
// written before ids existed is compared whole.
function sameGeneration(record, current) {
  if (!current) return false;
  if (record.id !== undefined) return current.id === record.id;
  const { recordFile: _file, ...saved } = record;
  return JSON.stringify(current) === JSON.stringify(saved);
}

const isGone = (config, record) => !existsSync(path.resolve(config.repoRoot, record.plan));

function recordLine(config, record) {
  return `  ${record.plan} (${isGone(config, record) ? 'gone' : 'still in place'}; record ${toRepoPath(record.recordFile, config.repoRoot)}, prompt ${record.name}, saved ${record.savedAt})`;
}

// Every command printed for a path is quoted, so it runs as shown.
const doneCommand = repoPath => `runlist baton --done ${shellQuote(repoPath)}`;
const clearCommand = record => doneCommand(record.plan);
const ARCHIVE_HINT = 'To archive a plan as part of a handoff, use `runlist baton --status archived`.';

// Whether a gone plan has a copy where `runlist archive` would have put it.
function archivedCopyExists(config, repoPath) {
  const abs = path.resolve(config.repoRoot, repoPath);
  return (config.docsRoots || [config.docsRoot]).some(root => {
    const rel = path.relative(root, abs);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) && existsSync(path.join(root, config.archiveDir, path.basename(abs)));
  });
}

// A plan whose handoff names a path it is no longer at. Writes never follow
// it: the fields go only to the plan at the path the handoff was saved for.
function goneMessage(config, record, writing) {
  const lead = writing
    ? `${record.plan} is gone (moved or archived?), so nothing was written: --next-step and --current-state write only the plan at the path its handoff was saved for.`
    : `${record.plan} is gone (moved or archived?).`;
  const hint = writing && archivedCopyExists(config, record.plan) ? `\n${ARCHIVE_HINT}` : '';
  return `${lead} Bring the plan up to date where it is now, then run \`runlist baton --done <its new path>\`; or clear this handoff by its old path: \`${clearCommand(record)}\`.${hint}\nSaved prompt: ${record.name}`;
}

// A named plan finishes the record saved for that exact path. The one
// exception is plain --done (no fields to write) for a plan that moved after
// the prompt was saved: when exactly one record shares the file name and its
// plan is gone, that record is cleared once the plan at the new path has a
// different next_step. It writes no plan, so the worst a wrong guess does is
// clear a reminder; anything less certain is refused with the records listed.
function namedHandoff(config, repoPath, writing) {
  const records = listPendingHandoffs(config);
  const exact = records.find(r => r.plan === repoPath);
  if (exact) return { record: exact, relocated: false };
  const sameName = records.filter(r => typeof r.plan === 'string' && path.basename(r.plan) === path.basename(repoPath));
  const moved = sameName.filter(r => isGone(config, r));
  if (!sameName.length) die(`No handoff waits on ${repoPath}: baton has not saved a prompt for it that needs the plan brought up to date.`);
  if (!moved.length) die(`No handoff waits on ${repoPath}. The handoff for a plan of the same file name is ${sameName.map(r => r.plan).join(', ')}, which is still in place; finish it there: ${clearCommand(sameName[0])}`);
  // With several candidates, at most one was saved for this plan, and
  // clearing it says nothing about whose the others are.
  const clearOne = `At most one of these was saved for this plan; clear that one by its old path (only its record is removed, the others stay pending):\n${moved.map(r => `  ${clearCommand(r)}`).join('\n')}`;
  if (writing) {
    const recover = sameName.length === 1
      ? `If ${repoPath} is that plan, moved: bring it up to date by any means and run \`${doneCommand(repoPath)}\`, or clear the handoff by its old path: \`${clearCommand(moved[0])}\`.`
      : clearOne;
    const hint = isArchivedPath(repoPath, config) ? `\n${ARCHIVE_HINT}` : '';
    die(`No handoff was saved for ${repoPath}, so nothing was written: --next-step and --current-state write only the plan at the path a handoff was saved for.\n${sameName.map(r => recordLine(config, r)).join('\n')}\n${recover}${hint}`);
  }
  if (sameName.length > 1) {
    die(`No handoff was saved for ${repoPath}, and ${sameName.length} handoffs for plans of that file name could be meant:\n${sameName.map(r => recordLine(config, r)).join('\n')}\n${clearOne}`);
  }
  return { record: moved[0], relocated: true };
}

// `runlist baton --done [<plan>] [--next-step "…"] [--current-state "…"]`
export function runBatonDone(planArg, config, { json = false, dryRun = false, nextStep = null, currentState = null } = {}) {
  const fields = {};
  if (nextStep !== null) fields.next_step = checkedFieldValue('--next-step', nextStep);
  if (currentState !== null) fields.current_state = checkedFieldValue('--current-state', currentState);
  const writing = Object.keys(fields).length > 0;
  if (dryRun && !writing) die('`runlist baton --done` changes nothing but its own record; run it without --dry-run, or preview a write with --next-step.');

  let record;
  let relocated = false;
  let abs = null;
  if (planArg) {
    // The argument is first taken as a path, exactly as typed: a record saved
    // for that path is the handoff meant, whether or not the plan is still
    // there. Resolving it as a doc first could land on another plan (another
    // root, a slug, a file name) while the named path is gone.
    // As for any doc argument, a path typed without `.md` names the file with it.
    const argRepoPath = toRepoPath(path.resolve(config.repoRoot, planArg), config.repoRoot);
    const candidates = argRepoPath.endsWith('.md') ? [argRepoPath] : [argRepoPath, `${argRepoPath}.md`];
    const pending = listPendingHandoffs(config);
    record = candidates.map(candidate => pending.find(r => r.plan === candidate)).find(Boolean);
    if (!record) {
      abs = resolveDocArg(planArg, config, { dieOnMiss: false });
      if (!abs) die(docArgMissMessage(planArg, config));
      ({ record, relocated } = namedHandoff(config, toRepoPath(abs, config.repoRoot), writing));
    }
  } else {
    const mine = pendingHandoffsForSession(config);
    if (mine.length === 0) die('No handoff of this session waits on a plan update. Name the plan: runlist baton --done <plan-file>');
    if (mine.length > 1) die(`This session has ${mine.length} handoffs waiting; name the plan:\n${mine.map(r => `  ${doneCommand(r.plan)}`).join('\n')}`);
    record = mine[0];
  }

  abs ??= path.resolve(config.repoRoot, record.plan);
  const planGone = !existsSync(abs);
  // Naming the gone path itself is how a handoff whose plan moved away is
  // cleared; with fields to write, or with no path named, it is refused.
  if (planGone && (writing || !planArg)) die(goneMessage(config, record, writing));
  const planRepoPath = toRepoPath(abs, config.repoRoot);
  const again = planArg ? doneCommand(planRepoPath) : 'runlist baton --done';

  if (fields.next_step !== undefined && JSON.stringify(fields.next_step) === comparableNextStep(record.nextStep)) {
    die(`Not done: --next-step repeats the next_step ${planRepoPath} had when the prompt was saved (${record.savedAt}). Write where the work goes from here.\nSaved prompt: ${record.name}`);
  }

  let source = abs;
  if (writing) {
    try { source = authorizeManagedSource(abs, config, { kind: 'Baton --done plan' }).path; }
    catch (err) { die(err.message); }
  }

  const finish = raw => {
    const next = writing ? renderFieldUpdates(raw, fields) : raw;
    if (stillAsRecorded(record, next)) {
      die(`Not done: ${planRepoPath} next_step is the same as when the prompt was saved (${record.savedAt}). Update the plan body first, then run \`${again} --next-step "<next move>"\`.\nSaved prompt: ${record.name}`);
    }
    return next;
  };
  const failed = err => {
    if (err instanceof DotmdError) throw err;
    const verb = planGone ? 'clear the handoff for' : writing ? 'write' : 'check';
    die(`Could not ${verb} ${planRepoPath} (${err.message}); the handoff is still pending.\nSaved prompt: ${record.name}`);
  };
  // Checked under the record's lock, before any plan write is published and
  // before the record is removed: a baton that saved a newer record for this
  // plan meanwhile is never finished by a call that read the older one.
  const current = () => {
    if (!sameGeneration(record, readRecord(record.recordFile))) {
      die(`The handoff record for ${record.plan} changed while this ran (a new baton, or another --done); run \`${again}\` again.\nSaved prompt: ${record.name}`);
    }
  };

  let preview = null;
  if (dryRun) {
    try { preview = finish(readFileSync(source, 'utf8')); } catch (err) { failed(err); }
  } else {
    try {
      if (planGone || relocated) {
        // No plan is written, so no plan is locked: a relocated plan is read
        // the way any reader would, and the old path is not touched at all.
        if (relocated) finish(readFileSync(source, 'utf8'));
        withPathLocks([record.recordFile], { repoRoot: config.repoRoot }, () => {
          current();
          // The saved path was gone when this started; a restore since then
          // (`set active` on the archived copy) brings the plan back as it
          // was, and that handoff is finished there, not cleared.
          if (existsSync(path.resolve(config.repoRoot, record.plan))) {
            die(`${record.plan} is back at the path its handoff was saved for, so the handoff was not cleared. Finish it there: \`${clearCommand(record)}\` once the plan is up to date.\nSaved prompt: ${record.name}`);
          }
          rmSync(record.recordFile, { force: true });
        });
      } else {
        // One sorted lock set, record and plan, so the verdict is reached on
        // the plan as it stands while the record cannot change: a refused call
        // publishes nothing, and the record goes only after the plan passed.
        // No other caller holds a plan lock while it takes a record lock
        // (baton records after its plan transaction releases). Like baton
        // itself, this leaves the shared generated index deferred.
        withPathLocks([record.recordFile, source], { repoRoot: config.repoRoot }, () => {
          current();
          mutateFile(source, { repoRoot: config.repoRoot, locked: true }, finish);
          rmSync(record.recordFile, { force: true });
        });
      }
    } catch (err) { failed(err); }
  }

  const result = {
    operation: 'baton-done',
    dryRun: Boolean(dryRun),
    plan: planRepoPath,
    prompt: record.prompt,
    name: record.name,
    nextStepChanged: !planGone,
    planGone,
    written: fields,
  };
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result;
  }
  if (dryRun) {
    const prefix = dim('[dry-run] ');
    process.stderr.write(`${prefix}Would write ${planRepoPath}:\n`);
    const { frontmatter } = extractFrontmatter(preview);
    const lines = frontmatter.split('\n');
    for (const key of Object.keys(fields)) {
      const at = lines.findIndex(line => line.startsWith(`${key}:`));
      for (let i = at; i >= 0 && i < lines.length && (i === at || /^[ \t]/.test(lines[i])); i++) process.stderr.write(`${prefix}  ${lines[i]}\n`);
    }
    process.stderr.write(`${prefix}Would report the handoff done and remove its record.\n`);
    process.stderr.write(`Saved prompt: ${record.name}\n`);
    return result;
  }
  if (planGone) {
    process.stderr.write(`${green('✓ Handoff cleared')}: ${planRepoPath} is gone, so there is no plan to update there; its record is removed.\n`);
    const others = listPendingHandoffs(config).filter(r => typeof r.plan === 'string' && path.basename(r.plan) === path.basename(planRepoPath));
    if (others.length) process.stderr.write(`Still pending, each for its own saved path: ${others.map(r => r.plan).join(', ')}.\n`);
  } else {
    const how = writing ? `${Object.keys(fields).join(' and ')} written` : 'next_step was updated after the prompt was saved';
    process.stderr.write(`${green('✓ Handoff done')}: ${planRepoPath} ${how}.\n`);
  }
  process.stderr.write(`Saved prompt: ${record.name}\n`);
  return result;
}
