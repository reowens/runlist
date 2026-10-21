// Freeze an already signed application and its matching tests. Never builds or launches it.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync,cpSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,readlinkSync,realpathSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repository=path.resolve(import.meta.dirname,'../..');
const identifier='dev.reowens.runlist';
const helperTests=['desktop/test/helper.test.mjs','desktop/test/headless-ui.test.mjs','desktop/test/accessibility.test.mjs'];
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const json=file=>JSON.parse(readFileSync(file,'utf8'));
const digest=files=>hash(JSON.stringify(files));
const safeName=name=>typeof name==='string'&&name.length>0&&!path.isAbsolute(name)&&name.split('/').every(part=>part&&part!=='.'&&part!=='..');

export function inventory(root) {
  const files=[];
  function visit(relative) {
    const file=path.join(root,relative),stat=lstatSync(file);
    if(stat.isSymbolicLink()) {
      const target=readlinkSync(file),resolved=path.resolve(path.dirname(file),target);
      if(!resolved.startsWith(path.resolve(root)+path.sep))throw Error('Symlink escapes inventory: '+relative);
      files.push({path:relative,type:'symlink',target});
    } else if(stat.isDirectory())for(const name of readdirSync(file).sort())visit(relative?relative+'/'+name:name);
    else if(stat.isFile())files.push({path:relative,type:'file',bytes:stat.size,executable:!!(stat.mode&0o111),sha256:hash(readFileSync(file))});
    else throw Error('Unsupported inventory entry: '+relative);
  }
  visit('');return files;
}

function signature(app) {
  const result=spawnSync('/usr/bin/codesign',['--verify','--deep','--strict',app],{encoding:'utf8'});
  if(result.error||result.status!==0)throw Error('Application signature verification failed: '+(result.error?.message??result.stderr));
  const identity=spawnSync('/usr/bin/codesign',['-d','-vv',app],{encoding:'utf8'});
  if(identity.status!==0||!/Authority=Developer ID Application:/.test(identity.stderr))throw Error('Select a Developer ID signed application.');
  const plist=spawnSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleIdentifier',path.join(app,'Contents/Info.plist')],{encoding:'utf8'});
  if(plist.status!==0||plist.stdout.trim()!==identifier)throw Error('Unexpected application bundle identifier.');
}

function copyRegular(from,to) {
  if(!lstatSync(from).isFile()||lstatSync(from).isSymbolicLink())throw Error('Expected regular source file: '+from);
  mkdirSync(path.dirname(to),{recursive:true});copyFileSync(from,to);
}

export async function prepareAirTests({app,source,sourceManifest,output,harness=path.join(repository,'desktop/native-tests')},{verifySignature=signature}={}) {
  for(const [name,value] of Object.entries({app,source,sourceManifest,output,harness}))if(!value)throw Error('Missing '+name+'.');
  app=realpathSync(app);source=realpathSync(source);harness=realpathSync(harness);output=path.resolve(output);
  output=path.join(realpathSync(path.dirname(output)),path.basename(output));
  if(existsSync(output))throw Error('Payload output must not already exist.');
  if([app,source,harness].some(root=>output===root||output.startsWith(root+path.sep)||root.startsWith(output+path.sep)))throw Error('Payload output must be separate from its inputs.');
  verifySignature(app);
  const provenanceBytes=readFileSync(sourceManifest),provenance=JSON.parse(provenanceBytes),pkg=json(path.join(source,'package.json')),engine=path.join(app,'Contents/Resources/engine');
  const enginePackage=json(path.join(engine,'package.json')),bundle=json(path.join(engine,'bundle-manifest.json'));
  if(pkg.name!=='runlist'||pkg.version!==enginePackage.version||provenance.candidateVersion!==pkg.version||bundle.version!==pkg.version||bundle.protocol!==1||bundle.platform!=='darwin'||bundle.architecture!=='arm64')throw Error('Application and frozen source identities differ.');
  const sourceFiles=provenance.files;
  if(!Array.isArray(sourceFiles)||!sourceFiles.length)throw Error('Source provenance has no files.');
  if(new Set(sourceFiles.map(file=>file.path)).size!==sourceFiles.length)throw Error('Source provenance repeats a file.');
  for(const file of sourceFiles) {
    if(!safeName(file.path)||!file.candidateSha256||hash(readFileSync(path.join(source,file.path)))!==file.candidateSha256)throw Error('Frozen source differs from provenance: '+file.path);
    if(lstatSync(path.join(source,file.path)).isSymbolicLink())throw Error('Frozen source contains a symlink.');
  }
  const {sourceFingerprint}=await import(pathToFileURL(path.join(source,'src/installation.mjs')));
  const fingerprint=sourceFingerprint(source),installed=sourceFingerprint(engine);
  if(fingerprint.state!=='readable'||fingerprint.sha256!==installed.sha256)throw Error('Application engine and source fingerprint differ.');
  for(const name of [...helperTests,'desktop/test/helper-environment.mjs','test/native-fixtures.mjs'])if(!sourceFiles.some(file=>file.path===name))throw Error('Missing matching test source: '+name);
  const dependencies=path.join(source,'desktop/node_modules');
  for(const name of ['linkedom','acorn'])if(!existsSync(path.join(dependencies,name,'package.json')))throw Error('Missing frozen test dependency: '+name);
  const appBefore=inventory(app),harnessBefore=inventory(harness),driverBytes=readFileSync(fileURLToPath(import.meta.url));
  const dependencyInventories=readdirSync(dependencies).sort().filter(name=>!name.startsWith('.')&&name!=='@tauri-apps').map(name=>({name,files:inventory(path.join(dependencies,name))}));
  mkdirSync(output,{recursive:false});
  for(const file of sourceFiles)copyRegular(path.join(source,file.path),path.join(output,'source',file.path));
  for(const {name,files} of dependencyInventories) {
    cpSync(path.join(dependencies,name),path.join(output,'source/desktop/node_modules',name),{recursive:true,preserveTimestamps:true,verbatimSymlinks:true});
    if(digest(files)!==digest(inventory(path.join(dependencies,name)))||digest(files)!==digest(inventory(path.join(output,'source/desktop/node_modules',name))))throw Error('Test dependency changed while freezing: '+name);
  }
  cpSync(app,path.join(output,'application/Runlist.app'),{recursive:true,preserveTimestamps:true,verbatimSymlinks:true});
  for(const file of harnessBefore) {
    if(file.type!=='file')throw Error('Harness must contain regular files only.');
    copyRegular(path.join(harness,file.path),path.join(output,'harness',file.path));
  }
  copyRegular(fileURLToPath(import.meta.url),path.join(output,'harness/prepare-air-tests.mjs'));
  if(hash(driverBytes)!==hash(readFileSync(path.join(output,'harness/prepare-air-tests.mjs'))))throw Error('Payload driver changed while freezing.');
  const copiedSource=inventory(path.join(output,'source')),copiedHarness=inventory(path.join(output,'harness'));
  if(digest(appBefore)!==digest(inventory(app))||digest(appBefore)!==digest(inventory(path.join(output,'application/Runlist.app'))))throw Error('Application changed while freezing.');
  for(const file of sourceFiles)if(hash(readFileSync(path.join(source,file.path)))!==file.candidateSha256)throw Error('Source changed while freezing: '+file.path);
  if(digest(harnessBefore)!==digest(inventory(harness)))throw Error('Harness changed while freezing.');
  if(hash(provenanceBytes)!==hash(readFileSync(sourceManifest)))throw Error('Source provenance changed while freezing.');
  const manifest={schemaVersion:1,project:'runlist',bundleIdentifier:identifier,version:pkg.version,engineFingerprint:fingerprint.sha256,
    provenance:{sourceManifestSha256:hash(provenanceBytes),inventorySha256:provenance.inventorySha256??null,baseHead:provenance.baseHead??null},
    app:{path:'application/Runlist.app',sha256:digest(appBefore),files:appBefore},source:{path:'source',sha256:digest(copiedSource),files:copiedSource},
    harness:{path:'harness',sha256:digest(copiedHarness),files:copiedHarness},profiles:['installed-helper','native-window']};
  const bytes=JSON.stringify(manifest,null,2)+'\n';writeFileSync(path.join(output,'manifest.json'),bytes,{flag:'wx'});
  return {output,manifestSha256:hash(bytes),appSha256:manifest.app.sha256,harnessSha256:manifest.harness.sha256,version:pkg.version};
}

export function verifyAirPayload(root,installedApp) {
  root=realpathSync(root);const manifest=json(path.join(root,'manifest.json'));
  if(manifest.schemaVersion!==1||manifest.project!=='runlist'||manifest.bundleIdentifier!==identifier)throw Error('Unsupported Air payload manifest.');
  for(const key of ['app','source','harness']) {
    const entry=manifest[key],expected={app:'application/Runlist.app',source:'source',harness:'harness'}[key];
    if(entry?.path!==expected||!Array.isArray(entry.files)||entry.sha256!==digest(entry.files)||entry.sha256!==digest(inventory(path.join(root,expected))))throw Error('Payload integrity failed: '+key);
  }
  if(installedApp&&manifest.app.sha256!==digest(inventory(installedApp)))throw Error('Installed application differs from the frozen signed candidate.');
  return manifest;
}

export function runAirHelper(root,app,{execute=spawnSync}={}) {
  if(!app)throw Error('Supply the installed application path.');
  verifyAirPayload(root,app);
  const runtime=path.join(app,'Contents/Resources/engine/runtime/RunlistHelper'),helper=path.join(app,'Contents/Resources/engine/desktop/helper.mjs'),assets=path.join(app,'Contents/Resources/engine/assets/app');
  const result=execute('/usr/bin/sandbox-exec',['-p','(version 1)(allow default)(deny network*)',runtime,'--experimental-vm-modules','--test',...helperTests],{
    cwd:path.join(root,'source'),stdio:'inherit',env:{...process.env,NODE_OPTIONS:'',RUNLIST_TEST_RUNTIME:runtime,RUNLIST_TEST_HELPER:helper,RUNLIST_TEST_ASSETS:assets}});
  if(result.error)throw result.error;return result.status??1;
}

if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [verb,...args]=process.argv.slice(2);
    if(verb==='--verify'&&args.length===2){const manifest=verifyAirPayload(...args);console.log(JSON.stringify({version:manifest.version,appSha256:manifest.app.sha256,harnessSha256:manifest.harness.sha256,engineFingerprint:manifest.engineFingerprint}));}
    else if(verb==='--run-helper'&&args.length===2)process.exitCode=runAirHelper(...args);
    else if(verb==='--prepare'&&args.length===4)console.log(JSON.stringify(await prepareAirTests({app:args[0],source:args[1],sourceManifest:args[2],output:args[3]}),null,2));
    else throw Error('Usage: prepare-air-tests.mjs --prepare APP SOURCE SOURCE_MANIFEST NEW_OUTPUT | --verify PAYLOAD INSTALLED_APP | --run-helper PAYLOAD INSTALLED_APP');
  } catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
