// Real editor logic/DOM, with selection positioning omitted by linkedom.
import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {BlockEditor} from '../../assets/app/block-editor.mjs';
import {parseBlocks,rewriteBlock} from '../../assets/app/block-model.mjs';
const original={document:globalThis.document,window:globalThis.window,getSelection:globalThis.getSelection};
afterEach(()=>Object.assign(globalThis,original));
function editor(body) {
  const {document,window}=parseHTML('<html><body><main id="editor"></main></body></html>');
  Object.assign(globalThis,{document,window,getSelection:()=>null});
  const value=new BlockEditor(document.getElementById('editor'));
  value.focus=()=>{}; // Linkedom has no native selection/range implementation.
  value.set(body);return value;
}
function edit(value,text,inputType='insertFromPaste') {
  const target=value.root.querySelector('.block-paragraph [data-editable]');
  target.textContent=text;value.input({target,inputType});
}
test('flat block snapshots isolate mutations and preserve exact untouched source through undo/redo',()=>{
  const body='# Heading\r\n\r\nOriginal 先 🧭.\r\n\r\n<!-- retained -->\r\n\r\n- [ ] A task\r\n\r\n```js\r\nconst x=1;\r\n```\r\n\r\n## Version History\r\n\r\n- Kept byte for byte.\r\n';
  const value=editor(body),snapshot=value.snapshot();
  for(const block of parseBlocks(body))assert.ok(Object.values(block).every(field=>field===null||typeof field!=='object'),'Snapshot sharing requires primitive block fields');
  assert.notEqual(snapshot.blocks[0],value.blocks[0]);
  const originalText=snapshot.blocks[0].text;
  value.blocks[0].text='Changed directly';assert.equal(snapshot.blocks[0].text,originalText);value.blocks=snapshot.blocks;
  edit(value,'First 先 🧭.');const first=value.source();
  edit(value,'Second 先 🧭.');const second=value.source();
  assert.ok(first.endsWith(body.slice(body.indexOf('<!-- retained -->'))));
  value.undo();assert.equal(value.source(),first);
  value.undo();assert.equal(value.source(),body);
  value.undo(true);assert.equal(value.source(),first);
  value.undo(true);assert.equal(value.source(),second);
  value.undo();edit(value,'New branch.');assert.equal(value.future.length,0);
});
test('ordinary documents retain 100 separate actions; typing groups and document switching retain their behavior',()=>{
  const value=editor('Original.\n');
  for(let i=0;i<120;i++)edit(value,'Edit '+i+'.');
  assert.equal(value.history.length,100);
  value.set('New document.\n');assert.equal(value.history.length,0);assert.equal(value.future.length,0);
  edit(value,'A.','insertText');edit(value,'AB.','insertText');assert.equal(value.history.length,1);
  value.undo();assert.equal(value.source(),'New document.\n');
});
test('moving a raw boundary without changing source does not create an undo action',()=>{
  const value=editor('A paragraph.\n\nAnother.\n'),before=value.snapshot();
  value.blocks[0].raw+='\n';value.blocks[1].raw=value.blocks[1].raw.slice(1);
  value.commit(before);assert.equal(value.history.length,0);
});
test('large edits bound both undo and redo history by bytes while keeping immediate undo/redo usable',()=>{
  const text='Large Unicode 先 🧭. '.repeat(25000),value=editor(text+'\n');
  for(let i=0;i<120;i++)edit(value,text+' Edit '+i+'.');
  const bytes=()=>[...value.history,...value.future].reduce((sum,snapshot)=>sum+snapshot.bytes,0);
  assert.ok(value.history.length>1&&value.history.length<100);
  assert.ok(bytes()<=32*1024*1024);
  const final=value.source();value.undo();const before=value.source();assert.notEqual(before,final);
  value.undo(true);assert.equal(value.source(),final);assert.ok(bytes()<=32*1024*1024);
  for(let i=0;i<5;i++)value.undo();assert.ok(bytes()<=32*1024*1024);
  value.undo(true);assert.ok(bytes()<=32*1024*1024);
});
test('a single oversized snapshot remains undoable instead of discarding the nearest action',()=>{
  const value=editor('Original.\n'),text='x'.repeat(8*1024*1024);
  // Avoid a giant mock DOM: this is the same snapshot/commit path used by toolbar actions.
  value.blocks=parseBlocks(text+'\n');
  value.mutate(()=>rewriteBlock(value.blocks[0],text+' edited'));
  value.mutate(()=>rewriteBlock(value.blocks[0],text+' edited again'));
  assert.equal(value.history.length,1);
  assert.ok(value.history[0].bytes>32*1024*1024);
  assert.equal(value.history[0].blocks[0].text,text+' edited');
});
