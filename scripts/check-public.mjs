import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPublicFiles, privateVocabularyAvailable } from './public-content.mjs';

export function packagePaths(inventory) {
  const packages = Array.isArray(inventory) ? inventory : Object.values(inventory ?? {});
  if (!packages.length || packages.some(pkg => !Array.isArray(pkg?.files) || !pkg.files.length ||
    pkg.files.some(file => typeof file?.path !== 'string' || !file.path))) {
    throw new Error('npm returned an incomplete package inventory.');
  }
  return packages.flatMap(pkg => pkg.files.map(file => file.path));
}

export function checkPublic(root = path.resolve(import.meta.dirname, '..')) {
  if (process.env.RUNLIST_REQUIRE_PUBLIC_CHECK_KEY === '1' && !privateVocabularyAvailable) {
    throw new Error('The publishing privacy check requires RUNLIST_PUBLIC_CHECK_KEY.');
  }
  const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  // Disable lifecycle scripts here so prepack can call this check without recursion.
  const packages = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    shell: process.platform === 'win32',
  }));
  const packed = packagePaths(packages);
  const findings = inspectPublicFiles(root, [...tracked, ...packed]);
  if (findings.length) {
    throw new Error('Public content check failed:\n' + findings.map(item =>
      `  ${item.file}${item.line ? ':' + item.line : ''}: ${item.category}`).join('\n'));
  }
  return { sourceFiles: new Set(tracked).size, packageFiles: new Set(packed).size, privateVocabularyAvailable };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const checked = checkPublic();
    console.error(`Public content checked: ${checked.sourceFiles} source files, ${checked.packageFiles} package files.`);
    if (!checked.privateVocabularyAvailable) console.error('Private vocabulary checks require the local key or CI secret; generic checks passed.');
  } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}
