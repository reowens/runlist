// Terminal-only qualification. Never launches the app, WebView or OS input.
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import path from 'node:path';

if (process.platform !== 'darwin') throw new Error('Installed macOS bundle verification requires macOS.');
const app = path.resolve(process.argv[2] ?? path.join(homedir(),'Applications/Runlist.app'));
const engine = path.join(app,'Contents/Resources/engine');
const runtime = path.join(engine,'runtime/RunlistHelper');
const helper = path.join(engine,'desktop/helper.mjs');
const assets = path.join(engine,'assets/app');
for (const file of [runtime,helper,path.join(assets,'app.mjs')]) {
  if (!existsSync(file)) throw new Error('Missing installed bundle resource: ' + file);
}
const result = spawnSync('/usr/bin/sandbox-exec',[
  '-p','(version 1)(allow default)(deny network*)',runtime,'--experimental-vm-modules','--test',
  'desktop/test/helper.test.mjs','desktop/test/headless-ui.test.mjs','desktop/test/accessibility.test.mjs'
],{
  cwd:path.resolve(import.meta.dirname,'../..'), stdio:'inherit',
  env:{...process.env,RUNLIST_TEST_RUNTIME:runtime,RUNLIST_TEST_HELPER:helper,RUNLIST_TEST_ASSETS:assets,NODE_OPTIONS:''}
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
