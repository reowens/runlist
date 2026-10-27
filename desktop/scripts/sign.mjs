import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {notarizeArtifact,saveReceipt} from './notarize.mjs';
import {notaryCredentials} from '../../scripts/desktop-release-config.mjs';
const root=path.resolve(import.meta.dirname,'..');
const version=JSON.parse(readFileSync(path.resolve(root,'../package.json'))).version;
const identity=process.env.RUNLIST_SIGN_IDENTITY,team=process.env.RUNLIST_SIGN_TEAM;
if(!identity||!team)throw new Error('Set RUNLIST_SIGN_IDENTITY and RUNLIST_SIGN_TEAM before signing.');
const notary=process.env.RUNLIST_NOTARY_PROFILE||process.env.RUNLIST_NOTARY_KEY?notaryCredentials(process.env):null,notaryKeyId=notary?.keyId??null;
const app=process.env.RUNLIST_SIGN_APP?path.resolve(process.env.RUNLIST_SIGN_APP):path.join(root,'src-tauri/target/release/bundle/macos/Runlist.app');
const releases=process.env.RUNLIST_RELEASE_DIR?path.resolve(process.env.RUNLIST_RELEASE_DIR):path.join(root,'releases');
mkdirSync(releases,{recursive:true});
const sourceCommit=process.env.RUNLIST_RELEASE_SOURCE_SHA??null;
const stateFile=path.join(releases,'signing-state.json');
const state=existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):{version,app,identity,team,notaryKeyId,sourceCommit};
for(const [key,value] of Object.entries({version,app,identity,team,notaryKeyId,sourceCommit}))if(state[key]!==value)throw new Error('Signing inputs changed; preserve existing submissions and use a new release directory.');
const save=()=>saveReceipt(stateFile,state);
const run=(exe,args)=>execFileSync(exe,args,{stdio:'inherit'});
const submissions=[];
const notarize=(artifact,name)=>{
 const receipt=notarizeArtifact(artifact,notary,path.join(releases,`${name}-notary.json`));
 submissions.push({artifact:path.basename(artifact),id:receipt.id,status:receipt.status});
 console.log(`Apple accepted ${path.basename(artifact)}: ${receipt.id}`);
};
if(!state.appSigned){
 run('/usr/bin/codesign',['--force','--options','runtime','--timestamp','--sign',identity,'--identifier','dev.reowens.runlist.helper','--entitlements',path.join(root,'src-tauri/helper-entitlements.plist'),app+'/Contents/Resources/engine/runtime/RunlistHelper']);
 run('/usr/bin/codesign',['--force','--options','runtime','--timestamp','--sign',identity,'--entitlements',path.join(root,'src-tauri/entitlements.plist'),app]);
 state.appSigned=true;save();
}
run('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',app]);
const signature=spawnSync('/usr/bin/codesign',['-dvv',app],{encoding:'utf8'});
if(signature.status!==0||!signature.stderr.includes(`TeamIdentifier=${team}\n`))throw new Error('The signed app must belong to the selected release team.');
if(notary){
 const zip=path.join(releases,`Runlist-${version}-macOS-${process.arch}.zip`);
 if(!existsSync(zip))run('/usr/bin/ditto',['-c','-k','--keepParent','--sequesterRsrc',app,zip]);
 notarize(zip,'app');
 if(!state.appStapled){run('/usr/bin/xcrun',['stapler','staple',app]);state.appStapled=true;save();}
 run('/usr/bin/xcrun',['stapler','validate',app]);
 run('/usr/sbin/spctl',['--assess','--type','execute','--verbose=2',app]);
}
const dmg=path.join(releases,`Runlist-${version}-macOS-${process.arch}.dmg`);
if(!state.dmgCreated){
 const staging=mkdtempSync(path.join(releases,'dmg-'));
 try {
  run('/usr/bin/ditto',[app,path.join(staging,'Runlist.app')]);symlinkSync('/Applications',path.join(staging,'Applications'));
  run('/usr/bin/hdiutil',['create','-volname',`Runlist ${version}`,'-srcfolder',staging,'-ov','-format','UDZO',dmg]);
 } finally {rmSync(staging,{recursive:true,force:true});}
 state.dmgCreated=true;save();
}
if(!state.dmgSigned){run('/usr/bin/codesign',['--force','--timestamp','--sign',identity,dmg]);state.dmgSigned=true;save();}
if(notary){
 if(!state.dmgStapled){notarize(dmg,'dmg');run('/usr/bin/xcrun',['stapler','staple',dmg]);state.dmgStapled=true;save();}
 else {const receipt=JSON.parse(readFileSync(path.join(releases,'dmg-notary.json'),'utf8'));submissions.push({artifact:path.basename(dmg),id:receipt.id,status:receipt.status});}
 run('/usr/bin/xcrun',['stapler','validate',dmg]);
 run('/usr/sbin/spctl',['--assess','--type','open','--context','context:primary-signature','--verbose=2',dmg]);
}
const evidence={version,architecture:process.arch,protocol:1,identity,team,notarized:!!notary,submissions,sha256:createHash('sha256').update(readFileSync(dmg)).digest('hex'),artifact:path.basename(dmg),sourceCommit,builtAt:new Date().toISOString()};
writeFileSync(path.join(releases,'release-manifest.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence,null,2));
