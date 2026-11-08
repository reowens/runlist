#!/usr/bin/env node
// Installs a released CLI on the other machines that run it. Each entry of
// `cliHosts` in the private release config names an SSH destination and the
// Runlist checkout there; the host fetches the release tag and runs that
// commit's own `prepare-local-cli.mjs install`, then the installed CLI refreshes
// and verifies the host integrations already installed there (never new ones),
// then every runlist and rl its shells can reach must read the release version
// (`check-cli-copies.mjs`). A host that cannot be reached, refuses or fails either step is reported as
// owed, and the release stays resumable.
// `--this-host` runs the same install on the release host itself.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellQuote } from '../src/util.mjs';
import { installLocalCLI } from './prepare-local-cli.mjs';

const REMOTE_SCRIPT = `set -euo pipefail
checkout=$1 tag=$2 commit=$3 version=$4 node=$5
cd "$checkout"
git fetch --quiet origin "refs/tags/$tag:refs/tags/$tag"
test "$(git rev-parse "$tag^{commit}")" = "$commit" || { echo "$tag does not name $commit in $checkout" >&2; exit 1; }
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
git archive "$commit" scripts/prepare-local-cli.mjs src/durable-rename.mjs | tar -xf - -C "$work"
"$node" -e 'process.stdout.write(JSON.stringify({ repository: process.argv[1], commit: process.argv[2], version: process.argv[3] }))' "$PWD" "$commit" "$version" > "$work/request.json"
"$node" "$work/scripts/prepare-local-cli.mjs" install "$work/request.json"`;

// A non-interactive SSH shell skips the profile that puts ~/.local/bin on PATH,
// where the install just linked runlist and where host CLIs such as codex sit.
const REFRESH_SCRIPT = `const [entry, version] = process.argv.slice(1);
const { pathToFileURL } = await import('node:url');
const { homedir } = await import('node:os');
const { delimiter, join } = await import('node:path');
process.env.PATH = [join(homedir(), '.local', 'bin'), process.env.PATH].filter(Boolean).join(delimiter);
const { updateInstalledHosts } = await import(new URL('../src/update.mjs', pathToFileURL(entry)));
await updateInstalledHosts(version);`;

// The copy check runs these files from this tree, so a host whose own checkout
// predates the check runs this version of it.
export const SHIPPED_FILES = ['scripts/check-cli-copies.mjs', 'scripts/sync-global-cli.mjs', 'src/util.mjs', 'src/color.mjs'];

const COPIES_SCRIPT = `set -euo pipefail
node=$1 version=$2
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar -xf - -C "$work"
"$node" "$work/scripts/check-cli-copies.mjs" --ssh "$version"`;

export function readCliHosts(root, env = process.env) {
  const file = env.RUNLIST_RELEASE_CONFIG || path.join(root, '.runlist', 'release-config.json');
  if (!existsSync(file)) return [];
  const hosts = JSON.parse(readFileSync(file, 'utf8')).cliHosts ?? [];
  if (!Array.isArray(hosts)) throw new Error(`cliHosts in ${file} must be a list`);
  return hosts.map((host, i) => {
    if (typeof host?.ssh !== 'string' || !host.ssh.trim() || host.ssh.startsWith('-')) throw new Error(`cliHosts[${i}] needs an ssh destination`);
    if (typeof host.checkout !== 'string' || !path.posix.isAbsolute(host.checkout)) throw new Error(`cliHosts[${i}] needs the absolute path of its Runlist checkout`);
    if (host.node !== undefined && (typeof host.node !== 'string' || !host.node.trim())) throw new Error(`cliHosts[${i}].node must name a Node executable`);
    return { ssh: host.ssh, checkout: host.checkout, node: host.node ?? 'node' };
  });
}

export function remoteInstallArgs(host, version, commit) {
  const command = ['bash', '-c', REMOTE_SCRIPT, 'runlist-install', host.checkout, `v${version}`, commit, version, host.node]
    .map(shellQuote).join(' ');
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host.ssh, command];
}

export function remoteRefreshArgs(host, version, entry) {
  const command = [host.node, '--input-type=module', '-e', REFRESH_SCRIPT, entry, version].map(shellQuote).join(' ');
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host.ssh, command];
}

export function remoteCheckArgs(host, version) {
  const command = ['bash', '-c', COPIES_SCRIPT, 'runlist-check', host.node, version].map(shellQuote).join(' ');
  return ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host.ssh, command];
}

// The host's own report is relayed line by line; exit 1 there means owed.
export function checkRemoteCliCopies({ host, version, root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), run = spawnSync, log = console.log }) {
  const bundle = run('tar', ['-cf', '-', '-C', root, ...SHIPPED_FILES], { env: { ...process.env, COPYFILE_DISABLE: '1' }, maxBuffer: 32 * 1024 ** 2 });
  if (bundle.error || bundle.status !== 0) {
    return { ok: false, result: bundle, reason: `could not pack the copy check (${bundle.error?.message ?? `tar exited ${bundle.status}`})` };
  }
  const result = run('ssh', remoteCheckArgs(host, version), { input: bundle.stdout, encoding: 'utf8', timeout: 300_000, maxBuffer: 8 * 1024 ** 2 });
  for (const line of String(result.stdout ?? '').trimEnd().split('\n').filter(Boolean)) log(`  ${line}`);
  if (!result.error && result.status === 0) return { ok: true, result };
  return {
    ok: false,
    result,
    reason: result.error ? result.error.message
      : result.status === 255 ? 'unreachable over SSH'
      : result.status === 1 ? 'a runlist or rl copy reads another version, or a shell runs none'
      : `copy check exited ${result.status}`,
  };
}

export function installCliHosts({ root, version, commit, env = process.env, run = spawnSync, log = console.log, checkCopies = checkRemoteCliCopies }) {
  if (!/^\d+\.\d+\.\d+/.test(version ?? '') || !/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('usage: install-cli-hosts.mjs <version> <commit>');
  const hosts = readCliHosts(root, env);
  if (!hosts.length) {
    log('→ no other CLI hosts listed (cliHosts in the release config)');
    return { owed: [] };
  }
  const owed = [];
  for (const host of hosts) {
    log(`→ installing runlist ${version} on ${host.ssh}`);
    const result = run('ssh', remoteInstallArgs(host, version, commit), { encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 ** 2 });
    let installed = null;
    try { installed = JSON.parse(result.stdout); } catch { /* reported below */ }
    if (!result.error && result.status === 0 && Array.isArray(installed?.links) && installed.links.length) {
      logLinks(installed, log);
      log(`→ refreshing and verifying installed host integrations on ${host.ssh}`);
      const refresh = run('ssh', remoteRefreshArgs(host, version, installed.entry ?? installed.links[0].entry), { encoding: 'utf8', timeout: 600_000, maxBuffer: 8 * 1024 ** 2 });
      for (const line of String(refresh.stdout ?? '').trimEnd().split('\n').filter(Boolean)) log(`  ${line}`);
      if (!refresh.error && refresh.status === 0) {
        log(`→ checking every runlist and rl on ${host.ssh}`);
        const copies = checkCopies({ host, version, run, log });
        if (copies.ok) continue;
        owe(host, copies.result ?? {}, copies.reason);
        continue;
      }
      owe(host, refresh, refresh.error ? refresh.error.message
        : refresh.status === 255 ? 'unreachable over SSH'
        : `host integration refresh exited ${refresh.status}`);
      continue;
    }
    owe(host, result, result.error ? result.error.message
      : result.status === 0 ? 'install reported no selected links'
      : result.status === 255 ? 'unreachable over SSH'
      : `install exited ${result.status}`);
  }
  function owe(host, result, reason) {
    const detail = String(result.stderr ?? '').trim().split('\n').slice(-3).join('\n    ');
    owed.push({ host: host.ssh, reason });
    log(`✗ runlist ${version} is still owed on ${host.ssh}: ${reason}${detail ? `\n    ${detail}` : ''}`);
  }
  if (owed.length) log(`✗ ${owed.length} CLI host(s) still owe ${version}; once they are reachable, finish with: npm run release:resume`);
  return { owed };
}

function logLinks(installed, log) {
  for (const link of installed.links ?? []) log(`  ${link.link} → ${link.entry}${link.changed ? '' : ' (already selected)'}`);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    const thisHost = process.argv[2] === '--this-host';
    const [version, commit] = process.argv.slice(thisHost ? 3 : 2);
    if (thisHost) {
      logLinks(installLocalCLI({ repository: process.cwd(), commit, version }), console.log);
    } else {
      const { owed } = installCliHosts({ root: process.cwd(), version, commit });
      process.exitCode = owed.length ? 1 : 0;
    }
  } catch (error) {
    process.stderr.write(`✗ ${error.message}\n`);
    process.exitCode = 1;
  }
}
