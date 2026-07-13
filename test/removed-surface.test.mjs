import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { KNOWN_COMMANDS } from '../src/commands.mjs';
import { resolveConfig } from '../src/config.mjs';

const root = path.resolve(import.meta.dirname, '..');
const bin = path.join(root, 'bin', 'dotmd.mjs');

describe('removed product surfaces', () => {
  it('treats notion as an ordinary unknown command', () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), 'dotmd-removed-'));
    try {
      mkdirSync(path.join(repo, '.git'));
      mkdirSync(path.join(repo, 'docs'));
      writeFileSync(path.join(repo, 'dotmd.config.mjs'), `export const root = 'docs';\n`);
      const result = spawnSync('node', [bin, 'notion', '--config', path.join(repo, 'dotmd.config.mjs')], {
        cwd: repo,
        encoding: 'utf8',
      });
      strictEqual(result.status, 1);
      ok(result.stderr.includes('Unknown command: notion'), result.stderr);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('ships no command, config, keyword, or dependency claim', async () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
    const help = spawnSync('node', [bin, 'help', 'all'], { cwd: root, encoding: 'utf8' });
    const removedHelp = spawnSync('node', [bin, 'help', 'notion'], { cwd: root, encoding: 'utf8' });
    const bashCompletion = spawnSync('node', [bin, 'completions', 'bash'], { cwd: root, encoding: 'utf8' });
    const zshCompletion = spawnSync('node', [bin, 'completions', 'zsh'], { cwd: root, encoding: 'utf8' });
    const configExample = readFileSync(path.join(root, 'dotmd.config.example.mjs'), 'utf8');
    const readme = readFileSync(path.join(root, 'README.md'), 'utf8');
    const claude = readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    const repo = mkdtempSync(path.join(os.tmpdir(), 'dotmd-removed-config-'));
    mkdirSync(path.join(repo, '.git'));
    mkdirSync(path.join(repo, 'docs'));
    const configPath = path.join(repo, 'dotmd.config.mjs');
    writeFileSync(configPath, `export const root = 'docs';\n`);
    const config = await resolveConfig(repo, configPath);

    strictEqual(help.status, 0, help.stderr);
    strictEqual(removedHelp.status, 1, removedHelp.stderr);
    ok(removedHelp.stderr.includes('Unknown help topic: notion'), removedHelp.stderr);
    strictEqual(bashCompletion.status, 0, bashCompletion.stderr);
    strictEqual(zshCompletion.status, 0, zshCompletion.stderr);
    strictEqual(pkg.dependencies, undefined);
    strictEqual(pkg.optionalDependencies, undefined);
    ok(!pkg.keywords.includes('notion'));
    ok(!/\bnotion\b/i.test(pkg.description));
    strictEqual(lock.packages[''].dependencies, undefined);
    strictEqual(lock.packages[''].optionalDependencies, undefined);
    const runtimePackages = Object.entries(lock.packages)
      .filter(([name, metadata]) => name !== '' && metadata.dev !== true)
      .map(([name]) => name);
    strictEqual(runtimePackages.length, 0, `unexpected runtime lockfile packages: ${runtimePackages.join(', ')}`);
    strictEqual(config.raw.notion, undefined);
    ok(!KNOWN_COMMANDS.includes('notion'));
    ok(!/\bnotion\b/i.test(help.stdout), help.stdout);
    ok(!/\bnotion\b/i.test(bashCompletion.stdout), bashCompletion.stdout);
    ok(!/\bnotion\b/i.test(zshCompletion.stdout), zshCompletion.stdout);
    ok(!/\bnotion\b/i.test(configExample), configExample);
    ok(!/\bnotion\b/i.test(readme), 'README still advertises the removed integration');
    ok(!/\bnotion\b/i.test(claude), 'CLAUDE.md still advertises the removed integration');
    ok(!existsSync(path.join(root, 'src', 'notion.mjs')));
    rmSync(repo, { recursive: true, force: true });
  });

  it('installs a packed artifact with no removed surface or runtime dependencies', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'dotmd-removed-pack-'));
    const runNpm = (args, options) => process.env.npm_execpath
      ? spawnSync(process.execPath, [process.env.npm_execpath, ...args], options)
      : spawnSync('npm', args, { ...options, shell: process.platform === 'win32' });
    try {
      const packed = runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', temp], {
        cwd: root,
        encoding: 'utf8',
      });
      strictEqual(packed.status, 0, packed.stderr);
      const packResult = JSON.parse(packed.stdout)[0];
      const files = packResult.files.map(file => file.path);
      ok(!files.some(file => /notion/i.test(file)), files.join('\n'));

      const installRoot = path.join(temp, 'install');
      mkdirSync(installRoot);
      writeFileSync(path.join(installRoot, 'package.json'), '{"private":true}\n');
      const installEnv = { ...process.env };
      delete installEnv.npm_config_allow_scripts;
      delete installEnv.NPM_CONFIG_ALLOW_SCRIPTS;
      const installed = runNpm([
        'install', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund', path.join(temp, packResult.filename),
      ], { cwd: installRoot, encoding: 'utf8', env: installEnv });
      strictEqual(installed.status, 0, installed.stderr);

      const tree = runNpm(['ls', '--omit=dev', '--json'], { cwd: installRoot, encoding: 'utf8' });
      strictEqual(tree.status, 0, tree.stderr);
      const installedPackage = JSON.parse(tree.stdout).dependencies?.['dotmd-cli'];
      ok(installedPackage, tree.stdout);
      strictEqual(installedPackage.dependencies, undefined, tree.stdout);

      const packageRoot = path.join(installRoot, 'node_modules', 'dotmd-cli');
      for (const productPath of [
        'package.json', 'README.md', 'dotmd.config.example.mjs',
        'bin/dotmd.mjs', 'src/commands.mjs', 'src/completions.mjs', 'src/config.mjs',
      ]) {
        const content = readFileSync(path.join(packageRoot, productPath), 'utf8');
        ok(!/\bnotion\b/i.test(content), `${productPath} still contains a removed product claim`);
      }
      ok(!existsSync(path.join(packageRoot, 'src', 'notion.mjs')));
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
