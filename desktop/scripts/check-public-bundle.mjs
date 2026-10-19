import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { inspectPublicText, privateVocabularyAvailable } from '../../scripts/public-content.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

// Code signatures change Mach-O linkedit bookkeeping, not executable payload.
function payloadHash(original) {
  const bytes = Buffer.from(original);
  if (bytes.readUInt32LE(0) !== 0xfeedfacf) throw new Error('Expected a 64-bit Mach-O runtime.');
  let at = 32, signature;
  const count = bytes.readUInt32LE(16);
  if (count > 512) throw new Error('Invalid Mach-O load commands.');
  for (let i = 0; i < count; i++) {
    const command = bytes.readUInt32LE(at), size = bytes.readUInt32LE(at + 4);
    if (size < 8 || at + size > bytes.length) throw new Error('Invalid Mach-O load command.');
    if (command === 0x1d) {
      signature = bytes.readUInt32LE(at + 8);
      bytes.writeUInt32LE(0, at + 8); bytes.writeUInt32LE(0, at + 12);
    }
    if (command === 0x19 && bytes.subarray(at + 8, at + 24).toString().replace(/\0+$/, '') === '__LINKEDIT') {
      bytes.writeBigUInt64LE(0n, at + 32); bytes.writeBigUInt64LE(0n, at + 48);
    }
    at += size;
  }
  if (!signature || signature > bytes.length) throw new Error('Invalid Mach-O signature range.');
  return sha(bytes.subarray(0, signature));
}

export function checkPublicBundle(app, repo) {
  if (!privateVocabularyAvailable) throw new Error('Desktop publication requires the private vocabulary key.');
  const pin = JSON.parse(readFileSync(path.join(repo, 'desktop/runtime-lock.json'), 'utf8'));
  const vendor = path.join(repo, 'desktop/.cache', `node-${pin.version}-darwin-arm64/bin/node`);
  const runtime = 'Contents/Resources/engine/runtime/RunlistHelper';
  const acorn = 'Contents/Resources/engine/desktop/node_modules/acorn/package.json';
  const runtimeMatches = existsSync(vendor) && payloadHash(readFileSync(path.join(app, runtime))) === payloadHash(readFileSync(vendor));
  const acornMatches = sha(readFileSync(path.join(app, acorn))) === sha(readFileSync(path.join(repo, 'desktop/node_modules/acorn/package.json')));
  if (!runtimeMatches || !acornMatches) throw new Error('Bundled vendor inputs differ from the pinned build inputs.');
  const findings = [], inventory = [];
  const scan = (text, file) => {
    for (const finding of inspectPublicText(text.replaceAll('/build/home/', '/build/neutral-home/'), file)) {
      if (file === runtime && finding.category === 'personal absolute path' && runtimeMatches) continue;
      if (file === acorn && finding.category === 'contact address in public metadata' && acornMatches) continue;
      findings.push({ file, category: finding.category });
    }
  };
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name), relative = path.relative(app, file).split(path.sep).join('/');
      const stat = lstatSync(file);
      if (stat.isDirectory()) { walk(file); continue; }
      if (!stat.isFile()) throw new Error('Unexpected nonregular desktop resource.');
      const bytes = readFileSync(file);
      inventory.push({ file: relative, sha256: sha(bytes), bytes: bytes.length });
      scan(relative, relative);
      if (!bytes.includes(0)) { scan(bytes.toString('utf8'), relative); continue; }
      for (let at = 0; at < bytes.length; at += 512 * 1024) {
        const piece = bytes.subarray(Math.max(0, at - 1024), at + 512 * 1024);
        scan((piece.toString('latin1').match(/[\x20-\x7e]{4,}/g) ?? []).join('\n'), relative);
        for (const offset of [0, 1]) scan((piece.subarray(offset).toString('utf16le').match(/[\x20-\x7e]{4,}/g) ?? []).join('\n'), relative);
      }
    }
  }
  walk(app);
  const unique = [...new Map(findings.map(item => [JSON.stringify(item), item])).values()];
  if (unique.length) throw new Error('Desktop public content check failed:\n' + unique.map(item => `${item.file}: ${item.category}`).join('\n'));
  return { files: inventory.length, inventory, runtimeMatches, acornMatches, privateVocabularyAvailable };
}
