// HTTP requests to the local model server, run as a child process so the
// synchronous callers (summaries, lint's status inference) can wait on them
// without every render path turning async. Reads a list of
// {url, method, body, timeoutMs} as JSON on stdin, sends them in order, and
// writes the list of {ok, status, json, error} as JSON on stdout.

const input = JSON.parse(await new Promise(resolve => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { data += chunk; });
  process.stdin.on('end', () => resolve(data));
}));

async function send(input) {
  try {
    const res = await fetch(input.url, {
      method: input.method ?? 'GET',
      headers: input.body ? { 'content-type': 'application/json' } : undefined,
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: AbortSignal.timeout(input.timeoutMs ?? 10000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body; status says enough */ }
  return { ok: res.ok, status: res.status, json, error: res.ok ? null : (json?.error ?? text.slice(0, 200)) };
  } catch (err) {
    return { ok: false, status: 0, json: null, error: err.name === 'TimeoutError' ? 'timed out' : (err.cause?.code ?? err.message) };
  }
}

const out = [];
for (const req of [input].flat()) out.push(await send(req));
process.stdout.write(JSON.stringify(Array.isArray(input) ? out : out[0]));
