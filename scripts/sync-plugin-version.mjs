// Sync the plugin manifests' version to package.json's version.
//
// Run from the `version` npm lifecycle (after npm bumps package.json, before
// the version commit) so the plugin ships in lockstep with the CLI. Claude Code
// keys its plugin cache on the version field, so without this bump a release's
// plugin changes (new commands, edited SKILL.md / hooks.json) would never reach
// installed users — `/plugin update` skips same-version copies. Keeping the
// versions equal means "release the CLI" also means "release the plugin."
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

// Targets: each file + a function that rewrites its version in place.
const targets = [
  {
    file: path.join(root, 'plugins', 'dotmd', '.claude-plugin', 'plugin.json'),
    set: (j) => { j.version = version; },
  },
  {
    file: path.join(root, '.claude-plugin', 'marketplace.json'),
    set: (j) => { if (j.plugins?.[0]) j.plugins[0].version = version; },
  },
];

for (const { file, set } of targets) {
  let json;
  try { json = JSON.parse(readFileSync(file, 'utf8')); }
  catch { continue; } // missing/unparseable — skip, never break a release
  set(json);
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n', 'utf8');
  process.stdout.write(`synced ${path.relative(root, file)} → ${version}\n`);
}
