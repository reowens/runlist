import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {selectRuntime,runtimeExtractor} from '../scripts/runtime-target.mjs';
import {isDesktopAssetLink} from '../../assets/app/transport.mjs';
import {desktopLaunch} from '../../src/desktop.mjs';
import {isBundledRunlistRuntime} from '../../src/desktop-runtime.mjs';
import path from 'node:path';
const lock=JSON.parse(readFileSync(new URL('../runtime-lock.json',import.meta.url)));
test('runtime extraction uses the host Windows tar rather than Git Bash PATH',()=>{
 assert.equal(runtimeExtractor({platform:'win32',env:{SystemRoot:'D:\\Windows',PATH:'C:\\Program Files\\Git\\usr\\bin'}}),'D:\\Windows\\System32\\tar.exe');
 assert.equal(runtimeExtractor({platform:'win32',env:{WINDIR:'C:\\Windows'}}),'C:\\Windows\\System32\\tar.exe');
 for(const env of [{},{SystemRoot:'Windows'}])assert.throws(()=>runtimeExtractor({platform:'win32',env}),/absolute SystemRoot/);
 for(const platform of ['darwin','linux'])assert.equal(runtimeExtractor({platform,env:{SystemRoot:'D:\\Windows'}}),'tar');
});
test('bundled worker identification handles Windows extensions/separators and rejects ordinary Node',()=>{
 assert.equal(isBundledRunlistRuntime('C:\\Program Files\\Runlist\\runtime\\RunlistHelper.exe',path.win32),true);
 assert.equal(isBundledRunlistRuntime('/opt/runlist/runtime/RunlistHelper',path.posix),true);
 for(const file of ['C:\\nodejs\\node.exe','C:\\runtime\\OtherRunlistHelper.exe'])assert.equal(isBundledRunlistRuntime(file,path.win32),false);
 assert.equal(isBundledRunlistRuntime('/usr/bin/node',path.posix),false);
});

test('runtime pins match each OS/architecture and reject unsupported targets',()=>{
 for(const platform of ['darwin','win32','linux'])for(const arch of ['x64','arm64']) {
  const pin=selectRuntime(lock,{platform,arch,target:null});
  assert.match(pin.file,new RegExp(`-${platform==='win32'?'win':platform}-${arch}\\.`));
  assert.equal(pin.executable,platform==='win32'?'RunlistHelper.exe':'RunlistHelper');
  assert.equal(pin.nodePath,platform==='win32'?'node.exe':'bin/node');
 }
 const win=selectRuntime(lock,{platform:'darwin',arch:'arm64',target:'x86_64-pc-windows-msvc'});
 assert.equal(win.platform,'win32');assert.equal(win.arch,'x64');
 assert.throws(()=>selectRuntime(lock,{platform:'linux',arch:'ia32',target:null}),/No verified/);
 assert.throws(()=>selectRuntime(lock,{target:'x86_64-unknown-linux-musl'}),/Unsupported/);
});
test('desktop links stay internal only for the current exact asset origin',()=>{
 for(const origin of ['tauri://localhost','http://tauri.localhost']) {
  const current=new URL(origin+'/index.html');
  assert.equal(isDesktopAssetLink(new URL('#heading',current),current),true);
  assert.equal(isDesktopAssetLink(new URL('/index.html?doc=one',current),current),true);
  for(const remote of ['https://example.com','http://tauri.localhost.evil','http://tauri.localhost:1234','tauri://user@localhost','https://tauri.localhost','http://ipc.localhost'])assert.equal(isDesktopAssetLink(new URL(remote),current),false);
 }
 assert.equal(isDesktopAssetLink(new URL('http://tauri.localhost/'),new URL('https://example.com/')),false);
});
test('CLI launch discovers native installations without shell arguments or checkout access',()=>{
 const windows=desktopLaunch([],{platform:'win32',home:'C:\\Users\\Test',env:{LOCALAPPDATA:'C:\\Users\\Test\\AppData\\Local'},exists:()=>true});
 assert.equal(windows.program,'C:\\Users\\Test\\AppData\\Local\\Runlist\\Runlist.exe');assert.deepEqual(windows.args,[]);
 const linux=desktopLaunch(['--app','/opt/Runlist release.AppImage'],{platform:'linux',exists:()=>false});assert.equal(linux.program,'/opt/Runlist release.AppImage');assert.deepEqual(linux.args,[]);
 const mac=desktopLaunch([],{platform:'darwin',home:'/Users/test',exists:file=>file.startsWith('/Users/')});assert.equal(mac.program,'/usr/bin/open');assert.deepEqual(mac.args,['-a','/Users/test/Applications/Runlist.app']);
 assert.throws(()=>desktopLaunch(['--app','--dry-run']),/requires/);
});
