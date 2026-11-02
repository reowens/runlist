// Codex's default personal marketplace is discovered without a CLI registration.
// The npm package carries this plugin so installation does not need a Git checkout.
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { commitRename } from './durable-rename.mjs';
import { executableName } from './util.mjs';

const SOURCE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'runlist-codex');
const NAME = 'runlist-codex';
const MARKER = '.runlist-generated.json';

// Codex keeps trust for a plugin hook against the plugin's whole contents, so
// every plugin update turned these hooks off until someone re-trusted them. A
// hook in the user's hooks.json is trusted against its own definition alone, so
// these live there and call scripts at a path that updates keep in place.
//
// Changing a command or matcher here makes every user review the hook again.
// Change the scripts instead unless that review is the point. A changed timeout
// reaches new installs only: an existing hook keeps the value it has, because
// Codex counts a timeout as part of the definition, and a user may have tuned it.
const HOOKS = {
  UserPromptSubmit: { run: 'node', script: 'consume-prompt.mjs', timeout: 15 },
  SessionStart: { matcher: 'startup|resume|clear|compact', run: 'sh', script: 'runlist-hook', args: ' --hint hud', timeout: 5 },
  SubagentStart: { matcher: '*', run: 'node', script: 'subagent-start.mjs', timeout: 5 },
  PreToolUse: { matcher: 'Bash|apply_patch|mcp__.*__(read_file|read_text_file|read_media_file|read_multiple_files)', run: 'sh', script: 'runlist-hook', args: ' guard', timeout: 5 },
};

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

export function codexHomeDir(homedir, env) {
  return env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(homedir, '.codex');
}

// A caller naming another home with no env of its own stays self-contained. One
// that passes env gets Codex's own rule, so every reader here agrees on the file.
export function codexPaths(homedir = os.homedir(), env = homedir === os.homedir() ? process.env : {}) {
  const root = path.join(homedir, '.agents', 'plugins');
  // The implicit personal marketplace file lives under ~/.agents/plugins,
  // but Codex resolves its `./plugins/...` sources relative to the home dir.
  return { root, marketplace: path.join(root, 'marketplace.json'), plugin: path.join(homedir, 'plugins', NAME), hooksFile: path.join(codexHomeDir(homedir, env), 'hooks.json') };
}

function shellPath(file) {
  const portable = file.split(path.sep).join('/');
  return process.platform === 'win32' ? portable : portable.replace(/[\\"$`]/g, '\\$&');
}

export function codexHookDefinitions(pluginRoot) {
  const root = shellPath(pluginRoot);
  return Object.fromEntries(Object.entries(HOOKS).map(([event, { matcher, run, script, args = '', timeout }]) => [event, {
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command: `${run} "${root}/bin/${script}"${args}`, timeout }],
  }]));
}

// A hook is ours only when the whole command is one we would write for this
// plugin folder. A wrapper around our script, or a copy in someone's checkout, is
// the user's own and is left alone.
function ourHookTest(pluginRoot) {
  const root = shellPath(pluginRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^(?:node|sh) "${root}/bin/[^"]*"(?: [\\w -]*)?$`);
  return hook => typeof hook?.command === 'string' && pattern.test(hook.command);
}

// Codex names a user hook by its event and position, and keeps trust under that
// name: a hook that changes position reads `modified` and stops running. So no
// path here moves someone else's hook. New hooks go last, ours are updated where
// they are, and a doubled one is dropped only when nothing of theirs follows it.
export function mergeCodexHooks(data, pluginRoot) {
  const hooks = { ...(data.hooks ?? {}) };
  const isOurs = ourHookTest(pluginRoot);
  let changed = false, present = false;
  const doubled = [];
  for (const [event, wanted] of Object.entries(codexHookDefinitions(pluginRoot))) {
    const groups = hooks[event] ?? [];
    if (!Array.isArray(groups)) throw new Error(`hooks.${event} is not a list`);
    const [want] = wanted.hooks;
    let count = 0;
    const next = groups.map(group => {
      const list = Array.isArray(group?.hooks) ? group.hooks : [];
      if (!list.some(isOurs)) return group;
      present = true;
      count += list.filter(isOurs).length;
      const updated = list.map(hook => !isOurs(hook) || hook.command === want.command ? hook : { ...hook, ...want });
      // A shared group's matcher also decides when the user's hook runs.
      const matcherStale = list.every(isOurs) && group.matcher !== wanted.matcher;
      if (!matcherStale && updated.every((hook, i) => hook === list[i])) return group;
      changed = true;
      const { matcher: _old, ...rest } = group;
      return matcherStale ? { ...rest, ...(wanted.matcher ? { matcher: wanted.matcher } : {}), hooks: updated } : { ...group, hooks: updated };
    });
    while (count > 1 && next.at(-1)?.hooks?.length === 1 && isOurs(next.at(-1).hooks[0])) { next.pop(); count--; changed = true; }
    if (count > 1) doubled.push(event);
    if (!count) { next.push(wanted); changed = true; }
    hooks[event] = next;
  }
  return { data: { ...data, hooks }, changed, present, doubled };
}

function readCodexHooks(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // Writing here would replace the link, and a dotfile manager with it.
    if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('it is a link to a file that does not exist');
    return {};
  }
  const data = JSON.parse(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('not a JSON object');
  if (data.hooks !== undefined && (!data.hooks || typeof data.hooks !== 'object' || Array.isArray(data.hooks))) throw new Error('hooks is not an object');
  return data;
}

export function codexHooksStatus({ hooksFile, pluginRoot }) {
  try {
    const { changed, present, doubled } = mergeCodexHooks(readCodexHooks(hooksFile), pluginRoot);
    return { path: hooksFile, state: !changed ? 'current' : present ? 'stale' : 'missing',
      ...(doubled.length ? { reason: `runlist's hook appears more than once in ${doubled.join(', ')}, and removing it here would move your hooks; remove the extra one by hand` } : {}) };
  } catch (err) {
    return { path: hooksFile, state: 'unreadable', reason: err.message };
  }
}

function writeHooksFile(hooksFile, data) {
  // Follow a linked file (a managed dotfile, say) rather than replace the link.
  const target = existsSync(hooksFile) ? realpathSync(hooksFile) : hooksFile;
  mkdirSync(path.dirname(target), { recursive: true });
  const stage = `${target}.runlist-stage-${process.pid}`;
  try {
    writeFileSync(stage, JSON.stringify(data, null, 2) + '\n', { mode: existsSync(target) ? statSync(target).mode & 0o777 : 0o600 });
    commitRename(stage, target);
  } finally {
    rmSync(stage, { force: true });
  }
}

// The plugin is already published by the time this runs, and a hooks file that
// cannot be written must not undo that. The caller reports it and fails the step.
function addCodexHooks(hooksFile, pluginRoot) {
  try {
    const { data, changed } = mergeCodexHooks(readCodexHooks(hooksFile), pluginRoot);
    if (changed) writeHooksFile(hooksFile, data);
    return {};
  } catch (err) {
    return { hooksError: `could not write ${hooksFile}: ${err.message}` };
  }
}

// Removing the plugin no longer removes the hooks, so this is how they come out.
// Hooks after ours do change position here, which cannot be avoided, so the count
// is returned for the caller to tell the user they need reviewing.
export function removeCodexHooks({ homedir = os.homedir(), env, dryRun = false } = {}) {
  const paths = codexPaths(homedir, env);
  const data = readCodexHooks(paths.hooksFile);
  const isOurs = ourHookTest(paths.plugin);
  let removed = 0, moved = 0;
  const hooks = { ...(data.hooks ?? {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const next = [];
    let groupDropped = false, removedHere = false;
    for (const group of groups) {
      const list = Array.isArray(group?.hooks) ? group.hooks : [];
      let oursBefore = false;
      for (const hook of list) {
        if (isOurs(hook)) { removed++; removedHere = true; oursBefore = true; }
        else if (oursBefore || groupDropped) moved++;
      }
      if (!oursBefore) { next.push(group); continue; }
      const kept = list.filter(hook => !isOurs(hook));
      if (kept.length) next.push({ ...group, hooks: kept });
      else groupDropped = true;
    }
    if (!removedHere) continue;
    if (next.length) hooks[event] = next;
    else delete hooks[event];
  }
  if (removed && !dryRun) writeHooksFile(paths.hooksFile, { ...data, hooks });
  let marketplaceName = 'personal';
  try { marketplaceName = marketplaceAt(paths.marketplace).name; } catch { /* the name only completes a printed command */ }
  return { hooksFile: paths.hooksFile, removed, moved, marketplaceName, ...(dryRun ? { dryRun: true } : {}) };
}

function marketplaceAt(file) {
  if (!existsSync(file)) return { name: 'personal', interface: { displayName: 'Personal' }, plugins: [] };
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!data || typeof data.name !== 'string' || !Array.isArray(data.plugins)) {
    throw new Error(`${file} is not a valid personal marketplace`);
  }
  return data;
}

export function codexStatus({ version, homedir = os.homedir(), env } = {}) {
  const paths = codexPaths(homedir, env);
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
  const pluginStale = Boolean(installed && ((version && installed !== version) || sourceParity.state !== 'match' || !marketplaceRegistered));
  const hooks = codexHooksStatus({ hooksFile: paths.hooksFile, pluginRoot: paths.plugin });
  return { ...paths, exists, foreign: (exists && !installed) || foreignRegistration, version: installed, sourceParity,
    marketplaceState, marketplaceRegistered, hooks, pluginStale,
    stale: pluginStale || Boolean(installed && hooks.state !== 'current') };
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

export function installCodexPlugin({ version, homedir = os.homedir(), env, dryRun = false } = {}) {
  const sourceVersion = JSON.parse(readFileSync(path.join(SOURCE, '.codex-plugin', 'plugin.json'), 'utf8')).version;
  if (sourceVersion !== version) throw new Error(`Codex plugin source is ${sourceVersion}, CLI is ${version}`);
  const status = codexStatus({ version, homedir, env });
  if (status.foreign) return { ...status, action: 'refused', reason: 'plugin directory exists without a runlist marker' };
  let market;
  try { market = marketplaceAt(status.marketplace); }
  catch (err) { return { ...status, action: 'refused', reason: err.message }; }
  if (status.hooks.state === 'unreadable') {
    return { ...status, action: 'refused', reason: `cannot add hooks to ${status.hooksFile}: ${status.hooks.reason}` };
  }
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
  const hooksChanged = status.hooks.state !== 'current';
  if (dryRun) return { ...status, action: status.exists ? 'updated' : 'installed', marketplaceName: market.name, hooksChanged, dryRun: true };
  if (status.exists && !status.pluginStale && entry) {
    const hooksResult = addCodexHooks(status.hooksFile, status.plugin);
    return { ...codexStatus({ version, homedir, env }), ...hooksResult, action: 'updated', marketplaceName: market.name, hooksChanged };
  }

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
  const hooksResult = addCodexHooks(status.hooksFile, status.plugin);
  return { ...codexStatus({ version, homedir, env }), ...hooksResult, action: status.exists ? 'updated' : 'installed', marketplaceName: market.name, hooksChanged };
}
