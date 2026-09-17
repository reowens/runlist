import { describe, it } from 'node:test';
import { deepStrictEqual } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// package.json promises Node >=20, but development happens on newer Node, where
// these APIs work and nothing local notices. Node 20 throws on them at runtime
// (iterator helpers took down `doctor` and `fix-membership` on the Node 20 CI
// leg). Scan the shipped sources so the next one fails here, on every Node.
const root = path.resolve(import.meta.dirname, '..');
const SHIPPED = ['src', 'bin', 'scripts', 'assets'];
const NODE_22_ONLY = [
  [/\.(?:values|keys|entries)\(\)\s*\.(?:map|filter|flatMap|reduce|toArray|forEach|some|every|find|take|drop)\(/, 'iterator helpers (Node 22)'],
  [/\bIterator\.from\(/, 'Iterator.from (Node 22)'],
  [/\b(?:Object|Map)\.groupBy\(/, 'groupBy (Node 21)'],
  [/\bPromise\.withResolvers\(/, 'Promise.withResolvers (Node 22)'],
  [/\bArray\.fromAsync\(/, 'Array.fromAsync (Node 22)'],
  [/\.(?:union|intersection|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/, 'Set methods (Node 22)'],
];

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(?:mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

describe('Node 20 compatibility', () => {
  it('shipped sources use no API newer than Node 20', () => {
    const hits = [];
    for (const dir of SHIPPED) {
      for (const file of sourceFiles(path.join(root, dir))) {
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          for (const [pattern, label] of NODE_22_ONLY) {
            if (pattern.test(line)) hits.push(`${path.relative(root, file)}:${i + 1} ${label}`);
          }
        });
      }
    }
    deepStrictEqual(hits, []);
  });
});
