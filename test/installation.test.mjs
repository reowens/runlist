import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {installationReport,sourceFingerprint,formatInstallationReport,readInstalledPluginRecords,persistentCliOnPath,isOneShotCliPath} from '../src/installation.mjs';

function fixture(t) {
  const home=realpathSync(mkdtempSync(path.join(os.tmpdir(),'runlist-installation-')));t.after(()=>rmSync(home,{recursive:true,force:true}));
  const write=(file,content)=>{mkdirSync(path.dirname(file),{recursive:true});writeFileSync(file,content);};
  const engine=(root,version='1.2.3',body='export const fixture=true;')=>{
    write(path.join(root,'package.json'),JSON.stringify({name:'runlist',version,main:'src/index.mjs'}));
    write(path.join(root,'src/index.mjs'),body);write(path.join(root,'bin/runlist.mjs'),'// launcher\n');
  };
  const root=path.join(home,'checkout'),project=path.join(home,'project'),app=path.join(home,'Applications/Runlist.app');
  engine(root);mkdirSync(path.join(root,'.git'));engine(path.join(app,'Contents/Resources/engine'));
  write(path.join(project,'package.json'),JSON.stringify({name:'consumer',devDependencies:{runlist:'^1.2.0'}}));
  const node=path.join(home,'nvm/versions/node/v22/bin/node'),npm=path.join(path.dirname(node),'npm');
  write(npm,'#!/bin/sh\ntouch '+path.join(home,'NPM_MUST_NOT_RUN')+'\n');
  const entry=path.join(path.dirname(node),'rl');symlinkSync(path.join(root,'bin/runlist.mjs'),entry,'file');
  const options={root,home,node,entry,app,platform:'darwin',env:{PATH:path.dirname(node)}};
  return {home,root,project,app,write,engine,options,report:()=>installationReport({repoRoot:project},options)};
}

test('reports active Node scope, launcher link, project dependency and equal-version source drift without running npm',t=>{
  const f=fixture(t),dependency=path.join(f.project,'node_modules/runlist');f.engine(dependency,'1.2.3','export const fixture="project copy";');
  let report=f.report();assert.equal(report.cli.kind,'checkout');assert.equal(report.cli.launcher.path,f.options.entry);
  assert.equal(report.cli.launcher.resolvedPath,path.join(f.root,'bin/runlist.mjs'));assert.equal(report.node.prefix,path.dirname(path.dirname(f.options.node)));
  assert.equal(report.project.declaration,'^1.2.0');assert.equal(report.project.resolvedPath,dependency);assert.equal(report.desktop.sameEngineSource,true);
  f.write(path.join(f.app,'Contents/Resources/engine/src/index.mjs'),'export const fixture="older code";');
  report=f.report();assert.equal(report.desktop.version,report.cli.version);assert.equal(report.desktop.sameEngineSource,false);
  assert.match(formatInstallationReport(report),/engine source differs from CLI/);assert.match(formatInstallationReport(report),/replacing its local link/);
  assert.equal(existsSync(path.join(f.home,'NPM_MUST_NOT_RUN')),false);assert.equal(existsSync(path.join(f.project,'.runlist')),false);
});

test('fingerprints compare engine inputs across candidate labels and exclude private checkout files',t=>{
  const f=fixture(t),before=sourceFingerprint(f.root);
  f.write(path.join(f.root,'docs/prompts/private.md'),'PRIVATE_BODY_NEVER_REPORTED');f.write(path.join(f.root,'.env'),'PRIVATE_CREDENTIAL_NEVER_REPORTED');
  assert.deepEqual(sourceFingerprint(f.root),before);
  f.engine(path.join(f.app,'Contents/Resources/engine'),'1.2.3-review.1');assert.equal(f.report().desktop.sameEngineSource,true);
  assert.equal(JSON.stringify(f.report()).includes('PRIVATE_BODY'),false);
  f.write(path.join(f.root,'package.json'),'null');assert.equal(f.report().cli.state,'unreadable');
});

test('shows managed host copies and leaves missing or unreadable identities explicit',t=>{
  const f=fixture(t),source=path.join(f.root,'plugins/runlist'),installed=path.join(f.home,'claude-copy');
  f.write(path.join(source,'skills/runlist/SKILL.md'),'new instructions');f.write(path.join(installed,'skills/runlist/SKILL.md'),'old instructions');
  f.write(path.join(f.home,'.claude/plugins/installed_plugins.json'),JSON.stringify({plugins:{'runlist@runlist':[{scope:'user',version:'1.2.3',installPath:installed}]}}));
  const report=f.report();assert.equal(report.integrations.claude[0].sameSource,false);
  const missing=installationReport({repoRoot:f.project},{...f.options,app:path.join(f.home,'missing.app')});assert.equal(missing.desktop.state,'missing');assert.equal(missing.desktop.sameEngineSource,null);
  const file=path.join(installed,'skills/runlist/SKILL.md');assert.equal(readFileSync(file,'utf8'),'old instructions');
});

test('installed plugin reader accepts an explicit profile without changing default or legacy selection',t=>{
  const f=fixture(t),configDir=path.join(f.home,'.claude-robot');
  f.write(path.join(f.home,'.claude/plugins/installed_plugins.json'),JSON.stringify({plugins:{'dotmd@dotmd':{scope:'user',version:'0.1.0'}}}));
  f.write(path.join(configDir,'plugins/installed_plugins.json'),JSON.stringify({plugins:{'runlist@runlist':[{scope:'user',version:'1.2.3'},{scope:'project',version:'1.2.2',projectPath:f.project}]}}));
  assert.equal(readInstalledPluginRecords({home:f.home}).id,'dotmd@dotmd');
  const selected=readInstalledPluginRecords({home:f.home,configDir});
  assert.equal(selected.id,'runlist@runlist');assert.equal(selected.entries.length,2);
  assert.equal(readInstalledPluginRecords({home:f.home,configDir,id:'dotmd@dotmd'}),null);
});

test('legacy installation report plugin hashes include standalone hooks.json',t=>{
  const f=fixture(t),source=path.join(f.root,'plugins/runlist'),installed=path.join(f.home,'claude-copy');
  for(const dir of [source,installed])f.write(path.join(dir,'hooks.json'),'{"hooks":{}}');
  f.write(path.join(f.home,'.claude/plugins/installed_plugins.json'),JSON.stringify({plugins:{'runlist@runlist':[{scope:'user',version:'1.2.3',installPath:installed}]}}));
  assert.equal(f.report().integrations.claude[0].sameSource,true);
  f.write(path.join(installed,'hooks.json'),'{"hooks":{"SessionStart":"old"}}');
  assert.equal(f.report().integrations.claude[0].sameSource,false);
});

// PATH fixtures describe synthetic launchers; none of these files is executed.
function cliFixture(t) {
  const f = fixture(t);
  const cwd = path.join(f.project, 'nested');
  mkdirSync(cwd);
  const bin = (directory, name = 'runlist') => {
    const file = path.join(directory, name + (process.platform === 'win32' ? '.cmd' : ''));
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, 'exit 99\n', { mode: 0o755 });
    return file;
  };
  const env = { PATH: '', npm_command: 'exec' };
  return { ...f, cwd, bin, env, check: () => persistentCliOnPath({ cwd, env }) };
}

const dlxHash = '0123456789abcdef0123456789abcdef';
const dlxBase32Hash = 'abcdefghijklmnopqrstuv2345';
const oneShotBins = [
  'custom-cache/_npx/abc123/node_modules/.bin',
  `custom-cache/pnpm/dlx/${dlxHash}/fixture-id/node_modules/.bin`,
  `custom-cache/pnpm/dlx/${dlxBase32Hash}/fixture-id/node_modules/.bin`,
  `custom-cache/pnpm-cache/dlx/${dlxHash}/fixture-id/node_modules/.bin`,
  `arbitrary-parent/dlx/${dlxHash.repeat(2)}/fixture-id/node_modules/.bin`,
  'pnpm/store/v3/tmp/dlx-1234/node_modules/.bin',
  'temp/bunx-1000-fixture/node_modules/.bin',
  'custom-cache/.bunx-1000/fixture/node_modules/.bin',
];
for (const relative of oneShotBins) test(`persistent CLI detection rejects one-shot bin ${relative} without npm markers`, t => {
  const f = cliFixture(t);
  const cacheBin = path.join(f.home, relative);
  f.bin(cacheBin);
  f.env.PATH = cacheBin;
  delete f.env.npm_command;
  assert.deepEqual(f.check(), { available: false, path: null });
  const lasting = path.join(f.home, 'lasting-bin');
  const expected = f.bin(lasting);
  for (const bins of [[cacheBin, lasting], [lasting, cacheBin]]) {
    f.env.PATH = bins.join(path.delimiter);
    assert.deepEqual(f.check(), { available: true, path: expected });
  }
});

for (const relative of [
  'custom-cache/not_npx/abc123/node_modules/.bin',
  `custom-cache/pnpm/not-dlx/${dlxHash}/fixture-id/node_modules/.bin`,
  `custom-cache/pnpm/dlx/${dlxHash}/node_modules/.bin`,
  `custom-cache/pnpm/dlx/${dlxHash}/fixture-id/not-node_modules/.bin`,
  'custom-cache/pnpm/dlx/not-a-cache-key/fixture-id/node_modules/.bin',
  'src/dlx-2024/node_modules/.bin',
  'pnpm/store/v3/not-tmp/dlx-1234/node_modules/.bin',
  'temp/not-dlx-1234/node_modules/.bin',
  'temp/dlx-fixture/node_modules/.bin',
  'temp/not-bunx-1000-fixture/node_modules/.bin',
  'temp/bunx-fixture/node_modules/.bin',
  'temp/xfs-1a2b3c4d',
  'temp/xfs-1a2b3c4d/dlx-1234/launchers',
]) test(`persistent CLI detection keeps ordinary bin ${relative}`, t => {
  const f = cliFixture(t);
  const binDir = path.join(f.home, relative);
  const expected = f.bin(binDir);
  f.env.PATH = binDir;
  delete f.env.npm_command;
  assert.deepEqual(f.check(), { available: true, path: expected });
});

test('one-shot path shapes recognize Windows pnpm-cache paths without Windows filesystem access', () => {
  const prefix = `C:\\Users\\fixture\\AppData\\Local\\pnpm-cache\\dlx\\${dlxHash}`;
  assert.equal(isOneShotCliPath(`${prefix}\\fixture-id\\node_modules\\.bin`), true);
  assert.equal(isOneShotCliPath(`${prefix}\\fixture-id\\node_modules\\runlist\\bin\\runlist.mjs`), true);
  assert.equal(isOneShotCliPath(`${prefix}\\node_modules\\.bin`), false);
  assert.equal(isOneShotCliPath(prefix.replace('\\dlx\\', '\\not-dlx\\') + '\\fixture-id\\node_modules\\.bin'), false);
  assert.equal(isOneShotCliPath(prefix.replace(dlxHash, dlxBase32Hash) + '\\fixture-id\\node_modules\\.bin'), true);
  assert.equal(isOneShotCliPath('C:\\pnpm\\store\\v3\\tmp\\dlx-1234\\node_modules\\.bin'), true);
  assert.equal(isOneShotCliPath('C:\\src\\dlx-2024\\node_modules\\.bin'), false);
});

function yarnWrapper(f, binDir) {
  // Yarn 4.9.2 makePathWrapper writes a regular shell wrapper in a separate
  // mktemp folder, not a link into the dlx package's mktemp folder.
  const target = path.join(f.home, 'temp/xfs-feedface/dlx-1234/node_modules/runlist/bin/runlist.mjs');
  f.write(target, '// synthetic package binary\n');
  const file = f.bin(binDir);
  writeFileSync(file, process.platform === 'win32'
    ? `@echo off\r\n@"node" "${target}" %*\r\n`
    : `#!/bin/sh\nexec "node" '${target}' "$@"\n`);
  return file;
}

test('persistent CLI detection excludes Yarn BERRY_BIN_FOLDER wrappers only when marked', t => {
  const f = cliFixture(t);
  const binDir = path.join(f.home, 'temp/xfs-1a2b3c4d');
  const wrapper = yarnWrapper(f, binDir);
  f.env.PATH = binDir;
  delete f.env.npm_command;
  f.env.BERRY_BIN_FOLDER = binDir;
  assert.deepEqual(f.check(), { available: false, path: null });
  delete f.env.BERRY_BIN_FOLDER;
  assert.deepEqual(f.check(), { available: true, path: wrapper });
  f.env.BERRY_BIN_FOLDER = binDir + '-other';
  assert.deepEqual(f.check(), { available: true, path: wrapper }, 'only the exact folder is excluded');
  f.env.BERRY_BIN_FOLDER = binDir;
  const persistent = path.join(f.home, 'persistent-bin');
  const expected = f.bin(persistent);
  for (const bins of [[binDir, persistent], [persistent, binDir]]) {
    f.env.PATH = bins.join(path.delimiter);
    assert.deepEqual(f.check(), { available: true, path: expected });
  }
});

test('persistent CLI detection excludes Yarn folder and launcher symlinks in either direction', t => {
  if (process.platform === 'win32') return t.skip('Symlink creation requires Windows privileges.');
  const f = cliFixture(t);
  const binDir = path.join(f.home, 'temp/xfs-1a2b3c4d');
  const wrapper = yarnWrapper(f, binDir);
  const linkedDir = path.join(f.home, 'linked-bin');
  symlinkSync(binDir, linkedDir, 'dir');
  const launcherDir = path.join(f.home, 'launcher-bin');
  mkdirSync(launcherDir);
  symlinkSync(wrapper, path.join(launcherDir, 'runlist'));
  delete f.env.npm_command;
  for (const marker of [binDir, linkedDir]) {
    f.env.BERRY_BIN_FOLDER = marker;
    for (const candidate of [binDir, linkedDir, launcherDir]) {
      f.env.PATH = candidate;
      assert.deepEqual(f.check(), { available: false, path: null });
    }
  }
});

test('persistent CLI detection excludes nested Yarn temp wrappers only when marked, including realpath aliases', t => {
  const f = cliFixture(t);
  const bins = Array.from({ length: 2 }, () => path.join(os.tmpdir(), `xfs-${randomBytes(4).toString('hex')}`));
  for (const bin of bins) {
    mkdirSync(bin);
    t.after(() => rmSync(bin, { recursive: true, force: true }));
    yarnWrapper(f, bin);
  }
  delete f.env.npm_command;
  f.env.BERRY_BIN_FOLDER = bins[0];
  for (const order of [bins, [...bins].reverse()]) {
    f.env.PATH = order.join(path.delimiter);
    assert.deepEqual(f.check(), { available: false, path: null });
  }
  if (process.platform !== 'win32') {
    const linkedDir = path.join(f.home, 'outer-wrapper-alias');
    symlinkSync(bins[1], linkedDir, 'dir');
    f.env.PATH = [bins[0], linkedDir].join(path.delimiter);
    assert.deepEqual(f.check(), { available: false, path: null });
  }
  f.env.PATH = bins.join(path.delimiter);
  delete f.env.BERRY_BIN_FOLDER;
  assert.deepEqual(f.check(), { available: true, path: path.join(bins[0], process.platform === 'win32' ? 'runlist.cmd' : 'runlist') });
  f.env.BERRY_BIN_FOLDER = bins[0];
  const lasting = path.join(f.home, 'lasting-bin');
  const expected = f.bin(lasting);
  for (const order of [[...bins, lasting], [lasting, ...bins]]) {
    f.env.PATH = order.join(path.delimiter);
    assert.deepEqual(f.check(), { available: true, path: expected });
  }
});

test('persistent CLI detection rejects an rl-only PATH because hooks do not call it', t => {
  const f = cliFixture(t);
  const binDir = path.join(f.home, 'lasting-bin');
  f.bin(binDir, 'rl');
  f.env.PATH = binDir;
  assert.deepEqual(f.check(), { available: false, path: null });
});

test('persistent CLI detection rejects project and ancestor bins injected by npm', t => {
  const f = cliFixture(t);
  const bins = [f.cwd, f.project, f.home].map(dir => path.join(dir, 'node_modules/.bin'));
  for (const dir of bins) f.bin(dir);
  f.env.PATH = bins.join(path.delimiter);
  assert.deepEqual(f.check(), { available: false, path: null });
  delete f.env.npm_command;
  assert.equal(f.check().available, true, 'an explicitly configured PATH outside npm is respected');
});

test('persistent CLI detection accounts for npm prefix and initial cwd outside current cwd', t => {
  const f = cliFixture(t);
  const binDir = path.join(f.home, 'workspace/node_modules/.bin');
  f.bin(binDir);
  f.env.PATH = binDir;
  for (const key of ['INIT_CWD', 'npm_config_local_prefix']) {
    f.env[key] = path.dirname(path.dirname(binDir));
    assert.equal(f.check().available, false);
    delete f.env[key];
  }
});

for (const name of ['runlist', 'dotmd']) test(`persistent CLI detection finds lasting ${name} after temporary entries`, t => {
  const f = cliFixture(t);
  const ephemeral = path.join(f.home, 'cache/_npx/abc123/node_modules/.bin');
  f.bin(ephemeral);
  const lasting = path.join(f.home, 'lasting-bin');
  const expected = f.bin(lasting, name);
  f.env.PATH = [ephemeral, path.join(f.project, 'node_modules/.bin'), lasting].join(path.delimiter);
  assert.deepEqual(f.check(), { available: true, path: expected });
});

test('persistent CLI detection skips directories, non-executable files and broken links', t => {
  if (process.platform === 'win32') return t.skip('POSIX executable bits and unprivileged symlinks.');
  const f = cliFixture(t);
  const binDir = path.join(f.home, 'bad-bin');
  mkdirSync(path.join(binDir, 'runlist'), { recursive: true });
  const nonExecutableDir = path.join(f.home, 'non-executable-bin');
  mkdirSync(nonExecutableDir);
  writeFileSync(path.join(nonExecutableDir, 'runlist'), 'not executable\n', { mode: 0o644 });
  symlinkSync(path.join(binDir, 'missing'), path.join(binDir, 'dotmd'));
  f.env.PATH = [binDir, nonExecutableDir].join(path.delimiter);
  assert.equal(f.check().available, false);
});

for (const relative of oneShotBins) test(`persistent CLI detection follows directory and launcher links into ${relative}`, t => {
  if (process.platform === 'win32') return t.skip('Symlink creation requires Windows privileges.');
  const f = cliFixture(t);
  const cacheBin = path.join(f.home, relative);
  const target = f.bin(cacheBin);
  const linkedDir = path.join(f.home, 'linked-bin');
  symlinkSync(cacheBin, linkedDir, 'dir');
  f.env.PATH = linkedDir;
  assert.equal(f.check().available, false);
  const lastingDir = path.join(f.home, 'lasting-bin');
  mkdirSync(lastingDir);
  symlinkSync(target, path.join(lastingDir, 'runlist'));
  f.env.PATH = lastingDir;
  assert.equal(f.check().available, false);
});
