import {spawnSync} from 'node:child_process';
import {accessSync,constants,realpathSync,statSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {commitVersionQualified} from '../src/git-commit-support.mjs';

function resolveGit(){
 const extensions=process.platform==='win32'?(process.env.PATHEXT??'.COM;.EXE;.BAT;.CMD').split(';'):[''];
 for(const directory of (process.env.PATH??'').split(path.delimiter))for(const extension of extensions){
  const candidate=path.resolve(directory,'git'+extension);
  try{accessSync(candidate,constants.X_OK);if(statSync(candidate).isFile())return realpathSync(candidate);}catch{/* Try the next PATH entry. */}
 }
 return null;
}

export function inspectGitCommitToolchain(){
 const executable=resolveGit();
 const probe=spawnSync('git',['--version'],{encoding:'utf8',timeout:5000});
 const version=probe.status===0?probe.stdout.trim():'unavailable';
 const diagnostic=`platform=${process.platform} architecture=${process.arch} Node=${process.version} Git=${executable??'unresolved'} version=${version}`;
 return {qualified:!!executable&&commitVersionQualified(version),diagnostic};
}

export const gitCommitToolchainRequirement='Guarded Git integration requires a qualified platform and Git version. Select a qualified toolchain; the production Git safety gate remains enabled.';

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const result=inspectGitCommitToolchain();
 if(result.qualified)console.log(result.diagnostic);
 else{console.error(`${gitCommitToolchainRequirement}\n${result.diagnostic}`);process.exitCode=1;}
}
