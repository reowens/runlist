import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GATE_API_VERSION, parseGate, gateDeclarations, createGateReader, resolveConfig, buildIndex } from 'runlist/gates';

test('public consumer interface retains declarations and archived fragment evidence', async () => {
  assert.equal(GATE_API_VERSION, 1);
  assert.deepEqual(parseGate('plan: b.md#phase-two'), {kind:'plan',ref:'b.md#phase-two'});
  const root=mkdtempSync(path.join(tmpdir(),'runlist-public-gates-'));
  try {
    mkdirSync(path.join(root,'docs'));
    writeFileSync(path.join(root,'runlist.config.mjs'),"export const root='docs';\n");
    const source='---\ntype: plan\nstatus: active\ndepends_on:\n  - "plan: b.md#phase-two"\n  - "external: endpoint proof"\n---\n# A\n';
    writeFileSync(path.join(root,'docs/a.md'),source);
    writeFileSync(path.join(root,'docs/b.md'),'---\ntype: plan\nstatus: archived\n---\n# B\n## Phase two\n');
    const config=await resolveConfig(root);
    const index=buildIndex(config,{fast:true});
    const gates=createGateReader(index.docs,config)('docs/a.md');
    assert.equal(gateDeclarations(source,config).entries.length,2);
    assert.equal(gates.entries[0].target.fragment,'phase-two');
    assert.equal(gates.entries[0].target.status,'archived');
    assert.equal(gates.entries[0].diagnostic,'resolved-unevaluated');
    assert.equal(gates.entries[1].diagnostic,'unevaluated');
    assert.equal(gates.ready,undefined);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
