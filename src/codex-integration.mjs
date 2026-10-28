// Codex's default personal marketplace is discovered without a CLI registration.
// The npm package carries this plugin so installation does not need a Git checkout.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { executableName } from './util.mjs';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'runlist-codex');
const NAME = 'runlist-codex';
const MARKER = '.runlist-generated.json';

// Compare the whole distributed tree, including hook scripts and manifests.
// The ownership marker is metadata, never an asset or proof of source parity.
export function codexAssetFingerprint(root) {
  const hash = createHash('sha256');
  let files = 0, bytes = 0;
  function visit(dir, prefix = '', depth = 0) {
    if (depth > 32) throw new Error('asset depth limit');
    for (const name of readdirSync(dir).sort()) {
      if (!prefix && name === MARKER) continue;
      const relative = prefix ? `${prefix}/${name}` : name;
      const file = path.join(dir, name);
      const stat = lstatSync(file);
      if (++files > 2000 || (bytes += stat.size) > 64 * 1024 * 1024) throw new Error('asset inventory limit');
      const kind = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other';
      hash.update(JSON.stringify([relative, kind, kind === 'file' ? stat.mode & 0o111 : null]) + '\n');
      if (kind === 'dir') visit(file, relative, depth + 1);
      else if (kind === 'link') hash.update(JSON.stringify(readlinkSync(file)) + '\n');
      else if (kind === 'file') hash.update(readFileSync(file));
    }
  }
  try { visit(root); return hash.digest('hex'); } catch { return null; }
}

export function codexAssetParity(installedPath, sourcePath = SOURCE) {
  const expected = codexAssetFingerprint(sourcePath);
  const actual = codexAssetFingerprint(installedPath);
  return { state: !expected || !actual ? 'unknown' : expected === actual ? 'match' : 'mismatch', expected, actual };
}

export function codexPaths(homedir = os.homedir()) {
  const root = path.join(homedir, '.agents', 'plugins');
  // The implicit personal marketplace file lives under ~/.agents/plugins,
  // but Codex resolves its `./plugins/...` sources relative to the home dir.
  return { root, marketplace: path.join(root, 'marketplace.json'), plugin: path.join(homedir, 'plugins', NAME) };
}

function marketplaceAt(file) {
  if (!existsSync(file)) return { name: 'personal', interface: { displayName: 'Personal' }, plugins: [] };
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!data || typeof data.name !== 'string' || !Array.isArray(data.plugins)) {
    throw new Error(`${file} is not a valid personal marketplace`);
  }
  return data;
}

export function codexStatus({ version, homedir = os.homedir() } = {}) {
  const paths = codexPaths(homedir);
  let installed = null;
  try { installed = JSON.parse(readFileSync(path.join(paths.plugin, MARKER), 'utf8')).version; } catch { /* absent or foreign */ }
  const exists = existsSync(paths.plugin);
  const sourceParity = installed ? codexAssetParity(paths.plugin) : { state: 'unknown' };
  let marketplaceState = existsSync(paths.marketplace) ? 'unreadable' : 'missing';
  let marketplaceRegistered = false, foreignRegistration = false;
  try {
    const marketplace = marketplaceAt(paths.marketplace);
    const entry = marketplace.plugins.find(item => item?.name === NAME);
    marketplaceState = existsSync(paths.marketplace) ? 'readable' : 'missing';
    marketplaceRegistered = entry?.source?.source === 'local' && entry.source.path === `./plugins/${NAME}`;
    foreignRegistration = Boolean(entry && !marketplaceRegistered);
  } catch { /* An unreadable registration cannot establish a managed source. */ }
  return { ...paths, exists, foreign: (exists && !installed) || foreignRegistration, version: installed, sourceParity,
    marketplaceState, marketplaceRegistered,
    stale: Boolean(installed && ((version && installed !== version) || sourceParity.state !== 'match' || !marketplaceRegistered)) };
}

// The marketplace source is not the plugin Codex loads. Ask the host about its
// installed copy rather than treating our generated source marker as proof.
export function installedCodexStatus({ homedir = os.homedir(), run = spawnSync, env = process.env, binary, offline = false } = {}) {
  if (offline) return { ok: false, state: 'unknown', loaded: 'unknown', reason: 'offline inventory cannot attest the host installed copy or loaded session' };
  try {
    const marketplace = marketplaceAt(codexPaths(homedir).marketplace).name;
    const pluginId = `${NAME}@${marketplace}`;
    const result = run(binary || executableName('codex'), ['plugin', 'list', '--marketplace', marketplace, '--json'], {
      encoding: 'utf8', shell: process.platform === 'win32' && (!binary || /\.(?:cmd|bat)$/i.test(binary)), timeout: 30_000, env: { ...env, HOME: homedir, USERPROFILE: homedir },
    });
    if (result.status !== 0) return { ok: false, reason: result.error?.message ?? `codex plugin list exited ${result.status ?? '?'}` };
    const installed = JSON.parse(result.stdout).installed;
    if (!Array.isArray(installed)) return { ok: false, reason: 'codex plugin list returned no installed plugin records' };
    const plugin = installed.find(entry => entry.pluginId === pluginId && entry.installed === true);
    if (!plugin?.version) return { ok: false, reason: `${pluginId} is not installed in Codex` };
    // Host versions do not establish byte parity. Inspect a host-provided path
    // when this CLI supports one, otherwise retain the explicit unknown state.
    const installedPath = plugin.installPath ?? plugin.installedPath ?? plugin.pluginPath ?? plugin.path;
    const sourceParity = typeof installedPath === 'string' && path.isAbsolute(installedPath)
      ? codexAssetParity(installedPath, codexPaths(homedir).plugin) : { state: 'unknown' };
    return { ok: sourceParity.state !== 'mismatch', version: plugin.version, pluginId, sourceParity, loaded: 'unknown',
      ...(sourceParity.state === 'mismatch' ? { reason: 'installed Codex plugin assets differ from the managed source' } : {}),
      ...(typeof installedPath === 'string' && path.isAbsolute(installedPath) ? { installedPath } : {}) };
  } catch (err) {
    return { ok: false, reason: `cannot verify installed Codex plugin: ${err.message}` };
  }
}

export function installCodexPlugin({ version, homedir = os.homedir(), dryRun = false } = {}) {
  const sourceVersion = JSON.parse(readFileSync(path.join(SOURCE, '.codex-plugin', 'plugin.json'), 'utf8')).version;
  if (sourceVersion !== version) throw new Error(`Codex plugin source is ${sourceVersion}, CLI is ${version}`);
  const status = codexStatus({ version, homedir });
  if (status.foreign) return { ...status, action: 'refused', reason: 'plugin directory exists without a runlist marker' };
  let market;
  try { market = marketplaceAt(status.marketplace); }
  catch (err) { return { ...status, action: 'refused', reason: err.message }; }
  const expected = `./plugins/${NAME}`;
  const entry = market.plugins.find(p => p.name === NAME);
  if (entry && (entry.source?.source !== 'local' || entry.source?.path !== expected)) {
    return { ...status, action: 'refused', reason: 'marketplace entry points to a different plugin source' };
  }
  if (!entry) market.plugins.push({
    name: NAME, source: { source: 'local', path: expected },
    policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity',
  });
  if (status.exists && !status.stale && entry) return { ...status, action: 'current', marketplaceName: market.name };
  if (dryRun) return { ...status, action: status.exists ? 'updated' : 'installed', marketplaceName: market.name, dryRun: true };

  const parent = path.dirname(status.plugin);
  mkdirSync(parent, { recursive: true });
  mkdirSync(path.dirname(status.marketplace), { recursive: true });
  const stage = mkdtempSync(path.join(parent, '.runlist-codex-stage-'));
  const backup = `${stage}-previous`;
  const marketStage = `${status.marketplace}.runlist-stage-${process.pid}`;
  let movedOld = false;
  let published = false;
  try {
    cpSync(SOURCE, stage, { recursive: true });
    writeFileSync(path.join(stage, MARKER), JSON.stringify({ version }) + '\n');
    writeFileSync(marketStage, JSON.stringify(market, null, 2) + '\n');
    if (status.exists) { renameSync(status.plugin, backup); movedOld = true; }
    renameSync(stage, status.plugin);
    published = true;
    renameSync(marketStage, status.marketplace);
    if (movedOld) rmSync(backup, { recursive: true, force: true });
  } catch (err) {
    if (published) rmSync(status.plugin, { recursive: true, force: true });
    if (movedOld) renameSync(backup, status.plugin);
    rmSync(stage, { recursive: true, force: true });
    rmSync(marketStage, { force: true });
    throw err;
  }
  return { ...codexStatus({ version, homedir }), action: status.exists ? 'updated' : 'installed', marketplaceName: market.name };
}
