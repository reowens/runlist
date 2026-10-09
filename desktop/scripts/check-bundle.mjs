// Exercise the packaged engine directly; never start the desktop app or WebView.
import {readFileSync,existsSync,realpathSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
const repo=path.resolve(import.meta.dirname,'../..');
const engine=realpathSync.native(path.resolve(process.argv[2]??path.join(repo,'desktop/src-tauri/resources')));
const manifest=JSON.parse(readFileSync(path.join(engine,'bundle-manifest.json'),'utf8'));
if(manifest.platform!==process.platform)throw new Error('Bundle platform does not match this test host.');
if(manifest.architecture!==process.arch)throw new Error('Bundle architecture does not match this test host.');
const runtime=path.join(engine,'runtime',manifest.executable),helper=path.join(engine,'desktop/helper.mjs'),assets=path.join(engine,'assets/app');
for(const file of [runtime,helper,path.join(assets,'app.mjs')])if(!existsSync(file))throw new Error('Missing bundle resource: '+file);
if(process.env.RUNLIST_REQUIRE_GMAX_QUALIFICATION==='1'&&!process.env.RUNLIST_GMAX_QUALIFICATION_ENTRY)throw new Error('Required bundle provider qualification needs an exact provider entry.');
const tests=['desktop/test/helper.test.mjs','desktop/test/headless-ui.test.mjs','desktop/test/accessibility.test.mjs','desktop/test/workspace-ui.test.mjs'];
if(process.env.RUNLIST_REQUIRE_GMAX_QUALIFICATION==='1'||process.env.RUNLIST_GMAX_QUALIFICATION_ENTRY)tests.push('desktop/test/semantic-gmax-contract.test.mjs');
const result=spawnSync(runtime,['--experimental-vm-modules','--test','--test-timeout=120000',...tests],{
 cwd:repo,stdio:'inherit',windowsHide:true,env:{...process.env,RUNLIST_GMAX_QUALIFICATION_NODE:process.env.RUNLIST_GMAX_QUALIFICATION_NODE??process.execPath,RUNLIST_TEST_RUNTIME:runtime,RUNLIST_TEST_HELPER:helper,RUNLIST_TEST_ASSETS:assets,NODE_OPTIONS:''}
});
if(result.error)throw result.error;
process.exitCode=result.status??1;
