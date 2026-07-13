import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { evaluateGuard } from '../src/guard.mjs';

const config = { configFound: true, repoRoot: '/repo', docsRoots: ['docs'] };
const notIncluded = { inspectGitPaths: () => [] };
const explicitPaths = { inspectGitPaths: (_subcommand, args) => args.filter(arg => !arg.startsWith('-')) };

test('git add of an ignored prompt is allowed because Git will not include it', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'git add docs/prompts/resume-foo.md' } },
    config, notIncluded,
  );
  assert.equal(r, null);
});

test('git commit of a tracked prompt is still denied (session-local)', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'git commit -m wip docs/prompts/foo.md' } },
    config, explicitPaths,
  );
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'commit-prompt');
});

for (const command of ['git add .', 'git add -A', 'git add docs', 'git commit', 'git commit -a -m save']) {
  test(`${command} denies when Git reports a live prompt`, () => {
    const r = evaluateGuard(
      { tool_name: 'Bash', tool_input: { command } },
      config,
      { inspectGitPaths: () => ['docs/prompts/resume-live.md', 'src/app.mjs'] },
    );
    assert.equal(r?.decision, 'deny');
    assert.equal(r?.rule, 'commit-prompt');
    assert.match(r.detail, /docs\/prompts\/resume-live\.md/);
  });
}

for (const command of ['git -C . add .', 'env git add .', 'command git add .', 'MODE=safe git add .']) {
  test(`${command} reaches Git-state inspection`, () => {
    const r = evaluateGuard(
      { tool_name: 'Bash', tool_input: { command } },
      config,
      { inspectGitPaths: () => ['docs/prompts/resume-live.md'] },
    );
    assert.equal(r?.rule, 'commit-prompt');
  });
}

test('git -C and cd segments inspect the command repository, including sudo wrappers', () => {
  const repoRoot = path.resolve('/repo');
  const seen = [];
  const deps = {
    gitCwd: path.join(repoRoot, 'subdir'),
    inspectGitPaths: (_subcommand, _args, cwd) => { seen.push(cwd); return ['docs/prompts/live.md']; },
  };
  assert.equal(evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'git -C ../other add .' } }, config, deps,
  )?.rule, 'commit-prompt');
  assert.equal(evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'cd ../other && sudo git add .' } }, config, deps,
  )?.rule, 'commit-prompt');
  assert.deepEqual(seen, [path.join(repoRoot, 'other'), path.join(repoRoot, 'other')]);
});

test('broad Git forms allow clean or archived prompts', () => {
  const clean = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'git add .' } },
    config,
    { inspectGitPaths: () => ['src/app.mjs'] },
  );
  assert.equal(clean, null);
  const archived = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'git commit' } },
    config,
    { inspectGitPaths: () => ['docs/prompts/archived/resume-old.md'] },
  );
  assert.equal(archived, null);
});

test('Git dry-run forms never deny', () => {
  // The real inspector returns no paths for these; this pins evaluator behavior
  // with an inspector that models that no-op result.
  assert.equal(evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'git add --dry-run .' } }, config,
    { inspectGitPaths: () => [] },
  ), null);
  assert.equal(evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'git commit --dry-run' } }, config,
    { inspectGitPaths: () => [] },
  ), null);
});

test('guard has no opinion without a discovered dotmd config', () => {
  const r = evaluateGuard(
    { tool_name: 'Read', tool_input: { file_path: 'docs/prompts/private.md' } },
    { ...config, configFound: false },
    notIncluded,
  );
  assert.equal(r, null);
});

test('cat of a prompt warns and nudges to dotmd use', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'cat docs/prompts/foo.md' } },
    config, notIncluded,
  );
  assert.equal(r.decision, 'warn');
  assert.equal(r.rule, 'cat-prompt');
  assert.match(r.reason, /dotmd use docs\/prompts\/foo\.md/);
});

test('Read tool on a prompt warns', () => {
  const r = evaluateGuard(
    { tool_name: 'Read', tool_input: { file_path: 'docs/prompts/foo.md' } },
    config, notIncluded,
  );
  assert.equal(r.decision, 'warn');
  assert.equal(r.rule, 'read-prompt');
});

test('Edit changing a status: line in a managed doc is denied by default', () => {
  const r = evaluateGuard(
    { tool_name: 'Edit', tool_input: { file_path: 'docs/plans/x.md', old_string: 'status: active\ntitle: X', new_string: 'status: archived\ntitle: X' } },
    config, notIncluded,
  );
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'edit-status');
  assert.match(r.reason, /dotmd set/);
});

test('guard.deny: false drops the status-edit rule back to warn', () => {
  const r = evaluateGuard(
    { tool_name: 'Edit', tool_input: { file_path: 'docs/plans/x.md', old_string: 'status: active', new_string: 'status: archived' } },
    { ...config, guard: { deny: false } }, notIncluded,
  );
  assert.equal(r.decision, 'warn');
  assert.equal(r.rule, 'edit-status');
});

test('Edit not touching status: is ignored', () => {
  const r = evaluateGuard(
    { tool_name: 'Edit', tool_input: { file_path: 'docs/plans/x.md', new_string: '## Some body change' } },
    config, notIncluded,
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
    config, notIncluded,
  );
  assert.equal(r, null, `unchanged status context must not fire; got ${JSON.stringify(r)}`);
});

test('Edit inserting a brand-new status: line fires', () => {
  const r = evaluateGuard(
    { tool_name: 'Edit', tool_input: { file_path: 'docs/plans/x.md', old_string: 'title: X', new_string: 'title: X\nstatus: active' } },
    config, notIncluded,
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
    config, notIncluded,
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
    config, notIncluded,
  );
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'edit-status');
  assert.match(r.reason, /dotmd set <status> docs\/plans\/x\.md/);
});

test('perl -pi mutating status: in a managed doc fires', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: "perl -pi -e 's/status: active/status: paused/' docs/plans/x.md" } },
    config, notIncluded,
  );
  assert.equal(r.rule, 'edit-status');
});

test('gawk inplace mutating status: in a managed doc fires', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: "gawk -i inplace '{sub(/status: active/, \"status: archived\")}1' docs/plans/x.md" } },
    config, notIncluded,
  );
  assert.equal(r.rule, 'edit-status');
});

test('sed without -i (stdout only) is not guarded', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: "sed 's/status: active/status: archived/' docs/plans/x.md" } },
    config, notIncluded,
  );
  assert.equal(r, null);
});

test('sed -i on a managed doc NOT touching status is not guarded', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: "sed -i '' 's/teh/the/g' docs/plans/x.md" } },
    config, notIncluded,
  );
  assert.equal(r, null);
});

test('sed -i on a non-managed file is not guarded', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: "sed -i '' 's/status: a/status: b/' src/config.json.md.bak" } },
    config, notIncluded,
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
  const r = evaluateGuard({ tool_name: 'Bash', tool_input: { command } }, config, notIncluded);
  assert.equal(r, null, `heredoc body must not trip the stream-editor rule; got ${JSON.stringify(r)}`);
});

test('quoted prose describing an in-place status edit is not guarded', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'echo "perl -pi status docs/plans/x.md"' } },
    config,
    notIncluded,
  );
  assert.equal(r, null);
});

for (const command of [
  "sudo sed -i '' 's/status: active/status: archived/' docs/plans/x.md",
  "env perl -pi -e 's/status: active/status: paused/' docs/plans/x.md",
  "command gawk -i inplace '{sub(/status: active/, \"status: archived\")}1' docs/plans/x.md",
  "MODE=safe sed -i '' 's/status: active/status: archived/' docs/plans/x.md",
]) {
  test(`wrapped stream editor is guarded: ${command.split(' ')[0]}`, () => {
    assert.equal(evaluateGuard(
      { tool_name: 'Bash', tool_input: { command } }, config, notIncluded,
    )?.rule, 'edit-status');
  });
}

test('normal commands and non-managed files produce no opinion', () => {
  assert.equal(evaluateGuard({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, config, notIncluded), null);
  assert.equal(evaluateGuard({ tool_name: 'Read', tool_input: { file_path: 'src/index.mjs' } }, config, notIncluded), null);
  assert.equal(evaluateGuard({ tool_name: 'Bash', tool_input: { command: 'cat README.md' } }, config, notIncluded), null);
});

test('reading a plan (not a prompt) via cat is allowed', () => {
  // Plans are fine to read directly — only prompts must go through `dotmd use`.
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'cat docs/plans/auth.md' } },
    config, notIncluded,
  );
  assert.equal(r, null);
});

test('DOTMD_GUARD=0 disables all rules', () => {
  const prev = process.env.DOTMD_GUARD;
  process.env.DOTMD_GUARD = '0';
  try {
    const r = evaluateGuard(
      { tool_name: 'Bash', tool_input: { command: 'git add docs/prompts/foo.md' } },
      config, explicitPaths,
    );
    assert.equal(r, null);
  } finally {
    if (prev === undefined) delete process.env.DOTMD_GUARD; else process.env.DOTMD_GUARD = prev;
  }
});

test('prompt path in a NON-git segment does not deny the commit', () => {
  // The false positive that taught sessions to distrust legitimate commits:
  // `dotmd check` on a prompt in one segment, `git commit` of a plan in another.
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'dotmd check docs/prompts/resume-x.md 2>&1 | tail -3; git commit -m "close plan" -- docs/plans/foo.md' } },
    config, notIncluded,
  );
  assert.equal(r, null, `prompt mention outside the git segment must not deny; got ${JSON.stringify(r)}`);
});

test('prompt path inside a quoted commit MESSAGE does not deny', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'git commit -m "handoff saved to docs/prompts/resume-x.md" -- docs/plans/foo.md' } },
    config, notIncluded,
  );
  assert.equal(r, null, `prose mention in -m must not deny; got ${JSON.stringify(r)}`);
});

test('quoted commit prose containing shell separators remains one argument', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'git commit -m "safe; prose | still message" -- src/app.mjs' } },
    config,
    { inspectGitPaths: (_subcommand, args) => args.includes('src/app.mjs') ? [] : ['docs/prompts/unrelated.md'] },
  );
  assert.equal(r, null);
});

test('git add of a QUOTED prompt path (no inner whitespace) is still denied', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'git add "docs/prompts/resume-x.md"' } },
    config, explicitPaths,
  );
  assert.equal(r.rule, 'commit-prompt');
  assert.equal(r.decision, 'deny');
});

test('git add of an escaped-space prompt path is denied', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'git add docs/prompts/resume\\ live.md' } },
    config,
    explicitPaths,
  );
  assert.equal(r?.rule, 'commit-prompt');
});

test('git add of a prompt in a LATER segment is denied', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'dotmd check && git add docs/prompts/resume-x.md && git commit -m x' } },
    config, explicitPaths,
  );
  assert.equal(r.rule, 'commit-prompt');
});

test('creating a prompt via heredoc whose BODY mentions a prompt path is not warned', () => {
  // The canonical creation flow — the guard must not scold it.
  const command = [
    "cat <<'EOF' | dotmd new prompt resume-y",
    'see docs/prompts/old-thing.md for context',
    'EOF',
  ].join('\n');
  const r = evaluateGuard({ tool_name: 'Bash', tool_input: { command } }, config, notIncluded);
  assert.equal(r, null, `heredoc body must not trip cat-prompt; got ${JSON.stringify(r)}`);
});

test('cat of a prompt piped onward still warns (segment-scoped, not pipe-blind)', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'cat docs/prompts/foo.md | head -5' } },
    config, notIncluded,
  );
  assert.equal(r.rule, 'cat-prompt');
  assert.match(r.reason, /dotmd prompts show docs\/prompts\/foo\.md/);
});

test('git add of a non-prompt path is not denied', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'git add src/foo.mjs' } },
    config, notIncluded,
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
    config, notIncluded,
  );
  assert.equal(r, null, `archived prompt commit must not be guarded; got ${JSON.stringify(r)}`);
});

test('reading an ARCHIVED prompt is not warned (history, not consumable)', () => {
  const archivedPath = 'docs/prompts/' + 'archived/resume-foo.md';
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'cat ' + archivedPath } },
    config, notIncluded,
  );
  assert.equal(r, null, `reading an archived prompt must not warn; got ${JSON.stringify(r)}`);
});

test('custom archive directory is treated as committable prompt history', () => {
  const custom = { ...config, archiveDir: 'history' };
  const pathInHistory = 'docs/prompts/history/resume-old.md';
  assert.equal(evaluateGuard(
    { tool_name: 'Read', tool_input: { file_path: pathInHistory } },
    custom,
    notIncluded,
  ), null);
  assert.equal(evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: `git add ${pathInHistory}` } },
    custom,
    { inspectGitPaths: () => [pathInHistory] },
  ), null);
});

// --- Windows backslash paths ---------------------------------------------
// On Windows the agent's tool payloads carry backslash-separated paths. The
// guard's `/`-based matching used to no-op on those, leaving protection silently
// absent. These pin the separator-agnostic behavior.

test('Edit changing status: in a backslash-path managed doc is denied', () => {
  const r = evaluateGuard(
    { tool_name: 'Edit', tool_input: { file_path: 'docs\\plans\\x.md', old_string: 'status: active', new_string: 'status: archived' } },
    config, notIncluded,
  );
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'edit-status');
});

test('git add of a backslash-path prompt is denied', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'git add docs\\prompts\\resume-foo.md' } },
    config, explicitPaths,
  );
  assert.equal(r.decision, 'deny');
  assert.equal(r.rule, 'commit-prompt');
});

test('cat of a backslash-path prompt warns', () => {
  const r = evaluateGuard(
    { tool_name: 'Bash', tool_input: { command: 'cat docs\\prompts\\foo.md' } },
    config, notIncluded,
  );
  assert.equal(r.decision, 'warn');
  assert.equal(r.rule, 'cat-prompt');
});

test('Read on a backslash-path prompt warns', () => {
  const r = evaluateGuard(
    { tool_name: 'Read', tool_input: { file_path: 'docs\\prompts\\foo.md' } },
    config, notIncluded,
  );
  assert.equal(r.decision, 'warn');
  assert.equal(r.rule, 'read-prompt');
});

test('backslash-path ARCHIVED prompt is still allowed (history, not session-local)', () => {
  const archivedPath = 'docs\\prompts\\' + 'archived\\resume-foo.md';
  const r = evaluateGuard(
    { tool_name: 'Read', tool_input: { file_path: archivedPath } },
    config, notIncluded,
  );
  assert.equal(r, null, `archived backslash prompt must not be guarded; got ${JSON.stringify(r)}`);
});
