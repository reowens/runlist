import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { green, dim, yellow } from './color.mjs';

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
export function readInstalledPlugin(opts = {}) {
  const home = opts.home || os.homedir();
  const file = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    const plugins = j.plugins || {};
    const id = plugins[DEFAULT_PLUGIN_ID]
      ? DEFAULT_PLUGIN_ID
      : Object.keys(plugins).find(k => /^dotmd@/.test(k));
    if (!id) return null;
    const entry = Array.isArray(plugins[id]) ? plugins[id][0] : plugins[id];
    return { id, version: entry?.version ?? null };
  } catch {
    return null;
  }
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
  }
  return steps;
}

function which(bin) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    return spawnSync(cmd, [bin], { encoding: 'utf8' }).status === 0;
  } catch {
    return false;
  }
}

export function runUpdate(argv, _config) {
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
      process.stdout.write(dim('dotmd plugin: not installed\n'));
    }
    return;
  }

  const steps = planUpdate({ cliOnly, pluginOnly }, { plugin, hasClaude: which('claude'), hasNpm: which('npm') });
  let ran = false;
  for (const s of steps) {
    if (s.kind === 'skip') {
      process.stdout.write(dim(`skip: ${s.reason}\n`));
      continue;
    }
    process.stdout.write(dim(`$ ${s.cmd.join(' ')}\n`));
    const r = spawnSync(s.cmd[0], s.cmd.slice(1), { stdio: 'inherit' });
    ran = true;
    if (r.status !== 0) process.stdout.write(yellow(`(${s.cmd[0]} exited ${r.status ?? '?'})\n`));
  }
  if (ran) {
    process.stdout.write(green('\n✓ restart your Claude Code session (or /reload-plugins) to apply.\n'));
  }
}
