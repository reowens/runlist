import {createHash,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {lstat,mkdir,mkdtemp,rename,rm} from 'node:fs/promises';
import {homedir,tmpdir} from 'node:os';
import path from 'node:path';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {desktopLaunch} from './desktop.mjs';

const RELEASES='https://api.github.com/repos/reowens/runlist/releases';
const DOWNLOADS='https://github.com/reowens/runlist/releases/download/';
const TEAM='7GSPYYN5X8';
const MAX_DOWNLOAD=512*1024*1024;
const nativeExec=(exe,args)=>{
 try {return {stdout:execFileSync(exe,args,{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']})};}
 catch(error) {throw new Error(`${path.basename(exe)} failed: ${(error.stderr?.toString()||error.message).trim()}`,{cause:error});}
};

export function selectDesktopRelease(releases) {
 if(!Array.isArray(releases))throw new Error('Runlist release information is unavailable.');
 for(const release of releases) {
  if(release.draft)continue;
  for(const asset of release.assets??[]) {
   const match=/^Runlist-(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)-macOS-arm64\.dmg$/.exec(asset.name??'');
   if(!match||asset.state!=='uploaded')continue;
   const url=new URL(asset.browser_download_url);
   if(!url.href.startsWith(DOWNLOADS)||url.username||url.password||url.search||url.hash||!url.pathname.endsWith('/'+asset.name))throw new Error('The Runlist installer download address is invalid.');
   if(!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>MAX_DOWNLOAD)throw new Error('The Runlist installer size is invalid.');
   const checksum=/^sha256:([a-f0-9]{64})$/i.exec(asset.digest??'')?.[1].toLowerCase();
   if(!checksum)throw new Error('The published Runlist installer is missing its SHA-256 digest.');
   return {url:url.href,version:match[1],size:asset.size,sha256:checksum};
  }
 }
 return null;
}

async function latestInstaller(fetcher) {
 for(let page=1;page<=3;page++) {
  const response=await fetcher(`${RELEASES}?per_page=100&page=${page}`,{
   headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'runlist-desktop-install'},
   signal:AbortSignal.timeout(15000),
  });
  if(!response.ok)throw new Error(`Cannot download Runlist release information (HTTP ${response.status}). Try again when online, or use runlist desktop install --from /path/to/installer.dmg.`);
  let bytes=0;const chunks=[];
  for await(const chunk of response.body) {
   bytes+=chunk.length;if(bytes>4*1024*1024)throw new Error('Runlist release information is too large.');chunks.push(chunk);
  }
  const releases=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const installer=selectDesktopRelease(releases);if(installer)return installer;
  if(releases.length<100)break;
 }
 throw new Error('No Mac GUI installer has been published to Runlist releases yet. Use runlist desktop install --from /path/to/installer.dmg with a signed Runlist installer.');
}

async function download(installer,file,fetcher) {
 const response=await fetcher(installer.url,{signal:AbortSignal.timeout(120000)});
 if(!response.ok||!response.body)throw new Error(`Cannot download the Runlist installer (HTTP ${response.status}).`);
 let bytes=0;const hash=createHash('sha256');
 const guard=new Transform({transform(chunk,encoding,callback){
  bytes+=chunk.length;
  if(bytes>MAX_DOWNLOAD||bytes>installer.size){callback(new Error('Runlist installer download exceeded its published size.'));return;}
  hash.update(chunk);callback(null,chunk);
 }});
 await pipeline(Readable.fromWeb(response.body),guard,createWriteStream(file,{flags:'wx',mode:0o600}));
 if(bytes!==installer.size||hash.digest('hex')!==installer.sha256)throw new Error('Runlist installer download did not match its published SHA-256 digest. Nothing was installed.');
}

async function entry(file) {
 try{return await lstat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}
}

function verifySigned(file,exec,identifier) {
 exec('/usr/bin/codesign',['--verify',...(identifier?['--deep']:[]),'--strict',file]);
 // spawnSync is used here rather than execFileSync to retain stderr on success.
 const description=exec('/usr/bin/codesign',['-dvv',file]);
 const text=(description.stderr??'')+'\n'+(description.stdout??'');
 if(!text.includes(`TeamIdentifier=${TEAM}\n`)||(identifier&&!text.includes(`Identifier=${identifier}\n`)))throw new Error('This installer is not signed by the Runlist developer. Nothing was installed.');
 exec('/usr/sbin/spctl',identifier
  ?['--assess','--type','execute','--verbose=2',file]
  :['--assess','--type','open','--context','context:primary-signature','--verbose=2',file]);
}

function requireStopped(exec) {
 const processes=exec('/bin/ps',['-axo','comm=']).stdout;
 if(processes.split('\n').some(line=>line.trim()==='Runlist'||line.trim().endsWith('/Runlist.app/Contents/MacOS/Runlist')))throw new Error('Quit Runlist, then run this install command again. Your current app was kept.');
}

export async function runDesktopInstall(argv,{dryRun=false,platform=process.platform,arch=process.arch,home=homedir(),temporary=tmpdir(),fetcher=globalThis.fetch,exec,write=message=>process.stdout.write(message)}={}) {
 if(platform!=='darwin'||arch!=='arm64')throw new Error('CLI GUI installation currently supports Mac Apple Silicon only. Windows, Linux and Intel Mac downloads are not available yet.');
 const fromAt=argv.indexOf('--from');
 const from=fromAt<0?null:argv[fromAt+1];
 if(fromAt>=0&&(!from||from.startsWith('--')))throw new Error('--from requires a local Runlist installer.dmg path.');
 if(dryRun){write(`Would install the optional Runlist GUI from ${from?path.resolve(from):'Runlist GitHub releases'} without opening it. No download or files changed.\n`);return {dryRun:true};}
 const installed=desktopLaunch([],{platform,home}).app;
 if(installed&&!from){write(`Runlist is already installed at ${installed}. Open it with runlist desktop.\n`);return {installed,alreadyInstalled:true};}
 if(!exec) {
  // Imported only for this explicit installer; no subprocess or download at import time.
  const {spawnSync}=await import('node:child_process');
  exec=(exe,args)=>{
   if(exe!=='/usr/bin/codesign'||args[0]!=='-dvv')return nativeExec(exe,args);
   const result=spawnSync(exe,args,{encoding:'utf8',timeout:30000,stdio:['ignore','pipe','pipe']});
   if(result.error||result.status!==0)throw new Error('Cannot inspect the Runlist developer signature.',{cause:result.error});
   return result;
  };
 }
 const target=installed??path.join(home,'Applications/Runlist.app');
 const previous=await entry(target);
 if(previous&&(previous.isSymbolicLink()||!previous.isDirectory()))throw new Error('The Runlist installation path is not a regular application folder. Nothing was changed.');
 if(installed)requireStopped(exec);
 const parent=path.dirname(target);await mkdir(parent,{recursive:true});
 const lock=path.join(parent,'.runlist-desktop-install.lock');
 try{await mkdir(lock);}catch(error){if(error.code==='EEXIST')throw new Error(`Another desktop installation is in progress. If an earlier install was interrupted, remove ${lock} after confirming it has stopped.`);throw error;}
 let work,mount,attached=false,stage,backup;
 try {
  work=await mkdtemp(path.join(temporary,'runlist-desktop-'));
  let image;
  if(from) {
   image=path.resolve(from);const info=await entry(image);
   if(!image.toLowerCase().endsWith('.dmg')||!info?.isFile()||info.isSymbolicLink()||info.size>MAX_DOWNLOAD)throw new Error('--from must name a regular signed Runlist .dmg installer.');
  } else {
   const installer=await latestInstaller(fetcher);write(`Downloading Runlist ${installer.version} for Mac Apple Silicon…\n`);
   image=path.join(work,'Runlist.dmg');await download(installer,image,fetcher);
  }
  verifySigned(image,exec);
  mount=path.join(work,'volume');await mkdir(mount);attached=true;
  exec('/usr/bin/hdiutil',['attach',image,'-readonly','-nobrowse','-noautoopen','-mountpoint',mount]);
  const source=path.join(mount,'Runlist.app');const info=await entry(source);
  if(!info?.isDirectory()||info.isSymbolicLink())throw new Error('The installer does not contain a regular Runlist.app.');
  verifySigned(source,exec,'dev.reowens.runlist');
  stage=path.join(parent,`.Runlist-install-${randomUUID()}.app`);
  exec('/usr/bin/ditto',[source,stage]);
  // Keep normal Mac download identification instead of stripping quarantine.
  const quarantine=`0083;${Math.floor(Date.now()/1000).toString(16)};Runlist;${randomUUID()}`;
  exec('/usr/bin/xattr',['-w','com.apple.quarantine',quarantine,stage]);
  verifySigned(stage,exec,'dev.reowens.runlist');
  const current=await entry(target);
  if(Boolean(previous)!==Boolean(current)||(previous&&(current.dev!==previous.dev||current.ino!==previous.ino)))throw new Error('The installed app changed during installation. Nothing was replaced.');
  if(previous) {
   requireStopped(exec);
   const backups=path.join(parent,'.Runlist-backups');await mkdir(backups,{recursive:true});
   backup=path.join(backups,`Runlist-${randomUUID()}.app`);await rename(target,backup);
  }
  try{await rename(stage,target);stage=null;}
  catch(error){if(backup)await rename(backup,target);throw error;}
  write(`Installed Runlist at ${target}. Open it with runlist desktop.\n`);
  if(backup)write(`Previous app kept at ${backup}.\n`);
  return {installed:target,backup:backup??null};
 } finally {
  if(stage)await rm(stage,{recursive:true,force:true});
  if(attached) {
   try{exec('/usr/bin/hdiutil',['detach',mount]);attached=false;}
   catch{write(`Could not unmount the temporary installer at ${mount}; it was left in place.\n`);}
  }
  if(work&&!attached)await rm(work,{recursive:true,force:true});
  await rm(lock,{recursive:true,force:true});
 }
}
