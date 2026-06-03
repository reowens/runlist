import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGuard } from '../src/guard.mjs';

const config = { repoRoot: '/repo', docsRoots: ['docs'] };
const notIgnored = { isIgnored: () => false };
const ignored = { isIgnored: () => true };

test('git add of a gitignored prompt is denied', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'git add docs/prompts/resume-foo.md' } },
    config, ignored,
  );
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'commit-prompt');
  assert.match(r.reason, /gitignored/);
  assert.match(r.reason, /dotmd use/);
});

test('git commit of a tracked prompt is still denied (session-local)', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'git commit -m wip docs/prompts/foo.md' } },
    config, notIgnored,
  );
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'commit-prompt');
});

test('cat of a prompt warns and nudges to dotmd use', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'cat docs/prompts/foo.md' } },
    config, notIgnored,
  );
  assert.equal(r.decision, 'warn');
  assert.equal(r.rule, 'cat-prompt');
  assert.match(r.reason, /dotmd use docs\/prompts\/foo\.md/);
});

test('Read tool on a prompt warns', () => {
  const r = evaluateGuard(
    { tool_name: 'Read', tool_input: { file_path: 'docs/prompts/foo.md' } },
    config, notIgnored,
  );
  assert.equal(r.decision, 'warn');
  assert.equal(r.rule, 'read-prompt');
});

test('Edit changing a status: line in a managed doc warns', () => {
  const r = evaluateGuard(
    { tool_name: 'Edit', tool_input: { file_path: 'docs/plans/x.md', new_string: 'status: archived\ntitle: X' } },
    config, notIgnored,
  );
  assert.equal(r.decision, 'warn');
  assert.equal(r.rule, 'edit-status');
  assert.match(r.reason, /dotmd set/);
});

test('Edit not touching status: is ignored', () => {
  const r = evaluateGuard(
    { tool_name: 'Edit', tool_input: { file_path: 'docs/plans/x.md', new_string: '## Some body change' } },
    config, notIgnored,
  );
  assert.equal(r, null);
});

test('normal commands and non-managed files produce no opinion', () => {
  assert.equal(evaluateGuard({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, config, notIgnored), null);
  assert.equal(evaluateGuard({ tool_name: 'Read', tool_input: { file_path: 'src/index.mjs' } }, config, notIgnored), null);
  assert.equal(evaluateGuard({ tool_name: 'Bash', tool_input: { command: 'cat README.md' } }, config, notIgnored), null);
});

test('reading a plan (not a prompt) via cat is allowed', () => {
  // Plans are fine to read directly — only prompts must go through `dotmd use`.
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'cat docs/plans/auth.md' } },
    config, notIgnored,
  );
  assert.equal(r, null);
});

test('DOTMD_GUARD=0 disables all rules', () => {
  const prev = process.env.DOTMD_GUARD;
  process.env.DOTMD_GUARD = '0';
  try {
    const r = evaluateGuard(
      { tool_name: 'Bash', tool_input: { command: 'git add docs/prompts/foo.md' } },
      config, ignored,
    );
    assert.equal(r, null);
  } finally {
    if (prev === undefined) delete process.env.DOTMD_GUARD; else process.env.DOTMD_GUARD = prev;
  }
});

test('git add of a non-prompt path is not denied', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'git add src/foo.mjs' } },
    config, notIgnored,
  );
  assert.equal(r, null);
});
