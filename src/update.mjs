import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { green, dim, yellow } from './color.mjs';
import { executableName } from './util.mjs';
import { CLAUDE_MARKETPLACE, claudeMarketplaceRefusalHint, opencodeStatus } from './host-integration.mjs';
import { codexStatus, installedCodexStatus } from './codex-integration.mjs';
import { desktopLaunch } from './desktop.mjs';
import { installationReport, formatInstallationReport, readInstalledPluginRecords, sourceFingerprint } from './installation.mjs';
export { readInstalledPluginRecords } from './installation.mjs';
import { compareDesktopVersions, installedDesktopVersion } from './desktop-install.mjs';
import { agentHostReport, discoverClaudeProfiles, discoverHostExecutables } from './agent-hosts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const NPM_PKG = 'runlist';
const DEFAULT_PLUGIN_ID = 'runlist@runlist';
export const LEGACY_PLUGIN_ID = 'dotmd@dotmd';

// Parse an x.y.z prefix; returns [major, minor, patch] or null.
function parseVer(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// -1 if a<b, 0 if equal, 1 if a>b, null if either is unparseable.
export function compareVersions(a, b) {
  const pa = parseVer(a), pb = parseVer(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

// Claude Code's marketplace registry, keyed by marketplace name. A plugin id
// is `<plugin>@<marketplace>`, and the plugin only loads while its marketplace
// is registered here — an install record alone is not an installed plugin.
export function readKnownMarketplaces(opts = {}) {
  const home = opts.home || os.homedir();
  const env = opts.env ?? (opts.home ? {} : process.env);
  const configDir = opts.configDir ?? (env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude'));
  const file = path.join(configDir, 'plugins', 'known_marketplaces.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// `marketplaceRegistered: false` is the state `claude plugin list` shows as
// "failed to load: Marketplace runlist not found": the install record survived,
// the marketplace registration did not (a settings.json declaration that no
// longer matches, a wiped registry). Reading only the install record called
// that "installed", so `runlist install claude` skipped the one repair it owns
// and `runlist update` ran a `plugin update` that could only fail.
export function readInstalledPlugin(opts = {}) {
  const env = opts.env ?? (opts.home ? {} : process.env);
  const configDir = opts.configDir ?? (env.CLAUDE_CONFIG_DIR?.trim() || path.join(opts.home ?? os.homedir(), '.claude'));
  const records = readInstalledPluginRecords({ ...opts, configDir });
  if (!records) return null;
  const marketplace = records.id.split('@')[1] || null;
  const known = readKnownMarketplaces({ ...opts, configDir });
  return {
    id: records.id,
    entries: records.entries,
    version: records.entries[0]?.version ?? null,
    marketplace,
    marketplaceRegistered: Boolean(marketplace && known[marketplace]),
  };
}

export function pluginScopeLabel(entry) {
  return `${entry.scope ?? 'unknown scope'}${entry.projectPath ? ` (${entry.projectPath})` : ''}`;
}

const scopeKey = entry => JSON.stringify([entry.scope, entry.projectPath ?? null]);

// Scope comes from the install registry, not the updater's current directory.
// Never turn a missing project or unsupported scope into a user-wide update.
export function planPluginUpdates(plugin) {
  if (!plugin) return [];
  if (!plugin?.entries) return [{ kind: 'plugin', cmd: ['claude', 'plugin', 'update', plugin.id] }];
  const steps = [];
  const seen = new Set();
  for (const entry of plugin.entries) {
    const key = scopeKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    const scoped = entry.scope === 'project' || entry.scope === 'local';
    if (!['user', 'project', 'local'].includes(entry.scope) ||
        (scoped && (typeof entry.projectPath !== 'string' || !path.isAbsolute(entry.projectPath)))) {
      steps.push({ kind: 'refusal', reason: `cannot update ${plugin.id} at ${pluginScopeLabel(entry)}: ${scoped ? 'an absolute project path is required' : 'scope is not writable by the Claude CLI'}` });
      continue;
    }
    steps.push({ kind: 'plugin', scope: entry.scope, ...(scoped ? { cwd: entry.projectPath } : {}),
      cmd: ['claude', 'plugin', 'update', plugin.id, '--scope', entry.scope] });
  }
  return steps;
}

// A zero command exit is insufficient: retain every original registration and
// verify the fresh registry rather than trusting the first installation.
export function verifyPluginScopeUpdates(before, after, { expectedVersion, minimumVersion } = {}) {
  if (!before?.entries?.length) return { ok: false, reason: `${before?.id ?? DEFAULT_PLUGIN_ID} plugin is not installed` };
  const failures = [];
  const versions = new Set();
  const targets = new Map([...before.entries, ...(after?.id === before.id ? after.entries : [])].map(entry => [scopeKey(entry), entry]));
  for (const entry of targets.values()) {
    const current = after?.id === before.id ? after.entries.filter(item => scopeKey(item) === scopeKey(entry)) : [];
    if (!current.length) {
      failures.push(`${pluginScopeLabel(entry)} registration disappeared`);
      continue;
    }
    for (const item of current) {
      versions.add(item.version);
      if (parseVer(item.version) === null || (expectedVersion && item.version !== expectedVersion) ||
          (minimumVersion && compareVersions(item.version, minimumVersion) < 0)) {
        failures.push(`${pluginScopeLabel(entry)} has ${item.version ?? 'unknown'}, expected ${expectedVersion ?? (minimumVersion ? `at least ${minimumVersion}` : 'a valid version')}`);
      }
    }
  }
  if (!failures.length && versions.size > 1) failures.push('installed scopes have different versions');
  return failures.length ? { ok: false, reason: `${before.id}: ${[...new Set(failures)].join('; ')}` } : { ok: true };
}

// The steps that put a plugin whose marketplace registration is gone back on
// its feet. Only the marketplace runlist publishes has a source runlist knows; a
// plugin installed from some other marketplace names a source we cannot guess.
export function planMarketplaceRepair(plugin, { hasClaude, verb }) {
  const reason = `marketplace "${plugin.marketplace}" is not registered, so the installed plugin cannot load`;
  if (plugin.marketplace !== 'runlist') {
    return [{ kind: 'skip', reason: `${reason} — re-add that marketplace (runlist does not know its source), then rerun` }];
  }
  if (!hasClaude) {
    return [{ kind: 'manual', reason, lines: [`/plugin marketplace add ${CLAUDE_MARKETPLACE}`, `/plugin ${verb} ${plugin.id}`] }];
  }
  return [
    { kind: 'marketplace', reason: `${reason} — re-adding it first`, cmd: ['claude', 'plugin', 'marketplace', 'add', CLAUDE_MARKETPLACE] },
    ...(verb === 'update' ? planPluginUpdates(plugin).map(step => ({ ...step, needs: 'marketplace' }))
      : [{ kind: 'plugin', needs: 'marketplace', cmd: ['claude', 'plugin', verb, plugin.id] }]),
  ];
}

// Decide which steps `runlist update` should run. Pure — no side effects — so the
// orchestration is unit-testable. `opts` = { cliOnly, pluginOnly }; `ctx` =
// { plugin: {id,version}|null, hasClaude, hasNpm }.
export function planUpdate(opts, ctx) {
  const steps = [];
  if (!opts.pluginOnly) {
    steps.push(ctx.hasNpm
      ? { kind: 'cli', cmd: ['npm', 'i', '-g', `${NPM_PKG}@latest`] }
      : { kind: 'skip', reason: 'npm not found on PATH — skipping CLI update' });
  }
  if (!opts.cliOnly) {
    if (!ctx.plugin) {
      steps.push({ kind: 'skip', reason: 'runlist plugin not installed — skipping plugin update' });
    } else if (ctx.plugin.id === LEGACY_PLUGIN_ID) {
      if (ctx.hasClaude) {
        steps.push({ kind: 'marketplace', cmd: ['claude', 'plugin', 'marketplace', 'add', CLAUDE_MARKETPLACE] });
        const scopes = planPluginUpdates(ctx.plugin);
        for (const step of scopes) {
          if (step.kind === 'refusal') { steps.push(step); continue; }
          steps.push({ ...step, needs: 'marketplace', cmd: ['claude', 'plugin', 'install', DEFAULT_PLUGIN_ID, ...step.cmd.slice(4)] });
        }
        for (const step of scopes) if (step.kind !== 'refusal') {
          steps.push({ ...step, kind: 'legacy', needs: 'plugin', cmd: ['claude', 'plugin', 'uninstall', LEGACY_PLUGIN_ID, ...step.cmd.slice(4)] });
        }
      } else {
        steps.push({ kind: 'manual', reason: 'Claude CLI not found', lines: [
          `/plugin marketplace add ${CLAUDE_MARKETPLACE}`,
          `/plugin install ${DEFAULT_PLUGIN_ID}`,
          `/plugin uninstall ${LEGACY_PLUGIN_ID}`,
        ] });
      }
    } else if (ctx.plugin.marketplaceRegistered === false) {
      steps.push(...planMarketplaceRepair(ctx.plugin, { hasClaude: ctx.hasClaude, verb: 'update' }));
    } else if (!ctx.hasClaude) {
      steps.push({ kind: 'skip', reason: `claude CLI not found — run \`/plugin update ${ctx.plugin.id}\` from a session instead` });
    } else {
      if (ctx.officialMarketplace) steps.push({ kind: 'marketplace', cmd: ['claude', 'plugin', 'marketplace', 'update', ctx.plugin.marketplace] });
      steps.push(...planPluginUpdates(ctx.plugin).map(step => ctx.officialMarketplace ? { ...step, needs: 'marketplace' } : step));
    }
    if (ctx.legacyPlugin && ctx.plugin?.id !== LEGACY_PLUGIN_ID) {
      if (ctx.hasClaude) for (const step of planPluginUpdates(ctx.legacyPlugin)) {
        steps.push(step.kind === 'refusal' ? step : { ...step, kind: 'legacy', needs: 'plugin', cmd: ['claude', 'plugin', 'uninstall', LEGACY_PLUGIN_ID, ...step.cmd.slice(4)] });
      }
      else steps.push({ kind: 'manual', reason: 'Legacy Claude plugin also installed', lines: [`/plugin uninstall ${LEGACY_PLUGIN_ID}`] });
    }
    // The OpenCode integration is a file runlist wrote, so it goes stale silently
    // the moment the CLI moves on. Refresh it here — but only if it is already
    // installed. `update` keeps hosts in lockstep; it never adopts a new one,
    // which stays the job of the explicit `runlist install`.
    if (ctx.opencode?.foreign) {
      steps.push({ kind: 'skip', reason: `${ctx.opencode.path} was not written by runlist — leaving it alone` });
    } else if (ctx.opencode?.exists && (ctx.refreshHosts || ctx.opencode.stale || (!opts.pluginOnly && ctx.hasNpm))) {
      steps.push({ kind: 'opencode', cmd: ['runlist', 'install', 'opencode'] });
    }
    if (ctx.codex?.foreign) {
      steps.push({ kind: 'skip', reason: `${ctx.codex.plugin} was not written by runlist — leaving it alone` });
    } else if (ctx.codex?.exists && (ctx.refreshHosts || ctx.codex.stale || (!opts.pluginOnly && ctx.hasNpm))) {
      steps.push({ kind: 'codex', cmd: ['runlist', 'install', 'codex'] });
    }
  }
  if (!opts.cliOnly && !opts.pluginOnly && ctx.desktop) {
    steps.push({ kind: 'desktop', cmd: ['runlist', 'desktop', 'install'] });
  }
  return steps;
}

export function verifyManagedHostUpdates(before, after, expectedVersion) {
  const failures = [];
  for (const host of ['opencode', 'codex']) {
    if (!before[host]?.exists || before[host].foreign) continue;
    const current = after[host];
    if (!current?.exists || current.foreign || current.version !== expectedVersion || current.stale) {
      failures.push(`${host} integration has ${current?.version ?? 'no managed installation'}, expected ${expectedVersion}`);
    }
    if (host === 'codex' && (!current?.installed?.ok || current.installed.version !== expectedVersion)) {
      failures.push(`Codex installed plugin ${current?.installed?.reason ?? `has ${current?.installed?.version ?? 'unknown'}, expected ${expectedVersion}`}`);
    }
  }
  return failures;
}

function currentCodexStatus(version, { home = os.homedir(), env = process.env, run = spawnSync, binary } = {}) {
  const source = codexStatus({ version, homedir: home });
  if (!source.exists || source.foreign) return source;
  const installed = binary ? installedCodexStatus({ homedir: home, env, run, binary }) : { ok: false, reason: 'codex CLI not found; installed plugin is unverified' };
  return { ...source, installed, stale: source.stale || !installed.ok || installed.version !== version };
}

function flagValues(argv, flag) {
  const values = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith(`${flag}=`)) values.push(argv[i].slice(flag.length + 1));
    else if (argv[i] === flag) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${flag} requires a value`);
      values.push(argv[++i]);
    }
  }
  if (values.some(value => !value.trim())) throw new Error(`${flag} requires a value`);
  return values;
}

export function updateOptions(argv, opts = {}) {
  const hosts = flagValues(argv, '--host');
  if (hosts.length > 1) throw new Error('--host may be supplied once');
  if (argv.includes('--json') && !argv.includes('--check')) throw new Error('update --json is available with --check; use update --check --json for offline inspection.');
  const host = hosts[0] ?? opts.host;
  if (host && !['claude', 'codex', 'opencode'].includes(host)) throw new Error('--host must be claude, codex, or opencode');
  const cliOnly = argv.includes('--cli-only') || Boolean(opts.cliOnly);
  if (host && cliOnly) throw new Error('--cli-only conflicts with --host');
  const configDirs = flagValues(argv, '--claude-config');
  const claudeConfigDirs = configDirs.length ? configDirs : opts.claudeConfigDirs ?? [];
  if (claudeConfigDirs.some(dir => !path.isAbsolute(dir))) throw new Error('--claude-config requires an absolute profile directory');
  const binaries = flagValues(argv, '--claude-bin');
  if (binaries.length > 1) throw new Error('--claude-bin may be supplied once');
  return { host, cliOnly, pluginOnly: Boolean(host || argv.includes('--plugin-only') || opts.pluginOnly),
    claudeConfigDirs: claudeConfigDirs.map(dir => path.resolve(dir)), claudeBin: binaries[0] ?? opts.claudeBin,
    check: argv.includes('--check'), json: argv.includes('--json'), dryRun: Boolean(opts.dryRun || argv.includes('--dry-run')) };
}

function inventoryNpm(env) {
  const suffixes = process.platform === 'win32' ? ['', '.cmd', '.exe'] : [''];
  return (env.PATH ?? '').split(path.delimiter).filter(Boolean).some(dir => suffixes.some(suffix => existsSync(path.join(dir, `npm${suffix}`))));
}

const officialMarketplace = market => (market?.source?.source === 'github' && market.source.repo === CLAUDE_MARKETPLACE)
  || (market?.source?.source === 'git' && /^https:\/\/github\.com\/reowens\/runlist(?:\.git)?\/?$/.test(market.source.url ?? ''));

// Published catalog parity is separate from local checkout parity. An unpublished
// checkout must never turn a perfectly valid published plugin into a failure.
export function publishedClaudePluginStatus(plugin, profile) {
  const market = readKnownMarketplaces({ configDir: profile.configDir })[plugin.marketplace];
  if (!officialMarketplace(market) || !path.isAbsolute(market.installLocation ?? '')) return { state: 'unknown' };
  try {
    const catalog = JSON.parse(readFileSync(path.join(market.installLocation, '.claude-plugin', 'marketplace.json'), 'utf8'));
    if (catalog.name !== plugin.marketplace) return { state: 'unknown' };
    const entry = catalog.plugins?.find(item => item.name === plugin.id.split('@')[0]);
    if (typeof entry?.source !== 'string' || path.isAbsolute(entry.source)) return { state: 'unknown' };
    const root = path.resolve(market.installLocation, entry.source);
    const relative = path.relative(realpathSync(market.installLocation), realpathSync(root));
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return { state: 'unknown' };
    const manifest = JSON.parse(readFileSync(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    const assets = ['commands', 'skills', 'hooks', 'hooks.json', '.claude-plugin'];
    const expected = sourceFingerprint(root, assets);
    const copies = plugin.entries.map(item => {
      const actual = item.installPath ? sourceFingerprint(item.installPath, assets) : null;
      return { scope: pluginScopeLabel(item), state: !expected.sha256 || !actual?.sha256 ? 'unknown' : expected.sha256 === actual.sha256 ? 'match' : 'mismatch' };
    });
    return { state: copies.some(copy => copy.state === 'mismatch') ? 'mismatch' : copies.length && copies.every(copy => copy.state === 'match') ? 'match' : 'unknown', version: parseVer(manifest.version) ? manifest.version : null, copies };
  } catch { return { state: 'unknown' }; }
}

// Keep physical-store writes deduplicated while retaining every profile for the
// caller's fresh verification. Explicit selectors never fall back to ~/.claude.
export function planClaudeProfileUpdates(profiles, inventory) {
  const steps = [], seen = new Set();
  const selected = inventory?.selected;
  const binary = typeof selected === 'string' ? selected : selected?.path;
  const candidate = typeof selected === 'object' ? selected : inventory?.candidates?.find(item => item.path === binary);
  for (const profile of profiles) {
    if (profile.registryState === 'unreadable') {
      steps.push({ kind: 'refusal', reason: `${profile.registryPath}: Claude registry unreadable; no profile update attempted` });
      continue;
    }
    if (profile.knownMarketplacesState === 'unreadable' || profile.settings?.some(settings => settings.configDir === profile.configDir && settings.state === 'unreadable')) {
      steps.push({ kind: 'refusal', reason: `${profile.configDir}: Claude marketplace/settings data is unreadable; preserve it and resolve it before updating` });
      continue;
    }
    const plugin = profile.installed;
    if (!plugin) { steps.push({ kind: 'skip', reason: `runlist plugin not installed in ${profile.configDir} — skipping plugin update` }); continue; }
    if (seen.has(profile.storeKey)) continue;
    seen.add(profile.storeKey);
    if (inventory?.explicit && !binary) {
      steps.push({ kind: 'refusal', reason: `selected --claude-bin is unavailable; no update attempted for ${profile.configDir}` });
      continue;
    }
    // A wrapper may hard-code a different CLAUDE_CONFIG_DIR. Merely exporting
    // the variable is not proof that it will target the selected profile.
    if (binary && (!candidate?.kind?.startsWith('native') || (!inventory.explicit && inventory.candidates?.filter(item => item.kind.startsWith('native')).length > 1))) {
      steps.push({ kind: 'refusal', reason: `cannot establish wrapper-to-profile mapping for ${binary} and ${profile.configDir}; use --claude-bin with a native executable path and --claude-config ${profile.configDir}` });
      continue;
    }
    const market = readKnownMarketplaces({ configDir: profile.configDir })[plugin.marketplace];
    const legacyPlugin = profile.plugins?.find(item => item.id === LEGACY_PLUGIN_ID);
    for (const step of planUpdate({ pluginOnly: true }, { plugin, legacyPlugin, hasClaude: binary, officialMarketplace: officialMarketplace(market) })) {
      steps.push({ ...step, profile: profile.configDir, dependencyKey: profile.storeKey,
        ...(step.cmd?.[0] === 'claude' ? { cmd: [binary || 'claude', ...step.cmd.slice(1)] } : {}) });
    }
  }
  return steps;
}

export async function runUpdate(argv, _config, opts = {}) {
  const options = updateOptions(argv, opts);
  const { check, cliOnly, pluginOnly, host, claudeConfigDirs, claudeBin, dryRun } = options;
  const home = opts.home ?? os.homedir(), env = opts.env ?? process.env;
  const run = opts.run ?? spawnSync;
  const inventory = opts.executables ?? discoverHostExecutables({ home, env, claudeBin });
  const discovered = discoverClaudeProfiles({ home, env, configDirs: claudeConfigDirs });
  const profiles = claudeConfigDirs.length ? discovered.flatMap(profile => {
    const selected = claudeConfigDirs.find(dir => (profile.configDirs ?? [profile.configDir]).includes(dir));
    return selected ? [{ ...profile, configDir: selected }] : [];
  }) : discovered;
  const reportOptions = { home, env, claudeConfigDirs, claudeBin };
  // Offline checks and previews do not invoke even a host's read-only CLI:
  // wrappers and host startup can perform network or settings writes.
  if (check) {
    const installation = installationReport(_config, reportOptions);
    const hosts = agentHostReport(_config, reportOptions);
    const managedSources = { codex: codexStatus({ version: pkg.version, homedir: home }), opencode: opencodeStatus({ version: pkg.version, homedir: home, env }) };
    const report = { ...installation, hostReport: hosts, managedSources, selection: { host: host ?? null, claudeConfigDirs },
      readOnly: true, offline: true, publishedAvailability: 'not-queried-offline' };
    if (options.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else {
      process.stdout.write('Offline inspection: local installed/catalog files only; newer published versions were not queried.\n');
      process.stdout.write(formatInstallationReport(installation).split('\n').filter(line => !/^(?:claude|codex|opencode):/.test(line)).join('\n'));
      process.stdout.write(`runlist CLI:    ${pkg.version}\n`);
      for (const profile of profiles) {
        if (!profile.installed) process.stdout.write(`runlist plugin: not installed (${profile.configDir})\n`);
        for (const plugin of profile.plugins) {
          for (const entry of plugin.entries) {
            const cmp = compareVersions(entry.version, pkg.version);
            const version = cmp === 0 ? 'version matches CLI' : cmp === null ? 'version unknown' : cmp < 0 ? 'behind CLI' : 'ahead of CLI';
            process.stdout.write(`runlist plugin: ${entry.version ?? '?'} (${plugin.id}; ${pluginScopeLabel(entry)}; ${profile.configDir}) ${version}; published source ${publishedClaudePluginStatus(plugin, profile).state}\n`);
          }
          if (plugin.marketplaceRegistered === false) process.stdout.write(`  marketplace "${plugin.marketplace}" is not registered; host activation is unknown\n`);
        }
      }
      for (const name of ['claude', 'codex', 'opencode']) {
        const info = hosts.hosts[name];
        process.stdout.write(`${name}: ${info.state}; loaded live session unknown\n`);
        for (const candidate of inventory[name]?.candidates ?? []) process.stdout.write(`  executable: ${candidate.path} → ${candidate.resolvedPath} (${candidate.kind})\n`);
        for (const requirement of info.requirements ?? []) process.stdout.write(`  ${requirement}\n`);
      }
      for (const [name, source] of Object.entries(managedSources)) process.stdout.write(`${name} managed source: ${source.exists ? source.foreign ? 'foreign' : source.sourceParity.state : 'missing'}; host installed copy and loaded session require separate attestation\n`);
      for (const warning of hosts.warnings) process.stdout.write(`${warning}\n`);
    }
    return report;
  }

  const selected = name => !host || host === name;
  if (!cliOnly) {
    const source = agentHostReport(_config, reportOptions).candidate;
    process.stdout.write(`CLI candidate: ${source.path} (${source.kind}, version ${source.version ?? 'unknown'}). `
      + (source.kind === 'checkout' ? 'This may contain unpublished assets; candidate parity is not a published-release attestation.\n' : 'Managed assets are compared with this CLI package.\n'));
    process.stdout.write('Claude updates use registered marketplace catalogs; Codex/OpenCode managed assets come from this CLI installation.\n');
    if (!pluginOnly) process.stdout.write('The CLI update may replace this installation before host installers read its assets.\n');
  }
  const opencode = !cliOnly && selected('opencode') ? opencodeStatus({ version: pkg.version, homedir: home, env }) : null;
  const codex = !cliOnly && selected('codex') ? (dryRun ? codexStatus({ version: pkg.version, homedir: home })
    : currentCodexStatus(pkg.version, { home, env, run, binary: inventory.codex.selected?.path })) : null;
  const desktop = !host && !pluginOnly && process.platform === 'darwin' && process.arch === 'arm64' ? desktopLaunch([], { home, env }).app : null;
  // Keep the existing all-host planner; replace only its single-default-profile
  // Claude plan with the discovered stores and their explicit environments.
  const steps = planUpdate({ cliOnly, pluginOnly }, { opencode, codex, desktop, refreshHosts: Boolean(host || dryRun), hasNpm: inventoryNpm(env) })
    .filter(step => !step.reason?.startsWith('runlist plugin not installed'));
  if (!cliOnly) for (const name of ['codex', 'opencode']) {
    if (selected(name) && !(name === 'codex' ? codex : opencode)?.exists) steps.push({ kind: 'skip', reason: `runlist ${name} integration not installed — skipping ${name} update` });
  }
  if (!cliOnly && selected('claude')) {
    const claudeSteps = planClaudeProfileUpdates(profiles, inventory.claude, { home, explicit: claudeConfigDirs.length > 0 });
    const index = steps.findIndex(step => step.kind !== 'cli');
    steps.splice(index < 0 ? steps.length : index, 0, ...claudeSteps);
  }
  if (dryRun) {
    for (const name of ['codex', 'opencode']) {
      const state = name === 'codex' ? codex : opencode;
      if (selected(name) && state?.exists) process.stdout.write(`[dry-run] ${name} managed source: ${state.foreign ? 'foreign (preserved)' : state.stale ? 'stale → current CLI candidate' : 'current (installed-copy verification may still be needed)'}\n`);
    }
    const skipped = host && steps.every(step => step.kind === 'skip');
    if (skipped) process.stdout.write(`[dry-run] Requested ${host} integration is absent or not writable; no update is planned. Use an explicit install/repair if desired.\n`);
    for (const step of steps) {
      if (step.kind === 'skip') process.stdout.write(dim(`[dry-run] skip: ${step.reason}\n`));
      else if (step.kind === 'manual') for (const line of step.lines) process.stdout.write(dim(`[dry-run] Run from a session: ${line}\n`));
      else if (step.kind === 'refusal') process.stdout.write(yellow(`[dry-run] Refused: ${step.reason}\n`));
      else process.stdout.write(dim(`[dry-run] Would run: ${step.cmd.join(' ')}${step.cwd ? ` (in ${step.cwd})` : ''}${step.profile ? ` [CLAUDE_CONFIG_DIR=${step.profile}]` : ''}\n`));
    }
    return { steps, dryRun: true, status: skipped ? 'skipped' : 'preview' };
  }
  // The hosts are independent: a failed `claude plugin update` says nothing
  // about the OpenCode file, so every step runs and the failures are reported
  // together at the end. Stopping at the first one left OpenCode stale behind a
  // Claude registry problem — silently, since the abort said nothing about the
  // steps it never reached.
  let ran = false;
  const failures = [];
  const failedKinds = new Set();
  const refreshedStores = new Set();
  for (const s of steps) {
    if (s.kind === 'refusal') {
      failures.push(s);
      failedKinds.add(`${s.dependencyKey ?? ''}:plugin`);
      process.stdout.write(yellow(`${s.reason}\n`));
      continue;
    }
    if (s.kind === 'skip') {
      process.stdout.write(dim(`skip: ${s.reason}\n`));
      continue;
    }
    if (s.kind === 'manual') {
      process.stdout.write(`${yellow(s.reason)} — run these from a Claude Code session:\n`);
      for (const line of s.lines) process.stdout.write(`  ${line}\n`);
      continue;
    }
    if (s.needs && failedKinds.has(`${s.dependencyKey ?? ''}:${s.needs}`)) {
      process.stdout.write(dim(`skip: ${s.cmd.join(' ')} — the ${s.needs} step it depends on failed\n`));
      continue;
    }
    if (s.reason) process.stdout.write(dim(`${s.reason}\n`));
    process.stdout.write(dim(`$ ${s.cmd.join(' ')}${s.cwd ? ` (in ${s.cwd})` : ''}\n`));
    // npm can replace this package during the CLI step. A new Node process
    // reads the new installers/assets; this process still holds the old modules.
    // Use this installation's entry point, not another runlist earlier on PATH.
    const ownCli = s.cmd[0] === 'runlist';
    const r = run(ownCli ? process.execPath : path.isAbsolute(s.cmd[0]) ? s.cmd[0] : executableName(s.cmd[0]),
      ownCli ? [path.join(__dirname, '..', 'bin', 'runlist.mjs'), ...s.cmd.slice(1)] : s.cmd.slice(1), {
      stdio: 'inherit',
      env: { ...env, HOME: home, USERPROFILE: home, ...(s.profile ? { CLAUDE_CONFIG_DIR: s.profile } : {}) },
      ...(s.cwd ? { cwd: s.cwd } : {}),
      shell: !ownCli && process.platform === 'win32' && (!path.isAbsolute(s.cmd[0]) || /\.(?:cmd|bat)$/i.test(s.cmd[0])),
    });
    ran = true;
    if (r.status !== 0) {
      failedKinds.add(`${s.dependencyKey ?? ''}:${s.kind}`);
      failures.push(s);
      process.stdout.write(yellow(`(${s.cmd[0]} ${r.error ? `failed: ${r.error.message}` : `exited ${r.status ?? '?'}`})\n`));
      if (s.kind === 'marketplace') for (const line of claudeMarketplaceRefusalHint('runlist')) process.stdout.write(yellow(`${line}\n`));
    } else if (s.kind === 'marketplace' && s.dependencyKey) refreshedStores.add(s.dependencyKey);
  }
  const currentVersion = opts.expectedVersion ?? JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version;
  if (!cliOnly) {
    const after = { opencode: opencode && opencodeStatus({ version: currentVersion, homedir: home, env }),
      codex: codex && currentCodexStatus(currentVersion, { home, env, run, binary: inventory.codex.selected?.path }) };
    for (const reason of verifyManagedHostUpdates({ opencode, codex }, after, currentVersion)) {
      failures.push({ reason });
      process.stdout.write(yellow(`${reason}\n`));
    }
  }
  if (!cliOnly && selected('claude')) for (const profile of profiles) {
    if (!profile.installed) continue;
    // Verify every registry/scope, even when another store or command failed.
    // Shared-store aliases remain separately visible in the inventory report.
    const plugin = profile.installed;
    const after = readInstalledPlugin({ home, configDir: profile.configDir, env });
    const published = after ? publishedClaudePluginStatus(after, profile) : { state: 'unknown' };
    const verified = verifyPluginScopeUpdates(plugin.id === LEGACY_PLUGIN_ID ? { ...plugin, id: DEFAULT_PLUGIN_ID } : plugin, after, opts.expectedVersion ? { expectedVersion: currentVersion }
      : published.version ? { expectedVersion: published.version } : {});
    if (!verified.ok) {
      const reason = `${profile.configDir}: ${verified.reason}`;
      failures.push({ reason }); process.stdout.write(yellow(`${reason}\n`));
    }
    if (published.state === 'mismatch') {
      const reason = `${profile.configDir}: installed Claude assets differ from the ${refreshedStores.has(profile.storeKey) ? 'refreshed ' : ''}registered official marketplace catalog`;
      failures.push({ reason }); process.stdout.write(yellow(`${reason}\n`));
    } else if (published.state === 'unknown') process.stdout.write(dim(`${profile.configDir}: published Claude source parity unknown; loaded session unknown\n`));
    if (profile.plugins.some(item => item.id === LEGACY_PLUGIN_ID) && readInstalledPluginRecords({ home, configDir: profile.configDir, id: LEGACY_PLUGIN_ID })) {
      failures.push({ reason: `${profile.configDir}: legacy Claude plugin ${LEGACY_PLUGIN_ID} remains installed; migration is incomplete` });
    }
  }
  if (desktop && steps.some(step => step.kind === 'desktop') && !failedKinds.has(':desktop')) {
    if (compareDesktopVersions(await installedDesktopVersion(desktop), currentVersion) < 0) {
      failures.push({ reason: 'The matching desktop installer is not published yet; retry `runlist update` after the product release completes.' });
    }
  }
  if (failures.length) {
    process.stdout.write(yellow(`\n${failures.length === 1 ? '1 step' : `${failures.length} steps`} failed: ${failures.map(s => s.cmd ? `${s.cmd.join(' ')}${s.cwd ? ` (in ${s.cwd})` : ''}` : s.reason).join('; ')}\n`));
    if (ran && failures.length < steps.filter(s => s.kind !== 'skip' && s.kind !== 'manual').length) {
      process.stdout.write(dim('the other steps completed; restart the affected host sessions to load the updated integrations.\n'));
    }
    process.exitCode = 1;
    return { ok: false, failures, steps };
  }
  if (ran) {
    process.stdout.write(green('\n✓ restart the affected host sessions to load the updated integrations.\n'));
  }
  return { ok: true, steps };
}
