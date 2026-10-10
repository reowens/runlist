import { createHash, createHmac } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Keyed fingerprints keep private vocabulary out of the repository and prevent
// identifying names by hashing guesses. The key is local/CI-only.
// Keep diagnostics limited to paths, line numbers and finding categories.
const PRIVATE_FINGERPRINTS = new Set([
  '4456e540ba47af8906520fa312084dad30451c32e887614bf9bafdc4f2b4c224',
  '47d9c885a72a12ab148fb5f8561f0417652d94e044574b999c56e237951b856e',
  'abce09f94a9050cbb40bddc651c6690b3ad616d0e0ea9b41a6f31943d4787285',
  '50bc81e6d2ade7d3398e52ee7a1ba9cdbed9108cc9be6d663e830a19060e0146',
  'b2413bc358f991e642c01b0ca0184ab19e24421cad3102e38902ed4a98a5588e',
  '876b227a6c1d10dbc4785a7e03b6fda35f242be99a707f8d4b9910972dd59b78',
  '1e4f1d75a0ae7b547412277a98221c4f9b79a6d04d46b443f2f22b9632224cdd',
  'd9d30e6c0fe3c142d5ca3f3acaa42ee46d01323b19bdbaa7ddd1b99564e4a4a8',
]);
let privateKey = process.env.RUNLIST_PUBLIC_CHECK_KEY ?? '';
if (!privateKey) {
  try { privateKey = readFileSync(new URL('../.runlist/public-content.key', import.meta.url), 'utf8').trim(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
export const privateVocabularyAvailable = Boolean(privateKey);
const fingerprint = (value, key) => (key ? createHmac('sha256', key) : createHash('sha256'))
  .update(value.toLowerCase()).digest('hex');
const PRIVATE_ROOT = /^(?:docs|\.runlist|\.dotmd|\.gmax|\.claude\/logs|desktop\/releases)(?:\/|$)/;
const CREDENTIAL_FILE = /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|[^/]*\.(?:pem|p12|pfx|key))$/;

export function inspectPublicText(text, file, { fingerprints = PRIVATE_FINGERPRINTS,
  key = fingerprints === PRIVATE_FINGERPRINTS ? privateKey : '' } = {}) {
  const findings = [];
  const fixture = /^(?:test|desktop\/test)\//.test(file);
  for (const [index, line] of text.split('\n').entries()) {
    const tokens = line.match(/[a-z0-9][a-z0-9._@+:/-]*/gi) ?? [];
    const candidates = tokens.flatMap(token => [token, ...token.split(/[.:/]/), ...token.split(/[._@+:/-]/)]);
    if (candidates.some(token => token && fingerprints.has(fingerprint(token, key)))) {
      findings.push({ file, line: index + 1, category: 'private vocabulary' });
    }
    const paths = line.match(/\/(?:Users|home)\/[a-z0-9._-]+/g) ?? [];
    if (paths.some(value => !fixture || !/\/(?:test|me|u|user|example)$/i.test(value))) {
      findings.push({ file, line: index + 1, category: 'personal absolute path' });
    }
    if (file.endsWith('.json') && !fixture && /"email"\s*:/.test(line)) {
      findings.push({ file, line: index + 1, category: 'contact address in public metadata' });
    }
  }
  return findings;
}

export function inspectPublicFiles(root, files, options) {
  const findings = [];
  for (const file of [...new Set(files)].sort()) {
    const normalized = file.split(path.sep).join('/');
    findings.push(...inspectPublicText(normalized, normalized, options));
    if (PRIVATE_ROOT.test(normalized) || CREDENTIAL_FILE.test(normalized)) {
      findings.push({ file: normalized, category: 'private file in public inventory' });
      continue;
    }
    const full = path.resolve(root, file);
    if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('Public inventory escapes the repository.');
    let stat;
    try { stat = lstatSync(full); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
    if (!stat.isFile()) {
      findings.push({ file: normalized, category: 'nonregular public file' });
      continue;
    }
    const bytes = readFileSync(full);
    const text = bytes.toString(bytes.includes(0) ? 'latin1' : 'utf8');
    findings.push(...inspectPublicText(text, normalized, options));
  }
  return findings;
}
