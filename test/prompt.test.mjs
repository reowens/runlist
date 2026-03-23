import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { isInteractive } from '../src/prompt.mjs';

describe('isInteractive', () => {
  it('returns a boolean', () => {
    strictEqual(typeof isInteractive(), 'boolean');
  });

  it('returns false when stdin is not a TTY (in test runner)', () => {
    strictEqual(isInteractive(), false);
  });
});

describe('promptChoice via subprocess', () => {
  it('selects option by 1-based numeric index', () => {
    const script = `
import { promptChoice } from './src/prompt.mjs';
const result = await promptChoice('Pick:', ['alpha', 'beta', 'gamma']);
process.stdout.write(result ?? 'NULL');
`;
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      input: '2\n', encoding: 'utf8', cwd: import.meta.dirname + '/..',
    });
    ok(result.stdout.includes('beta'), `got: ${result.stdout}`);
  });

  it('selects option by case-insensitive string match', () => {
    const script = `
import { promptChoice } from './src/prompt.mjs';
const result = await promptChoice('Pick:', ['alpha', 'beta', 'gamma']);
process.stdout.write(result ?? 'NULL');
`;
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      input: 'BETA\n', encoding: 'utf8', cwd: import.meta.dirname + '/..',
    });
    ok(result.stdout.includes('beta'), `got: ${result.stdout}`);
  });

  it('returns null for unrecognized input', () => {
    const script = `
import { promptChoice } from './src/prompt.mjs';
const result = await promptChoice('Pick:', ['alpha', 'beta', 'gamma']);
process.stdout.write(result ?? 'NULL');
`;
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      input: 'nope\n', encoding: 'utf8', cwd: import.meta.dirname + '/..',
    });
    ok(result.stdout.includes('NULL'), `got: ${result.stdout}`);
  });
});
