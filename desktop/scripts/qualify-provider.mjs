// Required, isolated qualification of an exact external tarball. Never uses an installed gmax.
// node qualify-provider.mjs TARBALL SHA256 NEW_CONSUMER_DIRECTORY [ENGINE_RESOURCES]
import {readFileSync,writeFileSync,mkdirSync,existsSync,realpathSync,readdirSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const repo=path.resolve(import.meta.dirname,'../..');
const [archiveArg,expected,directoryArg,engine]=process.argv.slice(2);
if(!archiveArg||!/^[a-f0-9]{64}$/.test(expected??'')||!directoryArg)throw new Error('Required: exact provider tarball, SHA-256 and a new consumer directory.');
const archive=realpathSync(archiveArg),directory=path.resolve(directoryArg);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
if(sha(readFileSync(archive))!==expected)throw new Error('Provider tarball checksum mismatch.');
if(existsSync(directory))throw new Error('Consumer directory must be new.');
mkdirSync(directory,{recursive:true});
const home=path.join(directory,'home');mkdirSync(home);
writeFileSync(path.join(directory,'package.json'),JSON.stringify({name:'runlist-provider-qualification',version:'1.0.0',private:true}));
const env={...process.env,HOME:home,GMAX_HOME:path.join(home,'.gmax'),NODE_OPTIONS:'',PATH:path.dirname(process.execPath)+path.delimiter+process.env.PATH,
 npm_config_userconfig:path.join(directory,'npmrc'),npm_config_cache:path.join(directory,'npm-cache'),npm_config_ignore_scripts:'true',npm_config_engine_strict:'true'};
for(const key of Object.keys(env))if(/^npm_config_(allow_scripts|strict_allow_scripts|dangerously_allow_all_scripts)$/i.test(key))delete env[key];
writeFileSync(env.npm_config_userconfig,'ignore-scripts=true\nengine-strict=true\n');
function run(command,args,cwd=directory,extra={}){
 const r=spawnSync(command,args,{cwd,env:{...env,...extra},stdio:'inherit',windowsHide:true,timeout:300000});
 if(r.error||r.status!==0)throw new Error(`Qualification failed: ${command} ${args.join(' ')} (${r.error??r.status})`);
}
const npm=process.platform==='win32'?'npm.cmd':'npm';
run(npm,['install',archive,'--package-lock-only','--ignore-scripts','--no-audit','--no-fund']);
run(npm,['ci','--ignore-scripts','--omit=dev','--no-audit','--no-fund']);
const modules=path.join(directory,'node_modules'),provider=path.join(modules,'grepmax'),entry=path.join(provider,'dist/bin.js');
const lock=JSON.parse(readFileSync(path.join(directory,'package-lock.json'),'utf8'));
if(Object.keys(lock.packages).some(p=>p.endsWith('node_modules/@lancedb/lancedb')))throw new Error('Consumer unexpectedly resolved the SDK provider manifest.');
function noExternalLinks(dir){for(const name of readdirSync(dir)){const file=path.join(dir,name),s=lstatSync(file);if(s.isSymbolicLink()){const resolved=realpathSync(file);if(!resolved.startsWith(modules+path.sep))throw new Error('Consumer dependency link escapes its fresh install.');}else if(s.isDirectory())noExternalLinks(file);}}
noExternalLinks(modules);
const manifest=JSON.parse(readFileSync(path.join(provider,'package.json'),'utf8'));
const provenance=JSON.parse(readFileSync(path.join(provider,'dist/vendor/lancedb/provenance.json'),'utf8'));
if(provenance.version!==manifest.devDependencies['@lancedb/lancedb']||provenance.entrySha256!==sha(readFileSync(path.join(provider,'dist/vendor/lancedb/index.js'))))throw new Error('Lance JS provenance/pin mismatch.');
const nativeName=`@lancedb/lancedb-${process.platform}-${process.arch}${process.platform==='linux'?'-gnu':process.platform==='win32'?'-msvc':''}`;
const native=JSON.parse(readFileSync(path.join(modules,nativeName,'package.json'),'utf8'));
if(native.version!==manifest.optionalDependencies[nativeName]||native.version!==provenance.version)throw new Error('Lance native/JS pin mismatch.');
const smoke=path.join(directory,'native-smoke.cjs');
writeFileSync(smoke,`const fs=require('node:fs'),path=require('node:path');global.fetch=()=>{throw Error('Model/network download forbidden');};for(const m of ['node:http','node:https']){require(m).request=require(m).get=()=>{throw Error('Network forbidden');};}const cp=require('node:child_process');cp.spawn=cp.fork=cp.exec=cp.execFile=()=>{throw Error('Background/model startup forbidden');};const sdk=require('grepmax/dist/vendor/lancedb/index.js');const session=new sdk.Session(1048576n,1048576n);if(!Number.isFinite(Number(session.sizeBytes())))throw Error('Native ABI/session mismatch');sdk.connect=()=>{throw Error('Store connection forbidden in ABI fixture');};const {VectorDB}=require('grepmax/dist/lib/store/vector-db.js');(async()=>{const store=path.join(process.cwd(),'fixture-store'),db=new VectorDB(store,384);try{const result=await db.optimize();if(result.status!=='skipped')throw Error('Compaction containment lost');console.log('Fresh native ABI, bounded 2 MiB session and no-connection containment: pass');}finally{await db.close();fs.rmSync(store,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});`);
run(process.execPath,[smoke]);
const required={RUNLIST_GMAX_QUALIFICATION_ENTRY:entry,RUNLIST_GMAX_QUALIFICATION_NODE:process.execPath,RUNLIST_REQUIRE_GMAX_QUALIFICATION:'1'};
run(process.execPath,['--test','--test-timeout=120000','desktop/test/semantic-gmax-contract.test.mjs'],repo,required);
if(engine)run(process.execPath,['desktop/scripts/check-bundle.mjs',path.resolve(engine)],repo,required);
writeFileSync(path.join(directory,'qualification.json'),JSON.stringify({at:new Date().toISOString(),runtime:process.version,platform:process.platform,architecture:process.arch,
 providerVersion:manifest.version,archive,archiveSha256:expected,entry,lockSha256:sha(readFileSync(path.join(directory,'package-lock.json'))),
 lance:provenance,nativeVersion:native.version,lifecycleScripts:false,externalDependencyLinks:false,actualProviderRequired:true,nativeCheck:"ABI, bounded 2 MiB session, no-connection containment; no live admission claim",packagedEngine:engine?path.resolve(engine):null},null,2)+'\n');
console.log('Required fresh-provider qualification passed.');
