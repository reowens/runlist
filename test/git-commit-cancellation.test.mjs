import {test} from 'node:test';
import assert from 'node:assert/strict';
import {requestCommitCancellation} from '../src/git-commit-cancellation.mjs';

function fixture(){
 const receipt={id:'operation',state:'reviewing',action:'preview',workerOwner:{pid:12345,hostname:'fixture',processStartIdentity:'fixture-start'},head:'original-head',indexReady:false};
 const store={read:id=>{assert.equal(id,receipt.id);return structuredClone(receipt);},update:(id,change)=>{assert.equal(id,receipt.id);change(receipt);}};
 return {receipt,store};
}

test('a denied cancellation signal is typed and retains the unfinished receipt',()=>{
 for(const code of ['EPERM','EINVAL']){
  const {receipt,store}=fixture(),before=structuredClone(receipt),signals=[];
  assert.throws(()=>requestCommitCancellation(store,receipt.id,{
   ownerLiveness:owner=>{assert.deepEqual(owner,before.workerOwner);return 'live';},
   signal:(pid,signal)=>{signals.push([pid,signal]);throw Object.assign(new Error('raw operating system diagnostic'),{code});},
  }),error=>error.code==='git-cancel-failed'&&/Keep its receipt/.test(error.message)&&!error.message.includes('raw operating system'));
  assert.deepEqual(signals,[[-before.workerOwner.pid,'SIGKILL']]);
  assert.ok(Number.isFinite(Date.parse(receipt.cancelRequestedAt)));
  const {cancelRequestedAt,...retained}=receipt;
  assert.deepEqual(retained,before); // No stopped/committed state or recovery claim.
  assert.deepEqual(store.read(receipt.id),receipt);
 }
});

test('a vanished process group is tolerated without declaring the worker stopped',()=>{
 const {receipt,store}=fixture(),before=structuredClone(receipt),signals=[];
 assert.equal(requestCommitCancellation(store,receipt.id,{ownerLiveness:()=> 'live',signal:(pid,signal)=>{signals.push([pid,signal]);throw Object.assign(new Error('gone'),{code:'ESRCH'});}}),undefined);
 assert.deepEqual(signals,[[-before.workerOwner.pid,'SIGKILL']]);
 assert.ok(receipt.cancelRequestedAt);
 const {cancelRequestedAt,...retained}=receipt;
 assert.deepEqual(retained,before); // The caller must still recheck liveness.
});

test('unverified or dead ownership refuses cancellation before changing the receipt or signaling',()=>{
 for(const status of ['unverifiable','dead']){
  const {receipt,store}=fixture(),before=structuredClone(receipt);
  assert.throws(()=>requestCommitCancellation(store,receipt.id,{ownerLiveness:()=>status,signal:()=>assert.fail('must not signal an unverified owner')}),{code:'git-owner-unverified'});
  assert.deepEqual(receipt,before);
 }
});
