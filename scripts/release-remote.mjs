#!/usr/bin/env node
// `npm run release [-- patch|minor|major]` and `npm run release:resume`.
// On the qualified Apple Silicon Mac they run `npm version` and the resume
// chain in place. Anywhere else they drive that Mac, named as `releaseHost` in
// the private release config: after checking both checkouts, the release
// starts in a new session of the Mac's own tmux server (only a session of a
// server started from its login can read the login Keychain for codesign), its
// log streams back here, and this command exits with the release's exit code.
// `--attach` re-follows a running or finished release; `--dry-run` runs every
// check, prints the command it would start and changes nothing.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote } from '../src/util.mjs';
import { preflightDesktopRelease, remoteDesktopRelease } from './desktop-release-config.mjs';
import { readReleaseIntent } from './release-intent.mjs';
import { runReleasePreflight } from './release-preflight.mjs';

export const RELEASE_SESSION = 'runlist-release';
const SSH_OPTIONS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15'];
const BUMPS = ['patch', 'minor', 'major'];
const KEYCHAIN_NOTE = 'start tmux from the Mac\'s own login first; a tmux server started over SSH cannot read the login Keychain, so codesign would fail';

// Prints what the release host's checkout and tmux server look like. With a
// target commit it fetches origin/main and checks that the checkout can fast-
// forward to it. With every other check passing it does: apply=1 for a new
// release, which needs no release intent, and apply=resume for a resume, which
// needs one.
const CHECK_SCRIPT = `set -uo pipefail
checkout=$1 target=$2 apply=$3
case $checkout in "~/"*) checkout="$HOME/$(printf '%s' "$checkout" | cut -c3-)" ;; esac
echo "home=$HOME"
held=""
if sessions=$(tmux list-sessions -F '#{session_name}' 2>/dev/null); then
  tmux=running
  held=$(printf '%s\\n' "$sessions" | grep '^${RELEASE_SESSION}' | tr '\\n' ' ' || true)
else
  tmux=none
fi
echo "tmux=$tmux"
echo "sessions=$held"
cd "$checkout" 2>/dev/null || { echo "checkout=missing"; exit 0; }
echo "checkout=$(pwd -P)"
branch=$(git branch --show-current)
dirty=$(git status --porcelain=v1 --untracked-files=all | wc -l | tr -d ' ')
echo "branch=$branch"
echo "head=$(git rev-parse HEAD)"
echo "dirty=$dirty"
gitdir=$(git rev-parse --path-format=absolute --git-dir)
intent=""
for file in "$gitdir/runlist-release-intent.json" "$gitdir/dotmd-release-intent.json"; do
  if [ -f "$file" ]; then intent=$(tr -d '\\n' < "$file"); break; fi
done
echo "intent=$intent"
[ -n "$target" ] || exit 0
if ! git fetch --quiet origin main; then echo "sync=fetch-failed"
elif [ "$(git rev-parse HEAD)" = "$target" ]; then echo "sync=current"
elif ! git cat-file -e "$target^{commit}" 2>/dev/null; then echo "sync=missing"
elif git merge-base --is-ancestor "$target" HEAD; then echo "sync=ahead"
elif ! git merge-base --is-ancestor HEAD "$target"; then echo "sync=diverged"
elif [ "$tmux" != running ] || [ -n "$held" ] || [ "$dirty" != 0 ] || [ "$branch" != main ]; then echo "sync=would-forward"
elif ! { [ "$apply" = 1 ] && [ -z "$intent" ]; } && ! { [ "$apply" = resume ] && [ -n "$intent" ]; }; then echo "sync=would-forward"
elif git merge --quiet --ff-only "$target"; then echo "sync=forwarded"
else echo "sync=failed"; fi`;

const START_SCRIPT = `set -euo pipefail
log=$1 command=$2
if tmux has-session -t ${RELEASE_SESSION} 2>/dev/null; then echo "a ${RELEASE_SESSION} tmux session already runs" >&2; exit 1; fi
: > "$log"
tmux new-session -d -s ${RELEASE_SESSION} "$command"`;

// With no log named, follows the newest release log.
const FOLLOW_SCRIPT = `set -euo pipefail
log=$1
if [ -z "$log" ]; then
  log=$(ls -t "$HOME"/runlist-release-*.*.*.log 2>/dev/null | head -n 1 || true)
  [ -n "$log" ] || { echo "no runlist-release-<version>.log in $HOME" >&2; exit 1; }
fi
echo "following $log" >&2
exec tail -n +1 -F "$log"`;

const homePath = value => typeof value === 'string' && (path.posix.isAbsolute(value) || value.startsWith('~/'));

function configFile(root, env) {
  return env.RUNLIST_RELEASE_CONFIG || path.join(root, '.runlist', 'release-config.json');
}

export function readReleaseHost(root, env = process.env) {
  const file = configFile(root, env);
  const host = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).releaseHost : undefined;
  if (host === undefined) return { file, host: null };
  if (typeof host?.ssh !== 'string' || !host.ssh.trim() || host.ssh.startsWith('-')) throw new Error(`releaseHost in ${file} needs an ssh destination`);
  if (!homePath(host.checkout)) throw new Error(`releaseHost.checkout in ${file} must be an absolute or ~/ path of the Runlist checkout`);
  if (host.node !== undefined && !homePath(host.node)) throw new Error(`releaseHost.node in ${file} must be an absolute or ~/ path of a Node executable`);
  const extra = host.env ?? {};
  if (typeof extra !== 'object' || Array.isArray(extra)) throw new Error(`releaseHost.env in ${file} must map variable names to values`);
  for (const [name, value] of Object.entries(extra)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name === 'PATH' || typeof value !== 'string') {
      throw new Error(`releaseHost.env.${name} in ${file} must be a string for a variable other than PATH`);
    }
  }
  return { file, host: { ssh: host.ssh, checkout: host.checkout, node: host.node ?? null, env: extra } };
}

export function nextVersion(version, bump) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!match) throw new Error(`cannot bump version ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function remoteArgs(host, mode, script, args) {
  return [...SSH_OPTIONS, host.ssh, ['bash', '-c', script, mode, ...args].map(shellQuote).join(' ')];
}

export const remoteCheckArgs = (host, target = '', apply = false) =>
  remoteArgs(host, 'release-host-check', CHECK_SCRIPT, [host.checkout, target, apply === 'resume' ? 'resume' : apply ? '1' : '0']);
export const remoteStartArgs = (host, log, command) => remoteArgs(host, 'release-host-start', START_SCRIPT, [log, command]);
export const remoteFollowArgs = (host, log = '') => remoteArgs(host, 'release-host-follow', FOLLOW_SCRIPT, [log]);

// What the tmux session runs: the release host's Node first on PATH, then
// ~/.local/bin (where `claude` sits for the plugin refresh), the configured
// variables, and the exit code appended to the log.
export function releaseCommand(host, remote, npmArgs, log) {
  const node = host.node?.startsWith('~/') ? `${remote.home}/${host.node.slice(2)}` : host.node;
  const bins = [node && path.posix.dirname(node), `${remote.home}/.local/bin`].filter(Boolean).map(shellQuote);
  const exports = [`PATH=${[...bins, '"$PATH"'].join(':')}`, ...Object.entries(host.env).map(([name, value]) => `${name}=${shellQuote(value)}`)];
  const quotedLog = shellQuote(log);
  return `cd ${shellQuote(remote.checkout)} && export ${exports.join(' ')} && npm ${npmArgs.map(shellQuote).join(' ')} >> ${quotedLog} 2>&1; echo release-exit=$? >> ${quotedLog}`;
}

function parseFacts(stdout) {
  const facts = {};
  for (const line of String(stdout ?? '').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) facts[line.slice(0, at)] = line.slice(at + 1).trim();
  }
  return facts;
}

function sshFailure(host, result) {
  if (result.error) return result.error.message;
  const detail = String(result.stderr ?? '').trim().split('\n').slice(-3).join(' ');
  return result.status === 255 ? `cannot reach ${host.ssh} over SSH${detail ? `: ${detail}` : ''}` : `${host.ssh} check exited ${result.status}${detail ? `: ${detail}` : ''}`;
}

function inspectHost(host, { target, apply, env }) {
  const result = spawnSync('ssh', remoteCheckArgs(host, target, apply), { env, encoding: 'utf8', timeout: 120_000 });
  if (result.error || result.status !== 0) return { failure: sshFailure(host, result) };
  const facts = parseFacts(result.stdout);
  let intent = null;
  if (facts.intent) {
    try { intent = JSON.parse(facts.intent); } catch { intent = { newVersion: 'unknown' }; }
  }
  return { facts, intent };
}

// Refusals that apply to any start on the release host.
function sessionProblems(host, facts) {
  const problems = [];
  if (facts.tmux !== 'running') problems.push(`no tmux server runs on ${host.ssh}; ${KEYCHAIN_NOTE}`);
  if (facts.sessions) problems.push(`a release tmux session already runs on ${host.ssh} (${facts.sessions}); follow it with \`npm run release -- --attach\``);
  if (facts.checkout === 'missing' || !facts.checkout) problems.push(`${host.checkout} is not a checkout on ${host.ssh}`);
  return problems;
}

function git(root, args, env) {
  return spawnSync('git', args, { cwd: root, env, encoding: 'utf8' });
}

function localChecks(root, env) {
  const problems = [];
  const dirty = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], env);
  if (dirty.status !== 0) problems.push(dirty.stderr.trim() || 'cannot inspect the local working tree');
  else if (dirty.stdout) problems.push('the local working tree is dirty; commit or remove changes before releasing');
  const branch = git(root, ['branch', '--show-current'], env).stdout.trim();
  if (branch !== 'main') problems.push(`the local checkout must be on main (current: ${branch || 'detached'})`);
  const fetch = git(root, ['fetch', '--quiet', 'origin', 'main'], env);
  if (fetch.status !== 0) return { problems: [...problems, fetch.stderr.trim() || 'cannot fetch origin/main'], target: null };
  const target = git(root, ['rev-parse', 'FETCH_HEAD'], env).stdout.trim();
  if (git(root, ['merge-base', '--is-ancestor', 'HEAD', target], env).status !== 0) {
    problems.push('local main has commits that are not on origin/main; push them before releasing');
  }
  const version = JSON.parse(git(root, ['show', `${target}:package.json`], env).stdout || '{}').version;
  return { problems, target, version };
}

function syncProblem(host, facts, target) {
  const short = target.slice(0, 7);
  if (facts.sync === 'current' || facts.sync === 'forwarded' || facts.sync === 'would-forward') return null;
  if (facts.sync === 'fetch-failed') return `${host.ssh} cannot fetch origin/main`;
  if (facts.sync === 'missing') return `${host.ssh} fetched origin/main but does not have ${short}; retry`;
  if (facts.sync === 'diverged' || facts.sync === 'ahead') return `the checkout on ${host.ssh} has commits that are not on origin/main ${short}`;
  return `the checkout on ${host.ssh} could not fast-forward to ${short}`;
}

export function followLog(host, log, { env, out, err }) {
  return new Promise(resolve => {
    const child = spawn('ssh', remoteFollowArgs(host, log), { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    let code = null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (code !== null) return;
      buffer += chunk;
      for (let end = buffer.indexOf('\n'); end !== -1 && code === null; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        out.write(`${line}\n`);
        const exit = /^release-exit=(\d+)\s*$/.exec(line);
        if (exit) {
          code = Number(exit[1]);
          child.kill();
        }
      }
    });
    child.stderr.on('data', chunk => err.write(chunk));
    const interrupt = () => child.kill();
    process.on('SIGINT', interrupt);
    let finished = false;
    const finish = status => {
      if (finished) return;
      finished = true;
      process.off('SIGINT', interrupt);
      resolve({ code, status });
    };
    child.on('error', error => {
      err.write(`✗ ${error.message}\n`);
      finish(1);
    });
    child.on('close', finish);
  });
}

function fastForwardLocal(root, env, say) {
  const fetch = git(root, ['fetch', '--quiet', '--tags', 'origin', 'main'], env);
  const merge = fetch.status === 0 ? git(root, ['merge', '--quiet', '--ff-only', 'FETCH_HEAD'], env) : fetch;
  if (merge.status !== 0) {
    say(`✗ the release finished, but this checkout could not fast-forward to origin/main: ${merge.stderr.trim()}`);
    return 1;
  }
  say(`✓ this checkout fast-forwarded to ${git(root, ['log', '-1', '--format=%h %s'], env).stdout.trim()}`);
  return 0;
}

async function startAndFollow(host, remote, npmArgs, log, { root, env, say, out, err }) {
  const command = releaseCommand(host, remote, npmArgs, log);
  const start = spawnSync('ssh', remoteStartArgs(host, log, command), { env, encoding: 'utf8', timeout: 120_000 });
  if (start.error || start.status !== 0) {
    say(`✗ could not start the release on ${host.ssh}: ${sshFailure(host, start)}`);
    return 1;
  }
  say(`→ started \`npm ${npmArgs.join(' ')}\` in tmux session ${RELEASE_SESSION} on ${host.ssh}; log ${log}`);
  return follow(host, log, { root, env, say, out, err });
}

async function follow(host, log, { root, env, say, out, err }) {
  const { code, status } = await followLog(host, log, { env, out, err });
  if (code === null) {
    say(`✗ stopped following ${host.ssh} before release-exit (ssh exited ${status}); a running release keeps going in tmux session ${RELEASE_SESSION} there. Re-follow it with: npm run release -- --attach`);
    return status || 1;
  }
  if (code !== 0) {
    say(`✗ the release on ${host.ssh} exited ${code}; resume it from here with: npm run release:resume`);
    return code;
  }
  return fastForwardLocal(root, env, say);
}

function runHere(command, args, { root, env }) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function hereQualification(root, env, platform, arch) {
  // A host with a remote desktop release command releases here and hands only
  // the Mac app to that command.
  if ((platform !== 'darwin' || arch !== 'arm64') && !remoteDesktopRelease(root, { env, platform, arch })) return 'this host is not an Apple Silicon Mac';
  try {
    preflightDesktopRelease(root, { env, platform, arch });
    return null;
  } catch (error) {
    return error.message;
  }
}

function parseArgs(argv) {
  const options = { bump: 'patch', dryRun: false, attach: false, resume: false };
  for (const arg of argv) {
    if (arg === '--dry-run' || arg === '-n') options.dryRun = true;
    else if (arg === '--attach') options.attach = true;
    else if (arg === '--resume') options.resume = true;
    else if (BUMPS.includes(arg)) options.bump = arg;
    else throw new Error(`usage: npm run release [-- patch|minor|major] [--dry-run] [--attach]; unknown argument ${arg}`);
  }
  return options;
}

export async function runRelease({ argv = [], root = process.cwd(), env = process.env, platform = process.platform, arch = process.arch, out = process.stdout, err = process.stderr } = {}) {
  const say = line => out.write(`${line}\n`);
  const options = parseArgs(argv);
  const { file, host } = readReleaseHost(root, env);
  const io = { root, env, say, out, err };

  if (options.attach) {
    if (!host) throw new Error(`--attach needs releaseHost in ${file}`);
    return follow(host, '', io);
  }

  if (options.resume) {
    if (readReleaseIntent(root) || !host) {
      if (options.dryRun) { say('would run `node scripts/recover-local-release.mjs && bash scripts/postversion.sh` here'); return 0; }
      const recovered = runHere('node', ['scripts/recover-local-release.mjs'], io);
      return recovered === 0 ? runHere('bash', ['scripts/postversion.sh'], io) : recovered;
    }
    // Commits pushed from here since the release began (a fix the resume
    // needs) would make the release host's push a non-fast-forward, so it
    // fast-forwards first. A version commit it has not pushed yet stays ahead.
    const fetch = git(root, ['fetch', '--quiet', 'origin', 'main'], env);
    const target = fetch.status === 0 ? git(root, ['rev-parse', 'FETCH_HEAD'], env).stdout.trim() : '';
    const remote = inspectHost(host, { target, apply: options.dryRun ? false : 'resume', env });
    if (remote.failure) { say(`✗ ${remote.failure}`); return 1; }
    const { facts } = remote;
    const problems = sessionProblems(host, facts);
    if (!remote.intent) problems.push(`no incomplete release on this host or ${host.ssh}; start one with: npm run release`);
    else if (!target) problems.push(fetch.stderr.trim() || 'cannot fetch origin/main');
    else if (facts.sync === 'diverged') problems.push(`the checkout on ${host.ssh} and origin/main ${target.slice(0, 7)} have diverged; merge origin/main there, keeping the release tag, then resume`);
    else if (facts.sync === 'would-forward' && !options.dryRun && !problems.length) problems.push(`the checkout on ${host.ssh} must be clean and on main to fast-forward to origin/main ${target.slice(0, 7)} (dirty=${facts.dirty}, branch=${facts.branch || 'detached'})`);
    else if (facts.sync !== 'ahead') {
      const sync = syncProblem(host, facts, target);
      if (sync) problems.push(sync);
    }
    for (const problem of problems) say(`✗ ${problem}`);
    if (problems.length) return 1;
    const log = `${facts.home}/runlist-release-${remote.intent.newVersion}-resume.log`;
    say(`✓ ${host.ssh} holds incomplete release v${remote.intent.newVersion}`);
    if (facts.sync === 'forwarded' || facts.sync === 'would-forward') say(`${facts.sync === 'forwarded' ? '✓' : '→'} ${host.ssh}: ${facts.checkout} ${facts.sync === 'forwarded' ? 'fast-forwarded' : 'would fast-forward'} to origin/main ${target.slice(0, 7)}`);
    if (options.dryRun) {
      say(`would start on ${host.ssh}: ${releaseCommand(host, facts, ['run', 'release:resume'], log)}`);
      return 0;
    }
    return startAndFollow(host, facts, ['run', 'release:resume'], log, io);
  }

  const unqualified = hereQualification(root, env, platform, arch);
  if (!unqualified) {
    if (options.dryRun) {
      runReleasePreflight(root, { env, platform, arch });
      say(`✓ release preflight passes; would run \`npm version ${options.bump}\` here`);
      return 0;
    }
    return runHere('npm', ['version', options.bump], io);
  }
  if (!host) {
    throw new Error(`releases run on the qualified Apple Silicon Mac (${unqualified}); name that Mac as "releaseHost": { "ssh": "<destination>", "checkout": "<its checkout>", "node": "<its Node executable>" } in ${file}, or release from here with a remote desktop release command as "desktopReleaseCommand": ["<command>", "<args>"]`);
  }

  const local = localChecks(root, env);
  for (const problem of local.problems) say(`✗ ${problem}`);
  if (!local.target || !local.version) return 1;
  if (!local.problems.length) say(`✓ this checkout is clean, on main and contained in origin/main ${local.target.slice(0, 7)}`);
  if (local.problems.length && !options.dryRun) return 1;

  const remote = inspectHost(host, { target: local.target, apply: !options.dryRun, env });
  if (remote.failure) { say(`✗ ${remote.failure}`); return 1; }
  const { facts } = remote;
  const problems = sessionProblems(host, facts);
  if (facts.dirty && facts.dirty !== '0') problems.push(`the checkout on ${host.ssh} has ${facts.dirty} uncommitted path(s)`);
  if (facts.branch !== undefined && facts.branch !== 'main') problems.push(`the checkout on ${host.ssh} must be on main (current: ${facts.branch || 'detached'})`);
  if (remote.intent) problems.push(`${host.ssh} has incomplete release v${remote.intent.newVersion}; finish it with: npm run release:resume`);
  const sync = facts.checkout && facts.checkout !== 'missing' ? syncProblem(host, facts, local.target) : null;
  if (sync) problems.push(sync);
  for (const problem of problems) say(`✗ ${problem}`);
  if (!problems.length) {
    const state = { current: 'already at', forwarded: 'fast-forwarded to', 'would-forward': 'would fast-forward to' }[facts.sync];
    say(`✓ ${host.ssh}: tmux server running, no release session, no incomplete release, ${facts.checkout} clean on main and ${state} ${local.target.slice(0, 7)}`);
  }

  const version = nextVersion(local.version, options.bump);
  const log = `${facts.home}/runlist-release-${version}.log`;
  if (options.dryRun) {
    say(`would start v${version} on ${host.ssh} in tmux session ${RELEASE_SESSION}: ${releaseCommand(host, facts, ['version', options.bump], log)}`);
    say(`then follow ${log} until release-exit= and fast-forward this checkout`);
    return problems.length || local.problems.length ? 1 : 0;
  }
  if (problems.length) return 1;
  return startAndFollow(host, facts, ['version', options.bump], log, io);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  runRelease({ argv: process.argv.slice(2) }).then(code => { process.exitCode = code; }, error => {
    process.stderr.write(`✗ ${error.message}\n`);
    process.exitCode = 1;
  });
}
