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

test('Edit changing a status: line in a managed doc is denied by default', () => {
  const r = evaluateGuard(
    { tool_name: 'Edit', tool_input: { file_path: 'docs/plans/x.md', old_string: 'status: active\ntitle: X', new_string: 'status: archived\ntitle: X' } },
    config, notIgnored,
  );
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'edit-status');
  assert.match(r.reason, /dotmd set/);
});

test('guard.deny: false drops the status-edit rule back to warn', () => {
  const r = evaluateGuard(
    { tool_name: 'Edit', tool_input: { file_path: 'docs/plans/x.md', old_string: 'status: active', new_string: 'status: archived' } },
    { ...config, guard: { deny: false } }, notIgnored,
  );
  assert.equal(r.decision, 'warn');
  assert.equal(r.rule, 'edit-status');
});

test('Edit not touching status: is ignored', () => {
  const r = evaluateGuard(
    { tool_name: 'Edit', tool_input: { file_path: 'docs/plans/x.md', new_string: '## Some body change' } },
    config, notIgnored,
  );
  assert.equal(r, null);
});

test('Edit with an UNCHANGED status: line as anchor context is ignored', () => {
  // The health-repo false positive: adding `summary:` to frontmatter anchors
  // the edit on surrounding lines, so `status:` rides along unchanged in both
  // old_string and new_string. That is not a status edit.
  const r = evaluateGuard(
    {
      tool_name: 'Edit',
      tool_input: {
        file_path: 'docs/plans/x.md',
        old_string: 'status: active\nupdated: 2026-06-09',
        new_string: 'status: active\nsummary: one-liner\nupdated: 2026-06-09',
      },
    },
    config, notIgnored,
  );
  assert.equal(r, null, `unchanged status context must not fire; got ${JSON.stringify(r)}`);
});

test('Edit inserting a brand-new status: line fires', () => {
  const r = evaluateGuard(
    { tool_name: 'Edit', tool_input: { file_path: 'docs/plans/x.md', old_string: 'title: X', new_string: 'title: X\nstatus: active' } },
    config, notIgnored,
  );
  assert.equal(r.rule, 'edit-status');
});

test('MultiEdit edits[] changing a status: line fires', () => {
  const r = evaluateGuard(
    {
      tool_name: 'MultiEdit',
      tool_input: {
        file_path: 'docs/plans/x.md',
        edits: [
          { old_string: '## Heading', new_string: '## New Heading' },
          { old_string: 'status: active', new_string: 'status: paused' },
        ],
      },
    },
    config, notIgnored,
  );
  assert.equal(r.rule, 'edit-status');
});

test('Write changing status: vs the file on disk fires; same status is ignored', () => {
  const onDisk = '---\nstatus: active\ntitle: X\n---\nbody\n';
  const deps = { isIgnored: () => false, readFile: () => onDisk };
  const changed = evaluateGuard(
    { tool_name: 'Write', tool_input: { file_path: 'docs/plans/x.md', content: '---\nstatus: archived\ntitle: X\n---\nbody\n' } },
    config, deps,
  );
  assert.equal(changed.rule, 'edit-status');
  const same = evaluateGuard(
    { tool_name: 'Write', tool_input: { file_path: 'docs/plans/x.md', content: '---\nstatus: active\ntitle: X\n---\nnew body\n' } },
    config, deps,
  );
  assert.equal(same, null, `unchanged status in a Write must not fire; got ${JSON.stringify(same)}`);
});

test('Write creating a NEW doc (nothing on disk) is ignored', () => {
  const deps = { isIgnored: () => false, readFile: () => { throw new Error('ENOENT'); } };
  const r = evaluateGuard(
    { tool_name: 'Write', tool_input: { file_path: 'docs/plans/new.md', content: '---\nstatus: planned\n---\n# New\n' } },
    config, deps,
  );
  assert.equal(r, null, `doc creation is not a status edit; got ${JSON.stringify(r)}`);
});

test('sed -i mutating status: in a managed doc is denied', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: "sed -i '' 's/^status: active/status: archived/' docs/plans/x.md" } },
    config, notIgnored,
  );
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'edit-status');
  assert.match(r.reason, /dotmd set <status> docs\/plans\/x\.md/);
});

test('perl -pi mutating status: in a managed doc fires', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: "perl -pi -e 's/status: active/status: paused/' docs/plans/x.md" } },
    config, notIgnored,
  );
  assert.equal(r.rule, 'edit-status');
});

test('gawk inplace mutating status: in a managed doc fires', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: "gawk -i inplace '{sub(/status: active/, \"status: archived\")}1' docs/plans/x.md" } },
    config, notIgnored,
  );
  assert.equal(r.rule, 'edit-status');
});

test('sed without -i (stdout only) is not guarded', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: "sed 's/status: active/status: archived/' docs/plans/x.md" } },
    config, notIgnored,
  );
  assert.equal(r, null);
});

test('sed -i on a managed doc NOT touching status is not guarded', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: "sed -i '' 's/teh/the/g' docs/plans/x.md" } },
    config, notIgnored,
  );
  assert.equal(r, null);
});

test('sed -i on a non-managed file is not guarded', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: "sed -i '' 's/status: a/status: b/' src/config.json.md.bak" } },
    config, notIgnored,
  );
  assert.equal(r, null);
});

test('heredoc prose DESCRIBING sed -i status edits is not guarded', () => {
  // Saved-prompt bodies often describe the rules; the body is data, not a command.
  const command = [
    "dotmd new prompt resume-foo - <<'EOF'",
    "Gotcha: never `sed -i 's/status: active/status: archived/' docs/plans/x.md` — use dotmd set.",
    'EOF',
  ].join('\n');
  const r = evaluateGuard({ tool_name: 'Bash', tool_input: { command } }, config, notIgnored);
  assert.equal(r, null, `heredoc body must not trip the stream-editor rule; got ${JSON.stringify(r)}`);
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

test('git add of an ARCHIVED prompt is allowed (committable history)', () => {
  // Prompts archive into docs/prompts/archived/ by default. Those are history,
  // not session-local pending prompts — the guard must not block committing
  // them. Path built by concat so the literal does not trip the live guard.
  const archivedPath = 'docs/prompts/' + 'archived/resume-foo.md';
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'git add ' + archivedPath } },
    config, notIgnored,
  );
  assert.equal(r, null, `archived prompt commit must not be guarded; got ${JSON.stringify(r)}`);
});

test('reading an ARCHIVED prompt is not warned (history, not consumable)', () => {
  const archivedPath = 'docs/prompts/' + 'archived/resume-foo.md';
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'cat ' + archivedPath } },
    config, notIgnored,
  );
  assert.equal(r, null, `reading an archived prompt must not warn; got ${JSON.stringify(r)}`);
});
