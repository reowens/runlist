// Codex's default personal marketplace is discovered without a CLI registration.
// The npm package carries this plugin so installation does not need a Git checkout.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'runlist-codex');
const NAME = 'runlist-codex';
const MARKER = '.runlist-generated.json';

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
  return { ...paths, exists, foreign: exists && !installed, version: installed, stale: Boolean(installed && version && installed !== version) };
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
