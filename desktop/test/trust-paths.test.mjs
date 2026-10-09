import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {checkoutTrust} from '../trust.mjs';
const dirs=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function fixture(){
  const parent=realpathSync(mkdtempSync(path.join(tmpdir(),'runlist-trust-paths-')));dirs.push(parent);
  const root=path.join(parent,'checkout'),outside=path.join(parent,'checkout-other');
  mkdirSync(root);mkdirSync(outside);writeFileSync(path.join(outside,'settings.mjs'),"export const root='outside';\n");
  return {root,outside};
}
test('configuration discovery rejects actual parent and sibling-prefix imports without executing them',()=>{
  const {root,outside}=fixture();
  writeFileSync(path.join(outside,'settings.mjs'),"throw new Error('CONFIGURATION MUST NOT EXECUTE');\n");
  writeFileSync(path.join(root,'runlist.config.mjs'),"import '../checkout-other/settings.mjs';\n");
  assert.throws(()=>checkoutTrust(root),/inside the selected checkout/);
  assert.equal(readFileSync(path.join(outside,'settings.mjs'),'utf8'),"throw new Error('CONFIGURATION MUST NOT EXECUTE');\n");
});
test('configuration discovery rejects escape through a symlink or Windows junction parent',()=>{
  const {root,outside}=fixture();
  symlinkSync(outside,path.join(root,'linked'),process.platform==='win32'?'junction':'dir');
  writeFileSync(path.join(root,'runlist.config.mjs'),"import './linked/settings.mjs';\n");
  assert.throws(()=>checkoutTrust(root),/inside the selected checkout/);
});
test('configuration discovery rejects internal symlink/junction aliases before Node can cache their targets',()=>{
  const {root}=fixture();const target=path.join(root,'original');mkdirSync(target);
  writeFileSync(path.join(target,'settings.mjs'),"export const root='docs';\n");
  symlinkSync(target,path.join(root,'linked'),process.platform==='win32'?'junction':'dir');
  writeFileSync(path.join(root,'runlist.config.mjs'),"import './linked/settings.mjs';\n");
  assert.throws(()=>checkoutTrust(root),/without symlinks/);
});
test('canonical discovery keeps valid nested imports and fingerprints their exact source',()=>{
  const {root}=fixture();mkdirSync(path.join(root,'nested'));
  const target=path.join(root,'nested/settings.mjs');writeFileSync(target,"export const root='docs';\n");
  writeFileSync(path.join(root,'runlist.config.mjs'),"export {root} from './nested/settings.mjs';\nthrow new Error('READ ONLY');\n");
  const first=checkoutTrust(root);assert.equal(first.root,realpathSync(root));
  assert.deepEqual(first.files.sort(),['nested/settings.mjs','runlist.config.mjs'].map(file=>file.split('/').join(path.sep)).sort());
  writeFileSync(target,"export const root='changed';\n");assert.notEqual(checkoutTrust(root).fingerprint,first.fingerprint);
});
