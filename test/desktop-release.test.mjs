import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {notarizeArtifact} from '../desktop/scripts/notarize.mjs';
import {desktopReleaseEnvironment,preflightDesktopRelease} from '../scripts/desktop-release-config.mjs';
import {releaseDesktop,validateDesktopManifest} from '../scripts/release-desktop.mjs';
import {prepareReleaseDocUpdates} from '../scripts/stamp-release-docs.mjs';
import {planUpdate} from '../src/update.mjs';

function fixture(t){const root=mkdtempSync(path.join(tmpdir(),'runlist-desktop-release-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}

test('an incomplete recovery checkout cannot report desktop release success',async t=>{
 await assert.rejects(releaseDesktop(fixture(t),'0.95.2','a'.repeat(40)),/missing its desktop sources/);
});

test('notarization saves the request before timeout and resumes without submitting again',t=>{
 const root=fixture(t),artifact=path.join(root,'app.zip'),receipt=path.join(root,'request.json');writeFileSync(artifact,'exact artifact');
 const id='11111111-1111-4111-8111-111111111111';let submits=0,waits=0;
 const exec=(_program,args)=>{
  if(args[1]==='submit'){submits++;return JSON.stringify({id,status:'In Progress'});}
  assert.equal(JSON.parse(readFileSync(receipt)).id,id);assert.equal(args[2],id);waits++;
  if(waits===1)throw new Error('wait timed out');return JSON.stringify({id,status:'Accepted'});
 };
 assert.throws(()=>notarizeArtifact(artifact,'fixture-profile',receipt,exec),/timed out/);
 assert.equal(notarizeArtifact(artifact,'fixture-profile',receipt,exec).status,'Accepted');
 assert.equal(submits,1);assert.equal(waits,2);
 notarizeArtifact(artifact,'fixture-profile',receipt,exec);assert.equal(waits,2);
 writeFileSync(artifact,'different artifact');
 assert.throws(()=>notarizeArtifact(artifact,'fixture-profile',receipt,exec),/artifact changed/);
 assert.equal(submits,1);
});

test('release preflight rejects missing signing inputs before starting a product release',t=>{
 const root=fixture(t);mkdirSync(path.join(root,'desktop'));writeFileSync(path.join(root,'desktop/package.json'),'{}');
 assert.throws(()=>preflightDesktopRelease(root,{platform:'linux',arch:'arm64',env:{}}),/Apple Silicon/);
 assert.throws(()=>preflightDesktopRelease(root,{platform:'darwin',arch:'arm64',env:{}}),/RUNLIST_SIGN_IDENTITY/);
 const env={RUNLIST_SIGN_IDENTITY:'fixture identity',RUNLIST_SIGN_TEAM:'7GSPYYN5X8',RUNLIST_NOTARY_PROFILE:'fixture profile'};
 assert.equal(preflightDesktopRelease(root,{platform:'darwin',arch:'arm64',env}).CARGO_BUILD_JOBS,'1');
 assert.throws(()=>preflightDesktopRelease(root,{platform:'darwin',arch:'arm64',env:{...env,RUNLIST_SIGN_TEAM:'other'}}),/trust policy/);
});

test('desktop child npm installs do not inherit npm version lifecycle policy or prefix',t=>{
 const root=fixture(t);
 const result=desktopReleaseEnvironment(root,{PATH:'/fixture/bin',npm_config_allow_scripts:'true',npm_config_prefix:'/fixture/other-prefix',npm_package_version:'0.95.2',npm_lifecycle_event:'postversion',RUNLIST_SIGN_IDENTITY:'fixture identity',RUNLIST_PUBLIC_CHECK_KEY:'fixture-key'});
 for(const key of ['npm_config_allow_scripts','npm_config_prefix','npm_package_version','npm_lifecycle_event'])assert.ok(!(key in result));
 assert.equal(result.RUNLIST_SIGN_IDENTITY,'fixture identity');assert.equal(result.RUNLIST_PUBLIC_CHECK_KEY,'fixture-key');
 assert.ok(result.PATH.endsWith('/fixture/bin'));
});

test('desktop publication refuses old source, old versions and unaccepted payloads',()=>{
 const source='a'.repeat(40),manifest={version:'0.95.2',sourceCommit:source,architecture:'arm64',protocol:1,team:'7GSPYYN5X8',notarized:true,sha256:'b'.repeat(64),artifact:'Runlist-0.95.2-macOS-arm64.dmg',submissions:[{status:'Accepted'},{status:'Accepted'}]};
 assert.doesNotThrow(()=>validateDesktopManifest(manifest,'0.95.2',source));
 for(const changed of [{version:'0.94.1'},{sourceCommit:'c'.repeat(40)},{notarized:false},{submissions:[{status:'Accepted'},{status:'In Progress'}]}])assert.throws(()=>validateDesktopManifest({...manifest,...changed},'0.95.2',source),/evidence/);
});

test('normal update includes an installed desktop while component-only updates preserve it',()=>{
 const ctx={desktop:'/fixture/Runlist.app',hasNpm:true};
 assert.deepEqual(planUpdate({},ctx).find(step=>step.kind==='desktop').cmd,['runlist','desktop','install']);
 assert.ok(!planUpdate({cliOnly:true},ctx).some(step=>step.kind==='desktop'));
 assert.ok(!planUpdate({pluginOnly:true},ctx).some(step=>step.kind==='desktop'));
 assert.ok(!planUpdate({},{hasNpm:true}).some(step=>step.kind==='desktop'));
});

test('release documentation stamps only marked current-version blocks',t=>{
 const root=fixture(t),file=path.join(root,'README.md');
 writeFileSync(file,'Historical 0.94.1\n<!-- runlist:release:start -->old<!-- runlist:release:end -->\n');
 const [{content}]=prepareReleaseDocUpdates(root,'0.95.2');assert.match(content,/Historical 0.94.1/);assert.match(content,/desktop-v0.95.2/);
 assert.match(readFileSync(file,'utf8'),/-->old<!--/);
 writeFileSync(file,'no current-version markers');assert.throws(()=>prepareReleaseDocUpdates(root,'0.95.2'),/markers/);
});
