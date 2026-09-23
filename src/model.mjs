import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { die, warn } from './util.mjs';
import { bold, dim, green, yellow } from './color.mjs';

// One local model server, talked to over HTTP. The model loads once, serves
// one request at a time, and unloads after it sits idle. runlist never starts
// the server on its own: only `runlist model start` does, and a model is never
// pulled for you.
//
// Settings are the machine's, not the repo's, because memory is: they live in
// ~/.runlist/model.json (RUNLIST_MODEL_SETTINGS moves it), written by
// `runlist model use` and `runlist model cap`. RUNLIST_MODEL,
// RUNLIST_MODEL_CAP_GB and RUNLIST_MODEL_ENDPOINT override them for one shell, and `--model` for one run.
//
// Runtimes: `ollama` (the default; its own API, so load state, memory and
// unload are visible) and `openai` (any OpenAI-compatible server: mlx_lm.server,
// llama-server, LM Studio), which can only be asked to generate.
//
// Memory is guarded twice. The cap, unless set, is a quarter of the machine's
// memory up to 12 GB, so an 8 GB laptop gets 2 GB and no candidate: model
// features stay off there and say why. And before a model loads on this
// machine, the memory free right now must hold it plus headroom, with the
// system's memory pressure normal; otherwise the request is refused and the
// command carries on without it. A server on another machine is that
// machine's memory, so neither check applies to it.

const REQUEST = fileURLToPath(new URL('./model-request.mjs', import.meta.url));

// Best first. None is picked on a machine until `runlist model measure` has
// recorded its peak memory there; the first measured one under the cap is used
// when no model is named.
export const CANDIDATES = Object.freeze(['gemma4:12b', 'qwen3.5:9b', 'qwen3.5:4b']);

export const DEFAULTS = Object.freeze({
  runtime: 'ollama',
  endpoint: 'http://127.0.0.1:11434',
  model: null,
  capGb: null,
  headroomGb: 1.5,
  keepAlive: '5m',
  contextTokens: 16384,
});

const GB = 1e9;
const MAX_CAP_GB = 12;

// A quarter of the machine's memory, in half-gigabyte steps, at most 12 GB.
export function autoCapGb(totalBytes = os.totalmem()) {
  return Math.min(MAX_CAP_GB, Math.floor((totalBytes / GB / 4) * 2) / 2);
}

const PRESSURE = { 1: 'normal', 2: 'warn', 4: 'critical' };

// Total, free-now and pressure for this machine. RUNLIST_MODEL_AVAILABLE_GB
// and RUNLIST_MODEL_PRESSURE replace the reading where it is wrong, and in tests.
export function memoryReading() {
  const totalGb = os.totalmem() / GB;
  let availableGb = os.freemem() / GB;
  let pressure = 'normal';
  if (process.platform === 'darwin') {
    const r = spawnSync('sysctl', ['-n', 'kern.memorystatus_level', 'kern.memorystatus_vm_pressure_level'], { encoding: 'utf8' });
    const [level, press] = (r.stdout ?? '').trim().split('\n').map(Number);
    if (level > 0) availableGb = totalGb * level / 100;
    if (PRESSURE[press]) pressure = PRESSURE[press];
  } else if (process.platform === 'linux') {
    const m = /^MemAvailable:\s+(\d+) kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    if (m) availableGb = Number(m[1]) * 1024 / GB;
  }
  if (process.env.RUNLIST_MODEL_AVAILABLE_GB) availableGb = Number(process.env.RUNLIST_MODEL_AVAILABLE_GB);
  if (process.env.RUNLIST_MODEL_PRESSURE) pressure = process.env.RUNLIST_MODEL_PRESSURE;
  return { totalGb, availableGb, pressure };
}

export function isLocalEndpoint(endpoint) {
  try {
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(endpoint).hostname);
  } catch { return true; }
}

export function settingsFile() {
  return process.env.RUNLIST_MODEL_SETTINGS || path.join(os.homedir(), '.runlist', 'model.json');
}

export function measurementsFile() {
  return path.join(path.dirname(settingsFile()), 'model-measurements.json');
}

export function readMeasurements() {
  const file = measurementsFile();
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
}

const peakOf = (name, measured = readMeasurements()) => measured[name]?.peakGb ?? null;

function readSettingsFile() {
  const file = settingsFile();
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, 'utf8')) ?? {}; } catch { return {}; }
}

export function writeSettings(patch) {
  const file = settingsFile();
  const next = { ...readSettingsFile(), ...patch };
  for (const [k, v] of Object.entries(next)) if (v === null) delete next[k];
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function modelSettings(overrides = {}) {
  const s = { ...DEFAULTS, ...readSettingsFile() };
  if (process.env.RUNLIST_MODEL_ENDPOINT) s.endpoint = process.env.RUNLIST_MODEL_ENDPOINT;
  if (process.env.RUNLIST_MODEL) s.model = process.env.RUNLIST_MODEL;
  if (process.env.RUNLIST_MODEL_CAP_GB) s.capGb = Number(process.env.RUNLIST_MODEL_CAP_GB);
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined && v !== null) s[k] = v;
  s.endpoint = String(s.endpoint).replace(/\/+$/, '');
  s.capSource = Number(s.capGb) > 0 ? 'set' : 'machine';
  s.capGb = Number(s.capGb) > 0 ? Number(s.capGb) : autoCapGb();
  return s;
}

// The named model, or the first measured candidate that fits the cap. A
// candidate not yet measured is never picked on its own.
export function pickModel(settings) {
  if (settings.model) return { name: settings.model, why: 'named' };
  const measured = readMeasurements();
  const fit = CANDIDATES.find(name => peakOf(name, measured) !== null && peakOf(name, measured) <= settings.capGb);
  if (fit) return { name: fit, why: `measured here at ${peakOf(fit, measured)} GB, under the ${settings.capGb} GB cap` };
  return { name: null, why: `no measured model fits the ${settings.capGb} GB cap${settings.capSource === 'machine' ? ' this machine allows' : ''}` };
}

const FAILED = Object.freeze({ ok: false, status: 0, json: null, error: 'request process failed' });

// Sends the requests in order from one child process and returns their results.
export function requests(list) {
  const total = list.reduce((sum, r) => sum + (r.timeoutMs ?? 10000), 0);
  const result = spawnSync(process.execPath, [REQUEST], {
    input: JSON.stringify(list),
    encoding: 'utf8',
    timeout: total + 10000,
  });
  if (result.status !== 0 || !result.stdout) return list.map(() => FAILED);
  try { return JSON.parse(result.stdout); } catch { return list.map(() => FAILED); }
}

export function request(url, { method = 'GET', body, timeoutMs = 10000 } = {}) {
  return requests([{ url, method, body, timeoutMs }])[0];
}

export function serverVersion(settings) {
  const res = settings.runtime === 'ollama'
    ? request(`${settings.endpoint}/api/version`, { timeoutMs: 5000 })
    : request(`${settings.endpoint}/v1/models`, { timeoutMs: 5000 });
  if (!res.ok) return null;
  return res.json?.version ?? 'up';
}

export function loadedModels(settings) {
  if (settings.runtime !== 'ollama') return [];
  const res = request(`${settings.endpoint}/api/ps`, { timeoutMs: 5000 });
  return res.ok ? (res.json?.models ?? []).map(m => ({ name: m.name, bytes: m.size, expiresAt: m.expires_at })) : [];
}

export function pulledModels(settings) {
  if (settings.runtime !== 'ollama') return null;
  const res = request(`${settings.endpoint}/api/tags`, { timeoutMs: 5000 });
  return res.ok ? (res.json?.models ?? []).map(m => ({ name: m.name, bytes: m.size })) : null;
}

// Why a model cannot load on this machine right now, or null when it can.
export function roomRefusal(name, needGb, settings, reading = memoryReading()) {
  if (reading.pressure !== 'normal') return `Memory pressure is ${reading.pressure}; ${name} was not loaded.`;
  const want = needGb + settings.headroomGb;
  if (reading.availableGb < want) {
    return `${name} needs about ${want.toFixed(1)} GB free with headroom and ${reading.availableGb.toFixed(1)} GB is; it was not loaded.`;
  }
  return null;
}

const sameModel = (a, b) => a === b || a === `${b}:latest` || b === `${a}:latest`;

const warned = new Set();
// A model that passed the server, pull and cap checks once is not re-checked
// for every document in the same run.
const ready = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  warn(message);
}

// The last request's timing and footprint, for `runlist model` and measurement.
export let lastRun = null;

// Sends one chat request and returns the reply text, or null with one warning
// saying why. Callers treat null as "no model available" and carry on.
export function generate(messages, opts = {}) {
  const settings = modelSettings({ model: opts.model });
  const { name } = pickModel(settings);
  if (!name) {
    const hint = settings.capSource === 'machine'
      ? 'Model features are off on this machine; a server on another machine can be named with RUNLIST_MODEL_ENDPOINT.'
      : '`runlist model use <name>` names one.';
    warnOnce('no-model', `No local model: ${pickModel(settings).why}. ${hint}`);
    return null;
  }

  const readyKey = `${settings.endpoint} ${name} ${settings.capGb}`;
  if (!ready.has(readyKey)) {
    const [up, tags, ps] = settings.runtime === 'ollama'
      ? requests(['version', 'tags', 'ps'].map(p => ({ url: `${settings.endpoint}/api/${p}`, timeoutMs: 5000 })))
      : [request(`${settings.endpoint}/v1/models`, { timeoutMs: 5000 }), null, null];
    if (!up.ok) {
      warnOnce('no-server', `The model server is not running at ${settings.endpoint}. \`runlist model start\` starts it.`);
      return null;
    }
    if (settings.runtime === 'ollama') {
      const onDisk = (tags.json?.models ?? []).find(m => sameModel(m.name, name));
      if (!onDisk) { warnOnce(`pull:${name}`, `${name} is not pulled. \`ollama pull ${name}\` downloads it.`); return null; }
      const floorGb = peakOf(name) ?? onDisk.size / GB;
      const local = isLocalEndpoint(settings.endpoint);
      if (local && floorGb > settings.capGb) {
        warnOnce(`cap:${name}`, `${name} needs about ${floorGb.toFixed(1)} GB, over this machine's ${settings.capGb} GB cap. \`runlist model cap <gb>\` raises it.`);
        return null;
      }
      const loaded = (ps.json?.models ?? []).some(m => sameModel(m.name, name));
      const refusal = local && !loaded ? roomRefusal(name, floorGb, settings) : null;
      if (refusal) { warnOnce(`room:${name}`, refusal); return null; }
    }
    ready.add(readyKey);
  }

  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 300000;
  let res;
  let text;
  let resident;
  if (settings.runtime === 'ollama') {
    // The chat and the memory reading after it go in one child process.
    const [chat, ps] = requests([
      {
        url: `${settings.endpoint}/api/chat`,
        method: 'POST',
        timeoutMs,
        body: {
          model: name,
          messages,
          stream: false,
          think: false,
          keep_alive: settings.keepAlive,
          options: { num_ctx: settings.contextTokens, num_predict: opts.maxTokens ?? 200, temperature: 0 },
        },
      },
      { url: `${settings.endpoint}/api/ps`, timeoutMs: 5000 },
    ]);
    res = chat;
    text = chat.json?.message?.content;
    const m = (ps.json?.models ?? []).find(x => sameModel(x.name, name));
    resident = m ? { bytes: m.size } : null;
  } else {
    res = request(`${settings.endpoint}/v1/chat/completions`, {
      method: 'POST',
      timeoutMs,
      body: { model: name, messages, max_tokens: opts.maxTokens ?? 200, temperature: 0 },
    });
    text = res.json?.choices?.[0]?.message?.content;
  }

  if (!res.ok) { warnOnce(`fail:${name}`, `${name} failed: ${res.error}`); return null; }
  lastRun = {
    model: name,
    ms: Date.now() - started,
    residentBytes: resident?.bytes ?? null,
    evalCount: res.json?.eval_count ?? null,
    evalNs: res.json?.eval_duration ?? null,
  };
  if (resident && isLocalEndpoint(settings.endpoint) && resident.bytes / GB > settings.capGb) {
    unload(settings, name);
    warnOnce(`over:${name}`, `${name} took ${(resident.bytes / GB).toFixed(1)} GB, over the ${settings.capGb} GB cap, and was unloaded.`);
  }
  return text?.trim() || null;
}

export function unload(settings, name) {
  if (settings.runtime !== 'ollama') return false;
  return request(`${settings.endpoint}/api/generate`, { method: 'POST', body: { model: name, keep_alive: 0 } }).ok;
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Starts `ollama serve` detached, holding one model and one request at a time.
// Refuses, unless forced, on a machine where no model could run.
export function startServer(settings, { force = false } = {}) {
  if (serverVersion(settings)) return { started: false, already: true };
  if (settings.runtime !== 'ollama') die(`runlist starts only Ollama; start the ${settings.runtime} server at ${settings.endpoint} yourself.`);
  if (!isLocalEndpoint(settings.endpoint)) die(`The model server is on another machine (${settings.endpoint}); start it there.`);
  const pick = pickModel(settings);
  if (!pick.name && !force) die(`Not started: ${pick.why}. Model features stay off on this machine; \`runlist model start --force\` starts the server anyway.`);
  const installed = spawnSync('ollama', ['--version'], { encoding: 'utf8' });
  if (installed.error) die('Ollama is not installed (https://ollama.com). Or point runlist at a server on another machine: RUNLIST_MODEL_ENDPOINT, or "endpoint" in the settings file.');
  const port = new URL(settings.endpoint).port || '11434';
  const child = spawn('ollama', ['serve'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MAX_LOADED_MODELS: '1', OLLAMA_NUM_PARALLEL: '1' },
  });
  child.unref();
  for (let i = 0; i < 40; i++) {
    sleepMs(250);
    if (serverVersion(settings)) return { started: true, pid: child.pid };
  }
  die(`ollama serve did not answer at ${settings.endpoint} within 10 seconds.`);
}

const gb = bytes => `${(bytes / GB).toFixed(1)} GB`;

function statusData(settings) {
  const version = serverVersion(settings);
  const local = isLocalEndpoint(settings.endpoint);
  const reading = local ? memoryReading() : null;
  const pick = pickModel(settings);
  const pulled = version ? pulledModels(settings) : null;
  return {
    runtime: settings.runtime,
    endpoint: settings.endpoint,
    server: version ? { running: true, version } : { running: false },
    model: pick.name,
    why: pick.why,
    pulled: pulled && pick.name ? pulled.some(m => sameModel(m.name, pick.name)) : null,
    capGb: settings.capGb,
    capSource: settings.capSource,
    memory: reading && { totalGb: +reading.totalGb.toFixed(1), availableGb: +reading.availableGb.toFixed(1), pressure: reading.pressure },
    local,
    keepAlive: settings.keepAlive,
    contextTokens: settings.contextTokens,
    loaded: version ? loadedModels(settings) : [],
    candidates: CANDIDATES.map(name => {
      const peakGb = peakOf(name);
      return {
        name,
        peakGb,
        pulled: pulled ? pulled.some(m => sameModel(m.name, name)) : null,
        fits: peakGb !== null ? peakGb <= settings.capGb : null,
      };
    }),
    settingsFile: settingsFile(),
  };
}

function printStatus(d) {
  const out = [];
  out.push(d.server.running
    ? `${bold('Server')}  ${green('running')} (${d.runtime} ${d.server.version}) at ${d.endpoint}`
    : `${bold('Server')}  ${yellow('not running')} at ${d.endpoint}. \`runlist model start\` starts it.`);
  const pulledNote = d.pulled === false ? yellow(` not pulled: \`ollama pull ${d.model}\``) : '';
  out.push(`${bold('Model')}   ${d.model ?? yellow('none')} ${dim(`(${d.why})`)}${pulledNote}`);
  const capWhy = d.capSource === 'set' ? 'set' : 'a quarter of this machine\'s memory, at most 12 GB';
  out.push(`${bold('Cap')}     ${d.capGb} GB ${dim(`(${capWhy}); idle unload ${d.keepAlive}, context ${d.contextTokens} tokens`)}`);
  out.push(d.memory
    ? `${bold('Memory')}  ${d.memory.totalGb} GB total, ${d.memory.availableGb} GB free now, pressure ${d.memory.pressure === 'normal' ? d.memory.pressure : yellow(d.memory.pressure)}`
    : `${bold('Memory')}  ${dim('the server is on another machine; its memory is its own')}`);
  if (d.loaded.length) {
    for (const m of d.loaded) out.push(`${bold('Loaded')}  ${m.name} ${gb(m.bytes)}${m.expiresAt ? dim(`, unloads ${new Date(m.expiresAt).toLocaleTimeString()}`) : ''}`);
  } else if (d.server.running) {
    out.push(`${bold('Loaded')}  nothing`);
  }
  out.push('', bold('Candidates'));
  for (const c of d.candidates) {
    const peak = c.peakGb !== null ? `${c.peakGb} GB peak here` : 'not measured here';
    const fits = c.fits === null ? '' : c.fits ? '' : yellow(' over the cap');
    const pulled = c.pulled === null ? '' : c.pulled ? '' : dim(' not pulled');
    out.push(`  ${c.name}  ${dim(peak)}${fits}${pulled}`);
  }
  out.push('', dim(`Settings: ${d.settingsFile}`));
  process.stdout.write(`${out.join('\n')}\n`);
}

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// The documents a measurement summarises: the largest few in the corpus, so
// the reading is taken on real text of the size the features will see.
async function measureDocs(config, count = 3) {
  const { buildIndex } = await import('./index.mjs');
  const { extractFrontmatter } = await import('./frontmatter.mjs');
  return buildIndex(config).docs
    .filter(d => !d.path.includes('/archived/'))
    .map(d => ({ doc: d, body: extractFrontmatter(readFileSync(path.resolve(config.repoRoot, d.path), 'utf8')).body ?? '' }))
    .sort((a, b) => b.body.length - a.body.length)
    .slice(0, count);
}

function reniceServer() {
  const r = spawnSync('pgrep', ['-x', 'ollama'], { encoding: 'utf8' });
  const pids = (r.stdout ?? '').trim().split('\n').filter(Boolean).map(Number);
  for (const pid of pids) { try { os.setPriority(pid, 10); } catch { /* not ours to renice */ } }
  return pids.length;
}

// Loads each named (or pulled) candidate in turn, summarises the largest
// documents, records the peak memory and speed on this machine, and unloads it.
// Skips any model the memory free right now cannot hold.
async function measure(names, settings, config) {
  if (settings.runtime !== 'ollama') die('`runlist model measure` reads memory from Ollama; it cannot measure another runtime.');
  if (!isLocalEndpoint(settings.endpoint)) die('Measure on the machine that runs the server; its memory is what is recorded.');
  if (!serverVersion(settings)) die('The model server is not running. `runlist model start --force` starts it for a measurement.');
  const pulled = pulledModels(settings) ?? [];
  const targets = names.length ? names : CANDIDATES.filter(n => pulled.some(m => sameModel(m.name, n)));
  if (!targets.length) die(`None of the candidates is pulled: ${CANDIDATES.map(n => `\`ollama pull ${n}\``).join(', ')}.`);
  const docs = await measureDocs(config);
  if (!docs.length) die('No documents to summarise in this corpus.');
  const { summarizeDocBody } = await import('./ai.mjs');
  const reniced = reniceServer();
  process.stderr.write(dim(`Measuring on ${docs.length} documents; ${reniced ? 'the server runs at lower priority' : 'could not lower the server\'s priority'}.\n`));

  const results = readMeasurements();
  let recorded = 0;
  for (const name of targets) {
    const onDisk = pulled.find(m => sameModel(m.name, name));
    if (!onDisk) { process.stdout.write(`${name}: not pulled, skipped.\n`); continue; }
    for (const m of loadedModels(settings)) if (CANDIDATES.some(c => sameModel(m.name, c))) unload(settings, m.name);
    const refusal = roomRefusal(name, onDisk.bytes / GB, settings);
    if (refusal) { process.stdout.write(`${name}: skipped. ${refusal}\n`); continue; }

    const runs = [];
    let peak = 0;
    for (const { doc, body } of docs) {
      const summary = summarizeDocBody(body, { title: doc.title ?? doc.path, status: doc.status }, { model: name, maxTokens: 120 });
      if (!summary || !lastRun) break;
      runs.push({ ms: lastRun.ms, tokensPerSec: lastRun.evalNs ? lastRun.evalCount / (lastRun.evalNs / 1e9) : null });
      peak = Math.max(peak, lastRun.residentBytes ?? 0);
    }
    unload(settings, name);
    if (runs.length < docs.length) { process.stdout.write(`${name}: stopped after ${runs.length} of ${docs.length} documents; nothing recorded.\n`); continue; }

    results[name] = {
      peakGb: +(peak / GB).toFixed(2),
      contextTokens: settings.contextTokens,
      firstMs: runs[0].ms,
      medianMs: median(runs.slice(1).map(r => r.ms)) ?? runs[0].ms,
      tokensPerSec: runs.every(r => r.tokensPerSec) ? +median(runs.map(r => r.tokensPerSec)).toFixed(1) : null,
      documents: docs.length,
      server: serverVersion(settings),
      measuredAt: new Date().toISOString(),
    };
    recorded += 1;
    mkdirSync(path.dirname(measurementsFile()), { recursive: true });
    writeFileSync(measurementsFile(), `${JSON.stringify(results, null, 2)}\n`);
    const r = results[name];
    process.stdout.write(`${name}: ${r.peakGb} GB peak, first ${(r.firstMs / 1000).toFixed(1)}s (load included), then ${(r.medianMs / 1000).toFixed(1)}s per summary${r.tokensPerSec ? `, ${r.tokensPerSec} tokens/s` : ''}.\n`);
  }
  if (recorded) process.stdout.write(dim(`Recorded in ${measurementsFile()}.\n`));
}

export async function runModel(argv, config) {
  const json = argv.includes('--json');
  const [sub = 'status', arg, ...more] = argv.filter(a => !a.startsWith('--'));
  const settings = modelSettings();

  if (sub === 'status') {
    const d = statusData(settings);
    if (json) process.stdout.write(`${JSON.stringify(d, null, 2)}\n`);
    else printStatus(d);
    return;
  }
  if (sub === 'start') {
    const r = startServer(settings, { force: argv.includes('--force') });
    process.stdout.write(r.already
      ? `The model server is already running at ${settings.endpoint}.\n`
      : `Started ollama serve (pid ${r.pid}) at ${settings.endpoint}. Nothing is loaded until a model command runs.\n`);
    return;
  }
  if (sub === 'stop') {
    if (settings.runtime !== 'ollama') die(`runlist can unload only from Ollama; stop the ${settings.runtime} server yourself.`);
    if (!serverVersion(settings)) { process.stdout.write('The model server is not running; nothing is loaded.\n'); return; }
    const loaded = loadedModels(settings);
    const name = pickModel(settings).name;
    const targets = argv.includes('--all') ? loaded : loaded.filter(m => sameModel(m.name, name));
    if (!targets.length) { process.stdout.write(`Nothing of runlist's is loaded${loaded.length ? ` (${loaded.map(m => m.name).join(', ')} loaded by others; --all unloads them)` : ''}.\n`); return; }
    for (const m of targets) {
      unload(settings, m.name);
      process.stdout.write(`Unloaded ${m.name}, ${gb(m.bytes)} freed.\n`);
    }
    return;
  }
  if (sub === 'measure') {
    await measure([arg, ...more].filter(Boolean), settings, config);
    return;
  }
  if (sub === 'use') {
    if (!arg) die('Usage: runlist model use <name>   (`runlist model use auto` goes back to the first candidate under the cap)');
    const next = writeSettings({ model: arg === 'auto' ? null : arg });
    process.stdout.write(`Model: ${next.model ?? 'auto'}. Written to ${settingsFile()}.\n`);
    return;
  }
  if (sub === 'cap') {
    if (arg === 'auto') {
      writeSettings({ capGb: null });
      process.stdout.write(`Cap: ${autoCapGb()} GB, from this machine's memory. Written to ${settingsFile()}.\n`);
      return;
    }
    const n = Number(arg);
    if (!(n > 0)) die('Usage: runlist model cap <gb|auto>');
    writeSettings({ capGb: n });
    process.stdout.write(`Cap: ${n} GB. Written to ${settingsFile()}.\n`);
    return;
  }
  die(`Unknown: runlist model ${sub}. Use status, start, stop, measure, use <name> or cap <gb>.`);
}
