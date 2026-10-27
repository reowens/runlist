import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export function saveReceipt(file, value) {
  writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(file + '.tmp', file);
}

// Persist Apple's request ID before waiting. A resume waits for that same
// request and refuses to attach an old request to different bytes.
// `credentials` is the App Store Connect key from notaryCredentials()
// (scripts/desktop-release-config.mjs), which has already checked its team.
export function notarizeArtifact(artifact, credentials, file, exec = execFileSync) {
  const sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex');
  let receipt = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  if (receipt && receipt.sha256 !== sha256) throw new Error('Notarization artifact changed; preserve the request and use a new release directory.');
  const run = args => JSON.parse(exec('/usr/bin/xcrun', ['notarytool', ...args, '--key', credentials.key, '--key-id', credentials.keyId, '--issuer', credentials.issuer, '--output-format', 'json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  }));
  if (!receipt) {
    const submitted = run(['submit', artifact, '--no-progress']);
    if (!/^[a-f0-9-]{36}$/i.test(submitted.id ?? '')) throw new Error('Apple did not return a notarization request ID.');
    receipt = { artifact, sha256, id: submitted.id, status: submitted.status };
    saveReceipt(file, receipt);
  }
  if (receipt.status !== 'Accepted') {
    const result = run(['wait', receipt.id, '--timeout', '15m']);
    receipt.status = result.status;
    saveReceipt(file, receipt);
  }
  if (receipt.status !== 'Accepted') throw new Error(`Notarization ${receipt.id} was ${receipt.status ?? 'not accepted'}; inspect that request before resuming.`);
  return receipt;
}
