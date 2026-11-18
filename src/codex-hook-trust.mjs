import { spawn } from 'node:child_process';
import { codexHookDefinitions, codexPaths } from './codex-integration.mjs';

const statuses = new Set(['managed', 'trusted', 'modified', 'untrusted']);

function summarize(result, cwd, paths) {
  const entry = result?.data?.find(item => item.cwd === cwd);
  if (!Array.isArray(entry?.hooks) || !Array.isArray(entry.errors) || entry.errors.length || !Array.isArray(entry.warnings) || entry.warnings.length) {
    throw new Error('Codex returned an incomplete hook inventory');
  }
  const expected = codexHookDefinitions(paths.plugin);
  const hooks = Object.entries(expected).map(([event, definition]) => {
    const eventName = event[0].toLowerCase() + event.slice(1);
    const matches = entry.hooks.filter(hook => hook.source === 'user' && hook.sourcePath === paths.hooksFile
      && hook.eventName === eventName && hook.command === definition.hooks[0].command);
    if (!matches.length) return { event, trust: 'missing' };
    if (matches.length !== 1) return { event, trust: 'unknown' };
    const [hook] = matches;
    return { event, trust: statuses.has(hook.trustStatus) ? hook.trustStatus : 'unknown', enabled: hook.enabled };
  });
  const pluginHooks = entry.hooks.filter(hook => hook.source === 'plugin' && /^runlist-codex(?:@|$)/.test(hook.pluginId ?? ''))
    .map(hook => ({ event: hook.eventName, pluginId: hook.pluginId, trust: statuses.has(hook.trustStatus) ? hook.trustStatus : 'unknown', enabled: hook.enabled }));
  const ready = hooks.every(hook => ['trusted', 'managed'].includes(hook.trust) && hook.enabled === true);
  return { state: ready && !pluginHooks.length ? 'ready' : 'review', hooks, pluginHooks };
}

export function readCodexHookTrust({ binary, cwd = process.cwd(), env = process.env, home, timeout = 3000 }) {
  const unknown = reason => ({ state: 'unknown', reason, hooks: [], pluginHooks: [] });
  if (!binary) return Promise.resolve(unknown('Codex executable unavailable'));
  const paths = codexPaths(home, env);
  return new Promise(resolve => {
    const child = spawn(binary, ['app-server'], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'],
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary) });
    let finished = false, initialized = false, buffer = '', size = 0;
    const timer = setTimeout(() => finish(unknown('Codex hooks/list timed out')), timeout);
    function finish(report) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.destroy();
      child.stdout.destroy();
      child.kill('SIGKILL');
      resolve(report);
    }
    function send(message) { child.stdin.write(JSON.stringify(message) + '\n'); }
    child.on('error', () => finish(unknown('Could not start Codex app-server')));
    child.stdin.on('error', () => finish(unknown('Codex closed the request stream')));
    child.on('close', () => finish(unknown('Codex exited before returning hooks/list')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (finished) return;
      size += Buffer.byteLength(chunk);
      if (size > 4 * 1024 * 1024) return finish(unknown('Codex response exceeded the size limit'));
      buffer += chunk;
      let end;
      try {
        while (!finished && (end = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.id !== (initialized ? 2 : 1)) continue;
          if (msg.error || !msg.result) throw new Error('Codex rejected the hook inventory request');
          if (initialized) finish(summarize(msg.result, cwd, paths));
          else {
            initialized = true;
            send({ method: 'initialized' });
            send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } });
          }
        }
      } catch { finish(unknown('Codex returned an invalid or incomplete hook inventory')); }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'runlist', version: '1' }, capabilities: { experimentalApi: true } } });
  });
}

export function formatCodexHookTrust(report) {
  const lines = [`Codex hook trust: ${report.state}${report.reason ? ' — ' + report.reason : ''}`];
  for (const hook of [...report.hooks, ...report.pluginHooks]) {
    lines.push(`  ${hook.event}${hook.pluginId ? ' (leftover plugin hook: ' + hook.pluginId + ')' : ''}: ${hook.trust}${hook.enabled === false ? ' (disabled)' : ''}`);
  }
  if (report.state !== 'ready') lines.push('Review Runlist hooks in Codex /hooks.');
  return lines.join('\n') + '\n';
}
