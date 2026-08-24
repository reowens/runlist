#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PACKAGE = 'dotmd-cli';

export function parseExecutablePaths(output) {
  return [...new Set(String(output ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean))];
}

export function buildSyncPlan(entries, targetVersion) {
  return entries.map(entry => ({
    ...entry,
    needsInstall: entry.version !== targetVersion
      || entry.runlistVersion !== targetVersion
      || entry.rlVersion !== targetVersion,
    canInstall: entry.managed !== false && Boolean(entry.npmPath && entry.prefix),
  }));
}

function discoverDotmdPaths() {
  const names = process.platform === 'win32' ? ['dotmd.cmd', 'dotmd.exe', 'dotmd'] : ['dotmd'];
  const paths = [];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) paths.push(candidate);
    }
  }
  return [...new Set(paths)];
}

function readVersion(dotmdPath) {
  const result = spawnSync(dotmdPath, ['--version'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function siblingExecutable(dotmdPath, name) {
  const ext = process.platform === 'win32' ? path.extname(dotmdPath) : '';
  const candidate = path.join(path.dirname(dotmdPath), `${name}${ext}`);
  return existsSync(candidate) ? candidate : null;
}

function siblingNpm(dotmdPath) {
  const npmName = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const candidate = path.join(path.dirname(dotmdPath), npmName);
  return existsSync(candidate) ? candidate : null;
}

// This script runs from `npm version`'s postversion lifecycle, and npm exports
// its own resolved config into the environment as npm_config_* (plus
// npm_lifecycle_*/npm_package_*). A child npm INHERITS those and lets them win
// over its own npmrc — so asking a sibling npm "what is your global prefix?"
// answered with the RELEASE SHELL's prefix instead. With two Node installs
// (NVM + Homebrew), the second npm claimed the first's prefix, failed
// isNpmManagedGlobalPath, was skipped as "tool-managed", and then failed the
// release as stale. `npm run release:resume` inherits the same variables, so it
// could not recover either. Strip them before spawning any sibling npm.
export function cleanNpmEnv(binDir) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^npm_(config|lifecycle|package)_/i.test(key) || key.toLowerCase() === 'npm_config_prefix') delete env[key];
  }
  env.PATH = [binDir, process.env.PATH ?? ''].filter(Boolean).join(delimiter);
  return env;
}

function npmGlobalPrefix(npmPath) {
  if (!npmPath) return null;
  const env = cleanNpmEnv(path.dirname(npmPath));
  const result = spawnSync(npmPath, ['prefix', '-g'], { env, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() ? path.resolve(result.stdout.trim()) : null;
}

function npmGlobalRoot(npmPath) {
  if (!npmPath) return null;
  const env = cleanNpmEnv(path.dirname(npmPath));
  const result = spawnSync(npmPath, ['root', '-g'], { env, encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim() ? path.resolve(result.stdout.trim()) : null;
}

export function isNpmManagedGlobalPath(dotmdPath, prefix, globalRoot, opts = {}) {
  if (!prefix || !globalRoot) return false;
  const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
  const actual = normalize(path.resolve(dotmdPath));
  const candidates = process.platform === 'win32'
    ? ['dotmd', 'dotmd.cmd', 'dotmd.ps1'].map(name => normalize(path.resolve(prefix, name)))
    : [path.resolve(prefix, 'bin', 'dotmd')];
  if (!candidates.includes(actual)) return false;

  const packageRoot = normalize(path.resolve(globalRoot, PACKAGE));
  if (process.platform === 'win32') {
    try {
      return normalize(readFileSync(dotmdPath, 'utf8')).includes(normalize(path.join('node_modules', PACKAGE)));
    } catch {
      return false;
    }
  }

  try {
    const resolveRealpath = opts.realpath ?? realpathSync;
    const target = normalize(resolveRealpath(dotmdPath));
    const rel = path.relative(packageRoot, target);
    return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

export function prefixForDotmd(dotmdPath) {
  const binDir = path.dirname(dotmdPath);
  return path.basename(binDir).toLowerCase() === 'bin' ? path.dirname(binDir) : binDir;
}

export function inspectGlobalCliCopies() {
  return discoverDotmdPaths().map(dotmdPath => {
    const npmPath = siblingNpm(dotmdPath);
    const runlistPath = siblingExecutable(dotmdPath, 'runlist');
    const rlPath = siblingExecutable(dotmdPath, 'rl');
    const prefix = npmGlobalPrefix(npmPath);
    const globalRoot = npmGlobalRoot(npmPath);
    return {
      dotmdPath,
      version: readVersion(dotmdPath),
      runlistPath,
      runlistVersion: runlistPath ? readVersion(runlistPath) : null,
      rlPath,
      rlVersion: rlPath ? readVersion(rlPath) : null,
      npmPath,
      prefix,
      globalRoot,
      managed: isNpmManagedGlobalPath(dotmdPath, prefix, globalRoot),
    };
  });
}

function installWithSiblingNpm(entry, targetVersion) {
  // Same inheritance problem as the probes above: npm_config_prefix from the
  // release lifecycle would redirect this install back to the release shell's
  // prefix, silently "installing" into the copy that was already current.
  const env = cleanNpmEnv(path.dirname(entry.npmPath));
  return spawnSync(entry.npmPath, ['install', '-g', '--prefix', entry.prefix, `${PACKAGE}@${targetVersion}`], {
    env,
    stdio: 'inherit',
  });
}

export function syncGlobalCliCopies(targetVersion, deps = {}) {
  const inspect = deps.inspect ?? inspectGlobalCliCopies;
  const install = deps.install ?? installWithSiblingNpm;
  const write = deps.write ?? (text => process.stdout.write(text));
  const initial = buildSyncPlan(inspect(), targetVersion);
  const managed = initial.filter(entry => entry.managed !== false);
  if (managed.length === 0) {
    throw new Error('No npm-managed global `dotmd` executable is visible on PATH after global install.');
  }

  for (const entry of initial) {
    if (entry.managed === false) {
      write(`⚠ skipping non-global or tool-managed executable ${entry.dotmdPath}\n`);
      continue;
    }
    if (!entry.needsInstall) {
      write(`  ${entry.dotmdPath} + ${entry.runlistPath} + ${entry.rlPath}: ${targetVersion}\n`);
      continue;
    }
    if (!entry.canInstall) {
      throw new Error(
        `${entry.dotmdPath} reports ${entry.version ?? 'unknown'}, but no sibling npm was found to update it.`,
      );
    }

    write(`→ synchronizing shadowed CLI ${entry.dotmdPath} (dotmd ${entry.version ?? 'unknown'}, runlist ${entry.runlistVersion ?? 'missing'}, rl ${entry.rlVersion ?? 'missing'} → ${targetVersion})\n`);
    const result = install(entry, targetVersion);
    if (result.status !== 0) {
      throw new Error(`Failed to update ${entry.dotmdPath} with ${entry.npmPath}.`);
    }
  }

  const final = inspect();
  const mismatches = final.filter(entry => entry.version !== targetVersion
    || entry.runlistVersion !== targetVersion
    || entry.rlVersion !== targetVersion);
  if (mismatches.length > 0) {
    throw new Error(`PATH still contains stale or incomplete runlist bridge installations:\n${mismatches
      .map(entry => `  ${entry.dotmdPath}: dotmd=${entry.version ?? 'unknown'} runlist=${entry.runlistVersion ?? 'missing'} rl=${entry.rlVersion ?? 'missing'} (wanted ${targetVersion})`)
      .join('\n')}`);
  }

  write(`✓ all ${final.length} PATH-visible dotmd/runlist/rl installation set${final.length === 1 ? '' : 's'} report ${targetVersion}\n`);
  return final;
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? '')) {
  const targetVersion = process.argv[2];
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(targetVersion ?? '')) {
    process.stderr.write('Usage: node scripts/sync-global-cli.mjs <version>\n');
    process.exit(2);
  }
  try {
    syncGlobalCliCopies(targetVersion);
  } catch (err) {
    process.stderr.write(`✗ ${err.message}\n`);
    process.exit(1);
  }
}
