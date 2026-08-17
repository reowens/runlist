import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { green, dim, yellow } from './color.mjs';
import { executableName, which } from './util.mjs';
import { installOpencodePlugin, opencodeStatus } from './host-integration.mjs';

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

export function readInstalledPlugin(opts = {}) {
  const records = readInstalledPluginRecords(opts);
  if (!records) return null;
  return { id: records.id, version: records.entries[0]?.version ?? null };
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
      steps.push({ kind: 'skip', reason: 'dotmd plugin not installed — skipping plugin update' });
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
      steps.push({ kind: 'skip', reason: `${ctx.opencode.path} was not written by dotmd — leaving it alone` });
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
    process.stdout.write(`dotmd CLI:    ${pkg.version}\n`);
    if (plugin) {
      const cmp = compareVersions(plugin.version, pkg.version);
      const tag = cmp === 0 ? green('in sync')
        : cmp === null ? dim('(unknown)')
        : cmp < 0 ? yellow('behind — run `dotmd update`')
        : yellow('ahead — CLI is behind');
      process.stdout.write(`dotmd plugin: ${plugin.version ?? '?'} (${plugin.id}) ${tag}\n`);
    } else {
      process.stdout.write(dim('dotmd plugin: not installed — `dotmd install claude`\n'));
    }
    const oc = opencodeStatus({ version: pkg.version });
    if (!oc.exists) process.stdout.write(dim('dotmd opencode: not installed\n'));
    else if (oc.foreign) process.stdout.write(`dotmd opencode: ${yellow('unmanaged file — not written by dotmd')}\n`);
    else process.stdout.write(`dotmd opencode: ${oc.version} ${oc.stale ? yellow('behind — run `dotmd update`') : green('in sync')}\n`);
    return;
  }

  const opencode = opencodeStatus({ version: pkg.version });
  const steps = planUpdate({ cliOnly, pluginOnly }, { plugin, opencode, hasClaude: which('claude'), hasNpm: which('npm') });
  if (opts.dryRun) {
    for (const step of steps) {
      if (step.kind === 'skip') process.stdout.write(dim(`[dry-run] skip: ${step.reason}\n`));
      else if (step.kind === 'opencode') process.stdout.write(dim(`[dry-run] Would refresh: ${step.path}\n`));
      else process.stdout.write(dim(`[dry-run] Would run: ${step.cmd.join(' ')}\n`));
    }
    return;
  }
  let ran = false;
  let failed = false;
  for (const s of steps) {
    if (s.kind === 'skip') {
      process.stdout.write(dim(`skip: ${s.reason}\n`));
      continue;
    }
    if (s.kind === 'opencode') {
      const result = installOpencodePlugin({ version: pkg.version });
      process.stdout.write(dim(`refreshed opencode integration → ${pkg.version}  ${result.path}\n`));
      ran = true;
      continue;
    }
    process.stdout.write(dim(`$ ${s.cmd.join(' ')}\n`));
    const r = spawnSync(executableName(s.cmd[0]), s.cmd.slice(1), {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    ran = true;
    if (r.status !== 0) {
      failed = true;
      process.stdout.write(yellow(`(${s.cmd[0]} exited ${r.status ?? '?'})\n`));
      break;
    }
  }
  if (ran && !failed) {
    process.stdout.write(green('\n✓ restart your Claude Code session (or /reload-plugins) to apply.\n'));
  }
  if (failed) process.exitCode = 1;
}
