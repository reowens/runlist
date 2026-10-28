import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertSnapshotCurrent, replaceSnapshot, snapshotFile } from './atomic-mutation.mjs';
import { renderPromptTrackingSetting } from './config-setting.mjs';

const KEY = 'promptTracking';
const VALUES = ['untracked', 'tracked', 'local'];
const USAGE = 'Usage: runlist config show [--json] | get promptTracking [--json] | set promptTracking <untracked|tracked|local> [--json]';

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
  if (action !== 'show' && key !== KEY) throw new Error(`Unsupported config key '${key}'. Supported setting: ${KEY}.`);
  const configPath = config.configPath ?? null;
  const setting = { key: KEY, value: config.promptTracking, source: config.promptTrackingSource, configPath };
  let result;
  if (action === 'show') {
    result = { supportedSettings: [KEY], settings: { [KEY]: { value: setting.value, source: setting.source } }, configPath };
  } else if (action === 'get') {
    result = { supportedSettings: [KEY], ...setting };
  } else {
    if (!VALUES.includes(value)) throw new Error("promptTracking must be 'untracked', 'tracked', or 'local'.");
    if (!configPath || !config.configFound || !existsSync(configPath)) throw new Error('No project config found. Run runlist init before config set.');
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
    out.write(`Supported setting: ${KEY}\n`);
    if (action === 'set') out.write(`${dryRun ? '[dry-run] Would set' : changedLabel(result.changed)} ${KEY} = ${value}\n`);
    out.write(`Effective value${action === 'set' && dryRun ? ' after proposed change' : ''}: ${action === 'set' ? value : setting.value}\n`);
    out.write(`Source: ${action === 'set' ? 'config' : setting.source}\nConfig path: ${configPath ?? '(none; run runlist init to create one)'}\n`);
    if ((action === 'set' ? value : setting.value) === 'untracked') out.write('Leave pending prompts untracked to reduce commit churn. git add -A can still stage them.\n');
  }
  return result;
}

function changedLabel(changed) { return changed ? 'Set' : 'Already set'; }
