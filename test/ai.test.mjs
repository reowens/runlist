import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert';
import { checkUvAvailable, DEFAULT_MODEL, summarizeDocBody, summarizeDiffText } from '../src/ai.mjs';

describe('ai module', () => {
  it('DEFAULT_MODEL is a non-empty string', () => {
    ok(typeof DEFAULT_MODEL === 'string');
    ok(DEFAULT_MODEL.length > 0);
  });

  it('checkUvAvailable returns a boolean', () => {
    const result = checkUvAvailable();
    strictEqual(typeof result, 'boolean');
  });

  it('checkUvAvailable returns consistent value (memoized)', () => {
    const first = checkUvAvailable();
    const second = checkUvAvailable();
    strictEqual(first, second);
  });

  it('summarizeDocBody returns null for whitespace-only body', () => {
    const result = summarizeDocBody('   \n  \n  ', { status: 'active', title: 'Test' });
    strictEqual(result, null);
  });

  it('summarizeDocBody returns null for null body', () => {
    const result = summarizeDocBody(null, { status: 'active', title: 'Test' });
    strictEqual(result, null);
  });
});
