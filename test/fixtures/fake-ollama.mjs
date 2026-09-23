// A stand-in Ollama server for the model tests. Answers the five endpoints
// runlist uses and appends every request it sees to FAKE_OLLAMA_LOG.
import http from 'node:http';
import { appendFileSync } from 'node:fs';

const pulled = JSON.parse(process.env.FAKE_OLLAMA_PULLED ?? '[]');
const residentBytes = Number(process.env.FAKE_OLLAMA_RESIDENT ?? 0);
let loaded = [];

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    const json = body ? JSON.parse(body) : null;
    appendFileSync(process.env.FAKE_OLLAMA_LOG, `${JSON.stringify({ path: req.url, body: json })}\n`);
    const send = obj => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj)); };
    if (req.url === '/api/version') return send({ version: '0.0.0-fake' });
    if (req.url === '/api/tags') return send({ models: pulled });
    if (req.url === '/api/ps') return send({ models: loaded });
    if (req.url === '/api/chat') {
      loaded = [{ name: json.model, size: residentBytes, expires_at: '2030-01-01T00:00:00Z' }];
      return send({ message: { role: 'assistant', content: `**reply** from ${json.model}` }, eval_count: 7 });
    }
    if (req.url === '/api/generate' && json.keep_alive === 0) {
      loaded = loaded.filter(m => m.name !== json.model);
      return send({ done: true });
    }
    res.statusCode = 404;
    send({ error: 'not found' });
  });
});

server.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`));
