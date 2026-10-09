import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const version=JSON.parse(readFileSync(path.resolve(root,'../package.json'))).version;
const identity=process.env.RUNLIST_SIGN_IDENTITY;
const team=process.env.RUNLIST_SIGN_TEAM;
if(!identity||!team)throw new Error('Set RUNLIST_SIGN_IDENTITY and RUNLIST_SIGN_TEAM before signing.');
const profile=process.env.RUNLIST_NOTARY_PROFILE;
const app=process.env.RUNLIST_SIGN_APP?path.resolve(process.env.RUNLIST_SIGN_APP):path.join(root,'src-tauri/target/release/bundle/macos/Runlist.app');
const run=(exe,args)=>execFileSync(exe,args,{stdio:'inherit'});
const submissions=[];
const notarize=artifact=>{
 const result=JSON.parse(execFileSync('/usr/bin/xcrun',['notarytool','submit',artifact,'--keychain-profile',profile,'--wait','--output-format','json','--no-progress'],{encoding:'utf8',stdio:['ignore','pipe','inherit']}));
 if(result.status!=='Accepted')throw new Error(`Notarization ${result.id??''} was ${result.status??'not accepted'}. Inspect its notarytool log before continuing.`);
 submissions.push({artifact:path.basename(artifact),id:result.id,status:result.status});console.log(`Apple accepted ${path.basename(artifact)}: ${result.id}`);
};
run('/usr/bin/codesign',['--force','--options','runtime','--timestamp','--sign',identity,'--identifier','dev.reowens.runlist.helper','--entitlements',path.join(root,'src-tauri/helper-entitlements.plist'),app+'/Contents/Resources/engine/runtime/RunlistHelper']);
run('/usr/bin/codesign',['--force','--options','runtime','--timestamp','--sign',identity,'--entitlements',path.join(root,'src-tauri/entitlements.plist'),app]);
run('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',app]);
const signature=spawnSync('/usr/bin/codesign',['-dvv',app],{encoding:'utf8'});
if(signature.status!==0||!signature.stderr.includes(`TeamIdentifier=${team}\n`))throw new Error(`The signed app must belong to release team ${team}.`);
const releases=process.env.RUNLIST_RELEASE_DIR?path.resolve(process.env.RUNLIST_RELEASE_DIR):path.join(root,'releases');mkdirSync(releases,{recursive:true});
if(profile){
 const zip=path.join(releases,`Runlist-${version}-macOS-${process.arch}.zip`);
 run('/usr/bin/ditto',['-c','-k','--keepParent','--sequesterRsrc',app,zip]);
 notarize(zip);
 run('/usr/bin/xcrun',['stapler','staple',app]);
 run('/usr/bin/xcrun',['stapler','validate',app]);
 run('/usr/sbin/spctl',['--assess','--type','execute','--verbose=2',app]);
}
const staging=mkdtempSync(path.join(releases,'dmg-'));
run('/usr/bin/ditto',[app,path.join(staging,'Runlist.app')]);symlinkSync('/Applications',path.join(staging,'Applications'));
const dmg=path.join(releases,`Runlist-${version}-macOS-${process.arch}.dmg`);
run('/usr/bin/hdiutil',['create','-volname',`Runlist ${version}`,'-srcfolder',staging,'-ov','-format','UDZO',dmg]);
rmSync(staging,{recursive:true,force:true});
run('/usr/bin/codesign',['--force','--timestamp','--sign',identity,dmg]);
if(profile){notarize(dmg);run('/usr/bin/xcrun',['stapler','staple',dmg]);run('/usr/bin/xcrun',['stapler','validate',dmg]);run('/usr/sbin/spctl',['--assess','--type','open','--context','context:primary-signature','--verbose=2',dmg]);}
const evidence={version,architecture:process.arch,protocol:1,identity,team,notarized:!!profile,submissions,sha256:createHash('sha256').update(readFileSync(dmg)).digest('hex'),artifact:path.basename(dmg),builtAt:new Date().toISOString()};writeFileSync(path.join(releases,'release-manifest.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
