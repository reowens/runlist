#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { commitRename } from '../src/durable-rename.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const refuse = message => { throw new Error(`Local CLI preparation refused: ${message}`); };
function files(root, prefix = '') {
  return readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) return files(root, path);
    if (!entry.isFile()) refuse(`non-regular package input ${path}`);
    return [path];
  });
}
function command(program, args, options = {}) {
  return execFileSync(program, args, { timeout: 30000, maxBuffer: 32 * 1024 ** 2, ...options });
}
function qualify(root) {
  for (const path of files(root).filter(path => path.endsWith('.mjs'))) command(process.execPath, ['--check', join(root, path)]);
  command(process.execPath, [join(root, 'bin/runlist.mjs'), '--help'], { cwd: root });
}

export function prepareLocalCLI({ repository, commit, directory }) {
  repository = resolve(repository); directory = resolve(directory);
  if (!/^[a-f0-9]{40}$/.test(commit ?? '') || existsSync(directory)) refuse('exact commit and fresh output directory required');
  const git = args => command('git', ['-C', repository, ...args]);
  const pkg = JSON.parse(git(['show', `${commit}:package.json`]));
  if (pkg.name !== 'runlist' || Object.keys(pkg.dependencies ?? {}).length) refuse('expected dependency-free Runlist package');
  const tracked = git(['ls-tree', '-r', '--name-only', commit]).toString().trim().split('\n');
  const paths = ['package.json', ...pkg.files.map(path => path.replace(/\/$/, '')), ...tracked.filter(path => /^(README|LICENSE)(\.|$)/i.test(path))];
  if (paths.some(path => !/^[A-Za-z0-9_./-]+$/.test(path) || path.includes('..'))) refuse('unsupported package projection');
  const temporary = mkdtempSync(join(tmpdir(), 'runlist-local-package-'));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    const source = join(temporary, 'source'); mkdirSync(source);
    const archive = git(['archive', '--format=tar', commit, '--', ...paths]);
    command('tar', ['-xf', '-', '-C', source], { input: archive });
    const inventory = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: source }));
    if (inventory.length !== 1 || !/^[A-Za-z0-9_.-]+\.tgz$/.test(inventory[0].filename)) refuse('unexpected npm package');
    const tarball = join(directory, inventory[0].filename);
    command('tar', ['-xzf', tarball, '-C', directory]);
    const root = join(directory, 'package');
    qualify(root);
    const sources = Object.fromEntries(files(root).map(path => [path, hash(readFileSync(join(root, path)))]));
    const receipt = { schemaVersion: 1, sourceCommit: commit, version: pkg.version, archiveSha256: hash(readFileSync(tarball)), files: sources };
    const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
    writeFileSync(join(directory, 'receipt.json'), bytes, { flag: 'wx', mode: 0o444 });
    for (const path of Object.keys(sources)) chmodSync(join(root, path), path.startsWith('bin/') ? 0o555 : 0o444);
    for (const entry of readdirSync(root, { recursive: true, withFileTypes: true }).reverse()) {
      if (entry.isDirectory()) chmodSync(join(entry.parentPath, entry.name), 0o555);
    }
    chmodSync(root, 0o555);
    return { directory, entry: join(root, 'bin/runlist.mjs'), manifestSha256: hash(bytes), ...receipt };
  } catch (error) {
    // Failed candidates remain unselected; retain their bytes for diagnosis.
    throw error;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function validateLocalCLI({ directory, manifestSha256 }) {
  directory = resolve(directory);
  const receiptBytes = readFileSync(join(directory, 'receipt.json'));
  if (!/^[a-f0-9]{64}$/.test(manifestSha256 ?? '') || hash(receiptBytes) !== manifestSha256) refuse('receipt digest differs');
  const receipt = JSON.parse(receiptBytes), root = join(directory, 'package');
  if (receipt.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(receipt.sourceCommit ?? '') || !receipt.files?.['bin/runlist.mjs']) refuse('incomplete receipt');
  if (lstatSync(root).isSymbolicLink() || JSON.stringify(files(root).sort()) !== JSON.stringify(Object.keys(receipt.files).sort())) refuse('package inventory differs');
  for (const [path, digest] of Object.entries(receipt.files)) {
    const full = join(root, path);
    if (hash(readFileSync(full)) !== digest || lstatSync(full).mode & 0o222) refuse(`package changed: ${path}`);
  }
  qualify(root);
  return { entry: join(root, 'bin/runlist.mjs'), receipt };
}

export function selectLocalCLI({ directory, manifestSha256, link, previous }) {
  link = resolve(link);
  const { entry } = validateLocalCLI({ directory, manifestSha256 });
  const selected = () => { try { return readlinkSync(link); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  if (selected() !== previous) refuse('selection changed; inspect it before selecting');
  const temporary = join(dirname(link), `.runlist-select-${randomUUID()}`);
  symlinkSync(entry, temporary);
  try {
    if (selected() !== previous) refuse('selection changed during preparation');
    commitRename(temporary, link);
  } finally { if (existsSync(temporary)) rmSync(temporary); }
  return { link, entry, previous };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [operation, request] = process.argv.slice(2);
  if (!['prepare', 'validate', 'select'].includes(operation) || !request || process.argv.length !== 4) refuse('expected prepare|validate|select request.json');
  const options = JSON.parse(readFileSync(request));
  const result = operation === 'prepare' ? prepareLocalCLI(options) : operation === 'select' ? selectLocalCLI(options) : validateLocalCLI(options);
  console.log(JSON.stringify(result, null, 2));
}
