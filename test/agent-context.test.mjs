import { afterEach, describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { resolveConfig } from '../src/config.mjs';
import { buildAgentContext, boundedCollection } from '../src/agent-context.mjs';

let repo;

async function configFor(source = `export const root = 'docs';\n`) {
  repo = mkdtempSync(path.join(os.tmpdir(), 'dotmd-agent-context-'));
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  writeFileSync(path.join(repo, 'dotmd.config.mjs'), source);
  return resolveConfig(repo);
}

function doc(pathName, type, status, extra = {}) {
  return { path: pathName, type, status, title: path.basename(pathName), blockers: [], ...extra };
}

afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

describe('agent context v1', () => {
  it('is type-correct, includes configured partial focus, and leaves input unchanged', async () => {
    const config = await configFor();
    const index = {
      docs: [
        doc('docs/partial.md', 'plan', 'partial'),
        doc('docs/awaiting-doc.md', 'doc', 'awaiting'),
        doc('docs/blocked-prompt.md', 'prompt', 'blocked'),
      ],
      countsByStatus: { partial: 1, awaiting: 1, blocked: 1 },
      countsByType: { plan: { partial: 1 }, doc: { awaiting: 1 }, prompt: { blocked: 1 } },
      errors: [], warnings: [],
    };
    const before = JSON.stringify(index);
    const context = buildAgentContext(index, config, { generatedAt: '2026-01-01T00:00:00.000Z' });
    strictEqual(context.schema.name, 'dotmd.agent-context');
    strictEqual(context.schema.version, 1);
    deepStrictEqual(context.plans.focus.items.map(item => item.path), ['docs/partial.md']);
    ok(!JSON.stringify(context.plans).includes('awaiting-doc'));
    ok(!JSON.stringify(context.plans).includes('blocked-prompt'));
    strictEqual(JSON.stringify(index), before, 'builder must not mutate its index');
  });

  it('reports total, shown, truncated, and items for every bounded collection', async () => {
    const config = await configFor();
    const plans = Array.from({ length: 13 }, (_, i) => doc(`docs/p-${String(i).padStart(2, '0')}.md`, 'plan', 'active'));
    const index = { docs: plans, countsByStatus: { active: 13 }, countsByType: { plan: { active: 13 } }, errors: [], warnings: [] };
    const context = buildAgentContext(index, config);
    strictEqual(context.plans.focus.total, 13);
    strictEqual(context.plans.focus.shown, 12);
    strictEqual(context.plans.focus.truncated, true);
    const collections = [
      ...Object.values(context.statusVocabulary),
      context.prompts.actionable,
      ...Object.values(context.plans),
      ...Object.values(context.issues),
    ];
    for (const collection of collections) {
      deepStrictEqual(Object.keys(collection), ['total', 'shown', 'truncated', 'items']);
    }
    deepStrictEqual(Object.keys(context.plans.focus.items[0].blockers), ['total', 'shown', 'truncated', 'items']);
    deepStrictEqual(boundedCollection([], 2), { total: 0, shown: 0, truncated: false, items: [] });
  });

  it('uses deterministic status/date/path ordering and explicit scope', async () => {
    const config = await configFor();
    const index = {
      docs: [doc('docs/z.md', 'plan', 'partial'), doc('docs/b.md', 'plan', 'active'), doc('docs/a.md', 'plan', 'active')],
      countsByStatus: { partial: 1, active: 2 }, countsByType: { plan: { partial: 1, active: 2 } }, errors: [], warnings: [],
    };
    const context = buildAgentContext(index, config, { roots: ['docs'], types: ['plan'] });
    deepStrictEqual(context.plans.focus.items.map(item => item.path), ['docs/a.md', 'docs/b.md', 'docs/z.md']);
    deepStrictEqual(context.scope, { roots: ['docs'], types: ['plan'] });
    deepStrictEqual(Object.keys(context.statusVocabulary), ['plan']);
  });
});
