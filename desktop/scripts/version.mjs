import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function syncCargoVersion(desktop, version) {
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
  writeFileSync(manifestPath, manifest.replace(/^(version\s*=\s*)"[^"]+"/m, `$1"${version}"`));
  writeFileSync(lockPath, lock);
}
