import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter, replaceFrontmatter } from './frontmatter.mjs';
import { replaceFrontmatterField } from './frontmatter-fix.mjs';
import { renderLifecycleMutation } from './lifecycle.mjs';
import { mutateFile } from './atomic-mutation.mjs';
import { authorizeManagedSource } from './managed-path.mjs';
import { die, nowIso, toRepoPath } from './util.mjs';
import { stateDir } from './naming.mjs';
import { resolveDocArg } from './index.mjs';
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

function recordPath(config, planRepoPath) {
  return path.join(recordsDir(config), `${path.basename(planRepoPath, '.md')}.json`);
}

function planNextStep(absPath) {
  const { frontmatter } = extractFrontmatter(readFileSync(absPath, 'utf8'));
  if (!frontmatter) return { present: false, value: null };
  const fm = parseSimpleFrontmatter(frontmatter);
  if (!Object.prototype.hasOwnProperty.call(fm, 'next_step')) return { present: false, value: null };
  return { present: true, value: JSON.stringify(fm.next_step ?? null) };
}

// Called by baton after the prompt and the plan release are published. Returns
// the record when the plan carries a next_step to wait on, else null (a repo
// whose plans have no next_step field has nothing for --done to check).
export function recordPendingHandoff(config, { planRepoPath, promptRepoPath, promptName }) {
  const abs = path.resolve(config.repoRoot, planRepoPath);
  const { present, value } = planNextStep(abs);
  if (!present) return null;
  const record = {
    plan: planRepoPath,
    prompt: promptRepoPath,
    name: promptName,
    savedAt: nowIso(),
    nextStep: value,
    sessionId: authoritativeSessionId() ?? null,
  };
  mkdirSync(recordsDir(config), { recursive: true });
  writeFileSync(recordPath(config, planRepoPath), JSON.stringify(record, null, 2) + '\n');
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

function recordedNextStep(record) {
  try {
    const value = JSON.parse(record.nextStep);
    return typeof value === 'string' ? normalizeFieldValue(value) : value;
  } catch { return undefined; }
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

// `runlist baton --done [<plan>] [--next-step "…"] [--current-state "…"]`
export function runBatonDone(planArg, config, { json = false, dryRun = false, nextStep = null, currentState = null } = {}) {
  const fields = {};
  if (nextStep !== null) fields.next_step = checkedFieldValue('--next-step', nextStep);
  if (currentState !== null) fields.current_state = checkedFieldValue('--current-state', currentState);
  const writing = Object.keys(fields).length > 0;
  if (dryRun && !writing) die('`runlist baton --done` changes nothing but its own record; run it without --dry-run, or preview a write with --next-step.');

  let record;
  let abs = null;
  if (planArg) {
    abs = resolveDocArg(planArg, config);
    const repoPath = toRepoPath(abs, config.repoRoot);
    record = listPendingHandoffs(config).find(r => r.plan === repoPath)
      ?? listPendingHandoffs(config).find(r => path.basename(r.plan) === path.basename(repoPath));
    if (!record) die(`No handoff waits on ${repoPath}: baton has not saved a prompt for it that needs the plan brought up to date.`);
  } else {
    const mine = pendingHandoffsForSession(config);
    if (mine.length === 0) die('No handoff of this session waits on a plan update. Name the plan: runlist baton --done <plan-file>');
    if (mine.length > 1) die(`This session has ${mine.length} handoffs waiting; name the plan:\n${mine.map(r => `  runlist baton --done ${r.plan}`).join('\n')}`);
    record = mine[0];
  }

  // A named plan is checked where it is now: the record may still carry the
  // path the plan had before it moved, matched above by its file name.
  abs ??= path.resolve(config.repoRoot, record.plan);
  if (!existsSync(abs)) die(`${record.plan} is gone (moved or archived?). Run \`runlist baton --done <its new path>\` once it is up to date.\nSaved prompt: ${record.name}`);
  const planRepoPath = toRepoPath(abs, config.repoRoot);
  const again = `runlist baton --done${planArg ? ` ${planRepoPath}` : ''}`;
  const notDone = () => die(`Not done: ${planRepoPath} next_step is the same as when the prompt was saved (${record.savedAt}). Update the plan body first, then run \`${again} --next-step "<next move>"\`.\nSaved prompt: ${record.name}`);
  const unchanged = file => {
    const { present, value } = planNextStep(file);
    return present && value === record.nextStep;
  };

  let preview = null;
  if (fields.next_step !== undefined) {
    if (fields.next_step === recordedNextStep(record)) {
      die(`Not done: --next-step repeats the next_step ${planRepoPath} had when the prompt was saved (${record.savedAt}). Write where the work goes from here.\nSaved prompt: ${record.name}`);
    }
  } else if (unchanged(abs)) {
    notDone(); // --current-state alone never counts as done
  }

  if (writing) {
    let source;
    try { source = authorizeManagedSource(abs, config, { kind: 'Baton --done plan' }).path; }
    catch (err) { die(err.message); }
    if (dryRun) {
      preview = renderFieldUpdates(readFileSync(source, 'utf8'), fields);
    } else {
      // Like baton itself, this leaves the shared generated index deferred.
      try { mutateFile(source, { repoRoot: config.repoRoot }, raw => renderFieldUpdates(raw, fields)); }
      catch (err) { die(`Could not write ${planRepoPath} (${err.message}); the handoff is still pending.\nSaved prompt: ${record.name}`); }
      if (unchanged(source)) notDone();
    }
  }

  if (!dryRun) rmSync(record.recordFile, { force: true });
  const result = {
    operation: 'baton-done',
    dryRun: Boolean(dryRun),
    plan: planRepoPath,
    prompt: record.prompt,
    name: record.name,
    nextStepChanged: true,
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
  const how = writing ? `${Object.keys(fields).join(' and ')} written` : 'next_step was updated after the prompt was saved';
  process.stderr.write(`${green('✓ Handoff done')}: ${planRepoPath} ${how}.\n`);
  process.stderr.write(`Saved prompt: ${record.name}\n`);
  return result;
}
