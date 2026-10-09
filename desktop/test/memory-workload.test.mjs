import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {cpuMilliseconds,percentile,fixture,ownedProcesses,sha256,measureHelper} from '../scripts/memory-workload.mjs';
test('allocation profiling refuses a real read-only checkout before starting a helper',async()=>{
  await assert.rejects(measureHelper({engine:'/unused',root:'/unused',allocationProfileDirectory:'/unused'}),/isolated mutable fixture/);
});
test('process attribution follows descendants and excludes unrelated helpers and services',()=>{
  const table='100 1 1000 /path/RunlistHelper\n102 101 300 git\n101 100 2000 /path/RunlistGit\n200 1 999999 /path/RunlistHelper\n300 1 900000 other-service\n';
  const items=ownedProcesses(table,100);
  assert.deepEqual(items.map(item=>item.pid),[100,102,101]);
  assert.equal(items.reduce((sum,item)=>sum+item.rssBytes,0),3300*1024);
});
test('process CPU times preserve seconds, hours and day prefixes',()=>{
  assert.equal(cpuMilliseconds('0:00.12'),120);
  assert.equal(cpuMilliseconds('12:34.56'),754560);
  assert.equal(cpuMilliseconds('01:02:03'),3723000);
  assert.equal(cpuMilliseconds('2-01:02:03'),176523000);
  assert.throws(()=>cpuMilliseconds('unavailable'));
  assert.equal(percentile([9,1,3,2,8],.5),3);
  assert.equal(percentile([], .95),null);
});
test('measurement fixtures isolate mutations, include a large Unicode document and clean up',()=>{
  const corpus=fixture(100);
  try {
    assert.equal(corpus.documents,101);
    assert.ok(readFileSync(path.join(corpus.root,corpus.large),'utf8').includes('先 🧭'));
    assert.ok(readFileSync(path.join(corpus.root,corpus.large)).length>2*1024*1024);
    assert.equal(sha256(path.join(corpus.root,corpus.large)),createHash('sha256').update(readFileSync(path.join(corpus.root,corpus.large))).digest('hex'));
    assert.equal(readFileSync(path.join(corpus.root,'.runlist/flags.jsonl'),'utf8').trim().split('\n').length,10);
  }finally{corpus.close();}
  assert.equal(existsSync(corpus.root),false);
});
