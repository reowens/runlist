// Build and check Linux installers from an identified, isolated source snapshot.
import {createHash, randomUUID} from 'node:crypto';
import {spawn, execFileSync} from 'node:child_process';
import {createWriteStream, readFileSync, writeFileSync, mkdirSync, mkdtempSync,
  lstatSync, chmodSync, utimesSync, rmSync} from 'node:fs';
import path from 'node:path';
import {inspectPublicFiles, privateVocabularyAvailable} from './public-content.mjs';

const root=path.resolve(import.meta.dirname,'..');
const args=process.argv.slice(2);
if(args.includes('--help')) {
  console.log('Usage: node scripts/check-linux-docker.mjs\nBuild and check Linux/x64 installers. Logs and installers: .runlist/docker/runs/<run>/');
  process.exit(0);
}
if(args.length)throw Error('No arguments supported; use --help.');
if(process.platform!=='linux'||process.arch!=='x64'||!process.getuid?.())throw Error('Run as a non-root user on Linux/x64.');
const git=(...argv)=>execFileSync('git',argv,{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024});
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const daemon=JSON.parse(execFileSync('docker',['info','--format','{{json .}}'],{encoding:'utf8'}));
if(daemon.OSType!=='linux'||daemon.Architecture!=='x86_64')throw Error('A native Linux/x64 Docker daemon is required.');

const state=path.join(root,'.runlist/docker');
mkdirSync(path.join(state,'runs'),{recursive:true});
const output=mkdtempSync(path.join(state,'runs',new Date().toISOString().replaceAll(':','-')+'-'));
const artifacts=path.join(output,'artifacts');
mkdirSync(artifacts);
const snapshot=path.join(output,'source');
mkdirSync(snapshot);
const head=git('rev-parse','HEAD').trim(),status=git('status','--porcelain=v1');
const diff=()=>git('diff','--binary','--no-ext-diff','--no-textconv','HEAD','--');
const sourceDiff=diff();
const untracked=git('ls-files','--others','--exclude-standard','-z').split('\0').filter(Boolean);
const inventory=()=>git('ls-files','--cached','--others','--exclude-standard','-z').split('\0').filter(Boolean).sort();
const paths=[...new Set(inventory())];
const files=[];
for(const file of paths) {
  if(path.isAbsolute(file)||file.split('/').some(p=>p==='..'||p==='.git'))throw Error('Invalid source path.');
  const source=path.join(root,file),target=path.join(snapshot,file);
  let stat;
  try{stat=lstatSync(source);}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(!stat.isFile())throw Error('Source must contain regular files: '+file);
  const bytes=readFileSync(source);
  mkdirSync(path.dirname(target),{recursive:true});
  writeFileSync(target,bytes);
  chmodSync(target,stat.mode&0o777);
  utimesSync(target,stat.atime,stat.mtime);
  files.push({path:file,bytes:bytes.length,mode:stat.mode&0o777,sha256:sha(bytes)});
}
if(git('rev-parse','HEAD').trim()!==head||git('status','--porcelain=v1')!==status||diff()!==sourceDiff||JSON.stringify([...new Set(inventory())])!==JSON.stringify(paths))throw Error('Source changed while freezing; rerun.');
for(const file of files)if((lstatSync(path.join(root,file.path)).mode&0o777)!==file.mode||sha(readFileSync(path.join(root,file.path)))!==file.sha256)throw Error('Source changed while freezing: '+file.path);
const findings=inspectPublicFiles(snapshot,files.map(f=>f.path));
if(findings.length)throw Error('Snapshot contains nonpublic content: '+findings.map(f=>`${f.file}: ${f.category}`).join('\n'));
writeFileSync(path.join(output,'source.patch'),sourceDiff);
for(const file of untracked) {
  const target=path.join(output,'untracked',file);
  mkdirSync(path.dirname(target),{recursive:true});
  writeFileSync(target,readFileSync(path.join(snapshot,file)));
  chmodSync(target,lstatSync(path.join(snapshot,file)).mode&0o777);
}

// Only these 3 public files enter the image context, never the checkout or secrets.
const context=path.join(output,'image-context');
mkdirSync(context);
const imageInputs=[['desktop/docker/Dockerfile','Dockerfile'],['desktop/docker/validate.sh','validate.sh'],['desktop/runtime-lock.json','runtime-lock.json']];
for(const [source,target] of imageInputs)writeFileSync(path.join(context,target),readFileSync(path.join(snapshot,source)));
const identity=`${process.getuid()}:${process.getgid()}`;
const key=sha(Buffer.concat([...imageInputs.map(([,file])=>readFileSync(path.join(context,file))),Buffer.from(identity)])).slice(0,20);
const image='runlist-linux-builder:'+key;
const cache=path.join(state,'cache',key);
for(const name of ['cargo','npm','xdg','runtime','target'])mkdirSync(path.join(cache,name),{recursive:true});
const container='runlist-linux-'+randomUUID();
const report={startedAt:new Date().toISOString(),head,status,inventorySha256:sha(JSON.stringify(files)),files,image,identity,dockerVersion:daemon.ServerVersion,privateVocabularyAvailable,cpus:4,memory:'8g',cargoJobs:2};
const save=()=>writeFileSync(path.join(output,'run.json'),JSON.stringify(report,null,2)+'\n');
save();
console.log('Linux Docker checks: '+output);

async function run(argv,logFile,{lock=false}={}) {
  const started=Date.now(),log=createWriteStream(path.join(output,logFile));
  const code=await new Promise((resolve,reject)=>{
    const child=spawn(lock?'flock':'docker',lock?['--exclusive','--nonblock','--no-fork','--conflict-exit-code','75',path.join(cache,'run.lock'),'docker',...argv]:argv,{cwd:root,stdio:['ignore','pipe','pipe']});
    const timer=setTimeout(()=>child.kill('SIGKILL'),30*60*1000);
    let interrupted;
    const forward=signal=>{child.kill(signal);interrupted??=setTimeout(()=>child.kill('SIGKILL'),10000);};
    const interrupt=()=>forward('SIGINT'),terminate=()=>forward('SIGTERM');
    process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{process.stdout.write(chunk);log.write(chunk);});
    child.once('error',reject);
    child.once('close',(code,signal)=>{
      clearTimeout(timer);clearTimeout(interrupted);process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);
      log.end();resolve(code??(signal?128:1));
    });
  });
  report[logFile]={exitCode:code,seconds:(Date.now()-started)/1000};save();
  if(code!==0)throw Error(code===75?'Another Linux Docker run holds this cache; retry after it finishes.':`Docker exited ${code}; see ${path.join(output,logFile)}`);
}
try {
  await run(['build','--platform','linux/amd64','--progress','plain','--build-arg',`BUILD_UID=${process.getuid()}`,
    '--build-arg',`BUILD_GID=${process.getgid()}`,'--tag',image,context],'image.log');
  report.imageId=execFileSync('docker',['image','inspect',image,'--format','{{.Id}}'],{encoding:'utf8'}).trim();
  const mount=(from,to,readOnly=false)=>{
    if(from.includes(','))throw Error('Docker bind paths must not contain commas.');
    return ['--mount',`type=bind,source=${from},target=${to}${readOnly?',readonly':''}`];
  };
  await run(['run','--rm','--init','--name',container,'--user',`${process.getuid()}:${process.getgid()}`,
    '--cpus','4','--memory','8g','--memory-swap','8g','--pids-limit','512','--cap-drop','ALL',
    '--security-opt','no-new-privileges',
    ...mount(snapshot,'/source',true),...mount(artifacts,'/output'),...mount(cache,'/cache'),report.imageId],'validation.log',{lock:true});
  report.passed=true;
} catch(error) {
  report.passed=false;report.error=error.message;
  try{execFileSync('docker',['rm','--force',container],{stdio:'ignore'});}catch{}
  console.error(error.message);process.exitCode=1;
} finally {
  report.finishedAt=new Date().toISOString();save();
  // Keep the manifest and output, not a second checkout containing source copies.
  rmSync(snapshot,{recursive:true,force:true});rmSync(context,{recursive:true,force:true});
  console.log('Result: '+path.join(output,'run.json'));
}
