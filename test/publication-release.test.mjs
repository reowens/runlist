import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, constants, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPublicationRelease } from '../scripts/publication-release.mjs';

const script = fileURLToPath(new URL('../scripts/publication-release.mjs', import.meta.url));
const windows = process.platform === 'win32';

function writeHelper(f, body) {
  // Windows runs node.exe with `publication` as its script, so Node consumes
  // that first protocol argument. Keep the remaining arguments untouched.
  writeFileSync(f.helperScript, `#!${process.execPath}\nconst helperArgs = ${f.nativeNode ? "['publication', ...process.argv.slice(2)]" : 'process.argv.slice(2)'};\n${body}`, { mode: 0o700 });
}

function fixture(t, body, helperName = 'local-helper', { nativeNode = windows } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'publication-wrapper-'));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const helper = path.join(directory, helperName + (nativeNode ? '.exe' : ''));
  const helperScript = nativeNode ? path.join(directory, 'publication') : helper;
  if (nativeNode) {
    if (windows) symlinkSync(process.execPath, helper, 'file');
    // A local copy satisfies the POSIX owner check even when system Node is
    // root-owned; reflink where supported to avoid copying the binary's bytes.
    else {
      copyFileSync(process.execPath, helper, constants.COPYFILE_FICLONE);
      // Hosted tool caches can be writable by other users. The fixture's own
      // executable must meet the bridge's trust policy regardless of that mode.
      chmodSync(helper, 0o700);
      // Homebrew Node may use @rpath/libnode.*.dylib relative to its executable.
      // Keep that dependency reachable when relocating only this test binary.
      if (process.platform === 'darwin') {
        const lib = path.resolve(path.dirname(process.execPath), '../lib');
        if (existsSync(lib)) for (const name of readdirSync(lib).filter(name => /^libnode\.[\d.]+\.dylib$/.test(name))) symlinkSync(path.join(lib,name),path.join(directory,name));
      }
    }
  }
  const request = path.join(directory, 'request.json');
  const recorded = path.join(directory, 'recorded.json');
  const artifact = path.join(directory, 'artifact.bin');
  writeFileSync(request, JSON.stringify({ dryRun: true, artifact }), { mode: 0o600 });
  writeFileSync(artifact, Buffer.from([0, 1, 2, 255]), { mode: 0o600 });
  const f = { directory, helper, helperScript, nativeNode, request, recorded, artifact };
  writeHelper(f, body ?? `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(recorded)}, JSON.stringify(helperArgs));
const request = JSON.parse(fs.readFileSync(helperArgs[3], 'utf8'));
if (request.dryRun !== true) process.exit(1);
process.stdout.write(JSON.stringify({ schemaVersion: 1, command: helperArgs[1], state: 'ready', dryRun: true }));
`);
  return f;
}

function args(f, command = 'check') {
  return [command, '--helper', f.helper, '--request', f.request];
}

function runFixture(f, argv = args(f), limits = {}) {
  if (!f.nativeNode) return runPublicationRelease(argv, limits);
  // Give native node.exe its fixture script through an isolated working
  // directory. The real bridge still launches its fixed arguments, shell-free;
  // neither global cwd nor production dependency injection is needed.
  const harness = `
import { runPublicationRelease } from ${JSON.stringify(new URL('../scripts/publication-release.mjs', import.meta.url).href)};
const result = await runPublicationRelease(JSON.parse(process.argv[1]), JSON.parse(process.argv[2]));
process.stdout.write(JSON.stringify(result));
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', harness, JSON.stringify(argv), JSON.stringify(limits)], {
    cwd: f.directory, encoding: 'utf8', timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

test('each local command forwards only fixed arguments and preserves dry-run inputs', async t => {
  const f = fixture(t);
  const originalRequest = readFileSync(f.request);
  const originalArtifact = readFileSync(f.artifact);
  for (const command of ['check', 'prepare', 'release', 'reconcile', 'remove']) {
    const result = await runFixture(f, args(f, command));
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
process.stdout.write(JSON.stringify({ schemaVersion: 1, command: helperArgs[1], state: 'ready',
  dryRun: true, releaseId: '1'.repeat(32), reason: 'PRIVATE_RESPONSE_SENTINEL', result: { diagnostic: 'PRIVATE_RESPONSE_SENTINEL' } }));
process.stderr.write('PRIVATE_ERROR_SENTINEL');
`);
  const result = spawnSync(process.execPath, [script, ...args(f)], { cwd: f.directory, encoding: 'utf8' });
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
    assert.equal((await runFixture(f, invalid)).reason, 'invalid-arguments');
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
    assert.equal((await runFixture(f, invalid)).reason, 'invalid-arguments');
    assert.equal(existsSync(f.recorded), false);
  }
});

test('missing, nonregular, and nonexecutable helpers fail closed', async t => {
  const f = fixture(t);
  for (const helper of [path.join(f.directory, 'absent'), f.directory]) {
    const result = await runFixture(f, ['check', '--helper', helper, '--request', f.request]);
    assert.equal(result.reason, 'helper-unavailable');
  }
  if (process.platform !== 'win32') {
    chmodSync(f.helper, 0o600);
    assert.equal((await runFixture(f)).reason, 'helper-unavailable');
  }
  assert.equal(existsSync(f.recorded), false);
});

test('missing and symlinked request files fail closed', async t => {
  const f = fixture(t);
  const alias = path.join(f.directory, 'alias.json');
  symlinkSync(f.request, alias);
  for (const request of [path.join(f.directory, 'absent.json'), f.directory, alias]) {
    const result = await runFixture(f, ['check', '--helper', f.helper, '--request', request]);
    assert.equal(result.reason, 'request-unavailable');
  }
  assert.equal(existsSync(f.recorded), false);
});

test('request files and their immediate directory must be owner-only', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  chmodSync(f.request, 0o644);
  assert.equal((await runFixture(f)).reason, 'request-not-private');
  chmodSync(f.request, 0o600);
  chmodSync(f.directory, 0o755);
  assert.equal((await runFixture(f)).reason, 'request-not-private');
  assert.equal(existsSync(f.recorded), false);
});

test('installed executable aliases are supported without shell interpretation', async t => {
  const f = fixture(t, undefined, 'helper $(touch unwanted); executable');
  const alias = path.join(f.directory, 'installed-helper' + (windows ? '.exe' : ''));
  symlinkSync(f.helper, alias);
  const result = await runFixture(f, ['check', '--helper', alias, '--request', f.request]);
  assert.equal(result.state, 'ready');
  assert.equal(existsSync(path.join(f.directory, 'unwanted')), false);
  assert.deepEqual(JSON.parse(readFileSync(f.recorded)), ['publication', 'check', '--request', f.request]);
});

test('helper rejections and launch errors expose only fixed categories', async t => {
  const f = fixture(t, `process.stderr.write('PRIVATE_ERROR_SENTINEL'); process.exit(7);`);
  const rejected = await runFixture(f, args(f, 'release'));
  assert.equal(rejected.reason, 'helper-rejected');
  assert.equal(rejected.state, 'blocked');
  assert.equal(JSON.stringify(rejected).includes('PRIVATE_ERROR_SENTINEL'), false);
  const invalidHelper = path.join(f.directory, windows ? 'invalid-helper.exe' : 'invalid-helper');
  writeFileSync(invalidHelper, '#!/missing/fixture-interpreter\n', { mode: 0o700 });
  assert.equal((await runFixture(f, ['check', '--helper', invalidHelper, '--request', f.request])).reason, 'helper-unavailable');
});

test('mutable executable targets are refused before invocation', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const alias = path.join(f.directory, 'installed-helper' + (windows ? '.exe' : ''));
  symlinkSync(f.helper, alias);
  chmodSync(f.helper, 0o722);
  assert.equal((await runFixture(f, ['check', '--helper', alias, '--request', f.request])).reason, 'helper-not-trusted');
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
    writeHelper(f, `process.stdout.write(${JSON.stringify(output)});`);
    const result = await runFixture(f);
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
    writeHelper(f, `process.stdout.write(${JSON.stringify(JSON.stringify(response))}); process.exitCode = ${code};`);
    const result = await runFixture(f);
    assert.equal(result.state, state);
    assert.equal(result.reason, code ? 'helper-rejected' : undefined);
    assert.equal(JSON.stringify(result).includes('PRIVATE_ERROR_SENTINEL'), false);
    writeHelper(f, `process.stdout.write(${JSON.stringify(JSON.stringify(response))}); process.exitCode = ${1 - code};`);
    assert.equal((await runFixture(f)).reason, 'helper-rejected');
  }
});

test('helper subprocess duration and combined output are bounded', async t => {
  const hanging = fixture(t, 'setInterval(() => {}, 1000);');
  assert.equal((await runFixture(hanging, args(hanging), { timeoutMs: 100 })).reason, 'helper-timeout');
  const verbose = fixture(t, `process.stdout.write('s'.repeat(400)); process.stderr.write('e'.repeat(400));`);
  assert.equal((await runFixture(verbose, args(verbose), { maxOutputBytes: 500 })).reason, 'helper-output-limit');
  for (const limits of [{ timeoutMs: 0 }, { timeoutMs: 300_001 }, { maxOutputBytes: 0 }, { maxOutputBytes: 262_145 }]) {
    assert.equal((await runFixture(verbose, args(verbose), limits)).reason, 'invalid-limits');
  }
});

test('blocked real CLI preserves artifacts and returns failure without raw diagnostics', t => {
  const f = fixture(t, `process.stderr.write('PRIVATE_ERROR_SENTINEL'); process.exit(1);`);
  const before = readFileSync(f.artifact);
  const result = spawnSync(process.execPath, [script, ...args(f, 'remove')], { cwd: f.directory, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).reason, 'helper-rejected');
  assert.deepEqual(readFileSync(f.artifact), before);
  assert.equal(result.stdout.includes('PRIVATE_ERROR_SENTINEL'), false);
});

test('native Node fixture exercises the isolated helper transport on every platform', async t => {
  const f = fixture(t, undefined, 'helper $(touch unwanted); executable', { nativeNode: true });
  const before = readFileSync(f.artifact);
  const result = await runFixture(f, args(f, 'prepare'));
  assert.equal(result.state, 'ready', JSON.stringify(result));
  assert.equal(result.dryRun, true);
  assert.deepEqual(JSON.parse(readFileSync(f.recorded)), ['publication', 'prepare', '--request', f.request]);

  const alias = path.join(f.directory, 'installed-helper.exe');
  symlinkSync(f.helper, alias, 'file');
  assert.equal((await runFixture(f, ['check', '--helper', alias, '--request', f.request])).state, 'ready');
  assert.equal(existsSync(path.join(f.directory, 'unwanted')), false);

  const cli = spawnSync(process.execPath, [script, ...args(f)], { cwd: f.directory, encoding: 'utf8' });
  assert.ifError(cli.error);
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stderr, '');
  assert.equal(JSON.parse(cli.stdout).state, 'ready');

  // Mutate only the fixture source, never its native executable or alias.
  writeHelper(f, "process.stderr.write('PRIVATE_ERROR_SENTINEL'); process.exit(7);");
  const rejected = await runFixture(f);
  assert.equal(rejected.reason, 'helper-rejected');
  assert.equal(JSON.stringify(rejected).includes('PRIVATE_ERROR_SENTINEL'), false);
  assert.deepEqual(readFileSync(f.artifact), before);
});
