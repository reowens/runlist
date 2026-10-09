import {createCheckoutService,localActor,appError} from './app-service.mjs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SourceEditError } from './source-editor.mjs';
import { resolveDocArg } from './index.mjs';

const assets = new URL('../assets/app/', import.meta.url);
const ttl = 12 * 60 * 60 * 1000;
const secret = () => randomBytes(32).toString('base64url');
function problem(code,message) { throw new SourceEditError(code,message); }
function relative(filePath,config) { return path.relative(config.repoRoot,filePath).split(path.sep).join('/'); }
async function bodyJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) problem('invalid-request', 'Use a JSON request body.');
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 32 * 1024 * 1024) problem('invalid-request', 'Request is too large.'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object'); return value; }
  catch { problem('invalid-request', 'Invalid JSON request body.'); }
}

export async function startApp({ config, port = 5173, initialPath = null, actor = localActor() }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) problem('invalid-port', 'Port must be an integer from 0 to 65535.');
  if (actor.kind !== 'human' || !actor.id) problem('unauthenticated', 'The local application runs as an explicitly identified human.');
  const capability = secret(), sessions = new Map();
  let origin, cookieName;
  function session(req) {
    const cookie = (req.headers.cookie ?? '').split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const value = sessions.get(cookie);
    if (!value || value.expires < Date.now()) { sessions.delete(cookie); problem('unauthenticated', 'Open the access link printed by runlist app to connect.'); }
    return value;
  }
  const service=createCheckoutService({config,initialPath,actor,authenticate:req=>session(req).actor});
  const server = createServer(async (req, res) => {
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      res.end(type.startsWith('application/json') ? JSON.stringify(value) : value);
    };
    try {
      if (!origin || ![new URL(origin).host, `localhost:${server.address().port}`].includes(req.headers.host)) problem('forbidden', 'Invalid local application host.');
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/') return send(200, readFileSync(new URL('index.html', assets)), 'text/html; charset=utf-8');
      const staticFiles = { '/document-create.mjs':['document-create.mjs','text/javascript'], '/quick-navigation.mjs':['quick-navigation.mjs','text/javascript'], '/recovery-center.mjs':['recovery-center.mjs','text/javascript'], '/transport.mjs':['transport.mjs','text/javascript'], '/settings.mjs':['settings.mjs','text/javascript'], '/document-lifecycle.mjs':['document-lifecycle.mjs','text/javascript'], '/record-navigation.mjs':['record-navigation.mjs','text/javascript'], '/theme.mjs':['theme.mjs','text/javascript'], '/library-navigation.mjs':['library-navigation.mjs','text/javascript'], '/outline.mjs':['outline.mjs','text/javascript'], '/editor-navigation.mjs':['editor-navigation.mjs','text/javascript'], '/template-editor.mjs':['template-editor.mjs','text/javascript'], '/block-model.mjs':['block-model.mjs','text/javascript'], '/block-editor.mjs':['block-editor.mjs','text/javascript'], '/app.mjs': ['app.mjs','text/javascript'], '/shared.mjs':['shared.mjs','text/javascript'], '/app.css':['app.css','text/css'] };
      staticFiles['/git-changes.mjs']=['git-changes.mjs','text/javascript'];
      staticFiles['/git-commit.mjs']=['git-commit.mjs','text/javascript'];
      if (req.method === 'GET' && staticFiles[url.pathname]) { const [file, type] = staticFiles[url.pathname]; return send(200, readFileSync(new URL(file, assets)), `${type}; charset=utf-8`); }
      const requestOrigin = req.headers.origin;
      const permittedOrigins = [origin, `http://localhost:${server.address().port}`];
      if (requestOrigin && !permittedOrigins.includes(requestOrigin)) problem('forbidden', 'Cross-origin requests are refused.');
      if (req.method === 'POST' && url.pathname === '/api/session') {
        if (!permittedOrigins.includes(requestOrigin)) problem('forbidden', 'Session connection requires the local application origin.');
        const body = await bodyJson(req);
        if (body.token !== capability) problem('unauthenticated', 'This access link is invalid or belongs to a stopped server.');
        for (const [key, value] of sessions) if (value.expires < Date.now()) sessions.delete(key);
        if (sessions.size >= 100) problem('forbidden', 'Too many browser sessions; restart the local server.');
        const token = secret(), value = { actor: { ...actor }, csrf: secret(), expires: Date.now() + ttl };
        sessions.set(token, value);
        res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ttl / 1000}`);
        return send(200, { actor: value.actor, csrf: value.csrf });
      }
      const authenticated = session(req);
      if (req.method === 'GET' && url.pathname === '/api/session') return send(200, { actor: authenticated.actor, csrf: authenticated.csrf });
      let body;
      if (req.method === 'POST') {
        if (!permittedOrigins.includes(requestOrigin) || req.headers['x-runlist-csrf'] !== authenticated.csrf) problem('forbidden', 'Mutation requires the authenticated session and CSRF token.');
        body=await bodyJson(req);
        if (url.pathname === '/api/logout') { for (const [key,value] of sessions) if (value===authenticated) sessions.delete(key); return send(200,{disconnected:true}); }
      }
      return send(200,await service.request(req,url.pathname+url.search,body));
    } catch (error) {
      const code = error.code || 'request-failed';
      const status = code === 'unauthenticated' ? 401 : code === 'forbidden' ? 403 : /conflict|reused|pending|repair|required|settled/.test(code) ? 409 : 400;
      send(status, appError(error));
    }
  });
  server.on('close',()=>service.close());
  server.requestTimeout = 15_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  cookieName = `runlist_session_${server.address().port}`;
  const launchUrl = `${origin}/#connect=${capability}${initialPath ? `&path=${encodeURIComponent(initialPath)}` : ''}`;
  return { server, origin, launchUrl, close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}

export async function runApp(argv, config, { dryRun = false } = {}) {
  let port = 5173, input = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') { port = Number(argv[++i]); continue; }
    if (!argv[i].startsWith('-')) input = argv[i];
  }
  const initial = input ? resolveDocArg(input, config) : null;
  const initialPath = initial ? relative(initial, config) : null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) problem('invalid-port', 'Use a port between 1 and 65535.');
  if (dryRun) { process.stdout.write(`Would open the plan editor for ${config.repoRoot} on 127.0.0.1:${port}${initialPath ? ` (${initialPath})` : ''}.\n`); return; }
  const app = await startApp({ config, port, initialPath });
  process.stdout.write(`Runlist · ${config.repoRoot}\nOpen this local access link:\n${app.launchUrl}\nSave writes Markdown. Review local commits in Changes; share through Git. Ctrl+C stops the server.\n`);
  await new Promise(resolve => {
    const stop = () => { app.server.close(); app.server.closeIdleConnections(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    app.server.once('close', () => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); resolve(); });
  });
}
