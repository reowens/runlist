// Execute the shipped frontend without a browser, WebView, native window or
// OS input. Only presentation controllers/DOM and the Tauri command bridge are
// doubled; recovery, draft persistence, transport and quit handlers are real.
import {test, afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {SourceTextModule, SyntheticModule, createContext} from 'node:vm';
import {spawn} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {checkoutTrust} from '../trust.mjs';
import {helperEnvironment} from './helper-environment.mjs';

const assets = process.env.RUNLIST_TEST_ASSETS ?? path.resolve(import.meta.dirname, '../../assets/app');
const runtime = process.env.RUNLIST_TEST_RUNTIME ?? process.execPath;
const entry = process.env.RUNLIST_TEST_HELPER ?? path.resolve(import.meta.dirname, '../helper.mjs');
const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).version;
const source = '---\r\ntype: plan\r\nstatus: active\r\ncustom: preserved\r\n---\r\n# Headless fixture\r\n\r\nOriginal paragraph.\r\n\r\n## Version History\r\n\r\n- Existing history.\r\n';
const relative = 'docs/plans/fixture.md';
const roots = [], engines = [], timers = new Set();
afterEach(async () => {
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
  for (const engine of engines.splice(0)) await engine.close();
  for (const root of roots.splice(0)) rmSync(root, {recursive:true, force:true});
});
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'runlist-headless-')));
  roots.push(root);
  mkdirSync(path.join(root, 'docs/plans'), {recursive:true});
  writeFileSync(path.join(root, 'runlist.config.mjs'), "export const root='docs';\n");
  writeFileSync(path.join(root, relative), source);
  return root;
}
async function engine(root) {
  const child = spawn(runtime, [entry, '--serve', root, checkoutTrust(root).fingerprint], {
    env:helperEnvironment(), windowsHide:true,
    stdio:['pipe','pipe','pipe']
  });
  const handle = randomUUID(), pending = new Map();
  let buffer = '', diagnostics = '';
  child.stderr.on('data', chunk => diagnostics += chunk);
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const reply = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      pending.get(reply.id)?.(reply);
      pending.delete(reply.id);
    }
  });
  const call = (op, route, body) => new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => reject(new Error(`Helper timeout: ${diagnostics}`)), 10000);
    pending.set(id, reply => {
      clearTimeout(timer);
      if (reply.ok) resolve(reply.value);
      else reject(Object.assign(new Error(reply.error.message), reply.error));
    });
    child.stdin.write(JSON.stringify({protocol:1, version, id, handle, op,
      ...(route ? {route:'/api/' + route} : {}), ...(body === undefined ? {} : {body})}) + '\n');
  });
  const close = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.stdin.end();
    await exited;
  };
  const result = {child, close, request:(route, body) => call('request', route, body)};
  engines.push(result);
  result.actor = (await call('hello')).actor;
  return result;
}
function storage() {
  const values = new Map();
  return {get length(){return values.size;}, key:i => [...values.keys()][i],
    getItem:key => values.get(key) ?? null, setItem:(key,value) => values.set(key,value),
    removeItem:key => values.delete(key)};
}
async function frontend(core, localStorage = storage()) {
  const nodes = new Map(), events = new Map(), calls = [];
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden:true, open:false, textContent:'', value:'', children:[],
      classList:{add(){}, remove(){}, toggle(){}}, setAttribute(){},
      addEventListener(){}, focus(){}, scrollIntoView(){}, replaceChildren(...children){this.children=children;},
      append(...children){this.children.push(...children);}
    });
    return nodes.get(id);
  };
  const location = {href:'tauri://localhost/', pathname:'/', search:'', hash:'', replace(){}};
  const context = createContext({
    URL, URLSearchParams, console, crypto:{randomUUID}, localStorage, sessionStorage:{},
    location, history:{replaceState(_a,_b,url){location.href=String(url);}},
    setTimeout:(fn,ms) => {const timer=setTimeout(fn,ms);timers.add(timer);return timer;}, clearTimeout,
    fetch:() => {throw new Error('Frontend must not use HTTP in desktop mode.');},
    document:{getElementById:node, querySelector:node, createElement:node, createTextNode:text=>({text}), addEventListener(){}},
    window:{scrollTo(){}, addEventListener(){}, __TAURI__:{
      event:{listen:async(name,handler) => events.set(name,handler)},
      core:{invoke:async(command,args) => {
        calls.push({command,args});
        if (command === 'desktop_status') return {handle:core.handle ?? null, recent:[], actor:core.actor};
        if (command === 'checkout_request') return core.request(args.route,args.body);
        if (command === 'finish_quit') return core.close?.();
        throw new Error('Unexpected native command: ' + command);
      }}
    }}
  });
  const noop = () => {};
  class BlockEditor {set(body){this.body=body;} source(){return this.body;} setReadOnly(){} hideTools(){}}
  const controllers = {
    'block-editor.mjs':{BlockEditor},
    'settings.mjs':{appSettings:() => ({read:() => ({})})},
    'document-lifecycle.mjs':{documentLifecycle:() => ({resolveInitial:async path=>path})},
    'document-stages.mjs':{documentStages:()=>({update:noop})},
    'document-yardstick.mjs':{documentYardstick:()=>({opened:async()=>{},update:noop,resolveInitial:async path=>path,resume:async()=>{},beforeLeave:async()=>{if(node('yardstick-dialog').open)throw new Error('Close the assessment review first.');},busy:()=>false})},
    'filing-navigation.mjs':{filingNavigation:()=>({show:async()=>{},load:async()=>{},invalidate:noop,deactivate:noop,visible:()=>false})},
    'record-navigation.mjs':{recordNavigation:() => ({deactivate:noop,counts:async()=>{}}),nativeContent:()=>''},
    'library-navigation.mjs':{libraryNavigation:() => ({render:noop,opened:noop})},
    'editor-navigation.mjs':{editorNavigation:() => ({update:noop})},
    'template-editor.mjs':{templateEditor:noop}
  };
  const modules = new Map();
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const exports = controllers[file];
    const module = exports
      ? new SyntheticModule(Object.keys(exports), function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value);}, {context})
      : new SourceTextModule(readFileSync(path.join(assets,file),'utf8') +
          (file === 'app.mjs' ? '\nexport {state, open, recover, candidate, beforeDesktopLeave, persistDraft, bodyChanged};' : ''),
          {context, identifier:file});
    modules.set(file,module);
    return module;
  }
  const app = load('app.mjs');
  await app.link(specifier => load(specifier.replace(/^\.\//,'')));
  await app.evaluate();
  // Mount with no checkout to avoid presentation bootstrap, then establish
  // the real transport session for document/persistence operations.
  core.handle ??= randomUUID();
  await modules.get('transport.mjs').namespace.request('session');
  return {app:app.namespace, node, events, calls, localStorage};
}
function bridge(runtime) {
  return {actor:runtime.actor, request:runtime.request, close:runtime.close};
}

test('shipped frontend Quit flushes exact private draft; a new renderer recovers only on explicit action', async () => {
  const root=fixture(), firstEngine=await engine(root), ui=await frontend(bridge(firstEngine));
  await ui.app.open(relative);
  ui.app.bodyChanged(ui.app.state.body.replace('Original paragraph.','Unpublished recovery — exact Unicode 先 🧭.'));
  const expected=ui.app.candidate();
  await ui.events.get('runlist:quit')();
  assert.equal(firstEngine.child.exitCode,0);
  assert.equal(readFileSync(path.join(root,relative),'utf8'),source);
  const secondEngine=await engine(root), reopened=await frontend(bridge(secondEngine),ui.localStorage);
  await reopened.app.open(relative);
  assert.equal(reopened.node('recovery').hidden,false);
  assert.equal(reopened.app.candidate(),source);
  assert.equal(reopened.app.state.pending,null);
  assert.equal(reopened.calls.some(c=>c.args?.route==='save'),false);
  await reopened.app.recover();
  assert.equal(reopened.app.candidate(),expected);
  assert.equal(readFileSync(path.join(root,relative),'utf8'),source);
  assert.equal(reopened.node('recovery').hidden,true);
});

test('recovery retains uncertain save identity and never automatically retries publication', async () => {
  const root=fixture(), firstEngine=await engine(root), ui=await frontend(bridge(firstEngine));
  await ui.app.open(relative);
  ui.app.bodyChanged(ui.app.state.body.replace('Original','Pending'));
  const pending={path:relative, operationId:randomUUID(), expectedRevision:ui.app.state.base.revision, source:ui.app.candidate()};
  ui.app.state.pending=pending;
  await ui.events.get('runlist:quit')();
  const reopened=await frontend(bridge(await engine(root)),ui.localStorage);
  await reopened.app.open(relative);
  await reopened.app.recover();
  assert.equal(JSON.stringify(reopened.app.state.pending),JSON.stringify(pending));
  assert.equal(reopened.calls.some(c=>['save','undo'].includes(c.args?.route)),false);
  assert.equal(readFileSync(path.join(root,relative),'utf8'),source);
});

test('external edits discovered after restart remain authoritative during explicit recovery', async () => {
  const root=fixture(), ui=await frontend(bridge(await engine(root)));
  await ui.app.open(relative);
  ui.app.bodyChanged(ui.app.state.body.replace('Original','Unpublished'));
  await ui.events.get('runlist:quit')();
  const external=source.replace('Original','External editor');
  writeFileSync(path.join(root,relative),external);
  const reopened=await frontend(bridge(await engine(root)),ui.localStorage);
  await reopened.app.open(relative);
  await reopened.app.recover();
  assert.equal(reopened.app.state.conflict.currentSource,external);
  assert.equal(reopened.node('conflict').hidden,false);
  assert.equal(readFileSync(path.join(root,relative),'utf8'),external);
});

test('Quit refuses busy operations and unfinished reviews without invoking native shutdown', async () => {
  const ui=await frontend({actor:{id:'human:test'}, request:async()=>{}});
  const quit=ui.events.get('runlist:quit');
  ui.app.state.busy=true;
  await quit();
  assert.match(ui.node('notice').textContent,/current operation/);
  ui.app.state.busy=false;
  for (const id of ['template-dialog','lifecycle-dialog','record-review']) {
    ui.node(id).open=true;ui.node(id).hidden=false;
    await quit();
    assert.match(ui.node('notice').textContent,/Close the current review/);
    ui.node(id).open=false;ui.node(id).hidden=true;
  }
  ui.node('yardstick-dialog').open=true;await quit();assert.match(ui.node('notice').textContent,/Close.*assessment review/);ui.node('yardstick-dialog').open=false;
  assert.equal(ui.calls.some(c=>c.command==='finish_quit'),false);
  await quit();
  assert.equal(ui.calls.filter(c=>c.command==='finish_quit').length,1);
});

test('Quit blocks when both local and disk recovery are unavailable', async () => {
  const root=fixture(), real=await engine(root), core=bridge(real), ui=await frontend(core);
  await ui.app.open(relative);
  ui.app.bodyChanged(ui.app.state.body.replace('Original','Retain me'));
  ui.localStorage.setItem=()=>{throw new Error('Quota exceeded');};
  core.request=async(route,body)=>{if(route==='draft/write')throw new Error('Disk unavailable');return real.request(route,body);};
  await ui.events.get('runlist:quit')();
  assert.match(ui.node('notice').textContent,/Recovery storage is unavailable/);
  assert.equal(ui.calls.some(c=>c.command==='finish_quit'),false);
  assert.equal(real.child.exitCode,null);
  assert.equal(readFileSync(path.join(root,relative),'utf8'),source);
});

test('disk draft failure preserves local recovery for a subsequent renderer', async () => {
  const root=fixture(), real=await engine(root), core=bridge(real), ui=await frontend(core);
  await ui.app.open(relative);
  ui.app.bodyChanged(ui.app.state.body.replace('Original','Local-only recovery'));
  const expected=ui.app.candidate();
  core.request=async(route,body)=>{if(route==='draft/write')throw new Error('Disk unavailable');return real.request(route,body);};
  await ui.events.get('runlist:quit')();
  const reopened=await frontend(bridge(await engine(root)),ui.localStorage);
  await reopened.app.open(relative);
  await reopened.app.recover();
  assert.equal(reopened.app.candidate(),expected);
  assert.equal(readFileSync(path.join(root,relative),'utf8'),source);
});

test('a fresh renderer with no local storage discovers disk drafts and keeps the interrupted request identity',async()=>{
  const root=fixture(),ui=await frontend(bridge(await engine(root)));
  await ui.app.open(relative);ui.app.bodyChanged(ui.app.state.body.replace('Original','Disk-only pending'));
  const pending={path:relative,operationId:randomUUID(),expectedRevision:ui.app.state.base.revision,source:ui.app.candidate()};ui.app.state.pending=pending;
  await ui.events.get('runlist:quit')();
  const reopened=await frontend(bridge(await engine(root)));await reopened.app.open(relative);
  assert.equal(reopened.node('recovery').hidden,false);assert.equal(reopened.app.state.pending,null);assert.equal(reopened.app.candidate(),source);
  await reopened.app.recover();assert.equal(reopened.app.state.pending.operationId,pending.operationId);assert.equal(reopened.app.state.pending.source,pending.source);
  assert.equal(reopened.calls.some(c=>['save','undo'].includes(c.args?.route)),false);assert.equal(readFileSync(path.join(root,relative),'utf8'),source);
});

test('disk recovery remains discoverable when local renderer storage is full',async()=>{
  const root=fixture(),ui=await frontend(bridge(await engine(root)));await ui.app.open(relative);
  ui.localStorage.setItem=()=>{throw new Error('Quota exceeded');};ui.app.bodyChanged(ui.app.state.body.replace('Original','Disk recovery despite quota'));
  await ui.events.get('runlist:quit')();assert.equal(ui.calls.some(c=>c.command==='finish_quit'),true);
  const reopened=await frontend(bridge(await engine(root)));await reopened.app.open(relative);assert.equal(reopened.node('recovery').hidden,false);await reopened.app.recover();assert.match(reopened.app.candidate(),/Disk recovery despite quota/);assert.equal(readFileSync(path.join(root,relative),'utf8'),source);
});
test('shipped source navigation highlights only the reviewed revision and keeps stale-row explanation',async()=>{
 const root=fixture(),runtime=await engine(root),ui=await frontend(bridge(runtime));
 const doc=await runtime.request('document?path='+relative),line=doc.source.split('\n').findIndex(text=>text==='Original paragraph.\r')+1;
 await ui.app.open(relative,{line,expectedRevision:doc.revision});assert.equal(ui.app.state.mode,'source');assert.equal(ui.node('full-source').children[1].textContent,'Original paragraph.\r');assert.equal(ui.node('full-source').children[1].className,'source-location');
 await ui.app.open(relative,{line,expectedRevision:'sha256:'+('0'.repeat(64))});assert.match(ui.node('notice').textContent,/changed since the filing report/);assert.equal(ui.app.state.mode,'source');
});
