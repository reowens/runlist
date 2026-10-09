// Inspect the bundle without executing its app entry point or creating a window.
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

const app=path.resolve(process.argv[2]??path.join(homedir(),'Applications/Runlist.app'));
const run=(command,args)=>execFileSync(command,args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
const info=JSON.parse(run('/usr/bin/plutil',['-convert','json','-o','-',path.join(app,'Contents/Info.plist')]));
const engine=path.join(app,'Contents/Resources/engine');
const manifest=JSON.parse(readFileSync(path.join(engine,'bundle-manifest.json')));
const packageVersion=JSON.parse(readFileSync(path.join(engine,'package.json'))).version;
if(info.CFBundleIdentifier!=='dev.reowens.runlist'||info.CFBundleShortVersionString!==packageVersion||manifest.version!==packageVersion||manifest.protocol!==1)throw new Error('Bundle identity/version/protocol mismatch.');
const numeric=version=>version.split('.').reduce((total,part,i)=>total+Number(part)*1000**(2-i),0);
const binaries=[];
for(const relative of ['Contents/MacOS/Runlist','Contents/Resources/engine/runtime/RunlistHelper']) {
  const file=path.join(app,relative);
  const arch=run('/usr/bin/lipo',['-archs',file]).trim();
  const minimum=run('/usr/bin/xcrun',['vtool','-show-build',file]).match(/\bminos\s+([\d.]+)/)?.[1];
  if(!minimum||numeric(minimum)>numeric(info.LSMinimumSystemVersion))throw new Error('Executable requires a newer OS than declared: '+relative);
  if(arch!==manifest.architecture)throw new Error('Architecture mismatch: '+relative);
  const dependencies=run('/usr/bin/otool',['-L',file]).split('\n').slice(1).map(line=>line.trim().split(' (')[0]).filter(Boolean);
  if(dependencies.some(file=>!file.startsWith('/System/Library/')&&!file.startsWith('/usr/lib/')))throw new Error('Non-system runtime dependency: '+relative);
  binaries.push({path:relative,architecture:arch,minimumMacOS:minimum,systemDependencies:dependencies.length});
}
const runtime=run(path.join(engine,'runtime/RunlistHelper'),['--version']).trim();
if(runtime!==manifest.runtime)throw new Error('Bundled runtime version mismatch.');
run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
console.log(JSON.stringify({app,version:packageVersion,identifier:info.CFBundleIdentifier,protocol:manifest.protocol,
  declaredMinimumMacOS:info.LSMinimumSystemVersion,runtime,binaries,signatureVerified:true,
  verificationHost:run('/usr/bin/sw_vers',['-productVersion']).trim(),
  limits:['Static deployment and dependencies verified; older/fresh hosts were not exercised.','Intel requires its own signed build and host evidence.','No app or WebView was launched.']},null,2));
