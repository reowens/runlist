import { describe, it } from 'node:test';
import { strictEqual } from 'node:assert';
import { summarizeDocBody, runModel } from '../src/ai.mjs';

describe('ai module', () => {
  it('summarizeDocBody returns null for whitespace-only body', () => {
    strictEqual(summarizeDocBody('   \n  \n  ', { status: 'active', title: 'Test' }), null);
  });

  it('summarizeDocBody returns null for null body', () => {
    strictEqual(summarizeDocBody(null, { status: 'active', title: 'Test' }), null);
  });

  it('runModel returns null when no server answers', () => {
    strictEqual(runModel('hello', { model: 'fixture:1b' }), null);
  });
});
