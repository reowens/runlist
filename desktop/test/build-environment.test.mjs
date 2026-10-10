import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { privateBuildEnvironment } from '../scripts/build-environment.mjs';

test('build flags retain caller settings and remap developer paths as whole arguments', () => {
  const env = { RUSTFLAGS: '-C debuginfo=1', RUNLIST_TARGET: 'example-target' };
  const result = privateBuildEnvironment('/checkout with spaces', env, '/developer');
  assert.deepEqual(result.CARGO_ENCODED_RUSTFLAGS.split('\x1f'), [
    '-C', 'debuginfo=1',
    `--remap-path-prefix=${path.resolve('/developer')}=/build/home`,
    `--remap-path-prefix=${path.resolve('/checkout with spaces')}=/runlist`,
  ]);
  assert.equal(result.RUNLIST_TARGET, env.RUNLIST_TARGET);
  assert.equal(env.CARGO_ENCODED_RUSTFLAGS, undefined);
});

test('encoded compiler flags retain precedence and arguments containing spaces', () => {
  const result = privateBuildEnvironment('/repo', {
    CARGO_ENCODED_RUSTFLAGS: '-C\x1flink-arg=argument with spaces', RUSTFLAGS: '--ignored',
  }, '/developer');
  const flags = result.CARGO_ENCODED_RUSTFLAGS.split('\x1f');
  assert.deepEqual(flags.slice(0, 2), ['-C', 'link-arg=argument with spaces']);
  assert.ok(!flags.includes('--ignored'));
});
