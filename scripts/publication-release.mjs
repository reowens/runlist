import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMANDS = new Set(['check', 'prepare', 'release', 'reconcile', 'remove']);
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
const STATES = new Set(['ready', 'prepared', 'blocked', 'unavailable', 'stale', 'verification-pending', 'uncertain', 'removed']);
const SUCCESS_STATES = new Set(['ready', 'prepared', 'verification-pending', 'removed']);

function receipt(command, state, reason) {
  return {
    schemaVersion: 1,
    command: COMMANDS.has(command) ? command : null,
    state,
    ...(reason ? { reason } : {}),
    boundary: 'advisory',
    message: 'Existing independent publication routes remain available.',
  };
}

function parse(argv) {
  if (!Array.isArray(argv) || !COMMANDS.has(argv[0])) return null;
  const parsed = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!['--helper', '--request'].includes(flag) || parsed[flag.slice(2)] !== undefined) return null;
    const value = argv[index + 1];
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) return null;
    parsed[flag.slice(2)] = value;
  }
  return parsed.helper && parsed.request ? parsed : null;
}

async function validatePaths({ helper, request }) {
  try {
    const executable = await stat(await realpath(helper));
    if (!executable.isFile()) return 'helper-unavailable';
    if (process.platform !== 'win32' && (executable.uid !== process.getuid() || (executable.mode & 0o022))) {
      return 'helper-not-trusted';
    }
    await access(helper, constants.X_OK);
  } catch {
    return 'helper-unavailable';
  }
  try {
    const file = await lstat(request);
    const directory = await lstat(path.dirname(request));
    if (!file.isFile() || !directory.isDirectory()) return 'request-unavailable';
    if (process.platform !== 'win32') {
      const uid = process.getuid();
      if (file.uid !== uid || directory.uid !== uid || (file.mode & 0o077) || (directory.mode & 0o077)) {
        return 'request-not-private';
      }
    }
  } catch {
    return 'request-unavailable';
  }
  return null;
}

function projectResponse(command, bytes, exitCode, signal) {
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(bytes).toString('utf8')); }
  catch { return receipt(command, 'blocked', exitCode === 0 ? 'helper-invalid-response' : 'helper-rejected'); }
  if (signal || parsed?.schemaVersion !== 1 || parsed.command !== command || !STATES.has(parsed.state) ||
      (parsed.dryRun !== undefined && typeof parsed.dryRun !== 'boolean') ||
      (parsed.releaseId !== undefined && (typeof parsed.releaseId !== 'string' || !/^[a-f0-9]{32}$/.test(parsed.releaseId)))) {
    return receipt(command, 'blocked', 'helper-invalid-response');
  }
  if (exitCode !== (SUCCESS_STATES.has(parsed.state) ? 0 : 1)) {
    return receipt(command, 'blocked', 'helper-rejected');
  }
  return {
    ...receipt(command, parsed.state, SUCCESS_STATES.has(parsed.state) ? undefined : 'helper-rejected'),
    ...(parsed.releaseId === undefined ? {} : { releaseId: parsed.releaseId }),
    ...(parsed.dryRun === undefined ? {} : { dryRun: parsed.dryRun }),
  };
}

// This bridge delegates only. The helper owns request validation, dry-run
// behavior, policy, credential access, and any authorized provider operations.
// No existing publication route is gated by calling this optional script.
export async function runPublicationRelease(argv, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  const parsed = parse(argv);
  if (!parsed) return receipt(argv?.[0], 'blocked', 'invalid-arguments');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > DEFAULT_MAX_OUTPUT_BYTES) {
    return receipt(parsed.command, 'blocked', 'invalid-limits');
  }
  const invalidPath = await validatePaths(parsed);
  if (invalidPath) return receipt(parsed.command, 'blocked', invalidPath);

  return new Promise(resolve => {
    let child;
    let failure = null;
    let outputBytes = 0;
    const output = [];
    let timer;
    const stop = code => {
      failure ??= code;
      child?.kill('SIGKILL');
    };
    try {
      child = spawn(parsed.helper, ['publication', parsed.command, '--request', parsed.request], {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve(receipt(parsed.command, 'blocked', 'helper-unavailable'));
      return;
    }
    // Discard stderr and project only the bounded JSON receipt from stdout.
    // Never repeat provider results, private paths, contacts, or diagnostics.
    const consume = (bytes, retain) => {
      outputBytes += bytes.length;
      if (outputBytes > maxOutputBytes) stop('helper-output-limit');
      else if (retain && !failure) output.push(bytes);
    };
    child.stdout.on('data', bytes => consume(bytes, true));
    child.stderr.on('data', bytes => consume(bytes, false));
    child.on('error', () => { failure ??= 'helper-unavailable'; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (failure) {
        resolve(receipt(parsed.command, 'blocked', failure));
      } else {
        resolve(projectResponse(parsed.command, output, code, signal));
      }
    });
    timer = setTimeout(() => stop('helper-timeout'), timeoutMs);
  });
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const result = await runPublicationRelease(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = SUCCESS_STATES.has(result.state) ? 0 : 1;
}
