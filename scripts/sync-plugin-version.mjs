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

function manifestTargets(projectRoot, version) {
  return [
  {
    file: path.join(projectRoot, 'plugins', 'dotmd', '.claude-plugin', 'plugin.json'),
    validate: (j) => j && !Array.isArray(j) && j.name === 'dotmd' && typeof j.version === 'string',
    set: (j) => { j.version = version; },
  },
  {
    file: path.join(projectRoot, '.claude-plugin', 'marketplace.json'),
    validate: (j) => j && !Array.isArray(j) && Array.isArray(j.plugins)
      && j.plugins[0]?.name === 'dotmd' && typeof j.plugins[0]?.version === 'string',
    set: (j) => { j.plugins[0].version = version; },
  },
  ];
}

export function preparePluginVersionUpdates(projectRoot = root) {
  const version = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
  return manifestTargets(projectRoot, version).map(target => {
    let json;
    try {
      json = JSON.parse(readFileSync(target.file, 'utf8'));
    } catch (err) {
      throw new Error(`Cannot sync plugin version in ${path.relative(projectRoot, target.file)}: ${err.message}`);
    }
    if (!target.validate(json)) {
      throw new Error(`Cannot sync plugin version in ${path.relative(projectRoot, target.file)}: invalid dotmd plugin manifest shape`);
    }
    target.set(json);
    return { file: target.file, content: JSON.stringify(json, null, 2) + '\n' };
  });
}

export function validatePluginManifests(projectRoot = root) {
  preparePluginVersionUpdates(projectRoot);
}

export function syncPluginVersions(projectRoot = root, opts = {}) {
  const version = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
  const prepared = preparePluginVersionUpdates(projectRoot);
  const write = opts.writeFile ?? writeFileSync;

  for (const { file, content } of prepared) {
    write(file, content, 'utf8');
    process.stdout.write(`synced ${path.relative(projectRoot, file)} → ${version}\n`);
  }
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  syncPluginVersions();
}
