import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishedClaudePluginStatus } from '../src/update.mjs';
import { discoverClaudeProfiles } from '../src/agent-hosts.mjs';
import os from 'node:os';

export function verifyInstalledPluginVersion(expectedVersion, opts = {}) {
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? (opts.home ? {} : process.env);
  const configDirs = (opts.claudeConfigDirs ?? (opts.configDir ? [opts.configDir] : [])).map(dir => path.resolve(dir));
  const profiles = discoverClaudeProfiles({ home, env, configDirs }).filter(profile =>
    !configDirs.length || configDirs.some(dir => (profile.configDirs ?? [profile.configDir]).includes(dir)));
  const unreadable = profiles.filter(profile => profile.registryState === 'unreadable');
  if (unreadable.length) return { ok: false, reason: `Claude installed-plugin registry unreadable: ${unreadable.map(profile => profile.registryPath).join(', ')}` };
  const installed = profiles.map(profile => ({ profile, plugin: profile.plugins.find(item => item.id === 'runlist@runlist') })).filter(item => item.plugin);
  const plugin = installed.length ? { id: 'runlist@runlist', entries: installed.flatMap(item => item.plugin.entries) } : null;
  if (!plugin || plugin.entries.length === 0) {
    return { ok: false, reason: 'runlist@runlist plugin is not installed' };
  }
  const mismatches = plugin.entries.filter(entry => entry.version !== expectedVersion);
  if (mismatches.length > 0) {
    return {
      ok: false,
      reason: `${plugin.id} has ${mismatches.map(entry => entry.version ?? 'unknown').join(', ')}, expected ${expectedVersion}`,
    };
  }
  const drift = installed.filter(({ profile, plugin }) => publishedClaudePluginStatus(plugin, profile).state === 'mismatch');
  if (drift.length) return { ok: false, reason: `${drift.map(item => item.profile.configDir).join(', ')}: installed Claude assets differ from the registered official catalog` };
  return { ok: true, plugin: { id: plugin.id, version: expectedVersion } };
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const expectedVersion = process.argv[2];
  if (!expectedVersion) {
    process.stderr.write('usage: node scripts/verify-installed-plugin.mjs <version>\n');
    process.exitCode = 2;
  } else {
    const result = verifyInstalledPluginVersion(expectedVersion);
    if (result.ok) {
      process.stdout.write(`runlist plugin ${result.plugin.version} (${result.plugin.id}) verified\n`);
    } else {
      process.stderr.write(`${result.reason}\n`);
      process.exitCode = 1;
    }
  }
}
