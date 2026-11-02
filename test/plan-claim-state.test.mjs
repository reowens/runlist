import { afterEach, beforeEach, describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { ownershipPathFor, planClaimState, readPlanOwnership } from '../src/pickup.mjs';
import { formatPlanRow } from '../src/query.mjs';
import { SESSION_ID_VARIABLES } from '../src/util.mjs';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'runlist.mjs');
const LABELS = {
  yours: '[IN-SESSION · yours]',
  other: '[IN-SESSION · other]',
  gone: '[IN-SESSION · gone]',
  none: '[IN-SESSION · no claim]',
};
let tmp;

// Every session and owning-process variable is cleared, so a fixture names its
// own session, or none at all, whatever host runs the suite.
function run(args, { session = 'session-a', pid = null } = {}) {
  const env = { ...process.env, NO_COLOR: '1' };
  for (const key of SESSION_ID_VARIABLES) delete env[key];
  for (const key of ['RUNLIST_SESSION_PID', 'DOTMD_SESSION_PID', 'CLAUDE_PID']) delete env[key];
  if (session) env.RUNLIST_SESSION_ID = session;
  if (pid) env.RUNLIST_SESSION_PID = String(pid);
  return spawnSync(process.execPath, [bin, ...args, '--config', path.join(tmp, 'runlist.config.mjs')], { cwd: tmp, encoding: 'utf8', env });
}

function ok0(result) {
  strictEqual(result.status, 0, result.stderr);
  return result.stdout;
}

const planPath = name => `docs/plans/${name}.md`;

function writePlan(name, status = 'active', extra = '') {
  writeFileSync(path.join(tmp, planPath(name)), `---\ntype: plan\nstatus: ${status}\ntitle: ${name}\nupdated: 2025-01-01T00:00:00Z\ncurrent_state: testing\n${extra}---\n# ${name}\n\n## Version History\n\n- **2025-01-01T00:00:00Z** Created.\n`);
  return planPath(name);
}

function claimedPlan(name, options) {
  const file = writePlan(name);
  ok0(run(['use', file], options));
  return file;
}

function unclaimedPlan(name) {
  const draft = path.join(tmp, `${name}-draft.md`);
  writeFileSync(draft, '# Draft\n\n## Problem\n\nA body.\n');
  ok0(run(['new', 'plan', name, `@${draft}`, '--status', 'in-session']));
  rmSync(draft);
  return planPath(name);
}

async function goneClaim(name) {
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  const file = claimedPlan(name, { session: 'session-gone', pid: owner.pid });
  await new Promise(resolve => { owner.on('exit', resolve); owner.kill('SIGKILL'); });
  return file;
}

const config = () => resolveConfig(tmp, path.join(tmp, 'runlist.config.mjs'));
const inSession = file => ({ type: 'plan', status: 'in-session', path: file });

function plansJson(args = [], options) {
  const { docs } = JSON.parse(ok0(run(['plans', '--json', ...args], options)));
  return new Map(docs.map(doc => [doc.path, doc]));
}

function rowFor(output, name) {
  return output.split('\n').find(line => line.includes(name));
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'runlist-claim-state-'));
  spawnSync('git', ['init', '-q'], { cwd: tmp });
  mkdirSync(path.join(tmp, 'docs', 'plans'), { recursive: true });
  writeFileSync(path.join(tmp, 'runlist.config.mjs'), "export const root = 'docs';\n");
});

afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('planClaimState', () => {
  it('is null for anything but an in-session plan', async () => {
    const cfg = await config();
    const file = claimedPlan('alpha');
    strictEqual(planClaimState({ type: 'plan', status: 'active', path: file }, cfg, 'session-a'), null);
    strictEqual(planClaimState({ type: 'doc', status: 'in-session', path: file }, cfg, 'session-a'), null);
    strictEqual(planClaimState(null, cfg, 'session-a'), null);
  });

  it('reads the holding session as yours, with its id and claim time', async () => {
    const file = claimedPlan('alpha', { pid: process.pid });
    const cfg = await config();
    const record = readPlanOwnership(file, cfg);
    deepStrictEqual(planClaimState(inSession(file), cfg, 'session-a'), {
      state: 'yours', sessionId: 'session-a', claimedAt: record.claimedAt, liveness: 'live',
    });
  });

  it('keeps your own claim as yours when its recorded process has ended', async () => {
    const file = await goneClaim('alpha');
    const claim = planClaimState(inSession(file), await config(), 'session-gone');
    strictEqual(claim.state, 'yours');
    strictEqual(claim.liveness, 'dead');
  });

  it('reads a live holder as other', async () => {
    const file = claimedPlan('alpha', { session: 'session-b', pid: process.pid });
    const claim = planClaimState(inSession(file), await config(), 'session-a');
    strictEqual(claim.state, 'other');
    strictEqual(claim.sessionId, 'session-b');
    strictEqual(claim.liveness, 'live');
  });

  it('reads an unverifiable holder as other, never gone', async () => {
    const file = claimedPlan('alpha', { session: 'session-b' });
    const cfg = await config();
    const claim = planClaimState(inSession(file), cfg, 'session-a');
    strictEqual(claim.state, 'other');
    strictEqual(claim.liveness, 'unverifiable');
  });

  it('does not call a process on another machine gone', async () => {
    const file = await goneClaim('alpha');
    const cfg = await config();
    const recordPath = ownershipPathFor(file, cfg);
    const record = JSON.parse(readFileSync(recordPath, 'utf8'));
    record.sessionOwner.hostname = 'worker-a-elsewhere';
    writeFileSync(recordPath, JSON.stringify(record));
    const claim = planClaimState(inSession(file), cfg, 'session-a');
    strictEqual(claim.state, 'other');
    strictEqual(claim.liveness, 'unverifiable');
  });

  it('reads a provably ended holder as gone', async () => {
    const file = await goneClaim('alpha');
    const claim = planClaimState(inSession(file), await config(), 'session-a');
    strictEqual(claim.state, 'gone');
    strictEqual(claim.sessionId, 'session-gone');
    strictEqual(claim.liveness, 'dead');
  });

  it('reads no record as none, with no ids', async () => {
    const file = unclaimedPlan('alpha');
    deepStrictEqual(planClaimState(inSession(file), await config(), 'session-a'), {
      state: 'none', sessionId: null, claimedAt: null, liveness: null,
    });
  });

  it('reads a released record as none, whoever released it', async () => {
    const file = claimedPlan('alpha');
    ok0(run(['set', 'active', file]));
    writePlan('alpha', 'in-session');
    const cfg = await config();
    strictEqual(readPlanOwnership(file, cfg).state, 'released');
    for (const sessionId of ['session-a', 'session-b']) {
      deepStrictEqual(planClaimState(inSession(file), cfg, sessionId), {
        state: 'none', sessionId: null, claimedAt: null, liveness: null,
      });
    }
  });

  it('reads a corrupt record as other', async () => {
    const file = claimedPlan('alpha');
    const cfg = await config();
    writeFileSync(ownershipPathFor(file, cfg), '{ not json');
    deepStrictEqual(planClaimState(inSession(file), cfg, 'session-a'), {
      state: 'other', sessionId: null, claimedAt: null, liveness: 'unverifiable',
    });
  });

  it('does not trust a mismatched record that names this session', async () => {
    const file = claimedPlan('alpha');
    const cfg = await config();
    const recordPath = ownershipPathFor(file, cfg);
    writeFileSync(recordPath, JSON.stringify({ ...JSON.parse(readFileSync(recordPath, 'utf8')), identityKey: 'something-else' }));
    const claim = planClaimState(inSession(file), cfg, 'session-a');
    strictEqual(claim.state, 'other');
    strictEqual(claim.sessionId, null);
  });

  it('reads nothing as yours with no session id', async () => {
    const file = claimedPlan('alpha');
    strictEqual(planClaimState(inSession(file), await config(), null).state, 'other');
  });
});

describe('runlist plans', () => {
  async function fourPlans() {
    claimedPlan('mine', { pid: process.pid });
    claimedPlan('theirs', { session: 'session-b' });
    await goneClaim('ended');
    unclaimedPlan('loose');
    writePlan('waiting');
  }

  it('labels each holder in the flat view and leaves other statuses alone', async () => {
    await fourPlans();
    const out = ok0(run(['plans']));
    ok(rowFor(out, 'mine').endsWith(LABELS.yours), out);
    ok(rowFor(out, 'theirs').endsWith(LABELS.other), out);
    ok(rowFor(out, 'ended').endsWith(LABELS.gone), out);
    ok(rowFor(out, 'loose').endsWith(LABELS.none), out);
    ok(rowFor(out, 'waiting').endsWith('[ACTIVE]'), out);
    strictEqual(rowFor(out, 'waiting').length, 100 - '[QUEUED-AFTER]'.length + '[ACTIVE]'.length);
  });

  it('works with no session id, where nothing is yours', async () => {
    await fourPlans();
    const out = ok0(run(['plans'], { session: null }));
    ok(!out.includes(LABELS.yours), out);
    ok(rowFor(out, 'mine').endsWith(LABELS.other), out);
    ok(rowFor(out, 'loose').endsWith(LABELS.none), out);
    strictEqual(plansJson([], { session: null }).get(planPath('mine')).claim.state, 'other');
  });

  for (const args of [['status'], ['--group', 'module'], ['--group', 'surface'], ['--group', 'owner'], ['--group-by', 'stage'], ['--sort', 'status']]) {
    it(`labels holders in the grouped view: ${args.join(' ')}`, async () => {
      await fourPlans();
      const out = ok0(run(['plans', ...args]));
      ok(rowFor(out, 'mine').endsWith(LABELS.yours), out);
      ok(rowFor(out, 'theirs').endsWith(LABELS.other), out);
      ok(rowFor(out, 'ended').endsWith(LABELS.gone), out);
      ok(rowFor(out, 'loose').endsWith(LABELS.none), out);
    });
  }

  it('prints no tag on other statuses where a grouped view prints none today', async () => {
    await fourPlans();
    for (const args of [['status'], ['--group', 'module']]) {
      const out = ok0(run(['plans', ...args]));
      ok(!rowFor(out, 'waiting').includes('['), out);
    }
  });

  it('labels a child folded under its hub, and a coordination hub', async () => {
    writePlan('sprint', 'active', 'runlist:\n  - sprint-one.md\n');
    writePlan('sprint-one', 'in-session', 'parent_plan: sprint.md\n');
    writePlan('area', 'in-session', 'execution_mode: coordination\n');
    const out = ok0(run(['plans']));
    ok(out.split('\n').find(line => /→ one\s+\d+d/.test(line)).endsWith(LABELS.none), out);
    ok(rowFor(out, 'sprint').endsWith('[RUNLIST]'), out);
    ok(rowFor(out, 'area').endsWith(LABELS.none), out);
    ok(rowFor(ok0(run(['runlists'])), 'area').endsWith('[IN-SESSION]'), 'the runlists dashboard is unchanged');
  });

  it('keeps long rows inside the width', async () => {
    const slug = 'a-plan-with-a-fairly-long-name-that-keeps-going';
    writePlan(slug, 'in-session', `next_step: ${'do the next thing '.repeat(12)}\n`);
    for (const line of ok0(run(['plans'])).split('\n')) ok(line.length <= 100, line);
    for (const line of ok0(run(['plans', 'status'])).split('\n')) ok(line.length <= 100, line);
  });

  it('fits every claim label at narrow widths, and keeps the row whole', () => {
    const doc = { status: 'in-session', daysSinceUpdate: 12, nextStep: 'do the next thing '.repeat(12), checklist: { total: 4, completed: 1 } };
    const slugs = ['short', 'x'.repeat(30), 'a-plan-with-a-fairly-long-name-that-keeps-going'];
    for (const [state, label] of Object.entries(LABELS)) {
      for (const width of [100, 80, 72, 60, 50]) {
        for (const slug of slugs) {
          const line = formatPlanRow({ ...doc, claim: { state } }, width, { slug, maxSlug: Math.min(30, slug.length), showTag: true });
          ok(line.length <= width, `${width}: ${line}`);
          ok(line.endsWith(label), line);
        }
      }
    }
  });

  it('leaves the row of another status exactly as it was', () => {
    const doc = { status: 'blocked', daysSinceUpdate: 2, nextStep: 'n'.repeat(200) };
    const line = formatPlanRow(doc, 60, { slug: 'x'.repeat(30), maxSlug: 30, showTag: true });
    strictEqual(line, `  ${'x'.repeat(30)}    2d         ${'n'.repeat(7)}...  [BLOCKED]`);
  });

  it('adds claim to in-session plans only in JSON', async () => {
    await fourPlans();
    const docs = plansJson();
    strictEqual(docs.get(planPath('mine')).claim.state, 'yours');
    strictEqual(docs.get(planPath('mine')).claim.sessionId, 'session-a');
    strictEqual(docs.get(planPath('theirs')).claim.state, 'other');
    strictEqual(docs.get(planPath('ended')).claim.state, 'gone');
    deepStrictEqual(docs.get(planPath('loose')).claim, { state: 'none', sessionId: null, claimedAt: null, liveness: null });
    ok(!('claim' in docs.get(planPath('waiting'))));
    strictEqual(docs.get(planPath('mine')).status, 'in-session');
    strictEqual(docs.get(planPath('mine')).title, 'mine');
  });

  it('adds no claim to other query output', async () => {
    claimedPlan('alpha');
    const { docs } = JSON.parse(ok0(run(['query', '--type', 'plan', '--json'])));
    ok(!('claim' in docs[0]));
  });
});

describe('doctor --claims', () => {
  it('lists unclaimed plans where the nothing-claimed message would have hidden them', () => {
    const file = unclaimedPlan('alpha');
    const out = ok0(run(['doctor', '--claims']));
    ok(out.includes('No claim (1)'), out);
    ok(out.includes(file), out);
    ok(out.includes('The holder may be on another machine or gone.'), out);
    ok(!out.includes('No plans are claimed'), out);
    ok(!out.includes('Plan claims'), out);
    deepStrictEqual(JSON.parse(ok0(run(['doctor', '--claims', '--json']))).unclaimed, [file]);
  });

  it('still says nothing is claimed when nothing is, and only then', () => {
    writePlan('alpha');
    ok(ok0(run(['doctor', '--claims'])).includes('No plans are claimed'));
    deepStrictEqual(JSON.parse(ok0(run(['doctor', '--claims', '--json']))).unclaimed, []);
  });

  it('does not list claimed plans, active plans or archived paths as unclaimed', async () => {
    claimedPlan('claimed');
    writePlan('waiting');
    mkdirSync(path.join(tmp, 'docs', 'plans', 'archived'));
    writeFileSync(path.join(tmp, 'docs', 'plans', 'archived', 'old.md'), '---\ntype: plan\nstatus: in-session\ntitle: old\n---\n# old\n');
    const loose = unclaimedPlan('loose');
    deepStrictEqual(JSON.parse(ok0(run(['doctor', '--claims', '--json']))).unclaimed, [loose]);
  });

  it('counts a released record as no claim', () => {
    const file = claimedPlan('alpha');
    ok0(run(['set', 'active', file]));
    writePlan('alpha', 'in-session');
    ok(ok0(run(['doctor', '--claims'])).includes('No claim (1)'));
  });

  it('never counts a corrupt record as no claim', async () => {
    const file = claimedPlan('alpha');
    writeFileSync(ownershipPathFor(file, await config()), '{ not json');
    deepStrictEqual(JSON.parse(ok0(run(['doctor', '--claims', '--json']))).unclaimed, []);
  });

  it('leaves unclaimed plans alone under --apply, with or without --older-than', async () => {
    const loose = unclaimedPlan('loose');
    const ended = await goneClaim('ended');
    const before = readFileSync(path.join(tmp, loose), 'utf8');

    const applied = ok0(run(['doctor', '--claims', '--apply']));
    ok(applied.includes('Released 1 claim'), applied);
    ok(applied.includes('No claim (1)'), applied);
    strictEqual(readFileSync(path.join(tmp, loose), 'utf8'), before);
    ok(readFileSync(path.join(tmp, ended), 'utf8').includes('status: active'));

    const json = JSON.parse(ok0(run(['doctor', '--claims', '--apply', '--older-than', '0h', '--json'])));
    deepStrictEqual(json.released, []);
    deepStrictEqual(json.unclaimed, [loose]);
    strictEqual(readFileSync(path.join(tmp, loose), 'utf8'), before);
    strictEqual(readPlanOwnership(loose, await config()), null);
  });

  it('prints both sections when both exist', () => {
    claimedPlan('claimed', { session: 'session-b' });
    unclaimedPlan('loose');
    const out = ok0(run(['doctor', '--claims']));
    ok(out.indexOf('Plan claims (1)') < out.indexOf('No claim (1)'), out);
    ok(out.indexOf('Plan claims (1)') >= 0, out);
  });
});

describe('help', () => {
  it('describes the labels and the unclaimed section', () => {
    const plans = ok0(run(['plans', '--help']));
    ok(plans.includes('[IN-SESSION · no claim]'), plans);
    ok(plans.includes('`claim`'), plans);
    const doctor = ok0(run(['doctor', '--help']));
    ok(doctor.includes('with no claim'), doctor);
    ok(doctor.includes('`unclaimed`'), doctor);
  });
});
