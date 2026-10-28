// Offline host inventory. No host executable is invoked, and settings readers
// intentionally retain only enabledPlugins (never environment or prompt data).
import { createHash } from 'node:crypto';
import { accessSync, constants, closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN_FILES = ['skills', 'commands', 'hooks', 'hooks.json', 'bin', '.claude-plugin', '.codex-plugin'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const real = file => { try { return realpathSync(file); } catch { return path.resolve(file); } };
function readJson(file) {
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return { state: 'unreadable', data: null };
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return object(data) ? { state: 'readable', data } : { state: 'unreadable', data: null };
  } catch (error) { return { state: error.code === 'ENOENT' ? 'missing' : 'unreadable', data: null }; }
}

// Engine hashes exclude private documents and release labels. Callers can pass
// PLUGIN_FILES to include both hook layouts and the plugin manifests.
export function sourceFingerprint(root, entries = ['package.json', 'src', 'bin', 'assets', 'desktop/helper.mjs', 'desktop/trust.mjs', 'desktop/line-framer.mjs']) {
  try {
    const files = [], hash = createHash('sha256'); let bytes = 0;
    const visit = (name, depth = 0) => {
      if (depth > 32 || files.length >= 2000) throw new Error('limit');
      const file = path.join(root, name), stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('symlink');
      if (stat.isDirectory()) for (const child of readdirSync(file).sort()) visit(`${name}/${child}`, depth + 1);
      else if (stat.isFile()) {
        bytes += stat.size; if (bytes > 64 * 1024 * 1024) throw new Error('limit');
        let content = readFileSync(file);
        if (name === 'package.json') { const pkg = JSON.parse(content); delete pkg.version; content = Buffer.from(JSON.stringify(pkg)); }
        hash.update(name + '\0').update(createHash('sha256').update(content).digest()); files.push(name);
      }
    };
    for (const name of [...entries].sort()) if (existsSync(path.join(root, name))) visit(name);
    return files.length ? { state: 'readable', sha256: hash.digest('hex'), files: files.length } : { state: 'unavailable' };
  } catch { return { state: 'unreadable' }; }
}
export const pluginFingerprint = root => root ? sourceFingerprint(root, PLUGIN_FILES) : { state: 'unavailable' };
const same = (a, b) => a?.sha256 && b?.sha256 ? a.sha256 === b.sha256 : null;
const safeEntry = entry => Object.fromEntries(['scope', 'projectPath', 'installPath', 'version'].filter(key => typeof entry?.[key] === 'string').map(key => [key, entry[key]]));
const pluginId = id => /^(?:runlist|dotmd)@/.test(id);
const profilePriority = source => ['home', 'default', 'environment', 'explicit'].indexOf(source);
const profileSource = sources => [...sources].sort((a, b) => profilePriority(b) - profilePriority(a))[0];

function enabledAt(configDir) {
  const { state, data } = readJson(path.join(configDir, 'settings.json'));
  return { configDir, state, enabledPlugins: object(data?.enabledPlugins)
    ? Object.fromEntries(Object.entries(data.enabledPlugins).filter(([id, enabled]) => pluginId(id) && typeof enabled === 'boolean')) : {} };
}

/** Bounded profile discovery, deduplicated by physical plugin store. Aliases
 * retain independent settings because a shared store does not imply activation. */
export function discoverClaudeProfiles({ home = os.homedir(), env = process.env, configDirs = [] } = {}) {
  home = path.resolve(home);
  const choices = new Map();
  const add = (dir, source) => { if (typeof dir !== 'string' || !dir.trim()) return;
    dir = path.resolve(dir); if (!choices.has(dir)) choices.set(dir, []); choices.get(dir).push(source); };
  add(path.join(home, '.claude'), 'default');
  add(env.CLAUDE_CONFIG_DIR, 'environment');
  try { for (const entry of readdirSync(home, { withFileTypes: true }))
    if (/^\.claude-.+/.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink())) add(path.join(home, entry.name), 'home'); } catch {}
  for (const dir of configDirs) { if (!path.isAbsolute(dir)) throw new Error('Claude config directories must be absolute'); add(dir, 'explicit'); }
  const stores = new Map();
  for (const [configDir, sources] of choices) {
    const pluginsDir = path.join(configDir, 'plugins'), storeKey = real(pluginsDir);
    if (stores.has(storeKey)) {
      const profile = stores.get(storeKey); profile.configDirs.push(configDir); profile.settings.push(enabledAt(configDir));
      profile.sources.push(...sources);
      const source = profileSource(sources);
      if (profilePriority(source) > profilePriority(profile.source)) Object.assign(profile, {
        configDir, pluginsDir, source, registryPath: path.join(pluginsDir, 'installed_plugins.json'),
        knownMarketplacesPath: path.join(pluginsDir, 'known_marketplaces.json'),
      });
      continue;
    }
    const registryPath = path.join(pluginsDir, 'installed_plugins.json'), registry = readJson(registryPath);
    if (registry.state === 'readable' && !object(registry.data.plugins)) registry.state = 'unreadable';
    const knownMarketplacesPath = path.join(pluginsDir, 'known_marketplaces.json'), known = readJson(knownMarketplacesPath);
    const plugins = Object.entries(object(registry.data?.plugins) ? registry.data.plugins : {}).filter(([id]) => pluginId(id)).map(([id, records]) => {
      const marketplace = id.split('@')[1] || null;
      return { id, entries: (Array.isArray(records) ? records : [records]).filter(object).map(safeEntry), marketplace,
        marketplaceRegistered: known.state === 'unreadable' ? null : Boolean(known.data?.[marketplace]) };
    });
    const preferred = plugins.find(p => p.id === 'runlist@runlist') ?? plugins.find(p => p.id === 'dotmd@dotmd') ?? plugins[0] ?? null;
    stores.set(storeKey, { configDir, configDirs: [configDir], pluginsDir, storeKey, registryPath, registryState: registry.state,
      knownMarketplacesPath, knownMarketplacesState: known.state, source: profileSource(sources), sources: [...sources],
      installed: preferred ? { ...preferred, version: preferred.entries[0]?.version ?? null } : null,
      plugins, settings: [enabledAt(configDir)] });
  }
  return [...stores.values()];
}

function executableCandidate(file, source, platform) {
  try {
    const stat = statSync(file); if (!stat.isFile()) return null;
    if (platform !== 'win32') accessSync(file, constants.X_OK);
    const buffer = Buffer.alloc(512); let fd;
    try { fd = openSync(file, 'r'); readSync(fd, buffer, 0, buffer.length, 0); } finally { if (fd !== undefined) closeSync(fd); }
    const magic = buffer.subarray(0, 4).toString('hex');
    const native = ['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca'].includes(magic) || buffer.subarray(0, 2).toString() === 'MZ';
    const symlink = lstatSync(file).isSymbolicLink();
    return { path: path.resolve(file), resolvedPath: real(file), kind: native ? (symlink ? 'native-symlink' : 'native') : (symlink ? 'script-symlink' : 'wrapper'), source,
      provenance: { state: 'unknown', reason: 'filesystem executable inventory does not attest package origin or version' } };
  } catch { return null; }
}

/** PATH order is retained; known native Claude and explicit paths stay visible.
 * No attempt is made to infer a wrapper's profile by reading its script body. */
export function discoverHostExecutables({ home = os.homedir(), env = process.env, claudeBin, platform = process.platform } = {}) {
  const result = {}, delimiter = platform === 'win32' ? ';' : path.delimiter;
  for (const host of ['claude', 'codex', 'opencode']) {
    const candidates = [], seen = new Set();
    const add = (file, source) => { const candidate = executableCandidate(file, source, platform);
      if (candidate && !seen.has(candidate.path)) { seen.add(candidate.path); candidates.push(candidate); } };
    if (host === 'claude' && claudeBin) add(claudeBin, 'explicit');
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean))
      for (const suffix of platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']) add(path.resolve(dir, host + suffix), 'PATH');
    if (host === 'claude') add(path.join(home, '.local', 'bin', 'claude'), 'native-location');
    const selected = host === 'claude' && claudeBin ? candidates.find(c => c.path === path.resolve(claudeBin)) ?? null
      : candidates.find(c => c.source === 'PATH') ?? candidates[0] ?? null;
    result[host] = { selected, candidates, explicit: host === 'claude' && Boolean(claudeBin),
      selectionState: selected ? 'selected' : claudeBin && host === 'claude' ? 'unavailable' : 'missing', profileMapping: 'unknown' };
  }
  return result;
}

function officialCatalog(profile, plugin) {
  const known = readJson(profile.knownMarketplacesPath), market = known.data?.[plugin.marketplace];
  const source = market?.source;
  const official = plugin.marketplace === 'runlist' && ((source?.source === 'github' && source.repo === 'reowens/runlist')
    || (source?.source === 'git' && /^https:\/\/github\.com\/reowens\/runlist(?:\.git)?\/?$/.test(source.url ?? '')));
  const location = typeof market?.installLocation === 'string' && path.isAbsolute(market.installLocation) ? market.installLocation : null;
  const catalog = location ? readJson(path.join(location, '.claude-plugin', 'marketplace.json')) : { state: 'missing' };
  const item = official && catalog.data?.name === 'runlist' && Array.isArray(catalog.data.plugins)
    ? catalog.data.plugins.find(p => p?.name === plugin.id.split('@')[0]) : null;
  let pluginPath = null;
  if (typeof item?.source === 'string' && !path.isAbsolute(item.source)) {
    const candidate = path.resolve(location, item.source), relative = path.relative(real(location), real(candidate));
    if (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) pluginPath = candidate;
  }
  const fingerprint = pluginFingerprint(pluginPath);
  return { state: !official ? 'unknown' : pluginPath ? fingerprint.state === 'readable' ? 'available' : fingerprint.state === 'unreadable' ? 'unreadable' : 'missing'
    : catalog.state === 'unreadable' ? 'unreadable' : 'unknown',
    provenance: official ? 'official' : object(source) ? 'foreign' : 'unknown',
    official, marketplace: plugin.marketplace, path: pluginPath, fingerprint,
    version: pluginPath ? readJson(path.join(pluginPath, '.claude-plugin', 'plugin.json')).data?.version ?? item?.version ?? null : null };
}

function claudeReport(profiles, executables, root) {
  const candidate = pluginFingerprint(path.join(root, 'plugins', 'runlist'));
  const reported = profiles.map(profile => {
    const plugins = profile.plugins.map(plugin => {
      const catalog = officialCatalog(profile, plugin);
      const entries = plugin.entries.map(entry => {
        const absolute = typeof entry.installPath === 'string' && path.isAbsolute(entry.installPath);
        const fingerprint = pluginFingerprint(absolute ? entry.installPath : null), sameSource = same(fingerprint, catalog.fingerprint);
        return { ...entry, fingerprint, sameSource, sameCandidate: same(fingerprint, candidate),
          state: !absolute ? 'unknown' : !existsSync(entry.installPath) ? 'missing' : sameSource === false ? 'stale' : sameSource === true ? 'current' : 'unknown' };
      });
      return { ...plugin, catalog, expectedVersion: catalog.version, entries, state: catalog.provenance === 'foreign' ? 'foreign' : plugin.marketplaceRegistered === false ? 'stale'
        : entries.some(e => e.state === 'missing' || e.state === 'stale') ? 'stale' : entries.length && entries.every(e => e.state === 'current') ? 'current' : 'unknown' };
    });
    const state = profile.registryState === 'unreadable' ? 'unknown' : plugins.some(p => p.state === 'foreign') ? 'foreign' : !plugins.length ? 'missing'
      : plugins.some(p => p.state === 'stale') ? 'stale' : plugins.every(p => p.state === 'current') ? 'current' : 'unknown';
    // A native binary paired explicitly with a profile is safe to target. PATH
    // wrappers can silently override CLAUDE_CONFIG_DIR and are never inferred.
    const native = executables.selected?.kind.startsWith('native');
    const unreadableSettings = profile.settings.some(settings => settings.configDir === profile.configDir && settings.state === 'unreadable');
    const nativeTargets = new Set(executables.candidates.filter(c => c.kind.startsWith('native')).map(c => c.resolvedPath));
    const targetable = Boolean(native && state !== 'foreign' && profile.registryState !== 'unreadable'
      && profile.knownMarketplacesState !== 'unreadable' && !unreadableSettings && (executables.explicit || nativeTargets.size === 1));
    const reason = state === 'foreign' ? 'preserve plugin records from a foreign marketplace'
      : profile.registryState === 'unreadable' || profile.knownMarketplacesState === 'unreadable' || unreadableSettings ? 'registry, marketplace or settings data is unreadable; do not replace unknown records'
        : !targetable ? 'select a native --claude-bin and absolute --claude-config; wrapper or binary profile mapping is unknown'
          : 'explicit profile environment required';
    const saved = profile.settings.flatMap(settings => Object.values(settings.enabledPlugins));
    const savedEnablement = saved.includes(true) && saved.includes(false) ? 'mixed' : saved.includes(false) ? 'disabled' : saved.includes(true) ? 'enabled' : 'unknown';
    return { ...profile, plugins, state, savedEnablement, loaded: 'unknown', repair: { host: 'claude', configDir: profile.configDir, storeKey: profile.storeKey,
      executable: executables.selected?.path ?? null, action: state === 'missing' ? 'install' : 'refresh', targetable,
      reason } };
  });
  return { state: reported.some(p => p.state === 'foreign') ? 'foreign' : reported.some(p => p.state === 'stale') ? 'stale'
    : reported.every(p => p.state === 'missing') ? 'missing' : reported.every(p => p.state === 'current') ? 'current' : 'unknown',
    executables, profiles: reported, candidate: { path: path.join(root, 'plugins', 'runlist'), fingerprint: candidate }, loaded: 'unknown',
    requirements: ['Reload plugins or restart Claude Code after repair.', 'Review enabledPlugins and host trust; registry records do not attest activation.'] };
}

function codexReport(home, env, root, executables) {
  const marketplacePath = path.join(home, '.agents/plugins/marketplace.json'), marketplace = readJson(marketplacePath);
  if (marketplace.state === 'readable' && (typeof marketplace.data.name !== 'string' || !Array.isArray(marketplace.data.plugins))) marketplace.state = 'unreadable';
  const item = Array.isArray(marketplace.data?.plugins) ? marketplace.data.plugins.find(p => p?.name === 'runlist-codex') : null;
  const expectedPath = path.join(home, 'plugins/runlist-codex');
  const sourcePath = item?.source?.source === 'local' && typeof item.source.path === 'string' ? path.resolve(home, item.source.path) : expectedPath;
  const marker = readJson(path.join(sourcePath, '.runlist-generated.json')), fingerprint = pluginFingerprint(sourcePath);
  const candidate = pluginFingerprint(path.join(root, 'plugins/runlist-codex'));
  const foreign = existsSync(sourcePath) && (marker.state !== 'readable' || typeof marker.data?.version !== 'string');
  const registered = Boolean(item), expectedSource = item?.source?.source === 'local' && sourcePath === expectedPath;
  const sourceState = !existsSync(sourcePath) ? 'missing' : foreign || registered && !expectedSource ? 'foreign'
    : marketplace.state === 'unreadable' ? 'unknown' : !registered || same(fingerprint, candidate) === false ? 'stale'
      : same(fingerprint, candidate) === true ? 'current' : 'unknown';
  const codexHome = env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  const cacheRoot = path.join(codexHome, 'plugins/cache'), cached = [];
  try { for (const market of readdirSync(cacheRoot).slice(0, 100)) {
    const pluginRoot = path.join(cacheRoot, market, 'runlist-codex');
    try { for (const version of readdirSync(pluginRoot).slice(0, 100)) {
      const file = path.join(pluginRoot, version), fp = pluginFingerprint(file);
      const sameSource = same(fp, fingerprint);
      cached.push({ path: file, version, marketplace: market, role: 'cached copy; not an installed or loaded attestation', fingerprint: fp,
        state: sameSource === true ? 'current' : sameSource === false ? 'stale' : 'unknown', sameSource, sameCandidate: same(fp, candidate) });
    } } catch {}
  } } catch {}
  return { state: sourceState, stateBasis: 'managed marketplace source relative to the selected candidate; installed and loaded states remain unknown', executables, configDir: codexHome, cacheRoot,
    marketplace: { path: marketplacePath, state: marketplace.state, name: marketplace.data?.name ?? null, registered, expectedSource },
    source: { path: sourcePath, state: sourceState, foreign, version: marker.data?.version ?? null, fingerprint, sameCandidate: same(fingerprint, candidate) },
    cached, installed: { state: 'unknown', reason: 'offline cache inventory does not attest host installation' }, loaded: 'unknown',
    repair: { host: 'codex', action: sourceState === 'missing' ? 'install' : 'refresh', targetable: !foreign && (!registered || expectedSource) && marketplace.state !== 'unreadable',
      reason: foreign ? 'preserve unmarked source' : registered && !expectedSource ? 'preserve marketplace entry targeting another source'
        : marketplace.state === 'unreadable' ? 'marketplace data is unreadable; preserve unknown entries'
          : 'refresh managed marketplace source; host installation still requires verification' },
    requirements: ['Start a new Codex thread after repair.', 'Review and trust plugin hooks in Codex; cached copies do not prove activation.'] };
}

function opencodeReport(home, env, root, executables) {
  const expectedVersion = readJson(path.join(root, 'package.json')).data?.version ?? null;
  const configDir = env.OPENCODE_CONFIG_DIR?.trim() ? path.resolve(env.OPENCODE_CONFIG_DIR) : path.join(env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, '.config'), 'opencode');
  const candidatePath = path.join(root, 'assets/opencode/plugin.js');
  let candidate = null; try { candidate = readFileSync(candidatePath, 'utf8'); } catch {}
  const files = [];
  for (const directory of ['plugin', 'plugins']) for (const name of ['runlist.js', 'dotmd.js']) {
    const file = path.join(configDir, directory, name); if (!existsSync(file)) continue;
    let body; try { const stat = statSync(file); if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('limit'); body = readFileSync(file, 'utf8'); } catch { files.push({ path: file, state: 'unknown', foreign: true }); continue; }
    const marker = /^\/\/ (runlist-generated:|dotmd-generated:)([^\r\n]*)/.exec(body);
    const expected = marker && candidate !== null ? [
      `// ${marker[1]}${expectedVersion ?? marker[2]}`,
      '// Generated by `runlist install opencode`. Refreshed by `runlist update`.',
      '// Hand edits are overwritten — remove with `runlist install opencode --remove`.', '',
    ].join('\n') + candidate : null;
    const sameSource = expected !== null ? body === expected : null;
    const legacy = name === 'dotmd.js' || marker?.[1] === 'dotmd-generated:';
    files.push({ path: file, version: marker?.[2] ?? null, foreign: !marker, legacy, sameSource,
      state: !marker ? 'foreign' : legacy || sameSource === false ? 'stale' : sameSource === true ? 'current' : 'unknown' });
  }
  const state = files.some(f => f.state === 'foreign') ? 'foreign' : !files.length ? 'missing' : files.some(f => f.state === 'stale') ? 'stale' : files.every(f => f.state === 'current') ? 'current' : 'unknown';
  return { state, configDir, executables, files, expectedVersion, loaded: 'unknown', candidate: { path: candidatePath },
    stateBasis: 'managed file compared with the current CLI candidate; checkout differences are not a published-release attestation',
    repair: { host: 'opencode', action: state === 'missing' ? 'install' : 'refresh', targetable: !files.some(f => f.foreign), reason: 'preserve unmarked files; refresh only generated content' },
    requirements: ['Restart OpenCode after repair; generated file presence does not attest live loading.'] };
}

/** Unified, serializable inventory. config is accepted for caller compatibility;
 * host inventory never imports or requires a project configuration. */
export function agentHostReport(config = {}, { root = PACKAGE_ROOT, home = os.homedir(), env = process.env, claudeConfigDirs = [], claudeBin, platform = process.platform } = {}) {
  const executables = discoverHostExecutables({ home, env, claudeBin, platform });
  const profiles = discoverClaudeProfiles({ home, env, configDirs: claudeConfigDirs });
  const pkg = readJson(path.join(root, 'package.json'));
  return { schemaVersion: 1, readOnly: true, candidate: { path: root, version: pkg.data?.version ?? null, kind: existsSync(path.join(root, '.git')) ? 'checkout' : 'package' },
    executables, hosts: { claude: claudeReport(profiles, executables.claude, root), codex: codexReport(home, env, root, executables.codex),
      opencode: opencodeReport(home, env, root, executables.opencode) },
    warnings: ['Loaded live-session state is unknown without host attestation.', 'Local candidate differences alone do not prove a published Claude install is broken.'] };
}

export function formatAgentHostReport(report) {
  const lines = [`Agent hosts (${report.readOnly === false ? 'after selected repairs' : 'read-only'}) · candidate ${report.candidate.version ?? 'unknown'} · ${report.candidate.kind} · ${report.candidate.path}`];
  const parity = value => value === true ? 'matches' : value === false ? 'differs' : 'unknown';
  for (const host of ['claude', 'codex', 'opencode']) {
    const item = report.hosts[host], inventory = item.executables;
    lines.push(`${host}: ${item.state} · loaded ${item.loaded}`,
      `  Selected executable: ${inventory.selected?.path ?? 'not found'}${inventory.selected ? ` (${inventory.selected.kind})` : ''}`);
    for (const candidate of inventory.candidates) lines.push(`  Executable candidate: ${candidate.path} → ${candidate.resolvedPath} · ${candidate.kind} · ${candidate.source} · provenance ${candidate.provenance.state}`);
    if (host === 'claude') for (const profile of item.profiles) {
      lines.push(`  Profiles: ${profile.configDirs.join(' ↔ ')} · ${profile.state} · saved enablement ${profile.savedEnablement} · source ${profile.sources.join(', ')} · registry ${profile.registryState}`,
        `    Plugin store: ${profile.storeKey} · marketplaces ${profile.knownMarketplacesState}`);
      for (const settings of profile.settings) {
        const enabled = Object.entries(settings.enabledPlugins).map(([id, value]) => `${id}=${value}`).join(', ');
        lines.push(`    Enabled settings: ${settings.configDir} · ${settings.state} · ${enabled || 'no saved runlist enablement'}`);
      }
      for (const plugin of profile.plugins) {
        lines.push(`    Plugin: ${plugin.id} · ${plugin.state} · expected published version ${plugin.expectedVersion ?? 'unknown'} · marketplace registered ${plugin.marketplaceRegistered ?? 'unknown'}`,
          `      Catalog: ${plugin.catalog.state} · provenance ${plugin.catalog.provenance}${plugin.catalog.path ? ` · ${plugin.catalog.path}` : ''}`);
        for (const entry of plugin.entries) lines.push(`      ${entry.scope ?? 'unknown scope'}${entry.projectPath ? ` (${entry.projectPath})` : ''} · ${entry.version ?? 'unknown version'} · ${entry.installPath ?? 'unknown path'} · ${entry.state} · catalog source ${parity(entry.sameSource)} · local candidate ${parity(entry.sameCandidate)}`);
      }
      lines.push(`    Repair: ${profile.repair.targetable ? profile.repair.action : 'requires explicit targeting'} · ${profile.repair.reason}`);
    }
    if (host === 'codex') {
      lines.push(`  Personal marketplace: ${item.marketplace.path} · ${item.marketplace.state} · registered ${item.marketplace.registered}`,
        `  Marketplace source: ${item.source.path} · ${item.source.state} · local candidate ${parity(item.source.sameCandidate)}`,
        `  State basis: ${item.stateBasis}`,
        `  Active Codex profile: ${item.configDir} · cache ${item.cacheRoot}`,
        `  Installed record: ${item.installed.state} · ${item.installed.reason}`);
      for (const cached of item.cached) lines.push(`  Cached copy: ${cached.path} · ${cached.version} · marketplace source ${parity(cached.sameSource)} · ${cached.role}`);
    }
    if (host === 'opencode') {
      lines.push(`  Config directory: ${item.configDir} · expected version ${item.expectedVersion ?? 'unknown'}`, `  State basis: ${item.stateBasis}`);
      for (const file of item.files) lines.push(`  Generated integration: ${file.path} · ${file.state} · ${file.version ?? 'unknown version'} · candidate source ${parity(file.sameSource)}`);
    }
    for (const requirement of item.requirements) lines.push(`  ${requirement}`);
  }
  for (const warning of report.warnings) lines.push(warning);
  return lines.join('\n') + '\n';
}
