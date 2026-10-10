import{execFileSync}from'node:child_process';
import{readFileSync,readdirSync,writeFileSync}from'node:fs';
import path from'node:path';
const root=path.resolve(import.meta.dirname,'..');
const metadata=JSON.parse(execFileSync('cargo',['metadata','--locked','--format-version','1','--manifest-path',path.join(root,'src-tauri/Cargo.toml')],{encoding:'utf8',maxBuffer:16*1024*1024,stdio:['ignore','pipe','inherit']}));
let text='Runlist desktop third-party notices\n\nNode.js and its bundled components: see NODE-LICENSE.txt.\nSystem webview supplied by the host operating system (WebKit/WebView2).\nBuild-time and target-specific Cargo dependencies are included for completeness.\n\n';
text+='Acorn 8.15.0 (MIT)\nhttps://github.com/acornjs/acorn\n'+readFileSync(path.join(root,'node_modules/acorn/LICENSE'),'utf8')+'\n';
for(const pkg of metadata.packages.filter(p=>p.source).sort((a,b)=>a.name.localeCompare(b.name))){text+=`\n${'='.repeat(72)}\n${pkg.name} ${pkg.version}\nLicense: ${pkg.license??'See source license'}\nRepository: ${pkg.repository??''}\nAuthors: ${pkg.authors.join(', ')}\n\n`;const dir=path.dirname(pkg.manifest_path);for(const name of readdirSync(dir).filter(n=>/^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[.-]|$)/i.test(n))){try{text+=`\n${name}\n${readFileSync(path.join(dir,name),'utf8')}\n`;}catch{}}}
writeFileSync(path.join(root,'src-tauri/resources/THIRD-PARTY-NOTICES.txt'),text);console.log(`Collected notices for ${metadata.packages.length} Cargo packages.`);
