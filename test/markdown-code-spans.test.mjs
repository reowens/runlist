import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert';
import { maskInlineCodeLine, maskInlineCodeSpans } from '../src/markdown-code-spans.mjs';

describe('maskInlineCodeLine', () => {
  it('leaves a line with no backticks alone', () => {
    strictEqual(maskInlineCodeLine('plain [a](b.md)'), 'plain [a](b.md)');
  });

  it('masks every span on a line and keeps its length', () => {
    const line = 'a `x` b ``y`z`` c';
    const masked = maskInlineCodeLine(line);
    strictEqual(masked, 'a xxx b xxxxxxx c');
    strictEqual(masked.length, line.length);
  });

  it('closes a span only on a run of the same length', () => {
    strictEqual(maskInlineCodeLine('``a`b`` [l](x.md)'), 'xxxxxxx [l](x.md)');
  });

  it('carries an unclosed opener to the next line until its closer', () => {
    const state = { run: null };
    strictEqual(maskInlineCodeLine('before `open', state), 'before xxxxx');
    strictEqual(maskInlineCodeLine('no ticks here', state), 'xxxxxxxxxxxxx');
    strictEqual(maskInlineCodeLine('end` after', state), 'xxxx after');
    strictEqual(state.run, null);
  });
});

describe('maskInlineCodeSpans', () => {
  it('keeps newlines and offsets across a multiline span', () => {
    const value = 'a `b\nc` d';
    const masked = maskInlineCodeSpans(value);
    strictEqual(masked, 'a xx\nxx d');
    strictEqual(masked.length, value.length);
  });
});
