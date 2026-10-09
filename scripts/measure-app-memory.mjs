// Read-only workload: no document, journal, draft, or lifecycle mutations.
// node [--expose-gc] scripts/measure-app-memory.mjs /path/to/checkout [cycles]
import { resolveConfig } from '../src/config.mjs';
import { startApp } from '../src/app.mjs';
import { getHeapSpaceStatistics } from 'node:v8';

const config = await resolveConfig(process.argv[2] ?? process.cwd());
const cycles = Math.max(1, Math.min(20, Number(process.argv[3]) || 3));
const sample = stage => console.log(JSON.stringify({ stage, pid: process.pid,
  ...Object.fromEntries(Object.entries(process.memoryUsage()).map(([key, bytes]) => [key, Math.round(bytes / 1024 / 1024 * 10) / 10])),
  heapSpaces: Object.fromEntries(getHeapSpaceStatistics().map(space => [space.space_name, Math.round(space.space_used_size / 1024 / 1024 * 10) / 10])) }));
const app = await startApp({ config, port: 0 });
try {
  sample('startup');
  const token = new URLSearchParams(new URL(app.launchUrl).hash.slice(1)).get('connect');
  const session = await fetch(app.origin + '/api/session', { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const get = async route => {
    const start = performance.now(), response = await fetch(app.origin + '/api/' + route, { headers: { Cookie: cookie } });
    const body = await response.json();
    if (!response.ok) throw new Error(`${response.status}: ${body.code}`);
    console.log(JSON.stringify({ route, elapsedMs: Math.round(performance.now() - start), total: body.total, counts: body.counts }));
    return body;
  };
  await get('library'); sample('library');
  let decisions;
  for (let i = 0; i < cycles; i++) {
    await get('records?kind=flags&refresh=1');
    decisions = await get('records?kind=decisions&status=');
    sample(`records-${i + 1}`);
  }
  if (decisions.records[0]) await get('records?' + new URLSearchParams({ kind: 'decisions', key: decisions.records[0].key }));
  sample('detail');
  if (global.gc) { global.gc(); sample('collected'); }
  await new Promise(resolve => setTimeout(resolve, 5_000)); sample('idle');
} finally { await app.close(); }
