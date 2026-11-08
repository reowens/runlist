#!/usr/bin/env node
// Finds every runlist and rl a host's shells can reach and reads each one's
// version. A release installs and checks only the copies it manages, so an
// older copy elsewhere (a pinned link, an npm global under another Node) keeps
// answering in whichever shell finds it first. A copy at another version, or a
// shell that resolves no runlist or rl, keeps the host owed; the report names
// the command that removes each stale copy. Nothing is removed here.
//
//   node scripts/check-cli-copies.mjs <version>                 this host
//   node scripts/check-cli-copies.mjs <version> --host <ssh>    over SSH
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { shellQuote } from '../src/util.mjs';
import { cleanNpmEnv, discoverExecutables, npmManagedPackageForPath } from './sync-global-cli.mjs';

const COMMANDS = ['runlist', 'rl'];
const MARK = '__RUNLIST_PATH__';
const BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const TIMEOUT = 30_000;
const VERSION = /^\d+\.\d+\.\d+(?:[-+].+)?$/;
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function userShell() {
  try { return os.userInfo().shell || null; } catch { return null; }
}

function withDefaults(deps) {
  const d = {
    env: process.env, platform: process.platform, home: os.homedir(), overSsh: false,
    exists: existsSync, readdir: readdirSync, realpath: realpathSync, run: spawnSync, ...deps,
  };
  d.shell ??= d.platform === 'darwin' ? 'zsh' : (userShell() || d.env.SHELL || 'bash');
  return d;
}

const quiet = { encoding: 'utf8', timeout: TIMEOUT, stdio: ['ignore', 'pipe', 'pipe'] };

// The interactive login shell starts from a bare environment, as a new
// terminal does, so only its own profile and rc files build its PATH. They can
// print anything, so only the marked line is read.
export function shellPaths(d) {
  const env = { HOME: d.home, SHELL: d.shell, TERM: 'dumb', PATH: BASE_PATH };
  for (const key of ['USER', 'LOGNAME', 'LANG']) if (d.env[key]) env[key] = d.env[key];
  const result = d.run(d.shell, ['-ilc', `printf '\\n%s%s\\n' ${MARK} "$PATH"`], { ...quiet, env });
  const line = String(result.stdout ?? '').split(/\r?\n/).findLast(text => text.startsWith(MARK));
  const login = { name: `interactive login shell (${path.basename(d.shell)} -ilc)`, path: line === undefined ? null : line.slice(MARK.length) };
  if (login.path === null) {
    login.error = result.error?.code === 'ETIMEDOUT' ? `timed out after ${TIMEOUT / 1000} s`
      : result.error ? result.error.message
      : `exited ${result.status} without printing its PATH`;
  }
  return [login, { name: d.overSsh ? 'non-interactive SSH shell' : 'this process', path: d.env.PATH ?? '' }];
}

function npmGlobal(npm, which, d) {
  const result = d.run(npm, [which, '-g'], { ...quiet, env: cleanNpmEnv(path.dirname(npm), d.env) });
  const out = result.status === 0 ? String(result.stdout ?? '').trim() : '';
  return out ? path.resolve(out) : null;
}

function describeCopy(file, owners, loginPath, d) {
  const owner = owners.get(path.dirname(file));
  const packageName = owner ? npmManagedPackageForPath(file, owner.prefix, owner.root, { realpath: d.realpath }) : null;
  let target = null;
  try { target = d.realpath(file); } catch { /* a dangling link reads no version either */ }
  // `#!/usr/bin/env node`: the copy's own folder first, then the login PATH.
  const env = cleanNpmEnv(path.dirname(file), { ...d.env, PATH: [loginPath, d.env.PATH].filter(Boolean).join(path.delimiter) });
  const result = d.run(file, ['--version'], { ...quiet, env });
  const version = result.status === 0 ? String(result.stdout ?? '').trim().split(/\r?\n/).at(-1) || null : null;
  const remove = packageName ? [owner.npm, 'uninstall', '-g', '--prefix', owner.prefix, packageName] : ['rm', file];
  return {
    path: file,
    target: target && target !== file ? target : null,
    version,
    npm: packageName ? owner.npm : null,
    prefix: packageName ? owner.prefix : null,
    remove: remove.map(shellQuote).join(' '),
  };
}

// Every runlist and rl on each shell's PATH, in each npm global prefix those
// PATHs name, in every Node version under ~/.nvm (on PATH or not), and in
// ~/.local/bin, where a host without an npm global links them.
export function inspectCliCopies(deps = {}) {
  const d = withDefaults(deps);
  const shells = shellPaths(d);
  const searched = shells.filter(shell => shell.path !== null).map(shell => shell.path);
  const found = new Set();
  const look = dir => { for (const file of discoverExecutables(COMMANDS, dir, d.exists)) found.add(file); };
  searched.forEach(look);
  look(path.join(d.home, '.local', 'bin'));

  const npms = new Set(searched.flatMap(dir => discoverExecutables(['npm'], dir, d.exists)));
  const nvm = path.join(d.home, '.nvm', 'versions', 'node');
  let nodes = [];
  try { nodes = [...d.readdir(nvm)].sort(); } catch { /* no nvm */ }
  for (const node of nodes) {
    const bin = path.join(nvm, node, 'bin');
    look(bin);
    if (d.exists(path.join(bin, 'npm'))) npms.add(path.join(bin, 'npm'));
  }

  const owners = new Map();
  for (const npm of npms) {
    const prefix = npmGlobal(npm, 'prefix', d);
    const root = prefix && npmGlobal(npm, 'root', d);
    if (!root) continue;
    const bin = path.join(prefix, 'bin');
    if (!owners.has(bin)) owners.set(bin, { npm, prefix, root });
    look(bin);
  }

  const copies = [...found].map(file => describeCopy(file, owners, shells[0].path, d));
  for (const shell of shells) {
    shell.resolves = Object.fromEntries(COMMANDS.map(name =>
      [name, shell.path === null ? null : discoverExecutables([name], shell.path, d.exists)[0] ?? null]));
  }
  return { shells, copies };
}

export function assessCliCopies({ shells, copies }, version) {
  const stale = copies.filter(copy => copy.version !== version);
  const unreadable = shells.filter(shell => shell.path === null);
  const unresolved = shells
    .filter(shell => shell.path !== null)
    .map(shell => ({ shell: shell.name, missing: COMMANDS.filter(name => !shell.resolves[name]) }))
    .filter(entry => entry.missing.length);
  return { ok: !stale.length && !unreadable.length && !unresolved.length, stale, unreadable, unresolved };
}

export function formatCliCopies({ shells, copies }, assessment, version) {
  const lines = [];
  for (const shell of shells) {
    if (shell.path === null) { lines.push(`  ${shell.name}: could not read its PATH (${shell.error})`); continue; }
    lines.push(`  ${shell.name} runs ${COMMANDS.map(name => `${name} → ${shell.resolves[name] ?? 'none'}`).join(', ')}`);
  }
  for (const copy of copies) {
    const owner = copy.prefix ? `, npm global in ${copy.prefix}` : '';
    lines.push(`  ${copy.path}: ${copy.version ?? 'no version'}${copy.target ? ` (→ ${copy.target}${owner})` : owner ? ` (${owner.slice(2)})` : ''}`);
  }
  if (assessment.ok) {
    lines.push(`✓ all ${copies.length} runlist and rl cop${copies.length === 1 ? 'y' : 'ies'} read ${version}, and each shell runs both`);
    return lines;
  }
  for (const copy of assessment.stale) lines.push(`✗ ${copy.path} reads ${copy.version ?? 'no version'}, not ${version}; remove it with: ${copy.remove}`);
  for (const shell of assessment.unreadable) lines.push(`✗ ${shell.name} could not be read, so what it runs is unknown: ${shell.error}`);
  for (const { shell, missing } of assessment.unresolved) lines.push(`✗ ${shell} resolves no ${missing.join(' or ')}`);
  return lines;
}

export function checkCliCopies(version, deps = {}) {
  const write = deps.write ?? (line => console.log(line));
  const inspection = inspectCliCopies(deps);
  const assessment = assessCliCopies(inspection, version);
  for (const line of formatCliCopies(inspection, assessment, version)) write(line);
  return { ...inspection, ...assessment };
}

// Compared through realpath: over SSH the check runs from a temporary folder
// that can sit behind a symbolic link, as /var does on macOS.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const take = flag => {
    const at = args.indexOf(flag);
    return at < 0 ? undefined : args.splice(at, 2)[1] ?? '';
  };
  const overSsh = args.includes('--ssh');
  if (overSsh) args.splice(args.indexOf('--ssh'), 1);
  const ssh = take('--host');
  const node = take('--node');
  const [version] = args;
  if (args.length !== 1 || !VERSION.test(version) || (ssh !== undefined && (!ssh.trim() || ssh.startsWith('-'))) || node === '') {
    process.stderr.write('usage: node scripts/check-cli-copies.mjs <version> [--host <ssh destination> [--node <remote node>]]\n');
    process.exit(2);
  }
  try {
    if (ssh === undefined) {
      if (!overSsh) console.log(`→ checking every runlist and rl this host's shells can reach against ${version}`);
      process.exitCode = checkCliCopies(version, { overSsh }).ok ? 0 : 1;
    } else {
      // A host listed as cliHosts runs its own named Node.
      const { checkRemoteCliCopies, readCliHosts } = await import('./install-cli-hosts.mjs');
      const listed = readCliHosts(REPO_ROOT).find(host => host.ssh === ssh);
      const host = { ssh, node: node ?? listed?.node ?? 'node' };
      console.log(`→ checking every runlist and rl on ${ssh} against ${version}`);
      const { ok, reason, result } = checkRemoteCliCopies({ host, version });
      if (!ok) {
        const detail = String(result.stderr ?? '').trim().split('\n').slice(-3).join('\n    ');
        console.log(`✗ ${ssh}: ${reason}${detail ? `\n    ${detail}` : ''}`);
      }
      process.exitCode = ok ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write(`✗ ${error.message}\n`);
    process.exitCode = 2;
  }
}
