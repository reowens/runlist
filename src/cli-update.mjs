import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { LEGACY_PRODUCT_NAME } from './naming.mjs';
import { persistentCliOnPath } from './installation.mjs';
import { isLocalCLIReceipt, preparePublishedCLI, selectLocalCLI, validateLocalCLI } from './local-cli.mjs';

const windows = process.platform === 'win32';

function metadata(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function classifyCli(env) {
  const { path: launcher } = persistentCliOnPath({ env });
  if (!launcher) throw new Error('No persistent Runlist CLI found on PATH');
  let entry = realpathSync(launcher);
  // npm on Windows writes sh/cmd/PowerShell launchers alongside node_modules.
  if (windows && /^(?:runlist|dotmd)(?:\.cmd)?$/i.test(path.basename(entry)) && /node_modules[\\/]runlist[\\/]bin[\\/](?:runlist|dotmd)\.mjs/i.test(readFileSync(entry, 'utf8'))) {
    entry = realpathSync(path.join(path.dirname(launcher), 'node_modules/runlist/bin/runlist.mjs'));
  }
  const root = path.dirname(path.dirname(entry));
  const pkg = metadata(path.join(root, 'package.json'));
  if (pkg?.name === 'runlist' && ['bin/runlist.mjs', `bin/${LEGACY_PRODUCT_NAME}.mjs`].includes(path.relative(root, entry).split(path.sep).join('/'))) {
    const common = { entry, launcher, version: pkg.version, root };
    if (existsSync(path.join(root, '.git'))) return { ...common, kind: 'checkout' };
    const directory = path.dirname(root);
    const receipt = metadata(path.join(directory, 'receipt.json'));
    if (path.basename(root) === 'package' && isLocalCLIReceipt(receipt) && receipt.version === pkg.version) {
      return { ...common, kind: 'pinned', receipt, directory, artifacts: path.dirname(directory), previous: readlinkSync(launcher) };
    }
    const suffix = windows ? 'node_modules/runlist' : 'lib/node_modules/runlist';
    const prefix = path.resolve(root, ...suffix.split('/').map(() => '..'));
    if (root === path.join(prefix, suffix)) return { ...common, kind: 'global', prefix };
  }
  throw new Error(`Unrecognized Runlist installation: ${launcher} → ${entry}`);
}

function output(run, command, args, env, options = {}) {
  const settings = { encoding: 'utf8', env, timeout: 120000, ...options };
  let result;
  if (windows && /\.cmd$/i.test(command)) {
    // cmd launchers need cmd.exe. Expand each argument inside quotes so a
    // PATH directory containing spaces or an ampersand stays one argument.
    const variables = [command, ...args];
    settings.env = { ...env };
    const quoted = variables.map((value, index) => {
      const key = 'RUNLIST_UPDATE_ARG_' + index;
      settings.env[key] = value;
      return '"%' + key + '%"';
    });
    settings.windowsVerbatimArguments = true;
    result = run(env.ComSpec || 'cmd.exe', ['/d', '/s', '/v:off', '/c', '"' + quoted.join(' ') + '"'], settings);
  } else {
    result = run(command, args, settings);
  }
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message || result.stderr || result.status}`);
  return String(result.stdout ?? '').trim();
}

export function updatePathCli(target, env, run) {
  const npm = windows ? 'npm.cmd' : 'npm';
  const invoke = args => output(run, npm, args, env);
  if (target.kind === 'global') {
    const prefix = target.prefix;
    for (const dir of [prefix, path.dirname(target.root), target.root, path.dirname(target.launcher)]) {
      try { accessSync(dir, constants.W_OK); } catch { throw new Error(`Cannot update npm prefix ${prefix}: ${dir} is not writable`); }
    }
    const npmPrefix = invoke(['prefix', '-g']);
    if (!npmPrefix || realpathSync(npmPrefix) !== prefix) throw new Error(`npm prefix ${npmPrefix} differs from PATH installation prefix ${prefix}`);
  }
  const info = JSON.parse(invoke(['view', 'runlist@latest', 'version', 'dist.integrity', '--json']));
  const version = info.version;
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error('Invalid published Runlist version');
  if (target.kind === 'global') {
    invoke(['i', '-g', `runlist@${version}`]);
  } else {
    const integrity = info['dist.integrity'] ?? info.dist?.integrity;
    if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) throw new Error('Missing published SHA-512 integrity');
    if (target.receipt.source?.integrity === integrity && target.version === version) {
      const bytes = readFileSync(path.join(target.directory, 'receipt.json'));
      validateLocalCLI({ directory: target.directory, manifestSha256: createHash('sha256').update(bytes).digest('hex') });
    } else {
      const candidate = preparePublishedCLI({ artifacts: target.artifacts, version, integrity, pack(directory) {
        const packed = JSON.parse(invoke(['pack', `runlist@${version}`, '--ignore-scripts', '--json', '--pack-destination', directory]));
        const entries = Object.values(packed);
        if (entries.length !== 1 || !/^[\w.-]+\.tgz$/.test(entries[0]?.filename ?? '')) throw new Error('Unexpected npm pack output');
        return entries[0].filename;
      } });
      selectLocalCLI({ ...candidate, link: target.launcher, previous: target.previous });
    }
  }
  const selected = classifyCli(env);
  const actual = launcherVersion(selected.launcher, env, run);
  if (selected.launcher !== target.launcher || selected.version !== version || actual !== version) throw new Error(`PATH CLI ${selected.launcher} reports ${actual}; expected ${version}`);
  return selected;
}

function launcherVersion(file, env, run) {
  if (windows && !path.extname(file)) file += '.cmd';
  return output(run, file, ['--version'], env, { timeout: 5000 });
}

export function warnOtherVersions(selected, env, run) {
  const seen = new Set([realpathSync(selected.launcher)]);
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of ['runlist', 'rl', LEGACY_PRODUCT_NAME]) {
      const file = path.resolve(dir, windows ? name + '.cmd' : name);
      try {
        accessSync(file, constants.X_OK);
        const real = realpathSync(file);
        if (seen.has(real)) continue;
        seen.add(real);
        const version = launcherVersion(file, env, run);
        if (version !== selected.version) process.stderr.write(`Warning: ${file} reports ${version}; selected CLI is ${selected.version}\n`);
      } catch { /* PATH entries may be missing or unavailable. */ }
    }
  }
}
