// Terminal-only qualification. Never launches the app, WebView or OS input.
import {spawnSync} from 'node:child_process';
import {existsSync,readFileSync,readdirSync,realpathSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sourceFingerprint} from '../../src/installation.mjs';

const repository=path.resolve(import.meta.dirname,'../..');
const tests=['desktop/test/helper.test.mjs','desktop/test/headless-ui.test.mjs','desktop/test/accessibility.test.mjs'];
const support=['desktop/test/helper-environment.mjs','test/native-fixtures.mjs'];
const usage='Usage: node desktop/scripts/check-installed.mjs [Runlist.app] [--source /path/to/matching/source]';
function packageAt(root) {
  try {return JSON.parse(readFileSync(path.join(root,'package.json'),'utf8'));} catch {return null;}
}

export function selectInstalledTestSource(engine,{repo=repository,source}={}) {
  const installed=packageAt(engine),fingerprint=sourceFingerprint(engine);
  if(installed?.name!=='runlist'||typeof installed.version!=='string'||fingerprint.state!=='readable')throw new Error('Cannot read installed Runlist engine identity.');
  const candidates=source?[path.resolve(source)]:[path.resolve(repo)];
  if(!source) {
    const releases=path.join(repo,'desktop/releases');
    if(existsSync(releases))for(const entry of readdirSync(releases,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      if(entry.isDirectory())candidates.push(path.join(releases,entry.name,'source'));
    }
  }
  for(const candidate of candidates) {
    const pkg=packageAt(candidate);
    if(pkg?.name!==installed.name||pkg.version!==installed.version)continue;
    if(![...tests,...support].every(file=>existsSync(path.join(candidate,file))))continue;
    if(sourceFingerprint(candidate).sha256===fingerprint.sha256)return {source:realpathSync(candidate),version:installed.version,fingerprint:fingerprint.sha256};
  }
  throw new Error(`No matching test source for installed Runlist ${installed.version}. Match requires the same version, engine fingerprint and installed-check test files. ${source?'The supplied --source did not match.':'Checked this checkout and desktop/releases/*/source; use --source /path/to/matching/source for a snapshot stored elsewhere.'}`);
}

export function runInstalledCheck(argv,{repo=repository,platform=process.platform,arch=process.arch,home=homedir(),env=process.env,execute=spawnSync,write=message=>process.stdout.write(message)}={}) {
  if(argv.length===1&&['--help','-h'].includes(argv[0])){write(usage+'\n');return 0;}
  let app,source;
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(arg==='--source'&&source===undefined&&argv[i+1]&&!argv[i+1].startsWith('-'))source=argv[++i];
    else if(!arg.startsWith('-')&&app===undefined)app=arg;
    else throw new Error(usage);
  }
  if(platform!=='darwin')throw new Error('Installed macOS bundle verification requires macOS.');
  app=path.resolve(app??path.join(home,'Applications/Runlist.app'));
  const engine=path.join(app,'Contents/Resources/engine'),pkg=packageAt(engine);
  let manifest;
  try {manifest=JSON.parse(readFileSync(path.join(engine,'bundle-manifest.json'),'utf8'));} catch {throw new Error('Cannot read installed bundle manifest: '+engine);}
  if(manifest.version!==pkg?.version||manifest.protocol!==1)throw new Error('Installed bundle version/protocol metadata does not match.');
  if(manifest.platform!==platform||manifest.architecture!==arch||manifest.executable!=='RunlistHelper')throw new Error('Installed bundle runtime does not match this host.');
  const runtime=path.join(engine,'runtime/RunlistHelper'),helper=path.join(engine,'desktop/helper.mjs'),assets=path.join(engine,'assets/app');
  for(const file of [runtime,helper,path.join(assets,'app.mjs')])if(!existsSync(file))throw new Error('Missing installed bundle resource: '+file);
  const selected=selectInstalledTestSource(engine,{repo,source});
  for(const name of ['linkedom','acorn'])if(!existsSync(path.join(selected.source,'desktop/node_modules',name,'package.json')))throw new Error(`Missing test dependency ${name}; run npm ci in ${path.join(selected.source,'desktop')}.`);
  write(`Installed Runlist: ${selected.version}\nApplication: ${app}\nTest source: ${selected.source}\nEngine fingerprint: ${selected.fingerprint}\n`);
  const result=execute('/usr/bin/sandbox-exec',[
    '-p','(version 1)(allow default)(deny network*)',runtime,'--experimental-vm-modules','--test',...tests
  ],{
    cwd:selected.source,stdio:'inherit',
    env:{...env,RUNLIST_TEST_RUNTIME:runtime,RUNLIST_TEST_HELPER:helper,RUNLIST_TEST_ASSETS:assets,NODE_OPTIONS:''}
  });
  if(result.error)throw result.error;
  return result.status??1;
}

if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {process.exitCode=runInstalledCheck(process.argv.slice(2));}
  catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
