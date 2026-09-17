import { afterEach, describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CLAUDE_MARKETPLACE, CLAUDE_PLUGIN_ID, GENERATED_MARKER, LEGACY_GENERATED_MARKER, degradedIdentityNotice, describeSessionIdentity,
  installOpencodePlugin, installedVersion, opencodeConfigDir, opencodePluginDir,
  opencodeStatus, planClaudeInstall, removeOpencodePlugin, renderOpencodePlugin,
} from '../src/host-integration.mjs';
import { planUpdate } from '../src/update.mjs';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');
let tmp;

function setup() {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'dotmd-host-'));
  return tmp;
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe('opencode config directory resolution', () => {
  it('prefers the explicit override, then XDG, then the default', () => {
    strictEqual(
      opencodeConfigDir({ OPENCODE_CONFIG_DIR: '/opt/oc', XDG_CONFIG_HOME: '/xdg' }, '/home/u'),
      path.resolve('/opt/oc'),
    );
    strictEqual(opencodeConfigDir({ XDG_CONFIG_HOME: '/xdg' }, '/home/u'), path.join('/xdg', 'opencode'));
    strictEqual(opencodeConfigDir({}, '/home/u'), path.join('/home/u', '.config', 'opencode'));
  });

  // Both spellings are auto-discovered by opencode, so adopting the one the
  // user already has avoids leaving two plugin directories side by side.
  it('adopts an existing plugin directory in either spelling, else creates the singular one', () => {
    const home = setup();
    const configDir = path.join(home, '.config', 'opencode');
    strictEqual(opencodePluginDir(configDir), path.join(configDir, 'plugin'));

    mkdirSync(path.join(configDir, 'plugins'), { recursive: true });
    strictEqual(opencodePluginDir(configDir), path.join(configDir, 'plugins'));

    mkdirSync(path.join(configDir, 'plugin'), { recursive: true });
    strictEqual(opencodePluginDir(configDir), path.join(configDir, 'plugin'));
  });
});

describe('opencode plugin install', () => {
  it('installs, reports current, and refreshes on a version bump', () => {
    const dir = path.join(setup(), 'plugin');
    const first = installOpencodePlugin({ version: '1.0.0', dir });
    strictEqual(first.action, 'installed');
    strictEqual(installedVersion(first.path), '1.0.0');
    match(readFileSync(first.path, 'utf8'), /shell\.env/);

    strictEqual(installOpencodePlugin({ version: '1.0.0', dir }).action, 'current');

    const bumped = installOpencodePlugin({ version: '1.1.0', dir });
    strictEqual(bumped.action, 'updated');
    strictEqual(installedVersion(bumped.path), '1.1.0');
  });

  // A dotmd.js without the banner is the user's own file. Same rule the retired
  // slash-command scaffolding followed: dotmd only ever removes what it wrote.
  it('refuses to overwrite or remove an unbannered file unless forced', () => {
    const dir = path.join(setup(), 'plugin');
    mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'dotmd.js');
    writeFileSync(target, 'export default async () => ({})\n');

    const refused = installOpencodePlugin({ version: '1.0.0', dir });
    strictEqual(refused.action, 'refused');
    strictEqual(readFileSync(target, 'utf8'), 'export default async () => ({})\n');

    strictEqual(removeOpencodePlugin({ dir }).action, 'refused');
    ok(existsSync(target));

    // Forced: the file was there, so this is a replacement, not a first write.
    strictEqual(installOpencodePlugin({ version: '1.0.0', dir, force: true }).action, 'updated');
    strictEqual(installedVersion(target), '1.0.0');
  });

  it('removes only what it wrote, and reports absent otherwise', () => {
    const dir = path.join(setup(), 'plugin');
    strictEqual(removeOpencodePlugin({ dir }).action, 'absent');
    installOpencodePlugin({ version: '1.0.0', dir });
    strictEqual(removeOpencodePlugin({ dir }).action, 'removed');
    ok(!existsSync(path.join(dir, 'dotmd.js')));
  });

  it('dry-run reports the action without writing', () => {
    const dir = path.join(setup(), 'plugin');
    strictEqual(installOpencodePlugin({ version: '1.0.0', dir, dryRun: true }).action, 'installed');
    ok(!existsSync(path.join(dir, 'dotmd.js')));
  });

  it('status flags a stale install against the running CLI version', () => {
    const dir = path.join(setup(), 'plugin');
    installOpencodePlugin({ version: '1.0.0', dir });
    strictEqual(opencodeStatus({ version: '1.0.0', dir }).stale, false);
    const stale = opencodeStatus({ version: '2.0.0', dir });
    strictEqual(stale.stale, true);
    strictEqual(stale.version, '1.0.0');
  });
});

describe('opencode files stamped with the legacy dotmd banner', () => {
  // Every install made by dotmd-cli 0.78.0 or earlier carries this banner. It
  // must stay recognizable as generated, or the file turns "foreign" and
  // install, update and remove all refuse to touch it.
  function writeLegacy(dir, version) {
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'dotmd.js');
    const legacy = renderOpencodePlugin(version).replace(GENERATED_MARKER, LEGACY_GENERATED_MARKER);
    writeFileSync(file, legacy);
    return file;
  }

  it('new files carry the runlist banner', () => {
    strictEqual(GENERATED_MARKER, 'runlist-generated:');
    strictEqual(LEGACY_GENERATED_MARKER, 'dotmd-generated:');
    ok(renderOpencodePlugin('1.0.0').startsWith('// runlist-generated:1.0.0\n'));
  });

  it('still parses the version and is not foreign', () => {
    const dir = path.join(setup(), 'plugin');
    const file = writeLegacy(dir, '0.78.0');
    strictEqual(installedVersion(file), '0.78.0');
    const status = opencodeStatus({ version: '0.78.0', dir });
    strictEqual(status.foreign, false);
    strictEqual(status.legacyBanner, true);
    // Same version, old banner: still stale, so the next install restamps it.
    strictEqual(status.stale, true);
  });

  it('install rewrites it in place with the current banner — one file, not two', () => {
    const dir = path.join(setup(), 'plugin');
    const file = writeLegacy(dir, '0.78.0');
    const result = installOpencodePlugin({ version: '0.79.0', dir });
    strictEqual(result.action, 'updated');
    const after = readFileSync(file, 'utf8');
    ok(after.startsWith('// runlist-generated:0.79.0\n'), after.slice(0, 80));
    ok(!after.includes(LEGACY_GENERATED_MARKER));
    deepStrictEqual(readdirSync(dir), ['dotmd.js']);
    strictEqual(opencodeStatus({ version: '0.79.0', dir }).stale, false);
  });

  it('install restamps an old banner even at the same version', () => {
    const dir = path.join(setup(), 'plugin');
    const file = writeLegacy(dir, '0.79.0');
    strictEqual(installOpencodePlugin({ version: '0.79.0', dir }).action, 'updated');
    ok(readFileSync(file, 'utf8').startsWith('// runlist-generated:0.79.0\n'));
  });

  it('update plans a refresh for it', () => {
    const dir = path.join(setup(), 'plugin');
    writeLegacy(dir, '0.78.0');
    const opencode = opencodeStatus({ version: '0.79.0', dir });
    const steps = planUpdate({ cliOnly: false, pluginOnly: false }, { plugin: null, opencode, hasClaude: false, hasNpm: true });
    ok(steps.some(step => step.kind === 'opencode'), JSON.stringify(steps));
  });

  it('remove deletes it without --force', () => {
    const dir = path.join(setup(), 'plugin');
    const file = writeLegacy(dir, '0.78.0');
    strictEqual(removeOpencodePlugin({ dir }).action, 'removed');
    ok(!existsSync(file));
  });

  it('a file with neither banner stays foreign', () => {
    const dir = path.join(setup(), 'plugin');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'dotmd.js'), '// hand-written\nexport default async () => ({});\n');
    strictEqual(opencodeStatus({ version: '0.79.0', dir }).foreign, true);
    strictEqual(installOpencodePlugin({ version: '0.79.0', dir }).action, 'refused');
    strictEqual(removeOpencodePlugin({ dir }).action, 'refused');
  });
});

describe('the generated opencode plugin module', () => {
  // OpenCode calls every export of a plugin module as a plugin factory and
  // throws `Plugin export is not a function` on anything else — so a stray
  // export would not merely be untidy, it would be invoked as a second plugin.
  it('parses as ESM and exports exactly one function, the default', async () => {
    const dir = path.join(setup(), 'plugin');
    const { path: file } = installOpencodePlugin({ version: '9.9.9', dir });
    const mod = await import(pathToFileURL(file).href);
    deepStrictEqual(Object.keys(mod), ['default']);
    strictEqual(typeof mod.default, 'function');
    ok(renderOpencodePlugin('9.9.9').includes(`${GENERATED_MARKER}9.9.9`));
  });

  it('gives every shell the real session id and the session-owning process', async () => {
    const dir = path.join(setup(), 'plugin');
    const { path: file } = installOpencodePlugin({ version: '9.9.9', dir });
    const hooks = await (await import(pathToFileURL(file).href)).default({ directory: tmp });

    const output = { env: {} };
    await hooks['shell.env']({ sessionID: 'ses_abc', cwd: tmp }, output);
    strictEqual(output.env.DOTMD_SESSION_ID, 'opencode:ses_abc');
    strictEqual(output.env.RUNLIST_SESSION_ID, 'opencode:ses_abc');
    // The opencode process hosts the session and outlives the tool shell, so it
    // is what `doctor --claims` probes for liveness.
    strictEqual(output.env.DOTMD_SESSION_PID, String(process.pid));
    strictEqual(output.env.RUNLIST_SESSION_PID, String(process.pid));
  });

  // A rejected hook fails the chat turn opencode is serving, so a malformed
  // call must degrade to "dotmd does nothing", never to a broken session.
  it('never throws out of a hook, whatever it is handed', async () => {
    const dir = path.join(setup(), 'plugin');
    const { path: file } = installOpencodePlugin({ version: '9.9.9', dir });
    const hooks = await (await import(pathToFileURL(file).href)).default({ directory: tmp });

    await hooks['shell.env'](undefined, { env: {} });
    await hooks['shell.env']({}, {});
    await hooks['experimental.chat.system.transform']({}, {});
    await hooks['experimental.chat.system.transform'](undefined, undefined);
  });

  it('primes the system prompt from runlist hud, and stays silent when it says nothing', async () => {
    const home = setup();
    const dir = path.join(home, 'plugin');
    const { path: file } = installOpencodePlugin({ version: '9.9.9', dir });

    // A stand-in `dotmd` on PATH: the plugin shells out to the real CLI, and
    // this keeps the test off whatever version happens to be installed.
    const fakeBin = path.join(home, 'bin');
    mkdirSync(fakeBin, { recursive: true });
    const stub = path.join(fakeBin, 'runlist');
    writeFileSync(stub, '#!/bin/sh\ncat "$DOTMD_TEST_HUD_FILE"\n');
    chmodSync(stub, 0o755);
    const hudFile = path.join(home, 'hud.txt');
    writeFileSync(hudFile, 'dotmd: plans|briefing\n');

    const restore = { PATH: process.env.PATH, DOTMD_TEST_HUD_FILE: process.env.DOTMD_TEST_HUD_FILE };
    process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`;
    process.env.DOTMD_TEST_HUD_FILE = hudFile;
    try {
      const hooks = await (await import(pathToFileURL(file).href)).default({ directory: home });
      const primed = { system: [] };
      await hooks['experimental.chat.system.transform']({ sessionID: 'ses_1' }, primed);
      deepStrictEqual(primed.system, ['dotmd: plans|briefing']);

      // Cached per session — a second turn reuses it rather than re-spawning.
      writeFileSync(hudFile, 'CHANGED\n');
      const again = { system: [] };
      await hooks['experimental.chat.system.transform']({ sessionID: 'ses_1' }, again);
      deepStrictEqual(again.system, ['dotmd: plans|briefing']);

      // A repo with nothing to say (hud is silent outside a dotmd repo) adds
      // no system entry at all.
      writeFileSync(hudFile, '');
      const quiet = { system: [] };
      await hooks['experimental.chat.system.transform']({ sessionID: 'ses_2' }, quiet);
      deepStrictEqual(quiet.system, []);
    } finally {
      process.env.PATH = restore.PATH;
      if (restore.DOTMD_TEST_HUD_FILE === undefined) delete process.env.DOTMD_TEST_HUD_FILE;
      else process.env.DOTMD_TEST_HUD_FILE = restore.DOTMD_TEST_HUD_FILE;
    }
  });
});

describe('the opencode plugin read-prompt warning', () => {
  // A stand-in `runlist` that runs this checkout's CLI, so the plugin talks to
  // the real guard instead of whatever version is installed globally.
  function withRepo(fn) {
    return async () => {
      const home = setup();
      const repo = path.join(home, 'repo');
      mkdirSync(path.join(repo, 'docs', 'prompts', 'archived'), { recursive: true });
      writeFileSync(path.join(repo, 'dotmd.config.mjs'), "export const root = 'docs';\n");
      writeFileSync(path.join(repo, 'docs', 'prompts', 'resume-x.md'), '---\ntype: prompt\nstatus: pending\n---\nbody\n');
      spawnSync('git', ['init', '-q'], { cwd: repo });
      const fakeBin = path.join(home, 'bin');
      mkdirSync(fakeBin, { recursive: true });
      const stub = path.join(fakeBin, 'runlist');
      writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${bin}" "$@"\n`);
      chmodSync(stub, 0o755);
      const { path: file } = installOpencodePlugin({ version: '9.9.9', dir: path.join(home, 'plugin') });
      // The guard logs every warning; keep the test's out of the real log.
      const restore = { PATH: process.env.PATH, logs: process.env.RUNLIST_ERROR_LOG_DIR };
      process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`;
      process.env.RUNLIST_ERROR_LOG_DIR = path.join(home, 'logs');
      try {
        const hooks = await (await import(pathToFileURL(file).href)).default({ directory: repo });
        await fn(hooks, repo);
      } finally {
        process.env.PATH = restore.PATH;
        if (restore.logs === undefined) delete process.env.RUNLIST_ERROR_LOG_DIR;
        else process.env.RUNLIST_ERROR_LOG_DIR = restore.logs;
      }
    };
  }

  const after = async (hooks, tool, args, text = 'file contents') => {
    const output = { title: '', output: text, metadata: {} };
    await hooks['tool.execute.after']({ tool, sessionID: 's', callID: 'c', args }, output);
    return output.output;
  };

  it('appends the guard warning when the read tool opens a pending prompt', withRepo(async (hooks, repo) => {
    const out = await after(hooks, 'read', { filePath: path.join(repo, 'docs', 'prompts', 'resume-x.md') });
    ok(out.startsWith('file contents\n\n[runlist] '), out);
    match(out, /saved runlist prompt/);
    match(out, /runlist use /);
  }));

  it('appends the warning when a shell command cats a pending prompt', withRepo(async (hooks) => {
    const out = await after(hooks, 'bash', { command: 'cat docs/prompts/resume-x.md' });
    match(out, /\[runlist\] .*runlist use docs\/prompts\/resume-x\.md/);
  }));

  it('leaves archived prompts and unrelated reads untouched', withRepo(async (hooks, repo) => {
    strictEqual(await after(hooks, 'read', { filePath: path.join(repo, 'docs', 'prompts', 'archived', 'resume-x.md') }), 'file contents');
    strictEqual(await after(hooks, 'read', { filePath: path.join(repo, 'README.md') }), 'file contents');
    strictEqual(await after(hooks, 'bash', { command: 'ls docs' }), 'file contents');
    strictEqual(await after(hooks, 'edit', { filePath: path.join(repo, 'docs', 'prompts', 'resume-x.md') }), 'file contents');
  }));

  it('never throws, whatever it is handed', async () => {
    const { path: file } = installOpencodePlugin({ version: '9.9.9', dir: path.join(setup(), 'plugin') });
    const hooks = await (await import(pathToFileURL(file).href)).default({ directory: tmp });
    await hooks['tool.execute.after'](undefined, undefined);
    await hooks['tool.execute.after']({ tool: 'read', args: { filePath: 'docs/prompts/a.md' } }, {});
    await hooks['tool.execute.after']({ tool: 'read', args: null }, { output: 'x' });
  });
});

// The plugin source lives outside src/, so a `files` list that forgets it would
// publish a CLI whose `install opencode` throws ENOENT — visible to every npm
// user and to nobody working from a clone. Exactly the "works here, not there"
// shape this integration exists to fix.
describe('packaging', () => {
  it('ships the opencode plugin asset in the npm tarball', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    ok(pkg.files.includes('assets/'), `package.json "files" must include assets/: ${pkg.files.join(', ')}`);
    ok(existsSync(path.join(root, 'assets', 'opencode', 'plugin.js')));
  });
});

describe('session identity reporting', () => {
  const bare = {
    CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', RUNLIST_SESSION_ID: '', DOTMD_SESSION_ID: '',
    OPENCODE_SESSION_ID: '', OPENCODE_SESSION: '', OPENCODE_PID: '', TERM_SESSION_ID: '',
  };

  it('separates a per-session identity from a coarser shared one', () => {
    const home = setup();
    const session = describeSessionIdentity({ env: { ...bare, CLAUDE_CODE_SESSION_ID: 'abc' }, homedir: home });
    strictEqual(session.scope, 'session');
    deepStrictEqual(session.advice, []);

    const shared = describeSessionIdentity({ env: { ...bare, OPENCODE: '1', OPENCODE_PID: '42' }, homedir: home });
    strictEqual(shared.scope, 'process');
    strictEqual(shared.id, 'opencode:42');
    match(shared.summary, /can release each other's plans/);
    match(shared.advice.join(' '), /runlist install opencode/);

    // Codex hands every tool shell its thread id, so it needs no install and
    // no advice — and it must win over a surrounding terminal id.
    const codex = describeSessionIdentity({ env: { ...bare, CODEX_THREAD_ID: 'thr-1', TERM_SESSION_ID: 'w0t0' }, homedir: home });
    strictEqual(codex.scope, 'session');
    strictEqual(codex.host, 'Codex');
    strictEqual(codex.source, 'CODEX_THREAD_ID');
    deepStrictEqual(codex.advice, []);

    // A terminal id is shared by every agent ever run in that window.
    const terminal = describeSessionIdentity({ env: { ...bare, TERM_SESSION_ID: 'w0t0' }, homedir: home });
    strictEqual(terminal.scope, 'terminal');
    ok(terminal.advice.length > 0);
  });

  // The warning marker must not survive with nothing to explain it: once the
  // plugin is installed, a still-coarse shell is one that predates it.
  it('tells an OpenCode shell to restart once the integration is installed', () => {
    const home = setup();
    const dir = path.join(home, '.config', 'opencode', 'plugin');
    installOpencodePlugin({ version: '1.0.0', dir });
    const described = describeSessionIdentity({
      env: { ...bare, OPENCODE: '1', OPENCODE_PID: '42' }, homedir: home, version: '1.0.0',
    });
    match(described.advice.join(' '), /restart OpenCode/);
  });

  it('names the host in the advice when the environment names no session at all', () => {
    const home = setup();
    const none = describeSessionIdentity({ env: { ...bare, OPENCODE: '1' }, homedir: home });
    strictEqual(none.id, null);
    match(none.summary, /fail closed/);
    match(none.advice.join(' '), /runlist install opencode/);
  });
});

// Every other surface has to be sought out. This one comes to the session,
// because the degraded mode is silent: with the OPENCODE_PID fallback the verbs
// all work, they just share an identity.
describe('degraded-identity notice', () => {
  const opencodeEnv = pid => ({
    CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', DOTMD_SESSION_ID: '',
    OPENCODE_SESSION_ID: '', OPENCODE_SESSION: '', TERM_SESSION_ID: '',
    OPENCODE: '1', OPENCODE_PID: String(pid),
  });

  it('fires once per session, then stays quiet', () => {
    const home = setup();
    const opts = { env: opencodeEnv(42), homedir: home };
    match(degradedIdentityNotice(home, opts) ?? '', /runlist install opencode/);
    strictEqual(degradedIdentityNotice(home, opts), null);
    // A different session in the same repo is a different reader.
    match(degradedIdentityNotice(home, { env: opencodeEnv(99), homedir: home }) ?? '', /runlist install opencode/);
  });

  it('says nothing on a host that is not degraded, or when hints are off', () => {
    const home = setup();
    strictEqual(degradedIdentityNotice(home, {
      env: { ...opencodeEnv(42), CLAUDE_CODE_SESSION_ID: 'abc' }, homedir: home,
    }), null);
    // Not under OpenCode at all: the check must cost nothing and say nothing.
    strictEqual(degradedIdentityNotice(home, { env: { TERM_SESSION_ID: 'w0' }, homedir: home }), null);
    strictEqual(degradedIdentityNotice(home, {
      env: { ...opencodeEnv(42), DOTMD_NO_HINTS: '1' }, homedir: home,
    }), null);
  });

  // Once installed, a still-coarse session is one that predates the plugin —
  // saying "install it" there would send the user to fix what is already fixed.
  it('switches to a restart nudge once the integration is installed', () => {
    const home = setup();
    installOpencodePlugin({ version: '1.0.0', dir: path.join(home, '.config', 'opencode', 'plugin') });
    const notice = degradedIdentityNotice(home, { env: opencodeEnv(42), homedir: home, version: '1.0.0' });
    match(notice ?? '', /Restart OpenCode/);
    ok(!/runlist install opencode/.test(notice ?? ''));
  });

  it('can answer without spending the once-per-session budget', () => {
    const home = setup();
    const opts = { env: opencodeEnv(42), homedir: home };
    ok(degradedIdentityNotice(home, { ...opts, record: false }));
    // Still unspent, so the real emission still happens.
    ok(degradedIdentityNotice(home, opts));
  });
});

describe('claude code install planning', () => {
  it('drives marketplace + install on a first install, and skips when present', () => {
    const fresh = planClaudeInstall({ installed: null, hasClaude: true });
    deepStrictEqual(fresh.map(s => s.cmd.join(' ')), [
      `claude plugin marketplace add ${CLAUDE_MARKETPLACE}`,
      `claude plugin install ${CLAUDE_PLUGIN_ID}`,
    ]);

    const present = planClaudeInstall({ installed: { id: CLAUDE_PLUGIN_ID, version: '1.2.3', marketplace: 'dotmd', marketplaceRegistered: true }, hasClaude: true });
    strictEqual(present[0].kind, 'skip');
    match(present[0].reason, /already installed \(1\.2\.3\)/);
  });

  // "Installed" used to mean "has an install record", so a plugin Claude
  // itself listed as failed-to-load was skipped as already installed — and no
  // dotmd verb could repair it.
  it('repairs an install record whose marketplace registration is gone instead of skipping it', () => {
    const broken = { id: CLAUDE_PLUGIN_ID, version: '1.2.3', marketplace: 'dotmd', marketplaceRegistered: false };
    const steps = planClaudeInstall({ installed: broken, hasClaude: true });
    deepStrictEqual(steps.map(s => s.cmd.join(' ')), [
      `claude plugin marketplace add ${CLAUDE_MARKETPLACE}`,
      `claude plugin update ${CLAUDE_PLUGIN_ID}`,
    ]);
    ok(steps.every(s => s.kind === 'run'));
    match(steps[0].reason, /not registered/);

    const manual = planClaudeInstall({ installed: broken, hasClaude: false });
    strictEqual(manual[0].kind, 'manual');
    deepStrictEqual(manual[0].lines, [`/plugin marketplace add ${CLAUDE_MARKETPLACE}`, `/plugin update ${CLAUDE_PLUGIN_ID}`]);
  });

  // Without the claude CLI the work can still be done — from inside a session.
  it('falls back to printable in-session commands when the claude CLI is absent', () => {
    const steps = planClaudeInstall({ installed: null, hasClaude: false });
    strictEqual(steps[0].kind, 'manual');
    deepStrictEqual(steps[0].lines, [
      `/plugin marketplace add ${CLAUDE_MARKETPLACE}`,
      `/plugin install ${CLAUDE_PLUGIN_ID}`,
    ]);
  });

  it('removes only an installed plugin', () => {
    strictEqual(planClaudeInstall({ installed: null, hasClaude: true, remove: true })[0].kind, 'skip');
    const removal = planClaudeInstall({ installed: { id: 'dotmd@dotmd' }, hasClaude: true, remove: true });
    deepStrictEqual(removal[0].cmd, ['claude', 'plugin', 'uninstall', 'dotmd@dotmd']);
  });
});

describe('update keeps the opencode file in lockstep', () => {
  const ctx = { plugin: { id: 'dotmd@dotmd', version: '1.0.0' }, hasClaude: true, hasNpm: true };

  it('refreshes a stale generated file and leaves a foreign one alone', () => {
    const stale = planUpdate({}, { ...ctx, opencode: { exists: true, stale: true, path: '/x/dotmd.js' } });
    ok(stale.some(step => step.kind === 'opencode'));

    const current = planUpdate({}, { ...ctx, opencode: { exists: true, stale: false, path: '/x/dotmd.js' } });
    ok(!current.some(step => step.kind === 'opencode'));

    const foreign = planUpdate({}, { ...ctx, opencode: { exists: true, foreign: true, path: '/x/dotmd.js' } });
    ok(!foreign.some(step => step.kind === 'opencode'));
    match(foreign.find(step => step.kind === 'skip')?.reason ?? '', /not written by runlist/);
  });

  // `update` keeps hosts in step; adopting a new one stays `dotmd install`'s job.
  it('never installs an absent integration', () => {
    const steps = planUpdate({}, { ...ctx, opencode: { exists: false, stale: false, path: '/x/dotmd.js' } });
    ok(!steps.some(step => step.kind === 'opencode'));
  });
});

describe('runlist install command', () => {
  function run(args, env = {}) {
    return spawnSync('node', [bin, 'install', ...args], {
      cwd: tmp, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env },
    });
  }

  it('installs, reports current, and removes through the CLI', () => {
    const dir = path.join(setup(), 'plugin');
    const installed = run(['opencode', '--path', dir]);
    strictEqual(installed.status, 0, installed.stderr);
    match(installed.stdout, /installed opencode integration/);
    ok(existsSync(path.join(dir, 'dotmd.js')));

    match(run(['opencode', '--path', dir]).stdout, /already current/);
    match(run(['opencode', '--path', dir, '--remove']).stdout, /removed/);
    ok(!existsSync(path.join(dir, 'dotmd.js')));
  });

  it('reports status as JSON without a host argument', () => {
    setup();
    const result = run(['--json'], { OPENCODE_CONFIG_DIR: path.join(tmp, 'oc') });
    strictEqual(result.status, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    strictEqual(parsed.hosts.opencode.exists, false);
    ok(parsed.hosts.opencode.path.startsWith(path.join(tmp, 'oc')));
  });

  // The notice has to reach the agent on whatever verb it happens to run, and
  // must not contaminate a --json stdout that a caller is parsing.
  it('warns an unequipped OpenCode session on stderr, once, leaving stdout parseable', () => {
    const home = setup();
    spawnSync('git', ['init', '-q'], { cwd: home });
    mkdirSync(path.join(home, 'docs', 'plans'), { recursive: true });
    writeFileSync(path.join(home, 'dotmd.config.mjs'), "export const root = 'docs';\n");

    const plans = (pid, args = []) => spawnSync('node', [bin, 'plans', ...args, '--config', path.join(home, 'dotmd.config.mjs')], {
      cwd: home,
      encoding: 'utf8',
      env: {
        ...process.env, NO_COLOR: '1',
        CLAUDE_CODE_SESSION_ID: '', CLAUDE_SESSION_ID: '', CODEX_THREAD_ID: '', CODEX_SESSION_ID: '', DOTMD_SESSION_ID: '', TERM_SESSION_ID: '',
        OPENCODE_SESSION_ID: '', OPENCODE_SESSION: '', DOTMD_NO_HINTS: '',
        OPENCODE: '1', OPENCODE_PID: String(pid), OPENCODE_CONFIG_DIR: path.join(home, 'oc'),
      },
    });

    const first = plans(4242);
    match(first.stderr, /runlist install opencode/);
    ok(!first.stdout.includes('runlist install opencode'), 'notice must not reach stdout');

    strictEqual(plans(4242).stderr.includes('runlist install opencode'), false, 'second call in the same session must be quiet');

    const json = plans(777, ['--json']);
    match(json.stderr, /runlist install opencode/);
    JSON.parse(json.stdout); // throws if the notice leaked into stdout
  });

  it('rejects an unknown host instead of guessing', () => {
    setup();
    const result = run(['emacs']);
    ok(result.status !== 0);
    match(result.stderr, /Unknown host/);
  });
});
