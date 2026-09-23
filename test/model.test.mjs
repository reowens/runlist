import { describe, it, afterEach } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { autoCapGb, isLocalEndpoint, pickModel, modelSettings, roomRefusal } from '../src/model.mjs';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
const FAKE = path.resolve(import.meta.dirname, 'fixtures', 'fake-ollama.mjs');
const GB = 1e9;
let tmpDir;
let fake;

afterEach(() => {
  if (fake) { fake.kill(); fake = null; }
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function setup() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'runlist-model-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs'));
  writeFileSync(path.join(tmpDir, 'runlist.config.mjs'), "export const root = 'docs';\n");
  writeFileSync(path.join(tmpDir, 'docs', 'a.md'), '---\ntype: doc\nstatus: current\ntitle: A\n---\n# A\n\nSynthetic body.\n');
}

async function startFake({ pulled = [], residentBytes = 0 } = {}) {
  const log = path.join(tmpDir, 'fake.log');
  writeFileSync(log, '');
  fake = spawn(process.execPath, [FAKE], {
    env: { ...process.env, FAKE_OLLAMA_LOG: log, FAKE_OLLAMA_PULLED: JSON.stringify(pulled), FAKE_OLLAMA_RESIDENT: String(residentBytes) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise(resolve => fake.stdout.once('data', d => resolve(String(d).trim())));
  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests: () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)),
  };
}

function run(args, env = {}) {
  return spawnSync('node', [BIN, ...args], {
    cwd: tmpDir,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', RUNLIST_MODEL_SETTINGS: path.join(tmpDir, 'model.json'), ...env },
  });
}

describe('model settings', () => {
  it('a named model wins over the candidates', () => {
    deepStrictEqual(pickModel({ ...modelSettings(), model: 'fixture:3b' }), { name: 'fixture:3b', why: 'named' });
  });

  it('picks the first candidate measured on this machine under the cap, never an unmeasured one', () => {
    setup();
    const file = path.join(tmpDir, 'model.json');
    const prev = process.env.RUNLIST_MODEL_SETTINGS;
    process.env.RUNLIST_MODEL_SETTINGS = file;
    try {
      strictEqual(pickModel({ ...modelSettings(), model: null, capGb: 1000 }).name, null);
      writeFileSync(path.join(tmpDir, 'model-measurements.json'), JSON.stringify({ 'qwen3.5:9b': { peakGb: 6 }, 'qwen3.5:4b': { peakGb: 3.4 } }));
      strictEqual(pickModel({ ...modelSettings(), model: null, capGb: 12 }).name, 'qwen3.5:9b');
      strictEqual(pickModel({ ...modelSettings(), model: null, capGb: 4 }).name, 'qwen3.5:4b');
      strictEqual(pickModel({ ...modelSettings(), model: null, capGb: autoCapGb(8 * 2 ** 30) }).name, null);
    } finally {
      process.env.RUNLIST_MODEL_SETTINGS = prev;
    }
  });

  it('use and cap write the machine settings file', () => {
    setup();
    strictEqual(run(['model', 'use', 'fixture:3b']).status, 0);
    strictEqual(run(['model', 'cap', '9']).status, 0);
    deepStrictEqual(JSON.parse(readFileSync(path.join(tmpDir, 'model.json'), 'utf8')), { model: 'fixture:3b', capGb: 9 });
    strictEqual(run(['model', 'use', 'auto']).status, 0);
    deepStrictEqual(JSON.parse(readFileSync(path.join(tmpDir, 'model.json'), 'utf8')), { capGb: 9 });
  });
});

describe('memory', () => {
  const GiB = 2 ** 30;

  it('caps a model at a quarter of the machine, at most 12 GB', () => {
    strictEqual(autoCapGb(8 * GiB), 2);
    strictEqual(autoCapGb(16 * GiB), 4);
    strictEqual(autoCapGb(24 * GiB), 6);
    strictEqual(autoCapGb(48 * GiB), 12);
    strictEqual(autoCapGb(128 * GiB), 12);
  });

  it('refuses a load that free memory or pressure cannot take', () => {
    const settings = { headroomGb: 1.5 };
    match(roomRefusal('m', 6, settings, { availableGb: 7, pressure: 'normal' }), /needs about 7\.5 GB free/);
    match(roomRefusal('m', 2, settings, { availableGb: 30, pressure: 'warn' }), /pressure is warn/);
    strictEqual(roomRefusal('m', 6, settings, { availableGb: 8, pressure: 'normal' }), null);
  });

  it('treats only this machine as local', () => {
    ok(isLocalEndpoint('http://127.0.0.1:11434'));
    ok(isLocalEndpoint('http://localhost:11434'));
    ok(!isLocalEndpoint('http://studio.tailnet:11434'));
  });
});

describe('model server', () => {
  it('says the server is not running and never starts it from a summary', () => {
    setup();
    const status = run(['model']);
    strictEqual(status.status, 0);
    match(status.stdout, /not running/);
    const summary = run(['summary', 'docs/a.md', '--model', 'fixture:3b']);
    match(summary.stderr, /runlist model start/);
  });

  it('sends one chat with the server-side template, no thinking, idle unload and a fixed context', async () => {
    setup();
    const f = await startFake({ pulled: [{ name: 'fixture:3b', size: 2 * GB }], residentBytes: 3 * GB });
    const result = run(['summary', 'docs/a.md', '--model', 'fixture:3b', '--json'], { RUNLIST_MODEL_ENDPOINT: f.endpoint });
    strictEqual(result.status, 0, result.stderr);
    strictEqual(JSON.parse(result.stdout).summary, 'reply from fixture:3b');
    const chats = f.requests().filter(r => r.path === '/api/chat');
    strictEqual(chats.length, 1);
    const body = chats[0].body;
    deepStrictEqual(body.messages.map(m => m.role), ['system', 'user']);
    strictEqual(body.think, false);
    strictEqual(body.keep_alive, '5m');
    strictEqual(body.options.num_ctx, 16384);
  });

  it('refuses a model that is not pulled, and never pulls it', async () => {
    setup();
    const f = await startFake({ pulled: [] });
    const result = run(['summary', 'docs/a.md', '--model', 'fixture:3b'], { RUNLIST_MODEL_ENDPOINT: f.endpoint });
    match(result.stderr, /ollama pull fixture:3b/);
    ok(!f.requests().some(r => r.path === '/api/chat' || r.path === '/api/pull'));
  });

  it('refuses a model whose size is over the cap before loading it', async () => {
    setup();
    const f = await startFake({ pulled: [{ name: 'fixture:3b', size: 20 * GB }] });
    const result = run(['summary', 'docs/a.md', '--model', 'fixture:3b'], { RUNLIST_MODEL_ENDPOINT: f.endpoint, RUNLIST_MODEL_CAP_GB: '12' });
    match(result.stderr, /over this machine's 12 GB cap/);
    ok(!f.requests().some(r => r.path === '/api/chat'));
  });

  it('unloads a model that grew past the cap once loaded', async () => {
    setup();
    const f = await startFake({ pulled: [{ name: 'fixture:3b', size: 2 * GB }], residentBytes: 14 * GB });
    const result = run(['summary', 'docs/a.md', '--model', 'fixture:3b'], { RUNLIST_MODEL_ENDPOINT: f.endpoint, RUNLIST_MODEL_CAP_GB: '12' });
    match(result.stderr, /14\.0 GB, over the 12 GB cap, and was unloaded/);
    ok(f.requests().some(r => r.path === '/api/generate' && r.body.keep_alive === 0 && r.body.model === 'fixture:3b'));
  });

  it('stop unloads runlist\'s model and reports what it freed', async () => {
    setup();
    const f = await startFake({ pulled: [{ name: 'fixture:3b', size: 2 * GB }], residentBytes: 3 * GB });
    const env = { RUNLIST_MODEL_ENDPOINT: f.endpoint, RUNLIST_MODEL: 'fixture:3b' };
    run(['summary', 'docs/a.md'], env);
    const status = run(['model', '--json'], env);
    strictEqual(JSON.parse(status.stdout).loaded[0].name, 'fixture:3b');
    const stop = run(['model', 'stop'], env);
    match(stop.stdout, /Unloaded fixture:3b, 3\.0 GB freed/);
    strictEqual(JSON.parse(run(['model', '--json'], env).stdout).loaded.length, 0);
  });

  it('status --json leads with running, name and memoryMb', async () => {
    setup();
    const down = JSON.parse(run(['model', 'status', '--json'], { RUNLIST_MODEL_ENDPOINT: 'http://127.0.0.1:9', RUNLIST_MODEL: 'fixture:3b' }).stdout);
    deepStrictEqual({ running: down.running, name: down.name, memoryMb: down.memoryMb }, { running: false, name: 'fixture:3b', memoryMb: null });
    strictEqual(down.server.running, false, 'the existing shape is kept');

    const f = await startFake({ pulled: [{ name: 'fixture:3b', size: 2 * GB }], residentBytes: 3 * GB });
    const env = { RUNLIST_MODEL_ENDPOINT: f.endpoint, RUNLIST_MODEL: 'fixture:3b' };
    const idle = JSON.parse(run(['model', 'status', '--json'], env).stdout);
    deepStrictEqual({ running: idle.running, name: idle.name, memoryMb: idle.memoryMb }, { running: true, name: 'fixture:3b', memoryMb: null });
    run(['summary', 'docs/a.md'], env);
    const busy = JSON.parse(run(['model', 'status', '--json'], env).stdout);
    deepStrictEqual({ running: busy.running, name: busy.name, memoryMb: busy.memoryMb }, { running: true, name: 'fixture:3b', memoryMb: Math.round(3 * GB / 2 ** 20) });
    strictEqual(busy.loaded[0].bytes, 3 * GB);
    strictEqual(busy.server.running, true);
  });

  it('does not load a model when free memory is short, and says so', async () => {
    setup();
    const f = await startFake({ pulled: [{ name: 'fixture:3b', size: 2 * GB }], residentBytes: 3 * GB });
    const result = run(['summary', 'docs/a.md', '--model', 'fixture:3b'], { RUNLIST_MODEL_ENDPOINT: f.endpoint, RUNLIST_MODEL_AVAILABLE_GB: '3' });
    strictEqual(result.status, 0, result.stderr);
    match(result.stderr, /needs about 3\.5 GB free with headroom and 3\.0 GB is/);
    ok(!f.requests().some(r => r.path === '/api/chat'));
  });

  it('does not load a model under memory pressure', async () => {
    setup();
    const f = await startFake({ pulled: [{ name: 'fixture:3b', size: 2 * GB }] });
    const result = run(['summary', 'docs/a.md', '--model', 'fixture:3b'], { RUNLIST_MODEL_ENDPOINT: f.endpoint, RUNLIST_MODEL_PRESSURE: 'critical' });
    match(result.stderr, /Memory pressure is critical/);
    ok(!f.requests().some(r => r.path === '/api/chat'));
  });

  it('start refuses in one line where no model fits', () => {
    setup();
    const result = run(['model', 'start'], { RUNLIST_MODEL_CAP_GB: '0.5' });
    strictEqual(result.status, 1);
    match(result.stderr, /Not started: no measured model fits the 0\.5 GB cap\./);
    ok(!/at .*\.mjs:\d+/.test(result.stderr), 'no stack trace');
  });

  it('start says Ollama is missing instead of crashing', () => {
    setup();
    const result = spawnSync(process.execPath, [BIN, 'model', 'start', '--force'], {
      cwd: tmpDir,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', PATH: '/nonexistent', RUNLIST_MODEL_SETTINGS: path.join(tmpDir, 'model.json') },
    });
    strictEqual(result.status, 1);
    match(result.stderr, /Ollama is not installed/);
  });

  it('measure records peak memory and speed for this machine, then unloads', async () => {
    setup();
    const f = await startFake({ pulled: [{ name: 'fixture:3b', size: 2 * GB }], residentBytes: 3 * GB });
    const env = { RUNLIST_MODEL_ENDPOINT: f.endpoint };
    const result = run(['model', 'measure', 'fixture:3b'], env);
    strictEqual(result.status, 0, result.stderr);
    match(result.stdout, /fixture:3b: 3 GB peak/);
    const recorded = JSON.parse(readFileSync(path.join(tmpDir, 'model-measurements.json'), 'utf8'))['fixture:3b'];
    strictEqual(recorded.peakGb, 3);
    strictEqual(recorded.contextTokens, 16384);
    ok(f.requests().some(r => r.path === '/api/generate' && r.body.keep_alive === 0));
  });

  it('measure skips a model the free memory cannot hold', async () => {
    setup();
    const f = await startFake({ pulled: [{ name: 'fixture:3b', size: 6 * GB }] });
    const result = run(['model', 'measure', 'fixture:3b'], { RUNLIST_MODEL_ENDPOINT: f.endpoint, RUNLIST_MODEL_AVAILABLE_GB: '4' });
    strictEqual(result.status, 0, result.stderr);
    match(result.stdout, /fixture:3b: skipped\. fixture:3b needs about 7\.5 GB free/);
    ok(!f.requests().some(r => r.path === '/api/chat'));
    ok(!existsSync(path.join(tmpDir, 'model-measurements.json')));
  });
});
