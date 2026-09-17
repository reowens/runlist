import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { green, dim, yellow } from './color.mjs';
import { executableName, which } from './util.mjs';
import { CLAUDE_MARKETPLACE, claudeMarketplaceRefusalHint, installOpencodePlugin, opencodeStatus } from './host-integration.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

const NPM_PKG = 'dotmd-cli';
const DEFAULT_PLUGIN_ID = 'dotmd@dotmd';

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

// Read Claude Code's plugin install record to find the installed dotmd plugin's
// id + version. Network-free. `opts.home` is injectable for tests. Returns
// { id, version } or null when nothing is installed / the file is absent.
export function readInstalledPluginRecords(opts = {}) {
  const home = opts.home || os.homedir();
  const file = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const plugins = j.plugins || {};
    const id = opts.id
      ? (plugins[opts.id] ? opts.id : null)
      : plugins[DEFAULT_PLUGIN_ID]
        ? DEFAULT_PLUGIN_ID
        : Object.keys(plugins).find(k => /^dotmd@/.test(k));
    if (!id) return null;
    const entries = Array.isArray(plugins[id]) ? plugins[id] : [plugins[id]];
    return { id, entries: entries.filter(Boolean) };
  } catch {
    return null;
  }
}

// Claude Code's marketplace registry, keyed by marketplace name. A plugin id
// is `<plugin>@<marketplace>`, and the plugin only loads while its marketplace
// is registered here — an install record alone is not an installed plugin.
export function readKnownMarketplaces(opts = {}) {
  const home = opts.home || os.homedir();
  const file = path.join(home, '.claude', 'plugins', 'known_marketplaces.json');
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// `marketplaceRegistered: false` is the state `claude plugin list` shows as
// "failed to load: Marketplace dotmd not found": the install record survived,
// the marketplace registration did not (a settings.json declaration that no
// longer matches, a wiped registry). Reading only the install record called
// that "installed", so `dotmd install claude` skipped the one repair it owns
// and `dotmd update` ran a `plugin update` that could only fail.
export function readInstalledPlugin(opts = {}) {
  const records = readInstalledPluginRecords(opts);
  if (!records) return null;
  const marketplace = records.id.split('@')[1] || null;
  const known = readKnownMarketplaces(opts);
  return {
    id: records.id,
    version: records.entries[0]?.version ?? null,
    marketplace,
    marketplaceRegistered: Boolean(marketplace && known[marketplace]),
  };
}

// The steps that put a plugin whose marketplace registration is gone back on
// its feet. Only the marketplace dotmd publishes has a source dotmd knows; a
// plugin installed from some other marketplace names a source we cannot guess.
export function planMarketplaceRepair(plugin, { hasClaude, verb }) {
  const reason = `marketplace "${plugin.marketplace}" is not registered, so the installed plugin cannot load`;
  if (plugin.marketplace !== 'dotmd') {
    return [{ kind: 'skip', reason: `${reason} — re-add that marketplace (runlist does not know its source), then rerun` }];
  }
  if (!hasClaude) {
    return [{ kind: 'manual', reason, lines: [`/plugin marketplace add ${CLAUDE_MARKETPLACE}`, `/plugin ${verb} ${plugin.id}`] }];
  }
  return [
    { kind: 'marketplace', reason: `${reason} — re-adding it first`, cmd: ['claude', 'plugin', 'marketplace', 'add', CLAUDE_MARKETPLACE] },
    { kind: 'plugin', needs: 'marketplace', cmd: ['claude', 'plugin', verb, plugin.id] },
  ];
}

// Decide which steps `dotmd update` should run. Pure — no side effects — so the
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
    } else if (ctx.plugin.marketplaceRegistered === false) {
      steps.push(...planMarketplaceRepair(ctx.plugin, { hasClaude: ctx.hasClaude, verb: 'update' }));
    } else if (!ctx.hasClaude) {
      steps.push({ kind: 'skip', reason: `claude CLI not found — run \`/plugin update ${ctx.plugin.id}\` from a session instead` });
    } else {
      steps.push({ kind: 'plugin', cmd: ['claude', 'plugin', 'update', ctx.plugin.id] });
    }
    // The OpenCode integration is a file dotmd wrote, so it goes stale silently
    // the moment the CLI moves on. Refresh it here — but only if it is already
    // installed. `update` keeps hosts in lockstep; it never adopts a new one,
    // which stays the job of the explicit `dotmd install`.
    if (ctx.opencode?.exists && ctx.opencode.stale) {
      steps.push({ kind: 'opencode', path: ctx.opencode.path });
    } else if (ctx.opencode?.foreign) {
      steps.push({ kind: 'skip', reason: `${ctx.opencode.path} was not written by runlist — leaving it alone` });
    }
  }
  return steps;
}

export function runUpdate(argv, _config, opts = {}) {
  const check = argv.includes('--check');
  const cliOnly = argv.includes('--cli-only');
  const pluginOnly = argv.includes('--plugin-only');
  const plugin = readInstalledPlugin();

  if (check) {
    process.stdout.write(`runlist CLI:    ${pkg.version}\n`);
    if (plugin) {
      const cmp = compareVersions(plugin.version, pkg.version);
      const tag = cmp === 0 ? green('in sync')
        : cmp === null ? dim('(unknown)')
        : cmp < 0 ? yellow('behind — run `runlist update`')
        : yellow('ahead — CLI is behind');
      process.stdout.write(`runlist plugin: ${plugin.version ?? '?'} (${plugin.id}) ${tag}\n`);
      if (plugin.marketplaceRegistered === false) {
        process.stdout.write(yellow(`  marketplace "${plugin.marketplace}" is not registered — the plugin fails to load; run \`runlist install claude\`\n`));
      }
    } else {
      process.stdout.write(dim('runlist plugin: not installed — `runlist install claude`\n'));
    }
    const oc = opencodeStatus({ version: pkg.version });
    if (!oc.exists) process.stdout.write(dim('runlist opencode: not installed\n'));
    else if (oc.foreign) process.stdout.write(`runlist opencode: ${yellow('unmanaged file — not written by runlist')}\n`);
    else process.stdout.write(`runlist opencode: ${oc.version} ${oc.stale ? yellow('behind — run `runlist update`') : green('in sync')}\n`);
    return;
  }

  const opencode = opencodeStatus({ version: pkg.version });
  const steps = planUpdate({ cliOnly, pluginOnly }, { plugin, opencode, hasClaude: which('claude'), hasNpm: which('npm') });
  if (opts.dryRun) {
    for (const step of steps) {
      if (step.kind === 'skip') process.stdout.write(dim(`[dry-run] skip: ${step.reason}\n`));
      else if (step.kind === 'manual') for (const line of step.lines) process.stdout.write(dim(`[dry-run] Run from a session: ${line}\n`));
      else if (step.kind === 'opencode') process.stdout.write(dim(`[dry-run] Would refresh: ${step.path}\n`));
      else process.stdout.write(dim(`[dry-run] Would run: ${step.cmd.join(' ')}\n`));
    }
    return;
  }
  // The hosts are independent: a failed `claude plugin update` says nothing
  // about the OpenCode file, so every step runs and the failures are reported
  // together at the end. Stopping at the first one left OpenCode stale behind a
  // Claude registry problem — silently, since the abort said nothing about the
  // steps it never reached.
  let ran = false;
  const failures = [];
  const failedKinds = new Set();
  for (const s of steps) {
    if (s.kind === 'skip') {
      process.stdout.write(dim(`skip: ${s.reason}\n`));
      continue;
    }
    if (s.kind === 'manual') {
      process.stdout.write(`${yellow(s.reason)} — run these from a Claude Code session:\n`);
      for (const line of s.lines) process.stdout.write(`  ${line}\n`);
      continue;
    }
    if (s.needs && failedKinds.has(s.needs)) {
      process.stdout.write(dim(`skip: ${s.cmd.join(' ')} — the ${s.needs} step it depends on failed\n`));
      continue;
    }
    if (s.kind === 'opencode') {
      const result = installOpencodePlugin({ version: pkg.version });
      process.stdout.write(dim(`refreshed opencode integration → ${pkg.version}  ${result.path}\n`));
      ran = true;
      continue;
    }
    if (s.reason) process.stdout.write(dim(`${s.reason}\n`));
    process.stdout.write(dim(`$ ${s.cmd.join(' ')}\n`));
    const r = spawnSync(executableName(s.cmd[0]), s.cmd.slice(1), {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    ran = true;
    if (r.status !== 0) {
      failedKinds.add(s.kind);
      failures.push(s);
      process.stdout.write(yellow(`(${s.cmd[0]} exited ${r.status ?? '?'})\n`));
      if (s.kind === 'marketplace') for (const line of claudeMarketplaceRefusalHint(plugin?.marketplace)) process.stdout.write(yellow(`${line}\n`));
    }
  }
  if (failures.length) {
    process.stdout.write(yellow(`\n${failures.length === 1 ? '1 step' : `${failures.length} steps`} failed: ${failures.map(s => s.cmd.join(' ')).join('; ')}\n`));
    if (ran && failures.length < steps.filter(s => s.kind !== 'skip' && s.kind !== 'manual').length) {
      process.stdout.write(dim('the other steps completed; restart your Claude Code session (or /reload-plugins) to apply them.\n'));
    }
    process.exitCode = 1;
    return;
  }
  if (ran) {
    process.stdout.write(green('\n✓ restart your Claude Code session (or /reload-plugins) to apply.\n'));
  }
}
