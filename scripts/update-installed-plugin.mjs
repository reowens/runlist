import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { planPluginUpdates, readInstalledPluginRecords, verifyPluginScopeUpdates } from '../src/update.mjs';
import { executableName } from '../src/util.mjs';

// Release and CLI updates share scope planning and fresh-record verification.
export function updateInstalledPluginVersion(expectedVersion, opts = {}) {
  if (!expectedVersion) return { ok: false, reason: 'an expected plugin version is required' };
  const read = () => readInstalledPluginRecords({ home: opts.home, id: 'runlist@runlist' });
  const before = read();
  if (!before?.entries.length) return { ok: false, reason: 'runlist@runlist plugin is not installed' };
  const run = opts.run ?? spawnSync;
  const log = opts.log ?? (line => process.stdout.write(`${line}\n`));
  const failures = [];
  for (const step of planPluginUpdates(before)) {
    if (step.kind === 'refusal') {
      failures.push(step.reason);
      log(step.reason);
      continue;
    }
    log(`$ ${step.cmd.join(' ')}${step.cwd ? ` (in ${step.cwd})` : ''}`);
    const result = run(executableName(step.cmd[0]), step.cmd.slice(1), {
      stdio: 'inherit', shell: process.platform === 'win32', ...(step.cwd ? { cwd: step.cwd } : {}),
    });
    if (result.status !== 0) failures.push(`${step.scope}: ${result.error?.message ?? `claude exited ${result.status ?? '?'}`}${step.cwd ? ` (in ${step.cwd})` : ''}`);
  }
  const verified = verifyPluginScopeUpdates(before, read(), { expectedVersion });
  if (!verified.ok) failures.push(verified.reason);
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
