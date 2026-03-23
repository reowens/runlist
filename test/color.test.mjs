import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert';
import { spawnSync } from 'node:child_process';

describe('color.mjs', () => {
  it('wraps text with ANSI codes when FORCE_COLOR=1', () => {
    const script = `import { bold, red } from './src/color.mjs'; process.stdout.write(bold('test') + '|' + red('err'));`;
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      cwd: import.meta.dirname + '/..',
      env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: undefined },
    });
    ok(result.stdout.includes('\x1b['), 'output contains ANSI escape codes');
    ok(result.stdout.includes('test'));
    ok(result.stdout.includes('err'));
  });

  it('returns plain text when NO_COLOR is set', () => {
    const script = `import { bold, red } from './src/color.mjs'; process.stdout.write(bold('test') + '|' + red('err'));`;
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      cwd: import.meta.dirname + '/..',
      env: { ...process.env, FORCE_COLOR: undefined, NO_COLOR: '1' },
    });
    strictEqual(result.stdout, 'test|err', 'no ANSI codes present');
  });

  it('exports bold, dim, red, yellow, green as functions', () => {
    const script = `
import { bold, dim, red, yellow, green } from './src/color.mjs';
const types = [bold, dim, red, yellow, green].map(f => typeof f);
process.stdout.write(types.join(','));
`;
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      cwd: import.meta.dirname + '/..',
      env: { ...process.env, NO_COLOR: '1' },
    });
    strictEqual(result.stdout, 'function,function,function,function,function');
  });

  it('each function returns its input as a string', () => {
    const script = `
import { bold, dim, red, yellow, green } from './src/color.mjs';
const results = [bold('a'), dim('b'), red('c'), yellow('d'), green('e')];
process.stdout.write(results.join(','));
`;
    const result = spawnSync('node', ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      cwd: import.meta.dirname + '/..',
      env: { ...process.env, NO_COLOR: '1' },
    });
    strictEqual(result.stdout, 'a,b,c,d,e');
  });
});
