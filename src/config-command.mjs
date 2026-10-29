import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertSnapshotCurrent, replaceSnapshot, snapshotFile } from './atomic-mutation.mjs';
import { renderPromptTrackingSetting } from './config-setting.mjs';
import { promptDirectory } from './new.mjs';

const KEY = 'promptTracking';
const VALUES = ['untracked', 'tracked', 'local'];
const READABLE = Object.freeze([KEY, 'mode', 'root', 'docsRoots', 'index.path', 'archiveDir', 'promptDirectory']);
const USAGE = 'Usage: runlist config show [--json] | get <key> [--json] | set promptTracking <untracked|tracked|local> [--json]';

function inspectSettings(config) {
  const source = key => config.settingSources?.[key] ?? 'unknown';
  return {
    promptTracking: { value: config.promptTracking, source: config.promptTrackingSource },
    mode: { value: config.mode ?? 'plans', source: source('mode') },
    root: { value: config.raw?.root ?? '.', source: source('root') },
    docsRoots: { value: config.docsRoots ?? [config.docsRoot], source: 'derived' },
    'index.path': { value: config.indexPath ?? null, source: source('index.path') },
    archiveDir: { value: config.archiveDir, source: source('archiveDir') },
    // Markdown template overrides change content, not routing. Inspect only
    // layout so a broken content template cannot prevent settings inspection.
    promptDirectory: { value: promptDirectory(config, { dir: 'prompts', targetRoot: 'prompts', ...config.raw?.templates?.prompt }), source: 'derived' },
  };
}

function manualSetting(key, configPath) {
  const file = configPath ?? 'runlist.config.mjs (create it with runlist setup)';
  if (key === 'mode') return `A handoffs-only project turns planning on with runlist setup, which previews the change to ${file} first.`;
  if (key === 'root' || key === 'docsRoots') return `Edit the root export in ${file}, review dependent index/template paths, then run runlist init --dry-run and runlist check. A new project can choose --docs-root during setup. Existing files are not moved automatically.`;
  if (key === 'promptDirectory') return `Edit templates.prompt.dir or templates.prompt.targetRoot and the root export in ${file}, then inspect runlist config get promptDirectory. Existing prompts are not moved automatically.`;
  return `Edit ${key === 'index.path' ? 'the index.path property (or legacy readme.path)' : 'the archiveDir export'} in ${file}, then run runlist init --dry-run and runlist check. Existing files are not moved automatically.`;
}

function checkSyntax(content) {
  try {
    execFileSync(process.execPath, ['--input-type=module', '--check'], { input: content, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch {
    throw new Error("Config is not a supported JavaScript module. Edit promptTracking manually in your config; no changes were made.");
  }
}

function assertRegularConfig(configPath, repoRoot) {
  const resolved = path.resolve(configPath);
  // Replacing a symlink would sever it. Refuse symlinked parent paths as well
  // so the loaded source and the publication path cannot silently diverge.
  const boundary = path.resolve(repoRoot);
  for (let cursor = resolved; ; cursor = path.dirname(cursor)) {
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Config path uses a symlink: ${cursor}. Edit the config manually; no changes were made.`);
    if (cursor === boundary || path.dirname(cursor) === cursor) break;
  }
  if (!lstatSync(resolved).isFile()) throw new Error(`Config path is not a regular file: ${resolved}`);
  return realpathSync(resolved);
}

export async function runConfig(argv, config, { dryRun = false, out = process.stdout, testHooks } = {}) {
  if (argv.filter(arg => arg === '--json').length > 1 || argv.some(arg => arg.startsWith('-') && arg !== '--json')) throw new Error(USAGE);
  const json = argv.includes('--json');
  const args = argv.filter(arg => arg !== '--json');
  const [action, key, value] = args;
  if (!['show', 'get', 'set'].includes(action) || args.length !== ({ show: 1, get: 2, set: 3 })[action]) throw new Error(USAGE);
  if (action !== 'show' && !READABLE.includes(key)) throw new Error(`Unsupported config key '${key}'. Readable settings: ${READABLE.join(', ')}. Editable setting: ${KEY}. Edit other exports manually in ${config.configPath ?? 'runlist.config.mjs (create it with runlist setup)'}.`);
  const configPath = config.configPath ?? null;
  if (action === 'set' && key !== KEY) throw new Error(`${key} is read-only in the CLI. ${manualSetting(key, configPath)} No changes were made.`);
  const settings = action === 'set'
    ? { [KEY]: { value: config.promptTracking, source: config.promptTrackingSource } }
    : inspectSettings(config);
  const setting = { key: key ?? KEY, ...settings[key ?? KEY], configPath };
  let result;
  if (action === 'show') {
    result = { supportedSettings: [KEY], readableSettings: READABLE, editableSettings: [KEY], settings, configPath };
  } else if (action === 'get') {
    result = { supportedSettings: [KEY], readableSettings: READABLE, editableSettings: [KEY], ...setting };
  } else {
    if (!VALUES.includes(value)) throw new Error("promptTracking must be 'untracked', 'tracked', or 'local'.");
    if (!configPath || !config.configFound || !existsSync(configPath)) throw new Error('No project config found. Run runlist setup before config set.');
    const file = assertRegularConfig(configPath, config.repoRoot);
    const snapshot = snapshotFile(file);
    checkSyntax(snapshot.content);
    const edit = renderPromptTrackingSetting(snapshot.content, value);
    checkSyntax(edit.content);
    const changed = edit.content !== snapshot.content;
    result = { action, supportedSettings: [KEY], key: KEY, previousValue: edit.previousValue, value, source: 'config', configPath, changed, dryRun };
    if (!dryRun && changed) {
      replaceSnapshot(snapshot, edit.content, {
        repoRoot: config.repoRoot,
        testHooks: {
          ...testHooks,
          beforeReplacePublish(info) {
            testHooks?.beforeReplacePublish?.(info);
            assertRegularConfig(configPath, config.repoRoot);
            assertSnapshotCurrent(snapshot);
          },
        },
      });
    }
  }
  if (json) out.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    out.write(`Editable setting: ${KEY}\n`);
    out.write(`Config path: ${configPath ?? '(none; run runlist setup to create one)'}\n`);
    if (action === 'show') {
      for (const [name, entry] of Object.entries(settings)) out.write(`${name}: ${JSON.stringify(entry.value)} (source: ${entry.source}${name === KEY ? '; editable' : '; read-only'})\n`);
    } else {
      if (action === 'set') out.write(`${dryRun ? '[dry-run] Would set' : changedLabel(result.changed)} ${KEY} = ${value}\n`);
      out.write(`Effective value${action === 'set' && dryRun ? ' after proposed change' : ''}: ${action === 'set' ? value : JSON.stringify(setting.value)}\n`);
      out.write(`Source: ${action === 'set' ? 'config' : setting.source}\n`);
    }
    if ((action === 'show' || key === KEY) && (action === 'set' ? value : settings.promptTracking.value) === 'untracked') out.write('Leave pending prompts untracked to reduce commit churn. git add -A can still stage them.\n');
  }
  return result;
}

function changedLabel(changed) { return changed ? 'Set' : 'Already set'; }
