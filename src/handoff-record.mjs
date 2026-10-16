import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { die, nowIso, toRepoPath } from './util.mjs';
import { stateDir } from './naming.mjs';
import { resolveDocArg } from './index.mjs';
import { authoritativeSessionId } from './pickup.mjs';
import { green } from './color.mjs';

// A baton that releases an in-session plan saves the prompt first, so a usage
// stop partway through the handoff loses nothing. The plan update that follows
// is the part sessions skipped: they saved the prompt, reported the handoff
// done, and left next_step saying what it said before the work. So baton leaves
// a record of the plan's next_step as it stood when the prompt was saved, and
// `runlist baton --done` reports the handoff done only once next_step differs.
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

export function handoffNotDoneLine(record, doneCommand = 'runlist baton --done') {
  return `Handoff not done yet: the prompt is saved, and ${record.plan} still needs bringing up to date (the body, then next_step). Then run \`${doneCommand}\`.`;
}

// `runlist baton --done [<plan>]`
export function runBatonDone(planArg, config, { json = false } = {}) {
  let record;
  if (planArg) {
    const abs = resolveDocArg(planArg, config);
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

  const abs = path.resolve(config.repoRoot, record.plan);
  if (!existsSync(abs)) die(`${record.plan} is gone (moved or archived?). Run \`runlist baton --done <its new path>\` once it is up to date.\nSaved prompt: ${record.name}`);
  const { present, value } = planNextStep(abs);
  if (present && value === record.nextStep) {
    die(`Not done: ${record.plan} next_step is the same as when the prompt was saved (${record.savedAt}). Bring the plan up to date (the body, then next_step), then run \`runlist baton --done${planArg ? ` ${record.plan}` : ''}\` again.\nSaved prompt: ${record.name}`);
  }
  rmSync(record.recordFile, { force: true });
  const result = { operation: 'baton-done', plan: record.plan, prompt: record.prompt, name: record.name, nextStepChanged: true };
  if (json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return result;
  }
  process.stderr.write(`${green('✓ Handoff done')}: ${record.plan} next_step was updated after the prompt was saved.\n`);
  process.stderr.write(`Saved prompt: ${record.name}\n`);
  return result;
}
