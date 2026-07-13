import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function intentPath(projectRoot) {
  const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-dir'], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(result.stderr.trim() || 'cannot locate Git directory');
  return path.join(result.stdout.trim(), 'dotmd-release-intent.json');
}

export function writeReleaseIntent(projectRoot, intent) {
  writeFileSync(intentPath(projectRoot), JSON.stringify({ schemaVersion: 1, ...intent }, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
}

export function readReleaseIntent(projectRoot) {
  const file = intentPath(projectRoot);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function clearReleaseIntent(projectRoot) {
  rmSync(intentPath(projectRoot), { force: true });
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const root = process.cwd();
  const command = process.argv[2];
  try {
    if (command === 'verify') {
      const expected = process.argv[3];
      const intent = readReleaseIntent(root);
      if (!intent || intent.newVersion !== expected) {
        throw new Error(`release intent does not match ${expected ?? 'missing version'}`);
      }
    } else if (command === 'clear') {
      clearReleaseIntent(root);
    } else {
      throw new Error('usage: release-intent.mjs verify <version> | clear');
    }
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}
