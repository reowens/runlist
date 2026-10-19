import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function prepareCargoVersion(desktop, version) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) throw new Error('Invalid desktop version.');
  const manifestPath = path.join(desktop, 'src-tauri/Cargo.toml');
  const lockPath = path.join(desktop, 'src-tauri/Cargo.lock');
  const manifest = readFileSync(manifestPath, 'utf8');
  const name = manifest.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
  if (!name || !/^version\s*=\s*"[^"]+"/m.test(manifest)) throw new Error('Missing desktop package identity.');
  let matches = 0;
  const lock = readFileSync(lockPath, 'utf8').split(/(?=^\[\[package\]\])/m).map(block => {
    if (block.match(/^name = "([^"]+)"/m)?.[1] !== name) return block;
    matches++;
    if (!/^version = "[^"]+"/m.test(block)) throw new Error('Missing desktop lock version.');
    return block.replace(/^(version = ")[^"]+("\r?$)/m, `$1${version}$2`);
  }).join('');
  if (matches !== 1) throw new Error('Expected one desktop package in Cargo.lock.');
  return [
    { file: manifestPath, content: manifest.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${version}"`) },
    { file: lockPath, content: lock },
  ];
}

export function syncCargoVersion(desktop, version) {
  for (const { file, content } of prepareCargoVersion(desktop, version)) writeFileSync(file, content);
}

export function prepareDesktopVersionUpdates(repo, version) {
  const desktop = path.join(repo, 'desktop');
  if (!existsSync(path.join(desktop, 'package.json'))) return [];
  const updates = prepareCargoVersion(desktop, version);
  for (const relative of ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']) {
    const file = path.join(desktop, relative);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof json.version !== 'string') throw new Error(`Missing desktop version in ${relative}.`);
    json.version = version;
    if (relative === 'package-lock.json') {
      if (!json.packages?.['']) throw new Error('Missing desktop lock root package.');
      json.packages[''].version = version;
    }
    updates.push({ file, content: JSON.stringify(json, null, 2) + '\n' });
  }
  return updates;
}

export function syncDesktopVersions(repo, version) {
  const updates = prepareDesktopVersionUpdates(repo, version);
  for (const { file, content } of updates) writeFileSync(file, content);
  return updates.map(({ file }) => path.relative(repo, file));
}
