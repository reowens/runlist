// Extract and qualify Linux installer resources without starting Runlist/WebKit.
import {mkdtempSync,readdirSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
if(process.platform!=='linux')throw new Error('Linux installer checks require a Linux host.');
const desktop=path.resolve(import.meta.dirname,'..');
const bundle=path.join(desktop,'src-tauri/target/release/bundle');
const nativeOnly=process.argv.includes('--native-only');
if(nativeOnly&&!process.env.RUNLIST_NATIVE_TEST_BIN)throw new Error('--native-only requires RUNLIST_NATIVE_TEST_BIN.');
const inputs=process.argv.slice(2).filter(arg=>arg!=='--native-only');
if(!inputs.length)for(const kind of ['deb','appimage'])for(const name of readdirSync(path.join(bundle,kind)))if(/\.(deb|AppImage)$/.test(name))inputs.push(path.join(bundle,kind,name));
assert.ok(inputs.some(p=>p.endsWith('.deb'))&&inputs.some(p=>p.endsWith('.AppImage')),'Provide both Debian and AppImage artifacts.');
const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function find(root,name){const found=[];for(const item of readdirSync(root,{withFileTypes:true})){const p=path.join(root,item.name);if(item.isDirectory())found.push(...find(p,name));else if(item.isFile()&&item.name===name)found.push(p);}return found;}
function inventory(root,prefix=''){const files={};for(const item of readdirSync(path.join(root,prefix),{withFileTypes:true})){const relative=path.join(prefix,item.name);if(item.isDirectory())Object.assign(files,inventory(root,relative));else{assert.ok(item.isFile(),'Engine resources may not be symlinks or special files.');files[relative]=digest(path.join(root,relative));}}return files;}
const records=[];
for(const input of inputs){
 const file=path.resolve(input),root=mkdtempSync(path.join(tmpdir(),'runlist-linux-installer-'));
 try{
  const metadata={};let extracted=root;
  if(file.endsWith('.deb')){
   for(const field of ['Package','Version','Architecture','Depends'])metadata[field]=execFileSync('dpkg-deb',['-f',file,field],{encoding:'utf8'}).trim();
   assert.equal(metadata.Architecture,process.arch==='arm64'?'arm64':'amd64');
   execFileSync('dpkg-deb',['-x',file,root]);
  }else{
   // This is AppImage runtime extraction only; it never invokes AppRun or Runlist.
   execFileSync(file,['--appimage-extract'],{cwd:root,maxBuffer:32*1024*1024});extracted=path.join(root,'squashfs-root');
  }
  const manifests=find(extracted,'bundle-manifest.json');assert.equal(manifests.length,1,'Installer must contain one engine.');
  const engine=path.dirname(manifests[0]),prepared=path.join(desktop,'src-tauri/resources');
  const manifest=JSON.parse(readFileSync(manifests[0],'utf8'));
  assert.equal(manifest.platform,'linux');assert.equal(manifest.architecture,process.arch);
  assert.deepEqual(manifest,JSON.parse(readFileSync(path.join(prepared,'bundle-manifest.json'),'utf8')));
  assert.equal(digest(path.join(engine,'runtime',manifest.executable)),digest(path.join(prepared,'runtime',manifest.executable)));
  const engineFiles=inventory(engine);assert.deepEqual(engineFiles,inventory(prepared),'Installer engine must exactly match the prepared payload.');
  const executables=find(extracted,'Runlist').filter(p=>readFileSync(p).subarray(0,4).equals(Buffer.from([0x7f,0x45,0x4c,0x46])));
  assert.equal(executables.length,1,'Installer must contain one native Runlist ELF.');
  const elf=readFileSync(executables[0]);assert.equal(elf[4],2);assert.equal(elf[5],1);assert.equal(elf.readUInt16LE(18),process.arch==='arm64'?183:62);
  const dependencies=execFileSync('ldd',[executables[0]],{encoding:'utf8'});assert.doesNotMatch(dependencies,/not found/);
  if(!nativeOnly){const result=spawnSync(process.execPath,[path.join(desktop,'scripts/check-bundle.mjs'),engine],{cwd:desktop,stdio:'inherit',env:process.env});
   if(result.error)throw result.error;assert.equal(result.status,0,'Extracted installer engine checks failed.');}
  const nativeTest=process.env.RUNLIST_NATIVE_TEST_BIN;
  if(nativeTest){const native=spawnSync(path.resolve(nativeTest),[],{stdio:'inherit',env:{...process.env,RUNLIST_TEST_ENGINE:engine}});if(native.error)throw native.error;assert.equal(native.status,0,'Native controller checks against extracted engine failed.');}
  records.push({engineTests:!nativeOnly,nativeTests:Boolean(nativeTest),engineFiles,file,bytes:statSync(file).size,sha256:digest(file),metadata,engineRelative:path.relative(extracted,engine),nativeSha256:digest(executables[0]),runtimeSha256:digest(path.join(engine,'runtime',manifest.executable)),dependencies});
 }finally{rmSync(root,{recursive:true,force:true});}
}
const report=JSON.stringify({platform:process.platform,architecture:process.arch,installers:records},null,2)+'\n';
if(process.env.RUNLIST_PACKAGE_REPORT)writeFileSync(path.resolve(process.env.RUNLIST_PACKAGE_REPORT),report);
console.log(JSON.stringify({platform:process.platform,architecture:process.arch,installers:records.map(({engineFiles,dependencies,...record})=>({...record,engineFileCount:Object.keys(engineFiles).length}))},null,2));
