import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSyncPlan,
  isNpmManagedGlobalPath,
  parseExecutablePaths,
  prefixForDotmd,
  syncGlobalCliCopies,
} from '../scripts/sync-global-cli.mjs';

test('parseExecutablePaths deduplicates PATH-visible binaries', () => {
  assert.deepEqual(
    parseExecutablePaths('/opt/homebrew/bin/dotmd\n/Users/me/.nvm/bin/dotmd\n/opt/homebrew/bin/dotmd\n'),
    ['/opt/homebrew/bin/dotmd', '/Users/me/.nvm/bin/dotmd'],
  );
});

test('buildSyncPlan identifies stale global installations', () => {
  const plan = buildSyncPlan([
    { dotmdPath: '/a/dotmd', version: '0.69.0', npmPath: '/a/npm', prefix: '/a' },
    { dotmdPath: '/b/dotmd', version: '0.50.2', npmPath: '/b/npm', prefix: '/b' },
    { dotmdPath: '/c/dotmd', version: null, npmPath: null },
  ], '0.69.0');

  assert.deepEqual(plan.map(entry => ({ needsInstall: entry.needsInstall, canInstall: entry.canInstall })), [
    { needsInstall: false, canInstall: true },
    { needsInstall: true, canInstall: true },
    { needsInstall: true, canInstall: false },
  ]);
});

test('prefixForDotmd derives the owning global prefix', () => {
  assert.equal(prefixForDotmd('/opt/homebrew/bin/dotmd'), '/opt/homebrew');
  assert.equal(prefixForDotmd('/Users/me/.nvm/versions/node/v22/bin/dotmd'), '/Users/me/.nvm/versions/node/v22');
});

test('isNpmManagedGlobalPath rejects a tool-manager shim outside npm prefix', { skip: process.platform === 'win32' && 'POSIX global-install layout' }, () => {
  assert.equal(isNpmManagedGlobalPath(
    '/opt/homebrew/bin/dotmd',
    '/opt/homebrew',
    '/opt/homebrew/lib/node_modules',
    { realpath: () => '/opt/homebrew/lib/node_modules/dotmd-cli/bin/dotmd.mjs' },
  ), true);
  assert.equal(isNpmManagedGlobalPath(
    '/opt/homebrew/bin/dotmd',
    '/opt/homebrew',
    '/opt/homebrew/lib/node_modules',
    { realpath: () => '/opt/homebrew/Cellar/dotmd/bin/dotmd' },
  ), false);
  assert.equal(isNpmManagedGlobalPath(
    '/Users/me/.volta/bin/dotmd',
    '/Users/me/.volta/tools/image/node/22',
    '/Users/me/.volta/tools/image/node/22/lib/node_modules',
  ), false);
});

test('syncGlobalCliCopies updates each stale PATH-visible prefix and verifies again', () => {
  const installed = [];
  let inspection = 0;
  const before = [
    { dotmdPath: '/homebrew/bin/dotmd', version: '0.69.0', npmPath: '/homebrew/bin/npm', prefix: '/homebrew' },
    { dotmdPath: '/nvm/bin/dotmd', version: '0.68.0', npmPath: '/nvm/bin/npm', prefix: '/nvm' },
  ];
  const after = before.map(entry => ({ ...entry, version: '0.69.0' }));

  const result = syncGlobalCliCopies('0.69.0', {
    inspect: () => inspection++ === 0 ? before : after,
    install: (entry, version) => { installed.push([entry.npmPath, entry.prefix, version]); return { status: 0 }; },
    write: () => {},
  });

  assert.deepEqual(installed, [['/nvm/bin/npm', '/nvm', '0.69.0']]);
  assert.deepEqual(result, after);
});

test('syncGlobalCliCopies refuses an unrepairable stale binary', () => {
  assert.throws(() => syncGlobalCliCopies('0.69.0', {
    inspect: () => [{ dotmdPath: '/orphan/dotmd', version: '0.50.2', npmPath: null }],
    write: () => {},
  }), /no sibling npm/);
});

test('syncGlobalCliCopies never overwrites but fails on a stale non-global shim', () => {
  const installed = [];
  const entries = [
    { dotmdPath: '/homebrew/bin/dotmd', version: '0.69.0', npmPath: '/homebrew/bin/npm', prefix: '/homebrew', managed: true },
    { dotmdPath: '/volta/bin/dotmd', version: '0.50.0', npmPath: '/volta/bin/npm', prefix: '/volta/tools/node', managed: false },
  ];
  const output = [];
  assert.throws(() => syncGlobalCliCopies('0.69.0', {
    inspect: () => entries,
    install: entry => { installed.push(entry); return { status: 0 }; },
    write: text => output.push(text),
  }), /PATH still contains stale dotmd installations/);
  assert.deepEqual(installed, []);
  assert.match(output.join(''), /skipping non-global or tool-managed executable/);
});
