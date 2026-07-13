import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readInstalledPluginRecords } from '../src/update.mjs';

export function verifyInstalledPluginVersion(expectedVersion, opts = {}) {
  const plugin = readInstalledPluginRecords({ ...opts, id: 'dotmd@dotmd' });
  if (!plugin || plugin.entries.length === 0) {
    return { ok: false, reason: 'dotmd@dotmd plugin is not installed' };
  }
  const mismatches = plugin.entries.filter(entry => entry.version !== expectedVersion);
  if (mismatches.length > 0) {
    return {
      ok: false,
      reason: `${plugin.id} has ${mismatches.map(entry => entry.version ?? 'unknown').join(', ')}, expected ${expectedVersion}`,
    };
  }
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
      process.stdout.write(`dotmd plugin ${result.plugin.version} (${result.plugin.id}) verified\n`);
    } else {
      process.stderr.write(`${result.reason}\n`);
      process.exitCode = 1;
    }
  }
}
