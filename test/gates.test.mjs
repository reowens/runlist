import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import { buildIndex } from '../src/index.mjs';
import { createGateReader } from '../src/gates.mjs';
import { configuredReferenceFields, createReferenceIdentitySet, rewriteDocumentReferences } from '../src/reference-planner.mjs';
import { dependencyTree, boundedOutput, DEPENDENCY_LIMITS } from '../src/dependency-tree.mjs';
const roots=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
async function fixture(gates, extra='') {
 const root=mkdtempSync(path.join(os.tmpdir(),'runlist-gates-'));roots.push(root);mkdirSync(path.join(root,'docs'));
 writeFileSync(path.join(root,'runlist.config.mjs'),`export const root='docs'; ${extra}`);
 writeFileSync(path.join(root,'docs/a.md'),`---\ntype: plan\nstatus: active\ndepends_on:\n${gates}\n---\n# A\n`);
 writeFileSync(path.join(root,'docs/b.md'),'---\ntype: plan\nstatus: archived\n---\n# B\n## Phase two\n- [x] Local check\n## Decisions\n### D7 Which path?\nDisposition: CLOSED. Withdrawn.\n');
 const config=await resolveConfig(root);const index=buildIndex(config,{fast:true});return {root,config,index,read:createGateReader(index.docs,config)};
}
test('fragments, archival, decision outcome and prose retain their different meanings',async()=>{
 const {read}=await fixture('  - "plan: b.md#phase-two"\n  - "decision: b.md#D7"\n  - "external: arrival"\n  - "decision: choose a path"\n  - "plan: b.md#missing"');
 const gates=read('docs/a.md');assert.equal(gates.review,'declared');assert.equal(gates.entries[0].target.fragment,'phase-two');assert.equal(gates.entries[0].target.status,'archived');assert.equal(gates.entries[0].diagnostic,'resolved-unevaluated');assert.equal(gates.entries[1].observed.disposition,'closed');assert.equal(gates.entries[1].diagnostic,'resolved-unevaluated');assert.equal(gates.entries[2].diagnostic,'unevaluated');assert.equal(gates.entries[3].diagnostic,'unevaluated');assert.equal(gates.entries[4].diagnostic,'missing-fragment');assert.equal(gates.ready,undefined);
});
test('empty scaffolds and explicit none declarations are distinct',async()=>{
 let f=await fixture('  -');assert.equal(f.read('docs/a.md').review,'unreviewed');
 f=await fixture('  - "none: isolated work"');assert.equal(f.read('docs/a.md').review,'declared-none');
 f=await fixture('  - "none: isolated work"\n  - "plan: b.md"');assert.equal(f.read('docs/a.md').entries[0].diagnostic,'invalid-none');
});
test('ambiguous document-relative and repository-relative targets are not guessed',async()=>{
 const f=await fixture('  - "plan: b.md"');writeFileSync(path.join(f.root,'b.md'),'# Root B');
 assert.equal(createGateReader([...f.index.docs,{path:'b.md',status:'active'}],f.config)('docs/a.md').entries[0].diagnostic,'ambiguous-target');
});
test('gate fields are separate from reciprocal reference graphs',async()=>{
 const f=await fixture('  - "plan: b.md"',"export const referenceFields={bidirectional:['depends_on','related_plans']};");
 assert(!f.config.referenceFields.bidirectional.includes('depends_on'));assert(f.config.configWarnings.some(w=>w.includes('gate semantics')));
 assert.deepEqual(f.index.docs.find(d=>d.path==='docs/a.md').refFields.depends_on,undefined);
});
test('rename preserves typed kind, fragment and external prose, including custom gate fields',async()=>{
 const f=await fixture('  - "plan: b.md#phase-two"\n  - "external: evidence in b.md"');
 const oldPath=path.join(f.root,'docs/b.md'),newPath=path.join(f.root,'docs/c.md');
 const content='---\ntype: plan\nneeds:\n  - "plan: b.md#phase-two"\n  - "decision: b.md#D7"\n  - "external: evidence in b.md"\n---\n# A\n';
 const fields=configuredReferenceFields({...f.config,dependencyField:'needs'});
 const changed=rewriteDocumentReferences(content,{sourcePath:path.join(f.root,'docs/a.md'),repoRoot:f.root,identities:createReferenceIdentitySet([oldPath]),oldPath,newPath,referenceFields:fields,dependencyField:'needs'});
 assert(changed.includes('plan: c.md#phase-two'));assert(changed.includes('decision: c.md#D7'));assert(changed.includes('external: evidence in b.md'));
});
test('shared DAGs expand each node once and preserve cycle evidence',()=>{
 const docs=new Map(Array.from({length:30},(_,i)=>[`docs/${i}.md`,{status:'active'}]));
 const forward=new Map([...docs.keys()].map((key,i)=>[key,[...docs.keys()].slice(i+1).map(target=>({target,field:'related_plans'}))]));
 const tree=dependencyTree({path:'docs/0.md',status:'active'},forward,new Map(),docs,64);
 assert.equal(tree.traversal.expanded,30);assert(tree.traversal.examined<500);assert(JSON.stringify(tree).length<100000);assert(tree.dependsOn.some(n=>n.shared));
 forward.set('docs/1.md',[{target:'docs/0.md',field:'related_plans'}]);
 assert(dependencyTree({path:'docs/0.md'},forward,new Map(),docs,5).dependsOn[0].dependsOn[0].cycle);
 const limited=dependencyTree({path:'docs/0.md'},forward,new Map(),docs,0);assert(limited.truncated);assert.deepEqual(limited.dependsOn,[]);
});
test('one oversized authored value cannot exhaust serialized output',()=>{
 const out=boundedOutput({blockers:['x'.repeat(2000000)]});assert(out.truncated);assert(out.truncationReasons.includes('value'));assert(Buffer.byteLength(JSON.stringify(out,null,2))<DEPENDENCY_LIMITS.bytes);
});
test('CLI adds exact inverse gates and keeps existing JSON keys',async()=>{
 const f=await fixture('  - "plan: b.md#phase-two"');
 const cli=path.resolve('bin/runlist.mjs');
 const run=(...args)=>spawnSync(process.execPath,[cli,...args],{cwd:f.root,encoding:'utf8'});
 const dep=run('deps','docs/a.md','--json');assert.equal(dep.status,0,dep.stderr);const data=JSON.parse(dep.stdout);assert(Array.isArray(data.dependsOn));assert.equal(data.gates.entries[0].target.fragment,'phase-two');
 const inverse=run('unblocks','docs/b.md','--json');assert.equal(inverse.status,0,inverse.stderr);assert.equal(JSON.parse(inverse.stdout).gates[0].dependent,'docs/a.md');
 const show=run('show','docs/a.md','--json');assert.equal(show.status,0,show.stderr);assert.equal(JSON.parse(show.stdout)[0].gates.review,'declared');
 const zero=run('deps','docs/a.md','--depth','0','--json');assert.equal(zero.status,0,zero.stderr);
 assert.notEqual(run('deps','docs/a.md','--depth','-1').status,0);
});
