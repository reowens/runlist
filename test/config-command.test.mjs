import { describe, it, beforeEach, afterEach } from 'node:test';
import { strictEqual, deepStrictEqual, ok, rejects } from 'node:assert';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../src/config.mjs';
import { runConfig } from '../src/config-command.mjs';

let dir;
let file;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'runlist-config-command-'));
  mkdirSync(path.join(dir, '.git'));
  file = path.join(dir, 'runlist.config.mjs');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function invoke(args, opts = {}, config) {
  let output = '';
  const result = await runConfig(args, config ?? await resolveConfig(dir), { ...opts, out: { write(text) { output += text; } } });
  return { output, result };
}

function assertNoTemps(folder = dir) {
  ok(!readdirSync(folder).some(name => name.includes('.runlist-tmp-')), 'no prepared temp leaked');
}

describe('config command reads', () => {
  it('shows the supported setting, default value, source, and missing path', async () => {
    const { output, result } = await invoke(['show']);
    deepStrictEqual(result, { supportedSettings: ['promptTracking'], settings: { promptTracking: { value: 'untracked', source: 'default' } }, configPath: null });
    ok(output.includes('Supported setting: promptTracking'));
    ok(output.includes('Effective value: untracked'));
    ok(output.includes('Source: default'));
    ok(output.includes('Config path: (none;'));
    ok(output.includes('git add -A can still stage them'));
    deepStrictEqual(readdirSync(dir), ['.git'], 'reads create nothing');
  });

  it('gets the legacy effective value and actual config path as JSON', async () => {
    writeFileSync(file, "export const root = '.';\n");
    const { output, result } = await invoke(['get', 'promptTracking', '--json']);
    deepStrictEqual(JSON.parse(output), result);
    strictEqual(result.value, 'local');
    strictEqual(result.source, 'legacy-default');
    strictEqual(result.configPath, file);
    deepStrictEqual(result.supportedSettings, ['promptTracking']);
  });

  it('shows only the supported setting as JSON with an explicit source', async () => {
    writeFileSync(file, "export const promptTracking = 'tracked';\nexport const root = '.';\n");
    const { output } = await invoke(['--json', 'show']);
    deepStrictEqual(JSON.parse(output), { supportedSettings: ['promptTracking'], settings: { promptTracking: { value: 'tracked', source: 'config' } }, configPath: file });
  });

  for (const args of [[], ['other'], ['show', 'promptTracking'], ['get'], ['get', 'root'], ['set', 'root', 'docs'], ['set', 'promptTracking'], ['set', 'promptTracking', 'tracked', 'extra'], ['show', '--all'], ['show', '--json', '--json']]) {
    it(`rejects unsupported arguments ${JSON.stringify(args)}`, async () => {
      await rejects(invoke(args), /Usage:|Unsupported config key/);
      deepStrictEqual(readdirSync(dir), ['.git']);
    });
  }
});

describe('config command edits', () => {
  it('requires init before set, including an explicit nonexistent config path', async () => {
    await rejects(invoke(['set', 'promptTracking', 'tracked']), /runlist init/);
    await rejects(invoke(['set', 'promptTracking', 'tracked'], {}, await resolveConfig(dir, 'missing.mjs')), /runlist init/);
    deepStrictEqual(readdirSync(dir), ['.git']);
  });

  it('appends an absent export without changing hooks, templates, comments, or CRLF bytes', async () => {
    const source = [
      '// export const promptTracking = "tracked";',
      "export const root = '.';",
      'export function onCreate(doc) {',
      '  const pattern = /[{}]/g;',
      '  const demo = `export const promptTracking = "local"; ${doc.name ?? "}"}`;',
      '  return { ...doc, demo: demo.replace(pattern, "") };',
      '}',
      '// keep final comment',
    ].join('\r\n');
    writeFileSync(file, source);
    const { result } = await invoke(['set', 'promptTracking', 'untracked']);
    strictEqual(readFileSync(file, 'utf8'), source + "\r\nexport const promptTracking = 'untracked';\r\n");
    strictEqual(result.previousValue, 'local');
    strictEqual(result.changed, true);
    strictEqual(result.source, 'config');
    assertNoTemps();
  });

  it('replaces only the existing literal and preserves its quote style and comments', async () => {
    const source = '// keep\nexport /*yes*/ const promptTracking /*key*/ = /*value*/ "untracked" /*tail*/;\nexport const root = ".";\nexport const onCreate = x => ({ ...x, title: `hello ${x.title}` });\n';
    writeFileSync(file, source);
    const { output, result } = await invoke(['set', 'promptTracking', 'tracked', '--json']);
    strictEqual(readFileSync(file, 'utf8'), source.replace('"untracked"', '"tracked"'));
    deepStrictEqual(JSON.parse(output), result);
    strictEqual(result.previousValue, 'untracked');
    strictEqual(result.dryRun, false);
    assertNoTemps();
  });

  it('supports a simple semicolonless export before another module declaration', async () => {
    const source = "export const promptTracking = 'local'\nexport const root = '.'\n";
    writeFileSync(file, source);
    await invoke(['set', 'promptTracking', 'tracked']);
    strictEqual(readFileSync(file, 'utf8'), source.replace("'local'", "'tracked'"));
  });

  it('does not rewrite a setting already holding the requested value', async () => {
    writeFileSync(file, "export const promptTracking = 'tracked';\n");
    const before = statSync(file, { bigint: true });
    const { result, output } = await invoke(['set', 'promptTracking', 'tracked']);
    strictEqual(result.changed, false);
    strictEqual(statSync(file, { bigint: true }).ino, before.ino);
    strictEqual(statSync(file, { bigint: true }).mtimeNs, before.mtimeNs);
    ok(output.includes('Already set'));
    ok(!existsSync(path.join(dir, '.runlist')));
  });

  it('dry-run validates and reports the proposed setting without filesystem writes', async () => {
    const source = "export const root = '.';\n";
    writeFileSync(file, source);
    const before = statSync(file, { bigint: true });
    const { result, output } = await invoke(['set', 'promptTracking', 'tracked', '--json'], { dryRun: true });
    deepStrictEqual(JSON.parse(output), result);
    strictEqual(result.dryRun, true);
    strictEqual(result.value, 'tracked');
    strictEqual(result.changed, true);
    strictEqual(readFileSync(file, 'utf8'), source);
    strictEqual(statSync(file, { bigint: true }).mtimeNs, before.mtimeNs);
    deepStrictEqual(readdirSync(dir).sort(), ['.git', 'runlist.config.mjs']);
  });

  it('never creates ignore files and leaves existing Git state and excludes byte-identical', async () => {
    writeFileSync(file, "export const root = '.';\n");
    await invoke(['set', 'promptTracking', 'untracked']);
    ok(!existsSync(path.join(dir, '.gitignore')));
    ok(!existsSync(path.join(dir, '.git', 'info')));
    mkdirSync(path.join(dir, '.git', 'info'));
    const paths = ['.gitignore', '.git/info/exclude', '.git/config', '.git/index'];
    for (const name of paths) writeFileSync(path.join(dir, name), `user-owned ${name}\n`);
    const snapshots = paths.map(name => readFileSync(path.join(dir, name)));
    // Reuse the caller's resolved object: the edit is based on a new source
    // snapshot even when Node has cached the previously loaded module.
    const config = { ...await resolveConfig(dir), promptTracking: 'untracked', promptTrackingSource: 'config' };
    await invoke(['set', 'promptTracking', 'local'], {}, config);
    for (let n = 0; n < paths.length; n++) deepStrictEqual(readFileSync(path.join(dir, paths[n])), snapshots[n]);
  });

  it('preserves the file mode across atomic replacement', async () => {
    writeFileSync(file, "export const root = '.';\n");
    if (process.platform !== 'win32') chmodSync(file, 0o640);
    const before = statSync(file).mode;
    await invoke(['set', 'promptTracking', 'tracked']);
    strictEqual(statSync(file).mode, before);
  });

  for (const source of [
    "export const promptTracking = ['tracked'][0];\n",
    "export const promptTracking = 'track' + 'ed';\n",
    "export const promptTracking = `tracked`;\n",
    "const policy = 'tracked'; export { policy as promptTracking };\n",
    "export { promptTracking } from './policy.mjs';\n",
    "export * from './policy.mjs';\n",
    "export let promptTracking = 'tracked';\n",
    "export const root = '.', promptTracking = 'tracked';\n",
    "export const { promptTracking } = { promptTracking: 'tracked' };\n",
    "export default { promptTracking: 'tracked' };\n",
  ]) {
    it(`refuses unsupported config shape without modifying bytes: ${source.trim()}`, async () => {
      writeFileSync(path.join(dir, 'policy.mjs'), "export const promptTracking = 'tracked';\n");
      writeFileSync(file, source);
      await rejects(invoke(['set', 'promptTracking', 'untracked']), /manual|manually/);
      strictEqual(readFileSync(file, 'utf8'), source);
      ok(!existsSync(path.join(dir, '.runlist')));
      assertNoTemps();
    });
  }

  it('rejects invalid enum values before writing', async () => {
    const source = "export const promptTracking = 'local';\n";
    writeFileSync(file, source);
    await rejects(invoke(['set', 'promptTracking', 'ignored']), /must be 'untracked', 'tracked', or 'local'/);
    strictEqual(readFileSync(file, 'utf8'), source);
  });

  it('checks syntax before appending to a malformed config passed by a caller', async () => {
    const config = await resolveConfig(dir);
    writeFileSync(file, 'export const broken = ;\n');
    await rejects(invoke(['set', 'promptTracking', 'tracked'], {}, { ...config, configPath: file, configFound: true }), /manually/);
    strictEqual(readFileSync(file, 'utf8'), 'export const broken = ;\n');
  });

  it('refuses a symlink config instead of replacing the link or its target', { skip: process.platform === 'win32' }, async () => {
    const target = path.join(dir, 'actual.mjs');
    const source = "export const root = '.';\n";
    writeFileSync(target, source);
    symlinkSync(target, file);
    await rejects(invoke(['set', 'promptTracking', 'tracked']), /symlink.*manually/);
    ok(lstatSync(file).isSymbolicLink());
    strictEqual(readFileSync(target, 'utf8'), source);
  });

  it('refuses a config under a symlinked directory', { skip: process.platform === 'win32' }, async () => {
    const actual = path.join(dir, 'actual');
    const linked = path.join(dir, 'linked');
    mkdirSync(actual);
    const source = "export const root = '.';\n";
    writeFileSync(path.join(actual, 'settings.mjs'), source);
    symlinkSync(actual, linked, 'dir');
    const config = await resolveConfig(dir, path.join(linked, 'settings.mjs'));
    await rejects(invoke(['set', 'promptTracking', 'tracked'], {}, config), /symlink.*manually/);
    strictEqual(readFileSync(path.join(actual, 'settings.mjs'), 'utf8'), source);
  });

  it('supports explicit config paths with spaces and punctuation', async () => {
    const explicit = path.join(dir, 'settings [custom]');
    mkdirSync(explicit);
    const target = path.join(explicit, 'project settings.mjs');
    const source = "export const root = '.';\n";
    writeFileSync(target, source);
    const config = await resolveConfig(dir, target);
    const { result } = await invoke(['set', 'promptTracking', 'tracked'], {}, config);
    strictEqual(result.configPath, target);
    strictEqual(readFileSync(target, 'utf8'), source + "export const promptTracking = 'tracked';\n");
    ok(!existsSync(file));
  });

  it('refuses publication over a concurrent editor change and cleans the temp', async () => {
    writeFileSync(file, "export const root = '.';\n");
    const concurrent = "// newer editor content\nexport const root = '.';\n";
    await rejects(invoke(['set', 'promptTracking', 'tracked'], {
      testHooks: { beforeReplacePublish() { writeFileSync(file, concurrent); } },
    }), error => error.code === 'RUNLIST_MUTATION_CONFLICT');
    strictEqual(readFileSync(file, 'utf8'), concurrent);
    assertNoTemps();
  });
});
