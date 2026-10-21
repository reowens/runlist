import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runInstalledCheck,selectInstalledTestSource} from '../scripts/check-installed.mjs';

function write(root,file,text='') {const target=path.join(root,file);mkdirSync(path.dirname(target),{recursive:true});writeFileSync(target,text);}
function source(root,version='1.2.3-review.1',code='selected engine') {
  write(root,'package.json',JSON.stringify({name:'runlist',version}));
  write(root,'src/fixture.mjs',code);
  write(root,'desktop/helper.mjs',code);
  write(root,'assets/app/app.mjs',code);
  for(const file of ['desktop/test/helper.test.mjs','desktop/test/headless-ui.test.mjs','desktop/test/accessibility.test.mjs','desktop/test/helper-environment.mjs','test/native-fixtures.mjs'])write(root,file);
  for(const name of ['linkedom','acorn'])write(root,`desktop/node_modules/${name}/package.json`,'{}');
  return root;
}
function fixture(t) {
  const root=realpathSync(mkdtempSync(path.join(tmpdir(),'runlist-installed-check-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const repo=source(path.join(root,'checkout'),'1.2.3'),app=path.join(root,'Applications/Runlist.app'),engine=path.join(app,'Contents/Resources/engine');
  source(engine);write(engine,'runtime/RunlistHelper');
  write(engine,'bundle-manifest.json',JSON.stringify({version:'1.2.3-review.1',protocol:1,platform:'darwin',architecture:'arm64',executable:'RunlistHelper'}));
  return {root,repo,app,engine};
}

test('installed check automatically selects the matching frozen source across version skew and keeps all execution headless',t=>{
  const f=fixture(t);
  source(path.join(f.repo,'desktop/releases/a-same-version-wrong-code/source'),'1.2.3-review.1','different code');
  const selected=source(path.join(f.repo,'desktop/releases/b-selected/source'));
  // A malformed unrelated snapshot must not prevent selecting a valid one.
  write(f.repo,'desktop/releases/0-invalid/source/package.json','invalid JSON');
  let invocation,output='';
  const status=runInstalledCheck([f.app],{repo:f.repo,platform:'darwin',arch:'arm64',env:{NODE_OPTIONS:'--invalid',RUNLIST_TEST_HELPER:'/wrong/helper'},write:message=>output+=message,execute:(command,args,options)=>{invocation={command,args,options};return {status:0};}});
  assert.equal(status,0);assert.equal(invocation.options.cwd,selected);
  assert.equal(invocation.command,'/usr/bin/sandbox-exec');
  assert.equal(invocation.args[1],'(version 1)(allow default)(deny network*)');
  assert.equal(invocation.args[2],path.join(f.engine,'runtime/RunlistHelper'));
  assert.deepEqual(invocation.args.slice(3),['--experimental-vm-modules','--test','desktop/test/helper.test.mjs','desktop/test/headless-ui.test.mjs','desktop/test/accessibility.test.mjs']);
  assert.equal(invocation.options.env.RUNLIST_TEST_HELPER,path.join(f.engine,'desktop/helper.mjs'));
  assert.equal(invocation.options.env.RUNLIST_TEST_ASSETS,path.join(f.engine,'assets/app'));
  assert.equal(invocation.options.env.NODE_OPTIONS,'');
  assert.match(output,/Installed Runlist: 1\.2\.3-review\.1/);assert.ok(output.includes('Test source: '+selected));
});

test('matching checkout is preferred; an explicit source is validated and never falls back silently',t=>{
  const f=fixture(t);source(f.repo);
  assert.equal(selectInstalledTestSource(f.engine,{repo:f.repo}).source,f.repo);
  const other=source(path.join(f.root,'elsewhere'));
  assert.equal(selectInstalledTestSource(f.engine,{repo:f.repo,source:other}).source,other);
  write(other,'src/fixture.mjs','different code');
  assert.throws(()=>selectInstalledTestSource(f.engine,{repo:f.repo,source:other}),/supplied --source did not match/);
  source(other,'1.2.3');
  assert.throws(()=>selectInstalledTestSource(f.engine,{repo:f.repo,source:other}),/same version, engine fingerprint/);
});

test('missing matching source or incomplete harness fails before any process starts',t=>{
  const f=fixture(t);let calls=0;
  const options={repo:f.repo,platform:'darwin',arch:'arm64',execute:()=>{calls++;},write(){}};
  assert.throws(()=>runInstalledCheck([f.app],options),/No matching test source.*1\.2\.3-review\.1/);
  const selected=source(path.join(f.repo,'desktop/releases/selected/source'));
  rmSync(path.join(selected,'desktop/test/headless-ui.test.mjs'));
  assert.throws(()=>runInstalledCheck([f.app],options),/installed-check test files/);
  source(selected);rmSync(path.join(selected,'desktop/node_modules/linkedom/package.json'));
  assert.throws(()=>runInstalledCheck([f.app],options),/Missing test dependency linkedom; run npm ci/);
  assert.equal(calls,0);
});

test('bundle identity and host mismatches fail before any process starts',t=>{
  const f=fixture(t);source(f.repo);let calls=0;
  const original=JSON.parse(readFileSync(path.join(f.engine,'bundle-manifest.json'),'utf8'));
  const options={repo:f.repo,platform:'darwin',arch:'arm64',execute:()=>{calls++;},write(){}};
  for(const change of [{version:'other'},{protocol:2},{platform:'linux'},{architecture:'x64'},{executable:'../../unexpected'}]) {
    write(f.engine,'bundle-manifest.json',JSON.stringify({...original,...change}));
    assert.throws(()=>runInstalledCheck([f.app],options),/Installed bundle/);
  }
  assert.equal(calls,0);
});

test('explicit external snapshot, default application path and test failures are handled without changing source',t=>{
  const f=fixture(t),selected=source(path.join(f.root,'external snapshot')),before=readFileSync(path.join(selected,'package.json'),'utf8');
  const status=runInstalledCheck(['--source',selected],{repo:f.repo,home:f.root,platform:'darwin',arch:'arm64',write(){},execute:(_command,_args,options)=>{assert.equal(options.cwd,selected);return {status:7};}});
  assert.equal(status,7);assert.equal(readFileSync(path.join(selected,'package.json'),'utf8'),before);
  const failure=new Error('sandbox unavailable');
  assert.throws(()=>runInstalledCheck([f.app,'--source',selected],{repo:f.repo,platform:'darwin',arch:'arm64',write(){},execute:()=>({error:failure})}),error=>error===failure);
});

test('help and invalid arguments never start a process',()=>{
  let output='',calls=0;const options={platform:'linux',write:message=>output+=message,execute:()=>{calls++;}};
  assert.equal(runInstalledCheck(['--help'],options),0);assert.match(output,/--source/);
  for(const argv of [['--source'],['--unexpected'],['one.app','two.app'],['--source','one','--source','two']])assert.throws(()=>runInstalledCheck(argv,options),/Usage:/);
  assert.equal(calls,0);
});
