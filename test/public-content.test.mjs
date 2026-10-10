import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectPublicText, inspectPublicFiles } from '../scripts/public-content.mjs';
import { packagePaths } from '../scripts/check-public.mjs';

const fingerprints = new Set([createHash('sha256').update('private-client').digest('hex')]);

test('package inspection covers array and keyed inventories and fails on incomplete output', () => {
  const first = { files: [{ path: 'package.json' }, { path: 'src/example.mjs' }] };
  const second = { files: [{ path: 'src/other.mjs' }] };
  const expected = ['package.json', 'src/example.mjs', 'src/other.mjs'];
  assert.deepEqual(packagePaths([first, second]), expected);
  assert.deepEqual(packagePaths({ example: first, other: second }), expected);
  for (const inventory of [null, [], {}, { example: {} }, [{ files: [] }], [{ files: [{ size: 4 }] }]]) {
    assert.throws(() => packagePaths(inventory), /incomplete package inventory/);
  }
});

test('private vocabulary uses keyed fingerprints without publishing the key', () => {
  const key = 'synthetic-policy-key';
  const keyed = new Set([createHmac('sha256', key).update('private-client').digest('hex')]);
  assert.equal(inspectPublicText('PRIVATE-CLIENT', 'README.md', { fingerprints: keyed, key }).length, 1);
  assert.equal(inspectPublicText('PRIVATE-CLIENT', 'README.md', { fingerprints: keyed, key: 'different-key' }).length, 0);
});

test('public checks cover prose, source comments, filenames and embedded terms without echoing private text', () => {
  for (const text of ['// PRIVATE-CLIENT', 'See docs/private-client.md', 'https://private-client.example/guide']) {
    const findings = inspectPublicText(text, 'src/example.mjs', { fingerprints });
    assert.deepEqual(findings, [{ file: 'src/example.mjs', line: 1, category: 'private vocabulary' }]);
    assert.ok(!JSON.stringify(findings).includes('private-client'));
  }
  assert.equal(inspectPublicText('a generic comment', 'src/example.mjs', { fingerprints }).length, 0);
});

test('personal paths are rejected except neutral usernames in test fixtures', () => {
  assert.equal(inspectPublicText('/Users/example/private', 'README.md').length, 1);
  assert.equal(inspectPublicText('/Users/example/private', 'test/example.test.mjs').length, 0);
  assert.equal(inspectPublicText('/home/' + 'operator/private', 'desktop/test/example.test.mjs').length, 1);
  assert.equal(inspectPublicText('{"email":"maintainer@example.com"}', '.claude-plugin/plugin.json').length, 1);
});

test('private inventories fail even when force-added or included in an npm package', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'runlist-public-check-'));
  try {
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'example.mjs'), '// private-client\n');
    writeFileSync(path.join(root, 'src', 'native'), Buffer.from('\0PRIVATE-CLIENT\0/Users/' + 'operator/build\0'));
    const findings = inspectPublicFiles(root, ['docs/plan.md', '.env.production', 'desktop/releases/evidence.json', 'src/example.mjs'], { fingerprints });
    assert.equal(findings.filter(item => item.category === 'private file in public inventory').length, 3);
    assert.equal(findings.filter(item => item.category === 'private vocabulary').length, 1);
    const binary = inspectPublicFiles(root, ['src/native'], { fingerprints });
    assert.equal(binary.filter(item => item.category === 'private vocabulary').length, 1);
    assert.equal(binary.filter(item => item.category === 'personal absolute path').length, 1);
    assert.throws(() => inspectPublicFiles(root, ['../outside']), /escapes/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
