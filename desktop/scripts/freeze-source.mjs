// Freeze tracked and nonignored untracked source without staging or committing it.
// node freeze-source.mjs REPOSITORY NEW_OUTPUT_DIRECTORY CANDIDATE_VERSION
import {readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync,copyFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
const [rootArg,outArg,version]=process.argv.slice(2);
if(!rootArg||!outArg||!/^\d+\.\d+\.\d+-[a-zA-Z0-9.-]+$/.test(version??''))throw Error('Supply repository, new output directory and an unpublished prerelease version.');
const root=path.resolve(rootArg),out=path.resolve(outArg),source=path.join(out,'source');
if(existsSync(out)||out===root||root.startsWith(out+path.sep))throw Error('Snapshot output must be new and outside the repository ancestry.');
const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8'});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const paths=[...new Set(git(['ls-files','--cached','--others','--exclude-standard','-z']).split('\0').filter(Boolean))].sort();
mkdirSync(source,{recursive:true});
const originals=[];
for(const file of paths){const from=path.join(root,file);if(!existsSync(from))continue;if(!lstatSync(from).isFile())throw Error('Source inventory contains a nonregular file: '+file);
 const bytes=readFileSync(from);mkdirSync(path.dirname(path.join(source,file)),{recursive:true});copyFileSync(from,path.join(source,file));
 originals.push({path:file,bytes:bytes.length,sha256:sha(bytes)});
}
for(const item of originals)if(sha(readFileSync(path.join(root,item.path)))!==item.sha256)throw Error('Source changed while freezing: '+item.path);
const rewrite=(file,transform)=>{const target=path.join(source,file);if(existsSync(target))writeFileSync(target,transform(readFileSync(target,'utf8')));};
const json=(file,transform)=>rewrite(file,text=>{const value=JSON.parse(text);transform(value);return JSON.stringify(value,null,2)+'\n';});
for(const file of ['package.json','desktop/package.json'])json(file,p=>{p.version=version;});
for(const file of ['package-lock.json','desktop/package-lock.json'])json(file,p=>{p.version=version;if(p.packages?.[''])p.packages[''].version=version;});
for(const file of ['plugins/runlist/.claude-plugin/plugin.json','plugins/runlist-codex/.codex-plugin/plugin.json','plugins/grepmax/.claude-plugin/plugin.json'])json(file,p=>{p.version=version;});
json('.claude-plugin/marketplace.json',p=>{for(const plugin of p.plugins??[])plugin.version=version;});
json('desktop/src-tauri/tauri.conf.json',p=>{p.version=version;});
rewrite('desktop/src-tauri/Cargo.toml',text=>text.replace(/^(version\s*=\s*)"[^"]+"/m,`$1"${version}"`));
rewrite('desktop/src-tauri/Cargo.lock',text=>text.replace(/(name = "runlist-desktop"\nversion = ")[^"]+/,`$1${version}`));
rewrite('CHANGELOG.md',text=>text.replace(/^## Unreleased[^\n]*$/m,`## Unreleased\n\n## ${version} — ${new Date().toISOString().slice(0,10)} (local candidate)`));
const files=originals.map(item=>({...item,candidateSha256:sha(readFileSync(path.join(source,item.path)))}));
const manifest={at:new Date().toISOString(),repository:root,baseHead:git(['rev-parse','HEAD']).trim(),gitStatus:git(['status','--porcelain=v1']),
 originalVersion:JSON.parse(readFileSync(path.join(root,'package.json'),'utf8')).version,candidateVersion:version,source,files,
 inventorySha256:sha(JSON.stringify(files)),gitMutation:false,published:false};
writeFileSync(path.join(out,'source-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({source,version,files:files.length,inventorySha256:manifest.inventorySha256},null,2));
