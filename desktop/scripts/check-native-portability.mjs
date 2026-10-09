// Compile production files/locks and helper launching for Windows and Linux. This
// neither links a desktop executable nor claims Tauri/WebView host coverage.
import {mkdtempSync,writeFileSync,rmSync,mkdirSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';

const desktop=path.resolve(import.meta.dirname,'..');
const toolchain=process.env.RUNLIST_PORTABILITY_TOOLCHAIN??'stable';
function tool(name){
  const result=spawnSync('rustup',['which','--toolchain',toolchain,name],{encoding:'utf8'});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(result.stderr||`Cannot find ${name} for ${toolchain}.`);
  return result.stdout.trim();
}
const cargo=tool('cargo'),rustc=tool('rustc');
const targets=process.argv.slice(2);
if(!targets.length)targets.push('x86_64-pc-windows-gnu','x86_64-unknown-linux-gnu');
const directory=mkdtempSync(path.join(tmpdir(),'runlist-portability-'));
const cache=path.join(desktop,'.cache/native-portability-target');mkdirSync(cache,{recursive:true});
const lock=readFileSync(path.join(desktop,'src-tauri/Cargo.lock'),'utf8');
const libc=lock.match(/\[\[package\]\]\nname = "libc"\nversion = "([^"]+)"/)[1];
const manifest=`[package]
name = "runlist-native-portability-check"
version = "0.0.0"
edition = "2021"
rust-version = "1.89"
[lib]
path = "lib.rs"
[dependencies]
url = "=2.5.8"
[target.'cfg(unix)'.dependencies]
libc = "=${libc}"
[target.'cfg(windows)'.dependencies]
windows-sys = { version = "=0.61.2", features = ["Win32_Storage_FileSystem"] }
`;
try{
  writeFileSync(path.join(directory,'Cargo.toml'),manifest);
  writeFileSync(path.join(directory,'lib.rs'),'extern crate self as tauri;\npub use url::Url;\n'+['native_files','native_process','native_navigation'].map(name=>`#[path = ${JSON.stringify(path.join(desktop,`src-tauri/src/${name}.rs`))}]\nmod ${name};\n`).join(''));
  for(const target of targets){
    console.log(`Compile production native files/locks, helper launching and their tests: ${target} (${toolchain})`);
    const result=spawnSync(cargo,['check','--offline','--tests','--target',target,'--manifest-path',path.join(directory,'Cargo.toml')],{stdio:'inherit',env:{...process.env,RUSTC:rustc,CARGO_TARGET_DIR:cache}});
    if(result.error)throw result.error;
    if(result.status!==0){process.exitCode=result.status??1;break;}
  }
}finally{rmSync(directory,{recursive:true,force:true});}
