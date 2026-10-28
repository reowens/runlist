import { accessSync, constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopLaunch } from './desktop.mjs';
import { codexStatus } from './codex-integration.mjs';
import { opencodeStatus } from './host-integration.mjs';
import { sourceFingerprint } from './agent-hosts.mjs';
import { LEGACY_PRODUCT_NAME, PRODUCT_NAME } from './naming.mjs';
export { sourceFingerprint } from './agent-hosts.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function json(file) { try { return JSON.parse(readFileSync(file,'utf8')); } catch { return null; } }
function resolved(file) { try { return realpathSync(file); } catch { return null; } }
function executable(name, env, { cwd = process.cwd(), runnable = false, accept = () => true } = {}) {
  const suffixes = process.platform === 'win32' ? ['', ...(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) for (const suffix of suffixes) {
    const file = path.resolve(cwd, dir, name + suffix);
    try {
      if (!accept(file)) continue;
      if (runnable) {
        if (!statSync(file).isFile()) continue;
        accessSync(file, constants.X_OK);
        return file;
      }
      if (lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) return file;
    } catch {}
  }
  return null;
}

export const PERSISTENT_CLI_WARNING = 'Host hooks need a lasting runlist CLI on PATH. Run `npm install -g runlist`, then restart/reload the host. Hooks may not run until then.';

export function persistentCliOnPath({ env = process.env, cwd = process.cwd() } = {}) {
  const normalize = file => {
    const value = path.resolve(cwd, file).replace(/\\/g, '/');
    return process.platform === 'win32' ? value.toLowerCase() : value;
  };
  const localBins = new Set();
  // Evidence: npm 11.20.0, offline npx --package <local tarball> <probe>,
  // exported npm_command=exec, npm_lifecycle_event=npx and prepended
  // <cache>/_npx/<hash>/node_modules/.bin, then project/ancestor bins.
  // libnpmexec/lib/index.js and @npmcli/run-script/lib/set-path.js confirm
  // those shapes. Cache bins are temporary regardless of npm env markers;
  // project/ancestor bins are excluded under npm, which injects them even
  // for local devDependencies. Do not infer persistence from the launcher.
  if (env.npm_command || env.npm_execpath || env.npm_lifecycle_event) {
    for (const start of [cwd, env.INIT_CWD, env.npm_config_local_prefix, env.npm_package_json && path.dirname(env.npm_package_json)].filter(Boolean)) {
      let dir = path.resolve(cwd, start);
      for (;;) {
        const bin = path.join(dir, 'node_modules', '.bin');
        localBins.add(normalize(bin));
        localBins.add(normalize(resolved(bin) || bin));
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  }
  const inCache = file => /(?:^|\/)_npx\/[^/]+\/node_modules(?:\/|$)/.test(normalize(file));
  const accept = file => {
    const dir = path.dirname(file), realDir = resolved(dir) || dir;
    return !localBins.has(normalize(dir)) && !localBins.has(normalize(realDir))
      && !inCache(dir) && !inCache(realDir) && !inCache(resolved(file) || file);
  };
  for (const name of [PRODUCT_NAME, LEGACY_PRODUCT_NAME, 'rl']) {
    const file = executable(name, env, { cwd, runnable: true, accept });
    if (file) return { available: true, path: file };
  }
  return { available: false, path: null };
}

function identity(root) {
  const realRoot=resolved(root),pkg=realRoot&&json(path.join(realRoot,'package.json'));
  if(!pkg||typeof pkg!=='object'||Array.isArray(pkg))return {path:root,resolvedPath:realRoot,state:existsSync(root)?'unreadable':'missing'};
  return {path:root,resolvedPath:realRoot,state:'readable',version:pkg.version??null,
    kind:existsSync(path.join(realRoot,'.git'))?'checkout':'package',fingerprint:sourceFingerprint(realRoot)};
}

// Shared with update; reading a host registry does not activate or modify it.
export function readInstalledPluginRecords({home=os.homedir(),configDir=path.join(home,'.claude'),id}={}) {
  const plugins=json(path.join(configDir,'plugins/installed_plugins.json'))?.plugins??{};
  id ??= plugins['runlist@runlist']?'runlist@runlist':plugins['dotmd@dotmd']?'dotmd@dotmd':Object.keys(plugins).find(k=>/^(?:runlist|dotmd)@/.test(k));
  if(!id||!plugins[id])return null;
  return {id,entries:(Array.isArray(plugins[id])?plugins[id]:[plugins[id]]).filter(Boolean)};
}

export function installationReport(config={}, {root=packageRoot,home=os.homedir(),env=process.env,node=process.execPath,entry=process.argv[1],platform=process.platform,app}={}) {
  config ??= {};
  const cli=identity(root),nodeDirectory=path.dirname(node);
  cli.launcher=entry?{path:path.resolve(entry),resolvedPath:resolved(path.resolve(entry))}:null;
  const nodePrefix=path.basename(nodeDirectory)==='bin'?path.dirname(nodeDirectory):nodeDirectory;
  const projectRoot=config.repoRoot??process.cwd(),projectPackage=json(path.join(projectRoot,'package.json'));
  const dependency=projectPackage?.dependencies?.runlist??projectPackage?.devDependencies?.runlist??null;
  let project={declaration:dependency,state:'not-resolved'};
  try {
    if(projectPackage?.name!=='runlist') {
      let dir=path.dirname(createRequire(path.join(projectRoot,'package.json')).resolve('runlist'));
      for(let n=0;n<8;n++,dir=path.dirname(dir))if(json(path.join(dir,'package.json'))?.name==='runlist'){project={...identity(dir),declaration:dependency};break;}
    }
  } catch {}
  const appPath=app??desktopLaunch([],{platform,home,env}).app;
  const desktop=appPath ? platform==='darwin'?{...identity(path.join(appPath,'Contents/Resources/engine')),application:appPath}: {application:appPath,state:'unverified'} : {state:'not-installed'};
  desktop.sameEngineSource=cli.fingerprint?.sha256&&desktop.fingerprint?.sha256?cli.fingerprint.sha256===desktop.fingerprint.sha256:null;
  const claude=readInstalledPluginRecords({home});
  const codex=codexStatus({homedir:home,version:cli.version});
  const market=json(codex.marketplace)?.name??'personal';
  const cache=path.join(home,'.codex/plugins/cache',market,'runlist-codex');
  let cached=[];
  try {cached=readdirSync(cache).slice(0,20).map(version=>({path:path.join(cache,version),version,role:'cached copy; active host copy unverified'}));}catch{}
  const pluginFiles=['skills','commands','hooks','hooks.json','bin','.claude-plugin','.codex-plugin'];
  const pluginCopy = (file,version,role,source) => {
    const fingerprint=file?sourceFingerprint(file,pluginFiles):{state:'unavailable'},expected=sourceFingerprint(source,pluginFiles);
    return {path:file,version:version??null,role,fingerprint,sameSource:fingerprint.sha256&&expected.sha256?fingerprint.sha256===expected.sha256:null};
  };
  const warnings=[];
  const claudeRegistry=path.join(home,'.claude/plugins/installed_plugins.json');
  if(existsSync(claudeRegistry)&&!json(claudeRegistry))warnings.push('Claude registry unreadable; installed copies are unknown.');
  if(codex.foreign)warnings.push('Codex marketplace directory is unmanaged; its active installed copy is unverified.');
  const integrations={
    claude:(claude?.entries??[]).map(e=>pluginCopy(e.installPath,e.version,`${e.scope??'unknown'} registry entry`,path.join(root,'plugins/runlist'))),
    codex:[...(codex.exists?[pluginCopy(codex.plugin,codex.version,'marketplace source; not proof of active host copy',path.join(root,'plugins/runlist-codex'))]:[]),...cached.map(e=>pluginCopy(e.path,e.version,e.role,path.join(root,'plugins/runlist-codex')))],
    opencode:opencodeStatus({env,homedir:home,version:cli.version}),
  };
  return {cli,warnings,node:{path:node,version:process.version,prefix:nodePrefix,npm:executable('npm',env)},project,desktop,integrations,
    updateEffect:'update installs the published CLI into the npm global scope selected by npm on PATH, replacing its local link if present. It does not edit checkout sources or a project dependency. Desktop and managed host copies are separate update steps.'};
}

export function formatInstallationReport(report) {
  const id = copy => `${copy.state}${copy.version?` ${copy.version}`:''}${copy.fingerprint?.sha256?` · source ${copy.fingerprint.sha256.slice(0,12)}`:''}`;
  const lines=[`CLI: ${id(report.cli)} · ${report.cli.kind??'unknown'} · ${report.cli.resolvedPath??report.cli.path}`,
    `Launcher: ${report.cli.launcher?.path??'unknown'} → ${report.cli.launcher?.resolvedPath??'unknown'}`,
    `Node: ${report.node.version} · ${report.node.path} · prefix ${report.node.prefix}`,
    `npm on PATH: ${report.node.npm??'not found'}`,
    `Project dependency: ${report.project.declaration??'not declared'} · ${id(report.project)}${report.project.resolvedPath?` · ${report.project.resolvedPath}`:''}`,
    `Desktop: ${id(report.desktop)}${report.desktop.application?` · ${report.desktop.application}`:''} · engine source ${report.desktop.sameEngineSource===null?'unverified':report.desktop.sameEngineSource?'matches CLI':'differs from CLI'}`];
  for(const warning of report.warnings??[])lines.push(warning);
  for(const host of ['claude','codex']) {
    const copies=report.integrations[host];
    if(!copies.length)lines.push(`${host}: no registered/cached copies found`);
    for(const copy of copies)lines.push(`${host}: ${copy.version??'unknown'} · ${copy.role} · ${copy.path??'path unknown'} · source ${copy.sameSource===null?'unverified':copy.sameSource?'matches checkout':'differs from checkout'}`);
  }
  const oc=report.integrations.opencode;
  lines.push(`opencode: ${oc.exists?`${oc.foreign?'unmanaged':oc.version??'unknown'} · ${oc.path}`:'not installed'}`,`Update effect: ${report.updateEffect}`);
  return lines.join('\n')+'\n';
}
