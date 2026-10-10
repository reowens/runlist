import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPublicationRelease } from '../scripts/publication-release.mjs';

const script = fileURLToPath(new URL('../scripts/publication-release.mjs', import.meta.url));

function fixture(t, body, helperName = 'local-helper') {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'publication-wrapper-'));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const helper = path.join(directory, helperName);
  const request = path.join(directory, 'request.json');
  const recorded = path.join(directory, 'recorded.json');
  const artifact = path.join(directory, 'artifact.bin');
  writeFileSync(request, JSON.stringify({ dryRun: true, artifact }), { mode: 0o600 });
  writeFileSync(artifact, Buffer.from([0, 1, 2, 255]), { mode: 0o600 });
  writeFileSync(helper, `#!${process.execPath}\n${body ?? `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(process.argv.slice(2)));
const request = JSON.parse(fs.readFileSync(process.argv[5], 'utf8'));
if (request.dryRun !== true) process.exit(1);
process.stdout.write(JSON.stringify({ schemaVersion: 1, command: process.argv[3], state: 'ready', dryRun: true }));
`}`, { mode: 0o700 });
  return { directory, helper, request, recorded, artifact };
}

function args(f, command = 'check') {
  return [command, '--helper', f.helper, '--request', f.request];
}

test('each local command forwards only fixed arguments and preserves dry-run inputs', async t => {
  const f = fixture(t);
  const originalRequest = readFileSync(f.request);
  const originalArtifact = readFileSync(f.artifact);
  for (const command of ['check', 'prepare', 'release', 'reconcile', 'remove']) {
    const result = await runPublicationRelease(args(f, command));
    assert.equal(result.state, 'ready');
    assert.equal(result.dryRun, true);
    assert.equal(result.command, command);
    assert.equal(result.boundary, 'advisory');
    assert.match(result.message, /independent publication routes remain available/);
    assert.deepEqual(JSON.parse(readFileSync(f.recorded)), ['publication', command, '--request', f.request]);
    assert.deepEqual(readFileSync(f.request), originalRequest);
    assert.deepEqual(readFileSync(f.artifact), originalArtifact);
  }
});

test('real CLI emits a neutral receipt and never repeats helper output', t => {
  const f = fixture(t, `
process.stdout.write(JSON.stringify({ schemaVersion: 1, command: process.argv[3], state: 'ready',
  dryRun: true, releaseId: '1'.repeat(32), reason: 'PRIVATE_RESPONSE_SENTINEL', result: { diagnostic: 'PRIVATE_RESPONSE_SENTINEL' } }));
process.stderr.write('PRIVATE_ERROR_SENTINEL');
`);
  const result = spawnSync(process.execPath, [script, ...args(f)], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.state, 'ready');
  assert.equal(output.releaseId, '1'.repeat(32));
  assert.equal(output.dryRun, true);
  assert.equal(output.boundary, 'advisory');
  for (const privateValue of [f.helper, f.request, 'PRIVATE_RESPONSE_SENTINEL', 'PRIVATE_ERROR_SENTINEL']) {
    assert.equal(result.stdout.includes(privateValue), false);
  }
});

test('unrecognized commands, missing flags, duplicate flags, and additional options never call the helper', async t => {
  const f = fixture(t);
  for (const invalid of [
    [], ['publish', '--helper', f.helper, '--request', f.request],
    ['check', '--request', f.request], ['check', '--helper', f.helper],
    [...args(f), '--helper', f.helper], [...args(f), '--request', f.request],
    [...args(f), '--token', 'sample-value'], [...args(f), '--dry-run'],
    [...args(f), 'extra'], [null],
  ]) {
    assert.equal((await runPublicationRelease(invalid)).reason, 'invalid-arguments');
    assert.equal(existsSync(f.recorded), false);
  }
});

test('helper and request references must be absolute and contain no controls', async t => {
  const f = fixture(t);
  for (const invalid of [
    ['check', '--helper', 'local-helper', '--request', f.request],
    ['check', '--helper', f.helper, '--request', 'request.json'],
    ['check', '--helper', f.helper + '\n', '--request', f.request],
    ['check', '--helper', f.helper, '--request', f.request + '\0'],
  ]) {
    assert.equal((await runPublicationRelease(invalid)).reason, 'invalid-arguments');
    assert.equal(existsSync(f.recorded), false);
  }
});

test('missing, nonregular, and nonexecutable helpers fail closed', async t => {
  const f = fixture(t);
  for (const helper of [path.join(f.directory, 'absent'), f.directory]) {
    const result = await runPublicationRelease(['check', '--helper', helper, '--request', f.request]);
    assert.equal(result.reason, 'helper-unavailable');
  }
  if (process.platform !== 'win32') {
    chmodSync(f.helper, 0o600);
    assert.equal((await runPublicationRelease(args(f))).reason, 'helper-unavailable');
  }
  assert.equal(existsSync(f.recorded), false);
});

test('missing and symlinked request files fail closed', async t => {
  const f = fixture(t);
  const alias = path.join(f.directory, 'alias.json');
  symlinkSync(f.request, alias);
  for (const request of [path.join(f.directory, 'absent.json'), f.directory, alias]) {
    const result = await runPublicationRelease(['check', '--helper', f.helper, '--request', request]);
    assert.equal(result.reason, 'request-unavailable');
  }
  assert.equal(existsSync(f.recorded), false);
});

test('request files and their immediate directory must be owner-only', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  chmodSync(f.request, 0o644);
  assert.equal((await runPublicationRelease(args(f))).reason, 'request-not-private');
  chmodSync(f.request, 0o600);
  chmodSync(f.directory, 0o755);
  assert.equal((await runPublicationRelease(args(f))).reason, 'request-not-private');
  assert.equal(existsSync(f.recorded), false);
});

test('installed executable aliases are supported without shell interpretation', async t => {
  const f = fixture(t, undefined, 'helper $(touch unwanted); executable');
  const alias = path.join(f.directory, 'installed-helper');
  symlinkSync(f.helper, alias);
  const result = await runPublicationRelease(['check', '--helper', alias, '--request', f.request]);
  assert.equal(result.state, 'ready');
  assert.equal(existsSync(path.join(f.directory, 'unwanted')), false);
  assert.deepEqual(JSON.parse(readFileSync(f.recorded)), ['publication', 'check', '--request', f.request]);
});

test('helper rejections and launch errors expose only fixed categories', async t => {
  const f = fixture(t, `process.stderr.write('PRIVATE_ERROR_SENTINEL'); process.exit(7);`);
  const rejected = await runPublicationRelease(args(f, 'release'));
  assert.equal(rejected.reason, 'helper-rejected');
  assert.equal(rejected.state, 'blocked');
  assert.equal(JSON.stringify(rejected).includes('PRIVATE_ERROR_SENTINEL'), false);
  writeFileSync(f.helper, '#!/missing/fixture-interpreter\n', { mode: 0o700 });
  assert.equal((await runPublicationRelease(args(f))).reason, 'helper-unavailable');
});

test('mutable executable targets are refused before invocation', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const alias = path.join(f.directory, 'installed-helper');
  symlinkSync(f.helper, alias);
  chmodSync(f.helper, 0o722);
  assert.equal((await runPublicationRelease(['check', '--helper', alias, '--request', f.request])).reason, 'helper-not-trusted');
  assert.equal(existsSync(f.recorded), false);
});

test('successful exit requires a valid command-bound receipt', async t => {
  const f = fixture(t);
  for (const response of [
    '', 'non-json', 'null', '[]',
    { schemaVersion: 2, command: 'check', state: 'ready' },
    { schemaVersion: 1, command: 'release', state: 'ready' },
    { schemaVersion: 1, command: 'check', state: 'PRIVATE_RESPONSE_SENTINEL' },
    { schemaVersion: 1, command: 'check', state: 'ready', dryRun: 'true' },
    { schemaVersion: 1, command: 'check', state: 'ready', releaseId: 'fixture@example.test' },
    { schemaVersion: 1, command: 'check', state: 'ready', releaseId: 'PRIVATE_RESPONSE_SENTINEL' },
  ]) {
    const output = typeof response === 'string' ? response : JSON.stringify(response);
    writeFileSync(f.helper, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});`, { mode: 0o700 });
    const result = await runPublicationRelease(args(f));
    assert.equal(result.state, 'blocked');
    assert.equal(result.reason, 'helper-invalid-response');
    assert.equal(JSON.stringify(result).includes('PRIVATE_RESPONSE_SENTINEL'), false);
  }
});

test('known broker states survive projection with matching exit codes only', async t => {
  const f = fixture(t);
  for (const [state, code] of [
    ['ready', 0], ['prepared', 0], ['verification-pending', 0], ['removed', 0],
    ['blocked', 1], ['unavailable', 1], ['stale', 1], ['uncertain', 1],
  ]) {
    const response = { schemaVersion: 1, command: 'check', state, reason: 'PRIVATE_ERROR_SENTINEL' };
    writeFileSync(f.helper, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(response))}); process.exitCode = ${code};`, { mode: 0o700 });
    const result = await runPublicationRelease(args(f));
    assert.equal(result.state, state);
    assert.equal(result.reason, code ? 'helper-rejected' : undefined);
    assert.equal(JSON.stringify(result).includes('PRIVATE_ERROR_SENTINEL'), false);
    writeFileSync(f.helper, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(response))}); process.exitCode = ${1 - code};`, { mode: 0o700 });
    assert.equal((await runPublicationRelease(args(f))).reason, 'helper-rejected');
  }
});

test('helper subprocess duration and combined output are bounded', async t => {
  const hanging = fixture(t, 'setInterval(() => {}, 1000);');
  assert.equal((await runPublicationRelease(args(hanging), { timeoutMs: 100 })).reason, 'helper-timeout');
  const verbose = fixture(t, `process.stdout.write('s'.repeat(400)); process.stderr.write('e'.repeat(400));`);
  assert.equal((await runPublicationRelease(args(verbose), { maxOutputBytes: 500 })).reason, 'helper-output-limit');
  for (const limits of [{ timeoutMs: 0 }, { timeoutMs: 300_001 }, { maxOutputBytes: 0 }, { maxOutputBytes: 262_145 }]) {
    assert.equal((await runPublicationRelease(args(verbose), limits)).reason, 'invalid-limits');
  }
});

test('blocked real CLI preserves artifacts and returns failure without raw diagnostics', t => {
  const f = fixture(t, `process.stderr.write('PRIVATE_ERROR_SENTINEL'); process.exit(1);`);
  const before = readFileSync(f.artifact);
  const result = spawnSync(process.execPath, [script, ...args(f, 'remove')], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).reason, 'helper-rejected');
  assert.deepEqual(readFileSync(f.artifact), before);
  assert.equal(result.stdout.includes('PRIVATE_ERROR_SENTINEL'), false);
});
