// linuxdeploy patches every ELF in AppDir, including the pinned Node resource.
// Restore that resource and rerun only the official AppImage output plugin.
import {cpSync,existsSync,lstatSync,readdirSync,readFileSync,renameSync,rmSync,statSync,chmodSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {homedir} from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const desktop=path.resolve(import.meta.dirname,'..');
const digest=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
function manifests(root){const found=[];for(const entry of readdirSync(root,{withFileTypes:true})){const p=path.join(root,entry.name);if(entry.isDirectory())found.push(...manifests(p));else if(entry.isFile()&&entry.name==='bundle-manifest.json')found.push(p);}return found;}
export function finalizeLinuxAppImage({target,notBefore=0}={}){
 if(process.platform!=='linux')return;
 const targetRoot=process.env.CARGO_TARGET_DIR?path.resolve(desktop,'src-tauri',process.env.CARGO_TARGET_DIR):path.join(desktop,'src-tauri/target');
 const directory=path.join(targetRoot,...(target?[target]:[]),'release/bundle/appimage');
 if(!existsSync(directory))return;
 const artifacts=readdirSync(directory).filter(name=>name.endsWith('.AppImage')&&!name.startsWith('.')).map(name=>path.join(directory,name)).filter(file=>statSync(file).mtimeMs>=notBefore);
 if(!artifacts.length)return;assert.equal(artifacts.length,1,'Expected one newly built AppImage.');
 const prepared=path.join(desktop,'src-tauri/resources'),manifest=JSON.parse(readFileSync(path.join(prepared,'bundle-manifest.json'),'utf8'));
 assert.equal(manifest.platform,'linux');assert.equal(manifest.architecture,process.arch,'AppImage finalization needs a matching native host.');
 const appdirs=readdirSync(directory).filter(name=>name.endsWith('.AppDir')&&lstatSync(path.join(directory,name)).isDirectory());
 assert.equal(appdirs.length,1,'Expected one Tauri AppDir.');const appdir=path.join(directory,appdirs[0]);
 const found=manifests(appdir);assert.equal(found.length,1,'Expected one packaged engine.');
 assert.deepEqual(JSON.parse(readFileSync(found[0],'utf8')),manifest);
 const original=path.join(prepared,'runtime',manifest.executable),packaged=path.join(path.dirname(found[0]),'runtime',manifest.executable);
 assert.ok(lstatSync(original).isFile()&&lstatSync(packaged).isFile(),'Runtime files must be regular files.');
 const plugin=path.join(process.env.XDG_CACHE_HOME??path.join(homedir(),'.cache'),'tauri/linuxdeploy-plugin-appimage.AppImage');
 assert.ok(existsSync(plugin),'Tauri AppImage output plugin is missing from the build cache.');
 cpSync(original,packaged);chmodSync(packaged,0o755);
 const artifact=artifacts[0],temporary=path.join(directory,'.'+path.basename(artifact)+'.preserved.AppImage');rmSync(temporary,{force:true});
 try{
  const result=spawnSync(plugin,['--appimage-extract-and-run','--appdir',appdir],{cwd:directory,stdio:'inherit',env:{...process.env,LDAI_OUTPUT:temporary,LDAI_VERSION:manifest.version,ARCH:process.arch==='arm64'?'aarch64':'x86_64'}});
  if(result.error)throw result.error;assert.equal(result.status,0,'AppImage output plugin failed.');
  assert.ok(existsSync(temporary),'AppImage output plugin did not produce the requested file.');
  assert.equal(digest(original),digest(packaged),'Output plugin changed the pinned runtime.');
  renameSync(temporary,artifact);console.log('Preserved pinned runtime in '+artifact);
 }finally{rmSync(temporary,{force:true});}
}
