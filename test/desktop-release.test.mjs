import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {notarizeArtifact} from '../desktop/scripts/notarize.mjs';
import {desktopReleaseEnvironment,preflightDesktopRelease,notaryCredentials,NOTARY_ISSUER_SHA256} from '../scripts/desktop-release-config.mjs';
import {releaseDesktop,validateDesktopManifest} from '../scripts/release-desktop.mjs';
import {prepareReleaseDocUpdates} from '../scripts/stamp-release-docs.mjs';
import {planUpdate} from '../src/update.mjs';

function fixture(t){const root=mkdtempSync(path.join(tmpdir(),'runlist-desktop-release-'));t.after(()=>rmSync(root,{recursive:true,force:true}));return root;}

test('an incomplete recovery checkout cannot report desktop release success',async t=>{
 await assert.rejects(releaseDesktop(fixture(t),'0.95.2','a'.repeat(40)),/missing its desktop sources/);
});

test('desktop publication completes without installing or launching a local app',async t=>{
 const root=fixture(t),version='0.99.2',source='a'.repeat(40),bytes=Buffer.from('signed installer fixture');
 const directory=path.join(root,'.runlist/desktop-release',version),artifact=`Runlist-${version}-macOS-arm64.dmg`;
 const sha256=createHash('sha256').update(bytes).digest('hex');
 mkdirSync(directory,{recursive:true});writeFileSync(path.join(root,'package.json'),JSON.stringify({version}));
 writeFileSync(path.join(directory,artifact),bytes);
 writeFileSync(path.join(directory,'release-manifest.json'),JSON.stringify({version,sourceCommit:source,architecture:'arm64',protocol:1,team:'7GSPYYN5X8',notarized:true,sha256,artifact,submissions:[{status:'Accepted'},{status:'Accepted'}]}));
 const commands=[],messages=[];let published=false,bundleChecks=0;
 t.mock.method(console,'log',message=>messages.push(message));
 const exec=(program,args)=>{
  commands.push([program,...args]);
  if(program==='git'){
   if(args.join(' ')==='rev-parse HEAD')return source;
   if(args[0]==='status')return '';
   throw new Error('Unexpected Git operation');
  }
  if(program==='gh'){
   if(args[0]==='api')return JSON.stringify(args[1].includes('/workflows/')?{workflow_runs:[{head_sha:source,event:'push',conclusion:'success'}]}:[]);
   if(args[1]==='view'){
    if(!published)throw new Error('Release is absent');
    return JSON.stringify({isDraft:false,targetCommitish:source,assets:[{name:artifact,state:'uploaded',size:bytes.length,digest:`sha256:${sha256}`,url:`https://github.com/reowens/runlist/releases/download/desktop-v${version}/${artifact}`}]});
   }
   if(args[1]==='edit')published=true;
  }
  if(args.some(arg=>arg.includes('check-installed.mjs')))throw new Error('Release must not execute installed-app diagnostics');
  return '';
 };
 const options={environment:{},exec,preflight:()=>({}),checkBundle:()=>{bundleChecks++;return {files:1};}};
 await releaseDesktop(root,version,source,options);
 const state=JSON.parse(readFileSync(path.join(directory,'state.json')));
 assert.equal(state.published,true);assert.ok(!Object.hasOwn(state,'installed'));
 assert.equal(bundleChecks,2);assert.ok(commands.some(command=>command.includes('desktop/scripts/sign.mjs')));
 assert.ok(commands.some(command=>command.includes('desktop/scripts/inspect-bundle.mjs')));
 assert.equal(messages.at(-1),`Desktop ${version} published.`);
 commands.length=0;
 await releaseDesktop(root,version,source,options);
 assert.ok(commands.every(command=>['git','gh'].includes(command[0])));
});

test('notarization saves the request before timeout and resumes without submitting again',t=>{
 const root=fixture(t),artifact=path.join(root,'app.zip'),receipt=path.join(root,'request.json');writeFileSync(artifact,'exact artifact');
 const id='11111111-1111-4111-8111-111111111111';let submits=0,waits=0;
 const credentials={key:'/keys/AuthKey_ABCDE12345.p8',keyId:'ABCDE12345',issuer:'fixture-issuer'};
 const exec=(_program,args)=>{
  assert.deepEqual(args.slice(args.indexOf('--key'),args.indexOf('--key')+6),['--key',credentials.key,'--key-id','ABCDE12345','--issuer','fixture-issuer']);
  assert.ok(!args.includes('--keychain-profile'));
  if(args[1]==='submit'){submits++;return JSON.stringify({id,status:'In Progress'});}
  assert.equal(JSON.parse(readFileSync(receipt)).id,id);assert.equal(args[2],id);waits++;
  if(waits===1)throw new Error('wait timed out');return JSON.stringify({id,status:'Accepted'});
 };
 assert.throws(()=>notarizeArtifact(artifact,credentials,receipt,exec),/timed out/);
 assert.equal(notarizeArtifact(artifact,credentials,receipt,exec).status,'Accepted');
 assert.equal(submits,1);assert.equal(waits,2);
 notarizeArtifact(artifact,credentials,receipt,exec);assert.equal(waits,2);
 writeFileSync(artifact,'different artifact');
 assert.throws(()=>notarizeArtifact(artifact,credentials,receipt,exec),/artifact changed/);
 assert.equal(submits,1);
});

test('release preflight rejects missing signing inputs before starting a product release',t=>{
 const root=fixture(t);mkdirSync(path.join(root,'desktop'));writeFileSync(path.join(root,'desktop/package.json'),'{}');
 assert.throws(()=>preflightDesktopRelease(root,{platform:'linux',arch:'arm64',env:{}}),/Apple Silicon/);
 assert.throws(()=>preflightDesktopRelease(root,{platform:'darwin',arch:'arm64',env:{}}),/RUNLIST_SIGN_IDENTITY/);
 const key=path.join(root,'AuthKey_ABCDE12345.p8');writeFileSync(key,'fixture key');
 const issuerSha256=createHash('sha256').update('personal-issuer').digest('hex'),mac={platform:'darwin',arch:'arm64',issuerSha256};
 const env={RUNLIST_SIGN_IDENTITY:'fixture identity',RUNLIST_SIGN_TEAM:'7GSPYYN5X8',RUNLIST_NOTARY_KEY:key,RUNLIST_NOTARY_KEY_ID:'ABCDE12345',RUNLIST_NOTARY_ISSUER:'personal-issuer'};
 assert.equal(preflightDesktopRelease(root,{...mac,env}).CARGO_BUILD_JOBS,'1');
 assert.throws(()=>preflightDesktopRelease(root,{...mac,env:{...env,RUNLIST_SIGN_TEAM:'other'}}),/trust policy/);
});

test('notarization runs only on the signing team\'s App Store Connect key',t=>{
 const root=fixture(t),key=path.join(root,'AuthKey_ABCDE12345.p8');writeFileSync(key,'fixture key');
 const issuerSha256=createHash('sha256').update('personal-issuer').digest('hex');
 const env={RUNLIST_NOTARY_KEY:key,RUNLIST_NOTARY_KEY_ID:'ABCDE12345',RUNLIST_NOTARY_ISSUER:'personal-issuer'};
 assert.deepEqual(notaryCredentials(env,{issuerSha256}),{key,keyId:'ABCDE12345',issuer:'personal-issuer'});
 assert.throws(()=>notaryCredentials({...env,RUNLIST_NOTARY_ISSUER:'other-team-issuer'},{issuerSha256}),/team other than 7GSPYYN5X8/);
 assert.throws(()=>notaryCredentials({...env,RUNLIST_NOTARY_PROFILE:'any-profile'},{issuerSha256}),/refuses a Keychain profile/);
 assert.throws(()=>notaryCredentials({...env,RUNLIST_NOTARY_KEY_ID:'ZZZZZ99999'},{issuerSha256}),/AuthKey_<RUNLIST_NOTARY_KEY_ID>/);
 assert.throws(()=>notaryCredentials({...env,RUNLIST_NOTARY_KEY:path.join(root,'missing','AuthKey_ABCDE12345.p8')},{issuerSha256}),/missing/);
 assert.throws(()=>notaryCredentials({RUNLIST_NOTARY_KEY_ID:'ABCDE12345'},{issuerSha256}),/RUNLIST_NOTARY_KEY/);
 assert.match(NOTARY_ISSUER_SHA256,/^[0-9a-f]{64}$/);
 assert.throws(()=>notaryCredentials(env),/team other than 7GSPYYN5X8/);
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
