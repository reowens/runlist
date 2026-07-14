import { describe, it } from 'node:test';
import { ok } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const changelog = readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('changelog continuity', () => {
  it('documents the current package version', () => {
    ok(
      new RegExp(`^## ${pkg.version.replaceAll('.', '\\.')}(?:\\s|$)`, 'm').test(changelog),
      `CHANGELOG.md is missing a heading for package version ${pkg.version}`,
    );
  });

  it('contains every release from 0.62.0 through 0.69.0 in descending order', () => {
    const versions = [
      '0.69.0',
      '0.68.0',
      '0.67.0',
      '0.66.0',
      '0.65.1',
      '0.65.0',
      '0.64.3',
      '0.64.2',
      '0.64.1',
      '0.64.0',
      '0.63.0',
      '0.62.0',
    ];
    let previous = -1;
    for (const version of versions) {
      const index = changelog.indexOf(`## ${version}`);
      ok(index > previous, `CHANGELOG.md is missing or misorders ${version}`);
      previous = index;
    }
  });
});
