import {test} from 'node:test';
import assert from 'node:assert/strict';
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runDesktopInstall,selectDesktopRelease} from '../src/desktop-install.mjs';
import {commandCompletionWords,validateCommandArgs,COMMAND_POLICIES} from '../src/commands.mjs';

const image=Buffer.from('a mock signed disk image');
const asset={name:'Runlist-0.91.0-rc.3-macOS-arm64.dmg',state:'uploaded',size:image.length,
 browser_download_url:'https://github.com/reowens/runlist/releases/download/desktop-v0.91.0-rc.3/Runlist-0.91.0-rc.3-macOS-arm64.dmg',
 digest:'sha256:'+createHash('sha256').update(image).digest('hex')};
const releases=[{draft:false,assets:[asset]}];

function fixture(t,{team='7GSPYYN5X8',running=false}={}) {
 const home=mkdtempSync(path.join(tmpdir(),'runlist-install-unit-'));
 t.after(()=>rmSync(home,{recursive:true,force:true}));
 const commands=[],messages=[],fetches=[];
 const exec=(program,args)=>{
  commands.push([program,...args]);
  if(program==='/bin/ps')return {stdout:running?'Runlist\n':''};
  if(program==='/usr/bin/codesign'&&args[0]==='-dvv')return {stdout:'',stderr:`Identifier=dev.reowens.runlist\nTeamIdentifier=${team}\n`};
  if(program==='/usr/bin/hdiutil'&&args[0]==='attach') {
   const folder=path.join(args[args.indexOf('-mountpoint')+1],'Runlist.app');
   mkdirSync(folder);writeFileSync(path.join(folder,'new-version'),'new');
  }
  if(program==='/usr/bin/ditto')cpSync(args[0],args[1],{recursive:true});
  return {stdout:'',stderr:''};
 };
 const fetcher=async url=>{
  fetches.push(url);
  return url.startsWith('https://api.github.com/')?Response.json(releases):new Response(image);
 };
 return {home,temporary:home,platform:'darwin',arch:'arm64',exec,fetcher,
  write:text=>messages.push(text),commands,messages,fetches};
}

test('desktop install has distinct grammar/help completion and installation policy',()=>{
 assert.deepEqual(validateCommandArgs('desktop',['install']),['install']);
 assert.deepEqual(validateCommandArgs('desktop',['install','--from','/tmp/Runlist.dmg']),['install','--from','/tmp/Runlist.dmg']);
 assert.deepEqual(validateCommandArgs('desktop',['--app','/tmp/Runlist.app']),['--app','/tmp/Runlist.app']);
 for(const args of [['install','--app','/tmp/a'],['--from','/tmp/a'],['install','extra'],['install','--from']])assert.throws(()=>validateCommandArgs('desktop',args));
 assert.ok(commandCompletionWords('desktop').includes('install'));
 assert.ok(commandCompletionWords('desktop').includes('--from'));
 assert.equal(COMMAND_POLICIES.desktop.mutation,'conditional');
});

test('official release selection excludes drafts and refuses foreign URLs/missing digests',()=>{
 assert.equal(selectDesktopRelease([{draft:true,assets:[asset]}]),null);
 assert.equal(selectDesktopRelease(releases).version,'0.91.0-rc.3');
 for(const browser_download_url of ['http://github.com/reowens/runlist/releases/download/tag/'+asset.name,'https://github.com.evil.test/reowens/runlist/releases/download/tag/'+asset.name,'https://github.com/another/repo/releases/download/tag/'+asset.name])assert.throws(()=>selectDesktopRelease([{assets:[{...asset,browser_download_url}]}]),/address/);
 assert.throws(()=>selectDesktopRelease([{assets:[{...asset,digest:null}]}]),/SHA-256/);
});

test('install dry-run is outside-checkout, network/file/process-free',async t=>{
 const f=fixture(t);const before=readFileSync(new URL('../bin/runlist.mjs',import.meta.url));
 const result=await runDesktopInstall(['install'],{...f,dryRun:true});
 assert.equal(result.dryRun,true);assert.equal(f.fetches.length,0);assert.equal(f.commands.length,0);
 assert.ok(!existsSync(path.join(f.home,'Applications')));
 const config=path.join(f.home,'evil.config.mjs'),sentinel=path.join(f.home,'imported');
 writeFileSync(config,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(sentinel)},'loaded');throw new Error('must not import');`);
 const bin=new URL('../bin/runlist.mjs',import.meta.url);
 const cli=spawnSync(process.execPath,[fileURLToPath(bin),'desktop','install','--dry-run','--config',config],{cwd:f.home,encoding:'utf8'});
 if(process.platform==='darwin'&&process.arch==='arm64') {
  assert.equal(cli.status,0,cli.stderr);assert.match(cli.stdout,/Would install/);
 } else {
  assert.notEqual(cli.status,0);assert.match(cli.stderr,/Mac Apple Silicon only/);
 }
 assert.ok(!existsSync(sentinel));
 const help=spawnSync(process.execPath,[fileURLToPath(bin),'desktop','--help','--config',config],{cwd:f.home,encoding:'utf8'});
 assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/desktop install/);assert.ok(!existsSync(sentinel));
 assert.deepEqual(readFileSync(bin),before);
});

test('an existing app stays untouched without network or processes',async t=>{
 const f=fixture(t);const app=path.join(f.home,'Applications/Runlist.app');mkdirSync(app,{recursive:true});writeFileSync(path.join(app,'keep'),'old');
 const result=await runDesktopInstall(['install'],f);
 assert.equal(result.alreadyInstalled,true);assert.equal(f.fetches.length,0);assert.equal(f.commands.length,0);
 assert.equal(readFileSync(path.join(app,'keep'),'utf8'),'old');
});

test('download verifies SHA before mounting and installs without opening the GUI',async t=>{
 const f=fixture(t);const result=await runDesktopInstall(['install'],f);
 assert.ok(existsSync(path.join(result.installed,'new-version')));assert.equal(f.fetches.length,2);
 assert.equal(result.backup,null);
 assert.ok(f.commands.some(([program,...args])=>program==='/usr/bin/hdiutil'&&args.includes('-readonly')&&args.includes('-nobrowse')&&args.includes('-noautoopen')));
 assert.ok(f.commands.some(([program,...args])=>program==='/usr/bin/xattr'&&args.includes('com.apple.quarantine')));
 assert.ok(!f.commands.some(([program])=>program==='/usr/bin/open'||program.endsWith('/Runlist')));
 assert.ok(!existsSync(path.join(f.home,'Applications/.runlist-desktop-install.lock')));
});

test('corrupt download and wrong signer cannot mount or install an app',async t=>{
 const f=fixture(t);f.fetcher=async url=>url.startsWith('https://api.github.com/')?Response.json(releases):new Response(Buffer.from('different bytes'));
 await assert.rejects(runDesktopInstall(['install'],f),/SHA-256|published size/);
 assert.equal(f.commands.length,0);assert.ok(!existsSync(path.join(f.home,'Applications/Runlist.app')));
 const bad=fixture(t,{team:'NOTRUNLIST'});
 await assert.rejects(runDesktopInstall(['install'],bad),/not signed by the Runlist developer/);
 assert.ok(!bad.commands.some(([program])=>program==='/usr/bin/hdiutil'));
});

test('local DMG replacement retains the old app and refuses a running app',async t=>{
 const f=fixture(t);const app=path.join(f.home,'Applications/Runlist.app');mkdirSync(app,{recursive:true});writeFileSync(path.join(app,'old-version'),'old');
 const dmg=path.join(f.home,'Runlist.dmg');writeFileSync(dmg,image);
 const result=await runDesktopInstall(['install','--from',dmg],f);
 assert.equal(f.fetches.length,0);assert.equal(readFileSync(path.join(result.backup,'old-version'),'utf8'),'old');
 assert.ok(existsSync(path.join(app,'new-version')));
 const busy=fixture(t,{running:true});const busyApp=path.join(busy.home,'Applications/Runlist.app');mkdirSync(busyApp,{recursive:true});
 await assert.rejects(runDesktopInstall(['install','--from',dmg],busy),/Quit Runlist/);
 assert.ok(!busy.commands.some(([program])=>program==='/usr/bin/codesign'));
});

test('unpublished and unsupported downloads refuse without launching or replacing files',async t=>{
 const f=fixture(t);f.fetcher=async()=>Response.json([]);
 await assert.rejects(runDesktopInstall(['install'],f),/No Mac GUI installer has been published/);
 assert.equal(f.commands.length,0);assert.ok(!existsSync(path.join(f.home,'Applications/Runlist.app')));
 await assert.rejects(runDesktopInstall(['install'],{...f,platform:'linux'}),/Mac Apple Silicon only/);
});
