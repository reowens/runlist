import { afterEach, describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { resolveConfig } from '../src/config.mjs';
import { resolveStatusMetadata, statusMetadataFor, statusesForContext } from '../src/status-metadata.mjs';
import { computeIsStale } from '../src/validate.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let repo;

async function setup(configSource) {
  repo = mkdtempSync(path.join(os.tmpdir(), 'dotmd-status-meta-'));
  mkdirSync(path.join(repo, 'docs'), { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: repo });
  writeFileSync(path.join(repo, 'dotmd.config.mjs'), configSource);
  return resolveConfig(repo);
}

afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });

describe('effective status metadata', () => {
  it('preserves type order, defaults unbucketed statuses to counted, and keeps type context separate', async () => {
    const config = await setup(`
      export const root = 'docs';
      export const types = {
        plan: { statuses: ['active', 'custom', 'never', 'archived'], context: { expanded: ['active'], listed: [], counted: ['archived'] }, staleDays: { custom: 2, never: null } },
        doc: { statuses: ['active', 'custom'], context: { expanded: ['custom'], listed: ['active'], counted: [] } },
      };
    `);
    const metadata = resolveStatusMetadata(config);
    deepStrictEqual(metadata.byType.plan.map(item => item.name), ['active', 'custom', 'never', 'archived']);
    strictEqual(statusMetadataFor(config, 'plan', 'custom').context, 'counted');
    strictEqual(statusMetadataFor(config, 'plan', 'custom').staleDays, 2);
    strictEqual(statusMetadataFor(config, 'doc', 'custom').context, 'expanded');
    strictEqual(statusMetadataFor(config, 'plan', 'never').staleDays, null);
    strictEqual(computeIsStale('never', '2020-01-01', config, 'plan'), false);
    deepStrictEqual(statusesForContext(config, 'plan', 'expanded'), ['active']);
  });

  it('drives built-in stale and actionable presets from custom status semantics', async () => {
    await setup(`
      export const root = 'docs';
      export const types = {
        plan: { statuses: {
          urgent: { context: 'expanded', staleDays: 1 },
          parked: { context: 'listed', staleDays: 1 },
          archived: { context: 'counted', terminal: true, archive: true }
        } }
      };
    `);
    writeFileSync(path.join(repo, 'docs', 'urgent.md'), '---\ntype: plan\nstatus: urgent\nupdated: 2020-01-01\nnext_step: act\n---\n# Urgent\n');
    writeFileSync(path.join(repo, 'docs', 'parked.md'), '---\ntype: plan\nstatus: parked\nupdated: 2020-01-01\nnext_step: wait\n---\n# Parked\n');
    const run = args => spawnSync('node', [BIN, ...args, '--config', path.join(repo, 'dotmd.config.mjs')], { cwd: repo, encoding: 'utf8' });
    const actionable = JSON.parse(run(['actionable', '--json']).stdout);
    deepStrictEqual(actionable.docs.map(doc => doc.path), ['docs/urgent.md']);
    const stale = JSON.parse(run(['stale', '--json']).stdout);
    ok(stale.docs.some(doc => doc.path === 'docs/urgent.md'));
    ok(stale.docs.some(doc => doc.path === 'docs/parked.md'));
  });
});
