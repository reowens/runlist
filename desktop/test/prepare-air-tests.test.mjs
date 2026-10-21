import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,readlinkSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {inventory,prepareAirTests,runAirHelper,verifyAirPayload} from '../scripts/prepare-air-tests.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
function write(root,name,value='fixture') {const file=path.join(root,name);mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,value);}
function fixture(t) {
  const root=realpathSync(mkdtempSync(path.join(tmpdir(),'runlist-air-payload-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),app=path.join(root,'Runlist.app'),engine=path.join(app,'Contents/Resources/engine'),harness=path.join(root,'harness');
  const pkg=JSON.stringify({name:'runlist',version:'1.2.3-review.1'});
  write(source,'package.json',pkg);write(engine,'package.json',pkg);
  const code="import {readFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; import path from 'node:path'; export function sourceFingerprint(root){return {state:'readable',sha256:createHash('sha256').update(readFileSync(path.join(root,'src/code.mjs'))).digest('hex')}}";
  write(source,'src/installation.mjs',code);write(source,'src/code.mjs','selected engine');write(engine,'src/code.mjs','selected engine');
  for(const name of ['desktop/test/helper.test.mjs','desktop/test/headless-ui.test.mjs','desktop/test/accessibility.test.mjs','desktop/test/helper-environment.mjs','test/native-fixtures.mjs'])write(source,name);
  for(const name of ['linkedom','acorn','entities'])write(source,`desktop/node_modules/${name}/package.json`,JSON.stringify({name,version:'1.0.0'}));
  write(source,'desktop/node_modules/@tauri-apps/cli/package.json','{}');
  write(engine,'bundle-manifest.json',JSON.stringify({version:'1.2.3-review.1',protocol:1,platform:'darwin',architecture:'arm64'}));
  write(engine,'runtime/RunlistHelper');write(engine,'desktop/helper.mjs');write(engine,'assets/app/app.mjs');
  write(app,'Contents/_CodeSignature/CodeResources','synthetic signature resource');
  symlinkSync('_CodeSignature/CodeResources',path.join(app,'Contents/CodeResources'));
  write(harness,'RunlistAcceptance.xcodeproj/project.pbxproj');write(harness,'RunlistAcceptance.xcodeproj/xcshareddata/xcschemes/RunlistAcceptance.xcscheme');write(harness,'RunlistAcceptanceTests.swift');
  const files=inventory(source).filter(file=>!file.path.includes('node_modules')).map(file=>({path:file.path,candidateSha256:file.sha256}));
  const sourceManifest=path.join(root,'source-manifest.json');writeFileSync(sourceManifest,JSON.stringify({candidateVersion:'1.2.3-review.1',files,inventorySha256:hash(JSON.stringify(files)),baseHead:'fixture-commit'}));
  return {root,source,sourceManifest,app,engine,harness,output:path.join(root,'payload')};
}

test('payload freezes signed app, exact source, dependency closure and harness with independently verifiable identities',async t=>{
  const f=fixture(t);let signatures=0;
  const result=await prepareAirTests(f,{verifySignature:app=>{assert.equal(app,f.app);signatures++;}});
  assert.equal(signatures,1);assert.equal(result.manifestSha256,hash(readFileSync(path.join(f.output,'manifest.json'))));
  const manifest=verifyAirPayload(f.output,f.app);
  assert.deepEqual(manifest.profiles,['installed-helper','native-window']);assert.equal(manifest.bundleIdentifier,'dev.reowens.runlist');
  assert.equal(result.appSha256,manifest.app.sha256);assert.equal(result.harnessSha256,manifest.harness.sha256);
  assert.ok(existsSync(path.join(f.output,'source/desktop/node_modules/entities/package.json')));
  assert.ok(!existsSync(path.join(f.output,'source/desktop/node_modules/@tauri-apps')));
  assert.equal(readFileSync(path.join(f.output,'source/src/code.mjs'),'utf8'),'selected engine');
  assert.ok(existsSync(path.join(f.output,'harness/prepare-air-tests.mjs')));
  assert.equal(readlinkSync(path.join(f.output,'application/Runlist.app/Contents/CodeResources')),'_CodeSignature/CodeResources');
  let invocation;
  assert.equal(runAirHelper(f.output,f.app,{execute:(command,args,options)=>{invocation={command,args,options};return {status:7};}}),7);
  assert.equal(invocation.command,'/usr/bin/sandbox-exec');
  assert.equal(invocation.args[1],'(version 1)(allow default)(deny network*)');
  assert.equal(invocation.args[2],path.join(f.engine,'runtime/RunlistHelper'));
  assert.deepEqual(invocation.args.slice(3),['--experimental-vm-modules','--test','desktop/test/helper.test.mjs','desktop/test/headless-ui.test.mjs','desktop/test/accessibility.test.mjs']);
  assert.equal(invocation.options.cwd,path.join(f.output,'source'));assert.equal(invocation.options.env.NODE_OPTIONS,'');
  assert.equal(invocation.options.env.RUNLIST_TEST_HELPER,path.join(f.engine,'desktop/helper.mjs'));
  assert.equal(invocation.options.env.RUNLIST_TEST_ASSETS,path.join(f.engine,'assets/app'));
  assert.deepEqual(readdirSync(f.root).sort(),['Runlist.app','harness','payload','source','source-manifest.json']);
});

test('signature, stale provenance, mismatched source and unsafe output refuse before creating payload',async t=>{
  const f=fixture(t),options={verifySignature(){}};
  await assert.rejects(prepareAirTests(f,{verifySignature(){throw Error('signature refused');}}),/signature refused/);
  assert.equal(existsSync(f.output),false);
  write(f.source,'src/code.mjs','changed engine');
  await assert.rejects(prepareAirTests(f,options),/differs from provenance/);assert.equal(existsSync(f.output),false);
  write(f.engine,'src/code.mjs','changed engine');
  await assert.rejects(prepareAirTests(f,options),/differs from provenance/);assert.equal(existsSync(f.output),false);
  write(f.source,'src/code.mjs','selected engine');
  await assert.rejects(prepareAirTests(f,options),/fingerprint differ/);assert.equal(existsSync(f.output),false);
  write(f.engine,'src/code.mjs','selected engine');
  await assert.rejects(prepareAirTests({...f,output:path.join(f.source,'payload')},options),/separate from its inputs/);
  mkdirSync(f.output);await assert.rejects(prepareAirTests(f,options),/must not already exist/);
});

test('payload mutation, installed-app drift and added files refuse before helper execution',async t=>{
  const f=fixture(t);await prepareAirTests(f,{verifySignature(){}});let calls=0;
  const execute=()=>{calls++;return {status:0};};
  write(f.app,'Contents/Resources/engine/src/code.mjs','other installed engine');
  assert.throws(()=>runAirHelper(f.output,f.app,{execute}),/Installed application differs/);
  write(f.app,'Contents/Resources/engine/src/code.mjs','selected engine');
  write(f.output,'harness/unexpected.mjs','not frozen');
  assert.throws(()=>runAirHelper(f.output,f.app,{execute}),/integrity failed: harness/);
  rmSync(path.join(f.output,'harness/unexpected.mjs'));
  write(f.output,'source/desktop/test/helper.test.mjs','changed tests');
  assert.throws(()=>verifyAirPayload(f.output,f.app),/integrity failed: source/);assert.equal(calls,0);
});

test('escaping symlinks and unsafe manifest paths cannot import files outside selected source',async t=>{
  const f=fixture(t);
  symlinkSync(f.source,path.join(f.harness,'outside'));
  await assert.rejects(prepareAirTests(f,{verifySignature(){}}),/Symlink escapes/);
  rmSync(path.join(f.harness,'outside'));
  const provenance=JSON.parse(readFileSync(f.sourceManifest));provenance.files.unshift({path:'../secret',candidateSha256:'ignored'});
  writeFileSync(f.sourceManifest,JSON.stringify(provenance));
  await assert.rejects(prepareAirTests(f,{verifySignature(){}}),/Frozen source differs/);assert.equal(existsSync(f.output),false);
});

test('helper launch errors are returned without an alternate runner or profile fallback',async t=>{
  const f=fixture(t);await prepareAirTests(f,{verifySignature(){}});
  let calls=0;const failure=Error('sandbox unavailable');
  assert.throws(()=>runAirHelper(f.output,f.app,{execute(){calls++;return {error:failure};}}),error=>error===failure);
  assert.equal(calls,1);assert.throws(()=>runAirHelper(f.output),/installed application path/);
});
