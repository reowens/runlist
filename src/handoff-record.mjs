import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter, replaceFrontmatter } from './frontmatter.mjs';
import { replaceFrontmatterField } from './frontmatter-fix.mjs';
import { renderLifecycleMutation } from './lifecycle.mjs';
import { mutateFile, withPathLocks } from './atomic-mutation.mjs';
import { commitRename } from './durable-rename.mjs';
import { authorizeManagedSource } from './managed-path.mjs';
import { DotmdError, die, nowIso, toRepoPath } from './util.mjs';
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

function titleOf(content) {
  const title = frontmatterOf(content)?.title;
  return typeof title === 'string' ? title : null;
}

// Called by baton after the prompt and the plan release are published. Returns
// the record when the plan carries a next_step to wait on, else null (a repo
// whose plans have no next_step field has nothing for --done to check).
export function recordPendingHandoff(config, { planRepoPath, promptRepoPath, promptName }) {
  const content = readFileSync(path.resolve(config.repoRoot, planRepoPath), 'utf8');
  const { present, value } = nextStepOf(content);
  if (!present) return null;
  const record = {
    plan: planRepoPath,
    prompt: promptRepoPath,
    name: promptName,
    savedAt: nowIso(),
    nextStep: value,
    title: titleOf(content),
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

// A named plan finishes the record saved for that exact path. The one
// exception is a plan that moved after the prompt was saved (archived, filed
// into a subdirectory): its record still names the old path, so a record with
// the same file name is taken, but only when its plan is gone from that path
// and no other record could be meant. A plan that merely shares a file name
// with one still in place is a different plan.
function namedHandoff(config, repoPath) {
  const records = listPendingHandoffs(config);
  const exact = records.find(r => r.plan === repoPath);
  if (exact) return { record: exact, movedFrom: null };
  const sameName = records.filter(r => typeof r.plan === 'string' && path.basename(r.plan) === path.basename(repoPath));
  const moved = sameName.filter(r => !existsSync(path.resolve(config.repoRoot, r.plan)));
  if (moved.length > 1) die(`No handoff was saved for ${repoPath}, and ${moved.length} handoffs for moved plans of that file name could be meant:\n${moved.map(r => `  ${r.plan} (saved ${r.savedAt}, prompt ${r.name})`).join('\n')}\nFinish each where it was saved, or archive its prompt.`);
  if (moved.length === 1) return { record: moved[0], movedFrom: path.resolve(config.repoRoot, moved[0].plan) };
  if (sameName.length) die(`No handoff waits on ${repoPath}. The handoff for a plan of the same file name is ${sameName.map(r => r.plan).join(', ')}, which is still in place; finish it there: runlist baton --done ${sameName[0].plan}`);
  die(`No handoff waits on ${repoPath}: baton has not saved a prompt for it that needs the plan brought up to date.`);
}

// `runlist baton --done [<plan>] [--next-step "…"] [--current-state "…"]`
export function runBatonDone(planArg, config, { json = false, dryRun = false, nextStep = null, currentState = null } = {}) {
  const fields = {};
  if (nextStep !== null) fields.next_step = checkedFieldValue('--next-step', nextStep);
  if (currentState !== null) fields.current_state = checkedFieldValue('--current-state', currentState);
  const writing = Object.keys(fields).length > 0;
  if (dryRun && !writing) die('`runlist baton --done` changes nothing but its own record; run it without --dry-run, or preview a write with --next-step.');

  let record;
  let movedFrom = null;
  let abs = null;
  if (planArg) {
    abs = resolveDocArg(planArg, config);
    ({ record, movedFrom } = namedHandoff(config, toRepoPath(abs, config.repoRoot)));
  } else {
    const mine = pendingHandoffsForSession(config);
    if (mine.length === 0) die('No handoff of this session waits on a plan update. Name the plan: runlist baton --done <plan-file>');
    if (mine.length > 1) die(`This session has ${mine.length} handoffs waiting; name the plan:\n${mine.map(r => `  runlist baton --done ${r.plan}`).join('\n')}`);
    record = mine[0];
  }

  abs ??= path.resolve(config.repoRoot, record.plan);
  if (!existsSync(abs)) die(`${record.plan} is gone (moved or archived?). Run \`runlist baton --done <its new path>\` once it is up to date.\nSaved prompt: ${record.name}`);
  const planRepoPath = toRepoPath(abs, config.repoRoot);
  const again = `runlist baton --done${planArg ? ` ${planRepoPath}` : ''}`;

  if (fields.next_step !== undefined && JSON.stringify(fields.next_step) === comparableNextStep(record.nextStep)) {
    die(`Not done: --next-step repeats the next_step ${planRepoPath} had when the prompt was saved (${record.savedAt}). Write where the work goes from here.\nSaved prompt: ${record.name}`);
  }

  let source = abs;
  if (writing) {
    try { source = authorizeManagedSource(abs, config, { kind: 'Baton --done plan' }).path; }
    catch (err) { die(err.message); }
  }

  // The verdict is reached on the content the plan will hold once this call
  // is through, read under the plan's lock: a refused call publishes nothing,
  // and a next_step restored by a concurrent writer is seen, not missed.
  const finish = raw => {
    const title = movedFrom && typeof record.title === 'string' ? titleOf(raw) : null;
    if (title !== null && title !== record.title) {
      die(`${planRepoPath} is not the plan the handoff was saved for: its title is "${title}", the plan saved at ${record.plan} was "${record.title}".\nSaved prompt: ${record.name}`);
    }
    const next = writing ? renderFieldUpdates(raw, fields) : raw;
    if (stillAsRecorded(record, next)) {
      die(`Not done: ${planRepoPath} next_step is the same as when the prompt was saved (${record.savedAt}). Update the plan body first, then run \`${again} --next-step "<next move>"\`.\nSaved prompt: ${record.name}`);
    }
    return next;
  };
  const failed = err => {
    if (err instanceof DotmdError) throw err;
    die(`Could not ${writing ? 'write' : 'check'} ${planRepoPath} (${err.message}); the handoff is still pending.\nSaved prompt: ${record.name}`);
  };

  let preview = null;
  if (dryRun) {
    try { preview = finish(readFileSync(source, 'utf8')); } catch (err) { failed(err); }
  } else {
    // The record is held for the whole call, so it is removed only after the
    // plan passed the gate (and any write was published), and only if it is
    // still the record that was read: another baton for this plan replaces
    // it under the same lock. A moved plan's old path is held too, and must
    // still be empty.
    try {
      withPathLocks([record.recordFile, ...(movedFrom ? [movedFrom] : [])], { repoRoot: config.repoRoot }, () => {
        const current = readRecord(record.recordFile);
        if (current?.plan !== record.plan || current?.savedAt !== record.savedAt) {
          die(`The handoff record for ${record.plan} changed while this ran (a new baton, or another --done); run \`${again}\` again.\nSaved prompt: ${record.name}`);
        }
        if (movedFrom && existsSync(movedFrom)) die(`${record.plan} is back in place; finish the handoff there: runlist baton --done ${record.plan}`);
        // Like baton itself, this leaves the shared generated index deferred.
        mutateFile(source, { repoRoot: config.repoRoot }, finish);
        rmSync(record.recordFile, { force: true });
      });
    } catch (err) { failed(err); }
  }

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
