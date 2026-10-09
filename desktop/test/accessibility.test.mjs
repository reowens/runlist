// DOM and keyboard checks only. No browser, WebView, native window or OS input.
import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseHTML} from 'linkedom';

const assets=process.env.RUNLIST_TEST_ASSETS??path.resolve(import.meta.dirname,'../../assets/app');
const {documentViews}=await import(pathToFileURL(path.join(assets,'document-views.mjs')));
const {BlockEditor}=await import(pathToFileURL(path.join(assets,'block-editor.mjs')));
const original={document:globalThis.document,window:globalThis.window};
afterEach(()=>{Object.assign(globalThis,original);});
function dom() {
  const result=parseHTML(readFileSync(path.join(assets,'index.html'),'utf8'));
  globalThis.document=result.document;globalThis.window=result.window;
  return result;
}
test('document tabs/panels and modal dialogs have resolvable accessible names and relationships',()=>{
  const {document}=dom(), ids=[...document.querySelectorAll('[id]')].map(el=>el.id);
  assert.equal(new Set(ids).size,ids.length,'IDs must be unique');
  for(const el of document.querySelectorAll('[aria-labelledby],[aria-controls]')) {
    for(const attr of ['aria-labelledby','aria-controls'])for(const id of (el.getAttribute(attr)??'').split(/\s+/).filter(Boolean)) {
      assert.ok(document.getElementById(id),`${attr} points at missing ${id}`);
    }
  }
  const tabs=[...document.querySelectorAll('#document-tabs > [role=tab]')];
  assert.equal(tabs.length,4);
  for(const tab of tabs) {
    const panel=document.getElementById(tab.getAttribute('aria-controls'));
    assert.equal(panel.getAttribute('role'),'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'),tab.id);
    assert.ok(tab.textContent.trim());
  }
  for(const dialog of document.querySelectorAll('dialog'))assert.ok(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent.trim());
  assert.ok(document.getElementById('main').getAttribute('aria-label'));
  assert.equal(document.getElementById('document').getAttribute('aria-labelledby'),'doc-title');
});
test('view changes expose one panel/Tab stop; arrow/Home/End keys wrap and skip disabled editing',()=>{
  const {document,window}=dom(), $=id=>document.getElementById(id);
  let focused,controller;
  const activate=mode=>controller.update(mode);
  controller=documentViews({$,view:activate});
  for(const tab of document.querySelectorAll('[role=tab]'))tab.focus=()=>focused=tab.id;
  const key=(id,value)=>{
    const event=new window.Event('keydown',{bubbles:true,cancelable:true});
    Object.defineProperty(event,'key',{value});$(id).dispatchEvent(event);assert.equal(event.defaultPrevented,true);
  };
  for(const mode of ['read','edit','review','source']) {
    controller.update(mode);
    assert.equal(document.querySelectorAll('[role=tab][aria-selected=true]').length,1);
    assert.equal(document.querySelectorAll('[role=tab][tabindex="0"]').length,1);
    assert.equal([...document.querySelectorAll('[role=tabpanel]')].filter(p=>!p.hidden).length,1);
  }
  key('tab-source','ArrowRight');assert.equal(focused,'tab-read');
  key('tab-read','End');assert.equal(focused,'tab-source');
  key('tab-source','Home');assert.equal(focused,'tab-read');
  $('tab-edit').disabled=true;key('tab-read','ArrowRight');assert.equal(focused,'tab-review');
  key('tab-review','ArrowLeft');assert.equal(focused,'tab-read');
  const untouched=new window.Event('keydown',{bubbles:true,cancelable:true});
  Object.defineProperty(untouched,'key',{value:'s'});$('tab-read').dispatchEvent(untouched);assert.equal(untouched.defaultPrevented,false);
});
test('inline blocks expose named multiline textboxes and update read-only semantics without altering source',()=>{
  const {document}=dom(), root=document.getElementById('block-editor'), editor=new BlockEditor(root,{});
  const body='# Heading\n\nA paragraph.\n\n- [ ] A task\n\n## Version History\n\n- Existing.\n';
  editor.set(body);
  assert.equal(root.getAttribute('role'),'group');
  const editable=[...root.querySelectorAll('[data-editable]')];assert.ok(editable.length>=3);
  for(const node of editable){assert.equal(node.getAttribute('role'),'textbox');assert.equal(node.getAttribute('aria-multiline'),'true');assert.ok(node.getAttribute('aria-label'));assert.equal(node.getAttribute('aria-readonly'),'false');}
  assert.equal(editable[0].getAttribute('aria-description'),'Heading level 1');
  editor.setReadOnly(true);
  for(const node of editable){assert.equal(node.getAttribute('aria-readonly'),'true');assert.equal(node.getAttribute('contenteditable'),'false');}
  assert.equal(root.querySelectorAll('.locked-block [data-editable]').length,0);
  editor.setReadOnly(false);
  assert.equal(editor.source(),body);
});
