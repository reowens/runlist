import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { planClaudeProfileUpdates, publishedClaudePluginStatus, readInstalledPlugin, verifyPluginScopeUpdates } from '../src/update.mjs';
import { discoverClaudeProfiles, discoverHostExecutables } from '../src/agent-hosts.mjs';
import os from 'node:os';
import { executableName } from '../src/util.mjs';

// Release and CLI updates share scope planning and fresh-record verification.
export function updateInstalledPluginVersion(expectedVersion, opts = {}) {
  if (!expectedVersion) return { ok: false, reason: 'an expected plugin version is required' };
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? (opts.home ? { ...process.env, CLAUDE_CONFIG_DIR: undefined } : process.env);
  const configDirs = (opts.claudeConfigDirs ?? (opts.configDir ? [opts.configDir] : [])).map(dir => path.resolve(dir));
  const discovered = discoverClaudeProfiles({ home, env, configDirs });
  const profiles = discovered.flatMap(profile => {
    const selected = configDirs.find(dir => (profile.configDirs ?? [profile.configDir]).includes(dir));
    return configDirs.length && !selected ? [] : [{ ...profile, configDir: selected ?? profile.configDir }];
  }).filter(profile => profile.installed?.id === 'runlist@runlist' || profile.registryState === 'unreadable');
  if (!profiles.length) return { ok: false, reason: 'runlist@runlist plugin is not installed' };
  const inventory = opts.executables ?? discoverHostExecutables({ home, env, claudeBin: opts.claudeBin });
  const run = opts.run ?? spawnSync;
  const log = opts.log ?? (line => process.stdout.write(`${line}\n`));
  const failures = [], failed = new Set();
  for (const step of planClaudeProfileUpdates(profiles, inventory.claude, { home, explicit: configDirs.length > 0 })) {
    if (!step.cmd) {
      failures.push(step.reason); log(step.reason); continue;
    }
    if (step.needs && failed.has(`${step.dependencyKey}:${step.needs}`)) continue;
    log(`$ ${step.cmd.join(' ')}${step.cwd ? ` (in ${step.cwd})` : ''} [CLAUDE_CONFIG_DIR=${step.profile}]`);
    const result = run(path.isAbsolute(step.cmd[0]) ? step.cmd[0] : executableName(step.cmd[0]), step.cmd.slice(1), {
      stdio: 'inherit', shell: process.platform === 'win32' && (!path.isAbsolute(step.cmd[0]) || /\.(?:cmd|bat)$/i.test(step.cmd[0])), ...(step.cwd ? { cwd: step.cwd } : {}),
      env: { ...env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: step.profile },
    });
    if (result.status !== 0) {
      failed.add(`${step.dependencyKey}:${step.kind}`);
      failures.push(`${step.profile}; ${step.scope ?? step.kind}: ${result.error?.message ?? `claude exited ${result.status ?? '?'}`}${step.cwd ? ` (in ${step.cwd})` : ''}`);
    }
  }
  for (const profile of profiles) {
    if (profile.registryState === 'unreadable') continue;
    const after = readInstalledPlugin({ home, configDir: profile.configDir, env });
    const verified = verifyPluginScopeUpdates(profile.installed, after, { expectedVersion });
    if (!verified.ok) failures.push(`${profile.configDir}: ${verified.reason}`);
    if (after && publishedClaudePluginStatus(after, profile).state === 'mismatch') failures.push(`${profile.configDir}: installed Claude assets differ from the registered official catalog`);
  }
  return failures.length ? { ok: false, reason: failures.join('; ') } : { ok: true };
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const version = process.argv[2];
  if (!version) {
    process.stderr.write('usage: node scripts/update-installed-plugin.mjs <version>\n');
    process.exitCode = 2;
  } else {
    const result = updateInstalledPluginVersion(version);
    if (result.ok) process.stdout.write(`runlist plugin ${version} verified across all installed scopes\n`);
    else { process.stderr.write(`${result.reason}\n`); process.exitCode = 1; }
  }
}
