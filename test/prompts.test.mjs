import { describe, it, beforeEach, afterEach } from 'node:test';
import { ok, strictEqual, match, rejects } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, chmodSync, utimesSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/config.mjs';
import { runPrompts } from '../src/prompts.mjs';
import { SESSION_ID_VARIABLES } from '../src/util.mjs';

const bin = path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs');

let tmpDir;
let docsDir;
let promptsDir;
let configPath;

function setupProject() {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-prompts-'));
  spawnSync('git', ['init', '-q'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: tmpDir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: tmpDir });

  docsDir = path.join(tmpDir, 'docs');
  promptsDir = path.join(docsDir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  mkdirSync(path.join(docsDir, 'archived'), { recursive: true });

  configPath = path.join(tmpDir, 'dotmd.config.mjs');
  writeFileSync(configPath, `export const root = 'docs';\n`);
}

function writePrompt(name, { status = 'pending', created = '2025-01-01', body = 'do the thing', parent = null } = {}) {
  const file = path.join(promptsDir, `${name}.md`);
  const fm = [
    'type: prompt',
    `status: ${status}`,
    `created: ${created}`,
    'related_plans: []',
    ...(parent ? [`parent_prompt: ${parent}`] : []),
  ].join('\n');
  writeFileSync(file, `---\n${fm}\n---\n${body}\n`);
  spawnSync('git', ['add', file], { cwd: tmpDir });
  spawnSync('git', ['commit', '-qm', `add ${name}`], { cwd: tmpDir });
  return file;
}

function run(args, env = {}) {
  return spawnSync('node', [bin, ...args, '--config', configPath], {
    cwd: tmpDir, encoding: 'utf8',
    env: { ...process.env, ...env, NO_COLOR: '1' },
  });
}

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe('runlist prompts list', () => {
  beforeEach(setupProject);

  it('bare `prompts` lists pending prompts (default)', () => {
    writePrompt('a-prompt', { status: 'pending' });
    writePrompt('b-prompt', { status: 'archived' });
    const r = run(['prompts']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('a-prompt'), 'lists pending');
    ok(!r.stdout.includes('b-prompt'), 'excludes archived');
  });

  it('`prompts list` works as alias', () => {
    writePrompt('foo-prompt');
    const r = run(['prompts', 'list']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('foo-prompt'), `expected listing to include foo-prompt:\n${r.stdout}`);
  });

  it('`prompts list` keeps age order without suggesting a prompt to consume', () => {
    writePrompt('newer', { created: '2025-06-01' });
    writePrompt('older', { created: '2025-01-01' });
    const r = run(['prompts', 'list']);
    strictEqual(r.status, 0, r.stderr);
    const olderIdx = r.stdout.indexOf('older');
    const newerIdx = r.stdout.indexOf('newer');
    ok(olderIdx > -1 && newerIdx > -1, `expected both prompts:\n${r.stdout}`);
    ok(olderIdx < newerIdx, `oldest pending should be first:\n${r.stdout}`);
    ok(!r.stdout.includes('[NEXT]'), r.stdout);
    match(r.stdout, /older[^\n]*\d+d old\n/);
  });

  it('shows explicit children on their parent line without changing the next consumed prompt', () => {
    writePrompt('subagent-review', { parent: 'resume-session', created: '2025-01-01', body: 'CHILD-FIRST' });
    writePrompt('unrelated', { created: '2025-02-01' });
    writePrompt('resume-session', { created: '2025-03-01' });
    const r = run(['prompts']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /resume-session[^\n]*\[PENDING\] \[\+1 subagent\]/);
    match(r.stdout, /children: \d+-\d+d old\n/);
    ok(!r.stdout.includes('subagent-review'), r.stdout);
    ok(r.stdout.indexOf('[+1 subagent]') < r.stdout.indexOf('unrelated'), r.stdout);
    const json = run(['prompts', '--json']);
    strictEqual(json.status, 0, json.stderr);
    const data = JSON.parse(json.stdout);
    strictEqual(data.docs.length, 3, 'JSON retains every individual prompt');
    ok(data.docs.some(doc => doc.path.endsWith('/subagent-review.md')));
    const next = run(['prompts', 'next']);
    strictEqual(next.status, 0, next.stderr);
    match(next.stdout, /CHILD-FIRST/);
  });

  it('groups legacy agent prefixes under the longest matching parent name', () => {
    writePrompt('resume-session');
    writePrompt('resume-session-api');
    for (const prefix of ['subagent', 'agent', 'session']) writePrompt(`${prefix}-session-api-review`);
    const r = run(['prompts']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /resume-session-api[^\n]*\[PENDING\](?: \[NEXT\])? \[\+3 subagent\]/);
    for (const prefix of ['subagent', 'agent', 'session']) ok(!r.stdout.includes(`${prefix}-session-api-review`), r.stdout);
  });

  it('collapses missing-parent children into one count and exposes their names in verbose output', () => {
    writePrompt('resume-session');
    writePrompt('resume-missing', { status: 'archived' });
    writePrompt('subagent-session-review', { parent: 'resume-missing' });
    writePrompt('agent-sessionish-review');
    const r = run(['prompts']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /\[\+2 subagent\]/);
    ok(!r.stdout.includes('subagent-session-review'), r.stdout);
    ok(!r.stdout.includes('agent-sessionish-review'), r.stdout);
    const expanded = run(['prompts', '--verbose']);
    strictEqual(expanded.status, 0, expanded.stderr);
    ok(expanded.stdout.includes('subagent-session-review'), expanded.stdout);
    ok(expanded.stdout.includes('agent-sessionish-review'), expanded.stdout);
    ok(!expanded.stdout.includes('- subagent-session-review'), 'missing explicit parent must not attach to a different one');
  });

  it('shows compact freshness when only subagent prompts are pending', () => {
    for (let i = 0; i < 5; i++) writePrompt(`subagent-review-${i}`);
    const r = run(['prompts']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /\[\+5 subagent\] · \d+-\d+d old\n/);
    ok(!r.stdout.includes('[NEXT]'), r.stdout);
    ok(!r.stdout.includes('subagent-review-'), r.stdout);
    match(r.stdout, /rl prompts --verbose/);
  });

  it('groups children in verbose output with their target information', () => {
    writePrompt('resume-session');
    writePrompt('subagent-review', { parent: 'resume-session', body: 'Read [plan](../plans/foo.md).' });
    const r = run(['prompts', '--verbose']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /resume-session[^\n]*\n[^\n]*\n\s+- subagent-review/);
    match(r.stdout, /docs\/plans\/foo.md/);
  });

  it('`prompts list --verbose` shows target plan from related_plans frontmatter', () => {
    const file = path.join(promptsDir, 'resume-foo.md');
    writeFileSync(file, `---\ntype: prompt\nstatus: pending\ncreated: 2025-01-01\nrelated_plans: [foo-plan]\n---\nresume foo\n`);
    spawnSync('git', ['add', file], { cwd: tmpDir });
    spawnSync('git', ['commit', '-qm', 'add resume-foo'], { cwd: tmpDir });
    const r = run(['prompts', 'list', '--verbose']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('resume-foo'), 'lists prompt name');
    ok(r.stdout.includes('docs/plans/foo-plan.md'), `expected docs/plans/foo-plan.md, got:\n${r.stdout}`);
  });

  it('`prompts list --verbose` falls back to first body markdown link', () => {
    const file = path.join(promptsDir, 'resume-bar.md');
    writeFileSync(file, `---\ntype: prompt\nstatus: pending\ncreated: 2025-01-01\n---\nRead [notes](../assets/notes.txt), then continue [bar plan](../plans/bar-plan.md) where we left off.\n`);
    spawnSync('git', ['add', file], { cwd: tmpDir });
    spawnSync('git', ['commit', '-qm', 'add resume-bar'], { cwd: tmpDir });
    const r = run(['prompts', 'list', '--verbose']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('docs/plans/bar-plan.md'), `expected docs/plans/bar-plan.md, got:\n${r.stdout}`);
  });

  it('`prompts list --verbose` marks prompts with no target', () => {
    const file = path.join(promptsDir, 'orphan.md');
    writeFileSync(file, `---\ntype: prompt\nstatus: pending\ncreated: 2025-01-01\n---\nNo target plan referenced.\n`);
    spawnSync('git', ['add', file], { cwd: tmpDir });
    spawnSync('git', ['commit', '-qm', 'add orphan'], { cwd: tmpDir });
    const r = run(['prompts', 'list', '--verbose']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('no target plan'), `expected no-target marker, got:\n${r.stdout}`);
  });

  it('shows frontmatter targets, missing targets and unknown ages without changing prompts', () => {
    mkdirSync(path.join(docsDir, 'plans'));
    const target = path.join(docsDir, 'plans', 'widget.md');
    writeFileSync(target, '---\ntype: plan\nstatus: archived\n---\nWidget\n');
    utimesSync(target, new Date('2025-01-01'), new Date('2025-01-01'));
    writeFileSync(path.join(tmpDir, '.gitignore'), 'docs/plans/\n');
    const contents = [
      ['resume-widget', 'created: 2025-02-01\nplan: ../plans/widget.md'],
      ['missing', 'created: 2025-02-01\nrelated_plans: [missing]'],
      ['undated', 'created: invalid\nparent_plan: widget'],
    ].map(([name, fields]) => {
      const file = path.join(promptsDir, `${name}.md`);
      const body = `---\ntype: prompt\nstatus: pending\n${fields}\n---\nBODY MUST STAY PRIVATE\n`;
      writeFileSync(file, body);
      return [file, body];
    });
    const result = run(['prompts']);
    strictEqual(result.status, 0, result.stderr);
    match(result.stdout, /resume-widget[^\n]*docs\/plans\/widget.md: no edits since save \(file clock\)/);
    match(result.stdout, /missing[^\n]*docs\/plans\/missing.md: unknown/);
    match(result.stdout, /undated[^\n]*age unknown[^\n]*docs\/plans\/widget.md: unknown/);
    ok(!result.stdout.includes('BODY MUST'), result.stdout);
    for (const [file, body] of contents) strictEqual(readFileSync(file, 'utf8'), body);
    match(readFileSync(target, 'utf8'), /status: archived/);
  });

  it('reads only capped headers for the default list, including in handoffs mode', async () => {
    writeFileSync(configPath, `export const mode = 'handoffs';\nexport const root = 'docs/prompts';\n`);
    const file = path.join(promptsDir, 'resume-widget.md');
    const header = '---\ntype: prompt\nstatus: pending\ncreated: 2025-01-01\n---\n';
    writeFileSync(file, header + 'private body\n'.repeat(10000));
    writeFileSync(path.join(promptsDir, 'oversized.md'), '---\n' + 'x'.repeat(20 * 1024));
    const config = await resolveConfig(tmpDir, configPath);
    const originalRead = fs.readFileSync, originalOpen = fs.openSync, originalReadBytes = fs.readSync;
    const fds = new Map(), bytes = new Map();
    const originalWrite = process.stdout.write;
    let output = '';
    fs.readFileSync = (candidate, ...args) => {
      if (String(candidate).startsWith(promptsDir)) throw new Error('whole prompt read');
      return originalRead(candidate, ...args);
    };
    fs.openSync = (candidate, ...args) => {
      const fd = originalOpen(candidate, ...args);
      if (String(candidate).startsWith(promptsDir)) fds.set(fd, String(candidate));
      return fd;
    };
    fs.readSync = (fd, ...args) => {
      const count = originalReadBytes(fd, ...args);
      if (fds.has(fd)) bytes.set(fds.get(fd), (bytes.get(fds.get(fd)) ?? 0) + count);
      return count;
    };
    process.stdout.write = chunk => { output += chunk; return true; };
    syncBuiltinESMExports();
    try { await runPrompts([], config); }
    finally {
      fs.readFileSync = originalRead; fs.openSync = originalOpen; fs.readSync = originalReadBytes;
      process.stdout.write = originalWrite;
      syncBuiltinESMExports();
    }
    match(output, /resume-widget[^\n]*\d+d old\n/);
    strictEqual(bytes.get(file), Buffer.byteLength(header));
    strictEqual(bytes.get(path.join(promptsDir, 'oversized.md')), 16 * 1024);
  });

  it('shows tracked changes and expands each grouped child freshness without selecting it', () => {
    mkdirSync(path.join(docsDir, 'plans'));
    const target = path.join(docsDir, 'plans', 'widget.md');
    writeFileSync(target, '---\ntype: plan\nstatus: active\n---\nWidget\n');
    spawnSync('git', ['add', target], { cwd: tmpDir });
    spawnSync('git', ['commit', '-qm', 'add widget'], { cwd: tmpDir });
    writePrompt('resume-widget');
    const child = writePrompt('subagent-widget', { parent: 'resume-widget' });
    writeFileSync(child, readFileSync(child, 'utf8').replace('related_plans: []', 'plan: ../plans/widget.md'));
    const listed = run(['prompts']);
    strictEqual(listed.status, 0, listed.stderr);
    match(listed.stdout, /children: \d+-\d+d old; targets: 1 changed since save/);
    ok(!listed.stdout.includes('subagent-widget'), listed.stdout);
    ok(!listed.stdout.includes('[NEXT]'), listed.stdout);
    const verbose = run(['prompts', '--verbose']);
    strictEqual(verbose.status, 0, verbose.stderr);
    match(verbose.stdout, /subagent-widget[^\n]*docs\/plans\/widget.md: changed since save/);
    ok(existsSync(child), 'listing leaves the child pending');
    ok(listed.stdout.split('\n').length <= 9, 'grouped freshness stays bounded to 1 extra line per prompt');
  });
});

describe('runlist prompts next', () => {
  beforeEach(setupProject);

  it('picks oldest pending by created date', () => {
    writePrompt('newer', { created: '2025-06-01', body: 'newer body' });
    writePrompt('older', { created: '2025-01-01', body: 'older body' });

    const r = run(['prompts', 'next']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('older body'), 'emits oldest body');
    ok(!r.stdout.includes('newer body'), 'does not emit newer body');
    ok(r.stderr.includes('Archived'), 'archive status on stderr');
    ok(r.stderr.includes('Consumed'), 'consume confirmation on stderr');
  });

  it('consumes custom expanded prompt statuses in deterministic path order', () => {
    writeFileSync(configPath, `
      export const root = 'docs';
      export const types = { prompt: { statuses: { urgent: { context: 'expanded' }, held: { context: 'listed' }, archived: { context: 'counted', terminal: true, archive: true } } } };
    `);
    writePrompt('z-urgent', { status: 'urgent', created: '2025-01-01', body: 'z body' });
    writePrompt('a-urgent', { status: 'urgent', created: '2025-01-01', body: 'a body' });
    const result = run(['use']);
    strictEqual(result.status, 0, result.stderr);
    ok(result.stdout.includes('a body'), result.stdout);
    ok(existsSync(path.join(promptsDir, 'z-urgent.md')), 'path tie-break leaves z queued');
  });

  it('archives the file (moves to prompts/archived/, flips status)', () => {
    const file = writePrompt('foo');
    const r = run(['prompts', 'next']);
    strictEqual(r.status, 0, r.stderr);
    ok(!existsSync(file), 'original file gone');
    // Prompts nest their archive under the prompts dir (default
    // lifecycle.archiveNestedTypes), not the shared docs/archived/.
    const archived = path.join(promptsDir, 'archived', 'foo.md');
    ok(existsSync(archived), 'moved to prompts/archived dir');
    ok(!existsSync(path.join(docsDir, 'archived', 'foo.md')), 'not in the shared archive');
    const content = readFileSync(archived, 'utf8');
    ok(content.includes('status: archived'), 'status flipped');
  });

  it('errors when queue is empty', () => {
    const r = run(['prompts', 'next']);
    ok(r.status !== 0, 'non-zero exit');
    ok(r.stderr.includes('No pending prompts'), 'clear error');
    strictEqual(r.stdout, '', 'no stdout');
  });

  it('does not double-consume the same prompt', () => {
    writePrompt('foo', { body: 'body' });
    run(['prompts', 'next']);

    const r2 = run(['prompts', 'next']);
    ok(r2.status !== 0, 'second call fails');
    ok(r2.stderr.includes('No pending prompts'), 'queue is empty after consume');
  });

  it('dry-run does not mutate', () => {
    const file = writePrompt('foo', { body: 'body' });
    const before = readFileSync(file, 'utf8');
    const r = run(['prompts', 'next', '--dry-run']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stderr.includes('[dry-run]'), 'dry-run prefix');
    ok(existsSync(file), 'file still in place');
    const after = readFileSync(file, 'utf8');
    strictEqual(after, before, 'file unchanged');
  });

  it('dry-run previews the body that would be emitted (issue #10 finding #11)', () => {
    writePrompt('foo', { body: 'this is the unique-needle body content' });
    const r = run(['prompts', 'next', '--dry-run']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stderr.includes('body preview'), 'shows preview heading');
    ok(r.stderr.includes('unique-needle'), `expected body content in preview, got stderr:\n${r.stderr}`);
    strictEqual(r.stdout, '', 'stdout stays empty in dry-run (no piping surprises)');
  });

  // Regression: if the archive step fails (read-only archive dir here), the
  // body must NOT have already been emitted to stdout. Otherwise the session
  // reads the body and the prompt stays pending in docs/prompts/ — the
  // failure mode that motivated the reorder.
  it('does not emit body when archive fails', { skip: process.platform === 'win32' }, () => {
    const file = writePrompt('foo', { body: 'unique-must-not-leak' });
    // Prompts archive into docs/prompts/archived/; making the prompts dir
    // read-only blocks creating that subdir, forcing the archive to fail.
    chmodSync(promptsDir, 0o555);
    try {
      const r = run(['prompts', 'next']);
      ok(r.status !== 0, 'archive failure exits non-zero');
      strictEqual(r.stdout, '', `stdout must stay empty when archive fails, got:\n${r.stdout}`);
      ok(existsSync(file), 'source file still in docs/prompts/');
    } finally {
      chmodSync(promptsDir, 0o755);
    }
  });
});

describe('prompt parent links and resume discovery', () => {
  beforeEach(setupProject);

  it('links several existing children without changing bodies, status, timestamps, or line endings', () => {
    writePrompt('resume-session');
    const paths = [writePrompt('subagent-review-a'), writePrompt('subagent-review-b')];
    writeFileSync(paths[0], readFileSync(paths[0], 'utf8').replaceAll('\n', '\r\n'));
    const before = paths.map(file => readFileSync(file, 'utf8'));
    const args = ['prompts', 'link', 'subagent-review-a', 'subagent-review-b', '--parent', 'resume-session', '--json'];
    const preview = run([...args, '--dry-run']);
    strictEqual(preview.status, 0, preview.stderr);
    strictEqual(JSON.parse(preview.stdout).linked.length, 2);
    paths.forEach((file, i) => strictEqual(readFileSync(file, 'utf8'), before[i]));
    const linked = run(args);
    strictEqual(linked.status, 0, linked.stderr);
    paths.forEach((file, i) => {
      const raw = readFileSync(file, 'utf8');
      const eol = i === 0 ? '\r\n' : '\n';
      strictEqual(raw, before[i].replace(`${eol}---${eol}`, `${eol}parent_prompt: "resume-session"${eol}---${eol}`));
    });
    const retry = run(args);
    strictEqual(retry.status, 0, retry.stderr);
    strictEqual(JSON.parse(retry.stdout).linked.length, 0, 'identical linking is a no-op');
    match(run(['prompts']).stdout, /resume-session[^\n]*\[\+2 subagent\]/);
  });

  it('refuses an invalid batch before changing any child', () => {
    writePrompt('resume-session');
    const child = writePrompt('subagent-review');
    const archived = writePrompt('subagent-old', { status: 'archived' });
    const before = readFileSync(child, 'utf8');
    for (const args of [
      ['subagent-review', 'subagent-old', '--parent', 'resume-session'],
      ['subagent-review', '--parent', 'resume-missing'],
      ['resume-session', '--parent', 'resume-session'],
    ]) {
      ok(run(['prompts', 'link', ...args]).status !== 0);
      strictEqual(readFileSync(child, 'utf8'), before);
    }
    match(readFileSync(archived, 'utf8'), /status: archived/);
  });

  it('rejects duplicate parent fields even when the first already names the requested parent', () => {
    writePrompt('resume-session');
    const first=writePrompt('subagent-first'),second=writePrompt('subagent-second',{parent:'resume-session'});
    writeFileSync(second,readFileSync(second,'utf8').replace('parent_prompt: resume-session','parent_prompt: resume-session\nparent_prompt: resume-other'));
    const before=[first,second].map(file=>readFileSync(file,'utf8'));
    const result=run(['prompts','link','subagent-first','subagent-second','--parent','resume-session']);
    ok(result.status!==0);match(result.stderr,/Repair the parent_prompt/);
    [first,second].forEach((file,i)=>strictEqual(readFileSync(file,'utf8'),before[i]));
  });

  it('rolls back a linking batch and preserves a child edited during publication', async () => {
    writePrompt('resume-session');
    const first = writePrompt('subagent-first');
    const second = writePrompt('subagent-second');
    const originals = [first, second].map(file => readFileSync(file, 'utf8'));
    const config = await resolveConfig(tmpDir, configPath);
    const args = ['link', first, second, '--parent', 'resume-session'];
    await rejects(runPrompts(args, config, { testHooks: { afterSetCommit: () => { throw new Error('abort parent linking'); } } }), /abort parent linking/);
    [first, second].forEach((file, i) => strictEqual(readFileSync(file, 'utf8'), originals[i]));
    const external = originals[1] + '\nAn independently saved update.\n';
    await rejects(runPrompts(args, config, { testHooks: { afterSetCommit: count => {
      if (count === 1) writeFileSync(second, external);
    } } }), /changed|conflict|generation/i);
    strictEqual(readFileSync(first, 'utf8'), originals[0]);
    strictEqual(readFileSync(second, 'utf8'), external);
  });

  it('surfaces pending children on parent show, preview and consumption without consuming the children', () => {
    const parent = writePrompt('resume-session', { body: 'PARENT-CONTINUE' });
    const child = writePrompt('subagent-review', { parent: 'resume-session', body: 'CHILD-PRIVATE-BODY' });
    writePrompt('subagent-done', { parent: 'resume-session', status: 'archived' });
    writePrompt('subagent-other', { parent: 'resume-another' });
    const peek = run(['prompts', 'show', 'resume-session']);
    strictEqual(peek.status, 0, peek.stderr);
    match(peek.stdout, /Saved child handoffs/);
    match(peek.stdout, /docs\/prompts\/subagent-review.md/);
    ok(!peek.stdout.includes('CHILD-PRIVATE-BODY'));
    ok(!peek.stdout.includes('subagent-done'));
    ok(!peek.stdout.includes('subagent-other'));
    const preview = run(['use', 'resume-session', '--dry-run']);
    strictEqual(preview.status, 0, preview.stderr);
    match(preview.stderr, /Saved child handoffs/);
    ok(existsSync(parent));
    const used = run(['use', 'resume-session']);
    strictEqual(used.status, 0, used.stderr);
    match(used.stdout, /PARENT-CONTINUE/);
    match(used.stdout, /subagent-review.md/);
    match(used.stdout, /--parent resume-session/);
    ok(existsSync(child), 'resuming a parent leaves each child pending');
    match(readFileSync(child, 'utf8'), /status: pending/);
    ok(!existsSync(parent));
    const reopened=run(['prompts','show','docs/prompts/archived/resume-session.md']);
    strictEqual(reopened.status,0,reopened.stderr);match(reopened.stdout,/subagent-review.md/);ok(!reopened.stdout.includes('CHILD-PRIVATE-BODY'));
    ok(!reopened.stderr.includes('to consume'),'an archived prompt cannot be consumed again');
    strictEqual(run(['prompts','archive','subagent-review']).status,0);
    const refreshed=run(['prompts','show','docs/prompts/archived/resume-session.md']);
    strictEqual(refreshed.status,0,refreshed.stderr);ok(!refreshed.stdout.includes('Saved child handoffs'),'archive peeks reflect the current pending children');
  });
});

describe('runlist prompts use', () => {
  beforeEach(setupProject);

  it('keeps legacy parent prompts ahead of newer child handoffs in the same queue', () => {
    const legacy = writePrompt('resume-older-work', { created: '2025-01-01', body: 'LEGACY-CONTINUE' });
    const child = run(['baton', '--subagent', 'newer-task', '--message', 'CHILD-CONTINUE']);
    strictEqual(child.status, 0, child.stderr);
    const peek = run(['prompts', 'show', 'resume-older-work']);
    strictEqual(peek.status, 0, peek.stderr);
    match(peek.stdout, /LEGACY-CONTINUE/);
    ok(existsSync(legacy), 'peek preserves legacy identity');
    const next = run(['use']);
    strictEqual(next.status, 0, next.stderr);
    match(next.stdout, /LEGACY-CONTINUE/);
    ok(!next.stdout.includes('CHILD-CONTINUE'));
    const childFile = path.join(promptsDir, 'subagent-newer-task.md');
    ok(existsSync(childFile), 'newer child remains queued');
    const consume = run(['use', 'subagent-newer-task']);
    strictEqual(consume.status, 0, consume.stderr);
    match(consume.stdout, /CHILD-CONTINUE/);
    for (const name of ['resume-older-work', 'subagent-newer-task']) {
      ok(existsSync(path.join(promptsDir, 'archived', `${name}.md`)));
      const again = run(['use', `docs/prompts/archived/${name}.md`]);
      ok(again.status !== 0, 'archived handoff cannot emit twice');
      strictEqual(again.stdout, '');
      const recover = run(['prompts', 'show', `docs/prompts/archived/${name}.md`]);
      strictEqual(recover.status, 0, recover.stderr);
      match(recover.stdout, /CONTINUE/);
    }
  });

  for (const kind of ['legacy-parent', 'new-child']) {
    for (const noClaim of [false, true]) {
      it(`${kind} consumption ${noClaim ? 'preserves' : 'claims'} its linked plan`, () => {
        const planDir = path.join(docsDir, 'plans');
        mkdirSync(planDir, { recursive: true });
        const plan = path.join(planDir, 'linked-work.md');
        writeFileSync(plan, '---\ntype: plan\nstatus: active\n---\n# Linked work\n');
        let name;
        if (kind === 'legacy-parent') {
          name = 'resume-linked-work';
          const file = writePrompt(name, { body: 'LINKED-CONTINUE' });
          writeFileSync(file, readFileSync(file, 'utf8').replace('related_plans: []', 'plan: ../plans/linked-work.md'));
        } else {
          const saved = run(['baton', '--subagent', plan, '--message', 'LINKED-CONTINUE', '--json'], { RUNLIST_SESSION_ID: 'writer' });
          strictEqual(saved.status, 0, saved.stderr);
          name = JSON.parse(saved.stdout).savedPrompt;
          strictEqual(name, 'subagent-linked-work');
        }
        const consumed = run(['use', name, ...(noClaim ? ['--no-claim'] : [])], { RUNLIST_SESSION_ID: 'reader' });
        strictEqual(consumed.status, 0, consumed.stderr);
        match(consumed.stdout, /LINKED-CONTINUE/);
        match(readFileSync(plan, 'utf8'), noClaim ? /^status: active$/m : /^status: in-session$/m);
        ok(!existsSync(path.join(promptsDir, `${name}.md`)));
        ok(existsSync(path.join(promptsDir, 'archived', `${name}.md`)));
        if (noClaim) match(consumed.stderr, /Not claimed.*--no-claim/);
        else {
          const handoff = run(['baton', '--message', 'READER-CONTINUE'], { RUNLIST_SESSION_ID: 'reader' });
          strictEqual(handoff.status, 0, handoff.stderr);
          match(readFileSync(plan, 'utf8'), /^status: active$/m);
        }
      });
    }
  }

  it('consumes specific file regardless of queue order', () => {
    writePrompt('older', { created: '2025-01-01', body: 'older body' });
    const target = writePrompt('target', { created: '2025-06-01', body: 'target body' });

    const r = run(['prompts', 'use', target]);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('target body'));
    ok(!r.stdout.includes('older body'));
    ok(!existsSync(target), 'target archived');
    ok(r.stderr.includes('Consumed: docs/prompts/archived/target.md'),
      `consume confirmation should name the nested archived path, not the stale source path:\n${r.stderr}`);
  });

  it('top-level `runlist use <slug>` resolves prompt basenames and consumes atomically', () => {
    writePrompt('resume-from-slug', { body: 'slug body' });
    const r = run(['use', 'resume-from-slug']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('slug body'), `expected prompt body:\n${r.stdout}`);
    ok(!existsSync(path.join(promptsDir, 'resume-from-slug.md')), 'source archived');
    ok(existsSync(path.join(promptsDir, 'archived', 'resume-from-slug.md')), 'archived target exists');
    ok(r.stderr.includes('Consumed: docs/prompts/archived/resume-from-slug.md'), r.stderr);
  });

  it('top-level `runlist use <slug>.md` resolves prompt basenames and consumes atomically', () => {
    writePrompt('resume-with-ext', { body: 'ext body' });
    const r = run(['use', 'resume-with-ext.md']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('ext body'), `expected prompt body:\n${r.stdout}`);
    ok(existsSync(path.join(promptsDir, 'archived', 'resume-with-ext.md')), 'archived target exists');
  });

  it('refuses non-prompt files', () => {
    const file = path.join(docsDir, 'plan.md');
    writeFileSync(file, '---\ntype: plan\nstatus: active\n---\n# plan body\n');
    spawnSync('git', ['add', file], { cwd: tmpDir });
    spawnSync('git', ['commit', '-qm', 'add plan'], { cwd: tmpDir });

    const r = run(['prompts', 'use', file]);
    ok(r.status !== 0, 'non-zero exit');
    ok(r.stderr.includes('Not a prompt'), 'clear error');
  });

  it('refuses already-archived prompts', () => {
    const file = writePrompt('done', { status: 'archived' });
    const r = run(['prompts', 'use', file]);
    ok(r.status !== 0);
    ok(r.stderr.includes('Already consumed'));
  });

  it('refuses prompts physically under archived/ even when frontmatter drifted', () => {
    const archivedDir = path.join(docsDir, 'archived');
    mkdirSync(archivedDir, { recursive: true });
    const file = path.join(archivedDir, 'drifted.md');
    writeFileSync(file, `---\ntype: prompt\nstatus: pending\ncreated: 2025-01-01\n---\nSTALE BODY\n`);
    spawnSync('git', ['add', file], { cwd: tmpDir });
    spawnSync('git', ['commit', '-qm', 'add drifted archived prompt'], { cwd: tmpDir });

    const r = run(['prompts', 'use', file]);
    ok(r.status !== 0, 'archived-path prompt must not be consumed');
    ok(r.stderr.includes('Already consumed: docs/archived/drifted.md'), r.stderr);
    strictEqual(r.stdout, '', 'body must not leak from a physically archived prompt');
  });

  it('errors when file argument missing', () => {
    const r = run(['prompts', 'use']);
    ok(r.status !== 0);
    ok(r.stderr.includes('Usage'));
  });

  it('accepts a bare slug (no .md, no path) matching a prompt basename', () => {
    writePrompt('resume-ios-comms-color-tokens', { body: 'resume body' });
    const r = run(['prompts', 'use', 'resume-ios-comms-color-tokens']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('resume body'));
    ok(!existsSync(path.join(promptsDir, 'resume-ios-comms-color-tokens.md')), 'archived');
  });

  it('accepts slug with .md suffix', () => {
    writePrompt('with-ext', { body: 'ext body' });
    const r = run(['prompts', 'use', 'with-ext.md']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('ext body'));
  });

  it('falls back to substring match when no exact basename match', () => {
    writePrompt('resume-payments-final-phase', { body: 'substr body' });
    const r = run(['prompts', 'use', 'payments-final']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('substr body'));
  });

  it('errors with candidate list when substring matches multiple prompts', () => {
    writePrompt('resume-a-foo', { body: 'a' });
    writePrompt('resume-b-foo', { body: 'b' });
    const r = run(['prompts', 'use', 'foo']);
    ok(r.status !== 0);
    ok(r.stderr.includes('Multiple prompts'), `expected ambiguity error:\n${r.stderr}`);
    ok(r.stderr.includes('resume-a-foo'));
    ok(r.stderr.includes('resume-b-foo'));
  });

  it('errors clearly when slug matches nothing', () => {
    writePrompt('exists', { body: 'x' });
    const r = run(['prompts', 'use', 'does-not-exist']);
    ok(r.status !== 0);
    ok(r.stderr.includes('No prompt found'), `expected no-match error:\n${r.stderr}`);
  });

  // "It should be very pasteable" — every common form a user might paste
  // into the terminal must resolve to the same prompt. Don't let this drift.
  describe('pasteable input forms', () => {
    it('accepts `docs/prompts/<slug>` (repo-relative path, no .md)', () => {
      writePrompt('path-no-ext', { body: 'path-no-ext body' });
      const r = run(['prompts', 'use', 'docs/prompts/path-no-ext']);
      strictEqual(r.status, 0, r.stderr);
      ok(r.stdout.includes('path-no-ext body'));
    });

    it('accepts `docs/prompts/<slug>.md` (repo-relative path with .md)', () => {
      writePrompt('full-path', { body: 'full-path body' });
      const r = run(['prompts', 'use', 'docs/prompts/full-path.md']);
      strictEqual(r.status, 0, r.stderr);
      ok(r.stdout.includes('full-path body'));
    });

    it('accepts `prompts/<slug>.md` (docsRoot-relative)', () => {
      writePrompt('docsroot-rel', { body: 'docsroot-rel body' });
      const r = run(['prompts', 'use', 'prompts/docsroot-rel.md']);
      strictEqual(r.status, 0, r.stderr);
      ok(r.stdout.includes('docsroot-rel body'));
    });

    it('accepts `./docs/prompts/<slug>.md` (./ prefix)', () => {
      writePrompt('dot-prefix', { body: 'dot-prefix body' });
      const r = run(['prompts', 'use', './docs/prompts/dot-prefix.md']);
      strictEqual(r.status, 0, r.stderr);
      ok(r.stdout.includes('dot-prefix body'));
    });

    it('accepts an absolute path', () => {
      const target = writePrompt('abs-path', { body: 'abs-path body' });
      const r = run(['prompts', 'use', target]);
      strictEqual(r.status, 0, r.stderr);
      ok(r.stdout.includes('abs-path body'));
    });
  });
});

describe('a prompt is consumed only inside an agent session', () => {
  beforeEach(setupProject);

  // A plain terminal: every variable that can name a session cleared.
  function runOutside(args, extra = {}) {
    const env = { ...process.env };
    for (const variable of SESSION_ID_VARIABLES) delete env[variable];
    Object.assign(env, extra, { NO_COLOR: '1' });
    return spawnSync('node', [bin, ...args, '--config', configPath], { cwd: tmpDir, encoding: 'utf8', env });
  }

  function linkedPrompt(name, body) {
    const planDir = path.join(docsDir, 'plans');
    mkdirSync(planDir, { recursive: true });
    const plan = path.join(planDir, 'linked-work.md');
    writeFileSync(plan, '---\ntype: plan\nstatus: active\n---\n# Linked work\n');
    const file = writePrompt(name, { body });
    writeFileSync(file, readFileSync(file, 'utf8').replace('related_plans: []', 'plan: ../plans/linked-work.md'));
    return { file, plan };
  }

  for (const args of [['use', 'resume-linked'], ['use'], ['next'], ['prompts', 'use', 'resume-linked'], ['prompts', 'resume', 'resume-linked'], ['prompts', 'next']]) {
    it(`\`runlist ${args.join(' ')}\` outside a session prints the body and leaves the prompt and its plan alone`, () => {
      const { file, plan } = linkedPrompt('resume-linked', 'OUTSIDE-BODY');
      const r = runOutside(args, { TERM_SESSION_ID: 'a-terminal-window' });
      strictEqual(r.status, 0, r.stderr);
      match(r.stdout, /OUTSIDE-BODY/);
      const lines = r.stdout.trimEnd().split('\n');
      match(lines.at(-1), /only inside an agent session.*`runlist prompts use docs\/prompts\/resume-linked\.md`/);
      ok(existsSync(file), 'the prompt stays pending');
      ok(!existsSync(path.join(promptsDir, 'archived', 'resume-linked.md')), 'nothing archived');
      match(readFileSync(file, 'utf8'), /^status: pending$/m);
      match(readFileSync(plan, 'utf8'), /^status: active$/m);
      ok(!r.stderr.includes('Claimed'), r.stderr);
      ok(!existsSync(path.join(tmpDir, '.runlist', 'ownership')), 'no ownership record written');
    });
  }

  it('inside a Claude Code session the same command archives the prompt and claims its plan', () => {
    const { file, plan } = linkedPrompt('resume-linked', 'INSIDE-BODY');
    const r = runOutside(['use', 'resume-linked'], { CLAUDE_CODE_SESSION_ID: 'claude-session' });
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /INSIDE-BODY/);
    ok(!r.stdout.includes('only inside an agent session'), r.stdout);
    ok(!existsSync(file), 'source archived');
    ok(existsSync(path.join(promptsDir, 'archived', 'resume-linked.md')));
    match(readFileSync(plan, 'utf8'), /^status: in-session$/m);
    match(r.stderr, /Claimed.*linked-work\.md/);
  });

  it('RUNLIST_SESSION_ID counts as a session', () => {
    const { file, plan } = linkedPrompt('resume-linked', 'EXPLICIT-BODY');
    const r = runOutside(['prompts', 'use', 'resume-linked'], { RUNLIST_SESSION_ID: 'explicit-session' });
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /EXPLICIT-BODY/);
    ok(!existsSync(file), 'source archived');
    match(readFileSync(plan, 'utf8'), /^status: in-session$/m);
  });

  it('`--dry-run` outside a session still previews the consume', () => {
    const file = writePrompt('resume-dry', { body: 'DRY-BODY' });
    const r = runOutside(['prompts', 'next', '--dry-run']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /Would emit body and archive/);
    ok(existsSync(file));
  });

  it('`prompts show` outside a session is unchanged', () => {
    const { file } = linkedPrompt('resume-linked', 'SHOW-BODY');
    const r = runOutside(['prompts', 'show', 'resume-linked']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stdout, /SHOW-BODY/);
    ok(!r.stdout.includes('only inside an agent session'));
    ok(existsSync(file));
  });
});

describe('runlist prompts archive', () => {
  beforeEach(setupProject);

  it('archives without emitting body to stdout', () => {
    const file = writePrompt('foo', { body: 'should-not-appear' });
    const r = run(['prompts', 'archive', file]);
    strictEqual(r.status, 0, r.stderr);
    ok(!r.stdout.includes('should-not-appear'), 'body suppressed');
    ok(!existsSync(file), 'archived');
  });

  it('refuses non-prompt files', () => {
    const file = path.join(docsDir, 'plan.md');
    writeFileSync(file, '---\ntype: plan\nstatus: active\n---\n');
    spawnSync('git', ['add', file], { cwd: tmpDir });
    spawnSync('git', ['commit', '-qm', 'add plan'], { cwd: tmpDir });

    const r = run(['prompts', 'archive', file]);
    ok(r.status !== 0);
    ok(r.stderr.includes('Not a prompt'));
  });

  it('accepts a bare slug', () => {
    writePrompt('cleanup-todo', { body: 'should-not-appear' });
    const r = run(['prompts', 'archive', 'cleanup-todo']);
    strictEqual(r.status, 0, r.stderr);
    ok(!existsSync(path.join(promptsDir, 'cleanup-todo.md')), 'archived by slug');
  });
});

describe('runlist prompts show', () => {
  beforeEach(setupProject);

  it('prints the body WITHOUT consuming', () => {
    const file = writePrompt('peek-me', { body: 'peek body text' });
    const r = run(['prompts', 'show', 'peek-me']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('peek body text'), `body printed:\n${r.stdout}`);
    ok(existsSync(file), 'prompt NOT archived by show');
    const after = readFileSync(file, 'utf8');
    ok(after.includes('status: pending'), 'status unchanged');
  });

  it('notes the read-only nature and the consume path on stderr', () => {
    writePrompt('peek-me');
    const r = run(['prompts', 'show', 'peek-me']);
    match(r.stderr, /read-only peek/);
    match(r.stderr, /runlist use/);
  });

  it('`peek` is an alias', () => {
    const file = writePrompt('peek-me', { body: 'peek body text' });
    const r = run(['prompts', 'peek', 'peek-me']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('peek body text'));
    ok(existsSync(file), 'not consumed');
  });

  it('refuses non-prompt files', () => {
    const file = path.join(docsDir, 'plan.md');
    writeFileSync(file, '---\ntype: plan\nstatus: active\n---\nbody\n');
    const r = run(['prompts', 'show', file]);
    ok(r.status !== 0);
    ok(r.stderr.includes('Not a prompt'));
  });

  // Bulk triage: sweeping the queue was the one thing show could not do, so
  // sessions fell back to Read and tripped the guard once per file.
  it('--all peeks every pending prompt without consuming any', () => {
    const a = writePrompt('alpha', { body: 'alpha body text' });
    const b = writePrompt('beta', { body: 'beta body text' });
    const r = run(['prompts', 'show', '--all']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('alpha body text'), r.stdout);
    ok(r.stdout.includes('beta body text'), r.stdout);
    ok(existsSync(a) && existsSync(b), 'neither prompt consumed');
    match(r.stdout, /alpha\.md \[pending\]/);
    match(r.stdout, /beta\.md \[pending\]/);
  });

  it('accepts several prompts by name', () => {
    writePrompt('alpha', { body: 'alpha body text' });
    writePrompt('beta', { body: 'beta body text' });
    writePrompt('gamma', { body: 'gamma body text' });
    const r = run(['prompts', 'show', 'alpha', 'gamma']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('alpha body text'));
    ok(r.stdout.includes('gamma body text'));
    ok(!r.stdout.includes('beta body text'), 'unnamed prompt not shown');
  });

  it('--limit caps the sweep and says so', () => {
    writePrompt('alpha', { body: 'alpha body text' });
    writePrompt('beta', { body: 'beta body text' });
    const r = run(['prompts', 'show', '--all', '--limit', '1']);
    strictEqual(r.status, 0, r.stderr);
    match(r.stderr, /1 prompt of 2/);
  });

  it('single-prompt output keeps the bare body on stdout', () => {
    writePrompt('solo', { body: 'solo body text' });
    const r = run(['prompts', 'show', 'solo']);
    strictEqual(r.status, 0, r.stderr);
    ok(!r.stdout.includes('────'), 'no separator for a single prompt');
    match(r.stderr, /read-only peek/);
  });

  it('rejects --all together with names, and a bad --limit', () => {
    writePrompt('alpha');
    ok(run(['prompts', 'show', '--all', 'alpha']).status !== 0);
    ok(run(['prompts', 'show', '--all', '--limit', '0']).status !== 0);
  });
});

describe('a prompt is pending or archived, and nothing else', () => {
  beforeEach(setupProject);

  // Removed 2026-08-30 with `held`/`shelved`/`claimed`: a prompt directs work,
  // so parking one instead of archiving it left work state outside the plan
  // that owned it, fighting with that plan's own status. These assert the
  // states are gone rather than merely unused.

  it('rejects `held` as a prompt status', () => {
    const file = writePrompt('parked', { status: 'pending' });
    const r = run(['set', 'held', file]);
    ok(r.status !== 0, `held must not be settable on a prompt:\n${r.stdout}${r.stderr}`);
  });

  it('rejects `shelved` as a prompt status', () => {
    const file = writePrompt('shelf', { status: 'pending' });
    const r = run(['set', 'shelved', file]);
    ok(r.status !== 0, `shelved must not be settable on a prompt:\n${r.stdout}${r.stderr}`);
  });

  it('`prompts hold` and its aliases no longer exist', () => {
    writePrompt('todo-later', { status: 'pending' });
    for (const sub of ['hold', 'unhold', 'shelve', 'unshelve']) {
      const r = run(['prompts', sub, 'todo-later']);
      ok(r.status !== 0, `prompts ${sub} should be gone, got exit 0`);
    }
    ok(!existsSync(path.join(promptsDir, 'held')), 'no prompts/held/ bucket should be created');
  });

  it('`prompts list` shows pending prompts and nothing is filed elsewhere', () => {
    writePrompt('active-one', { status: 'pending' });
    writePrompt('other-one', { status: 'pending' });
    const r = run(['prompts', 'list']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('active-one'), `list should show pending:\n${r.stdout}`);
    ok(r.stdout.includes('other-one'), `list should show pending:\n${r.stdout}`);
    ok(!existsSync(path.join(promptsDir, 'held')), 'archived is the only directory');
  });

  it('archiving is the only way a prompt leaves the pending list', () => {
    writePrompt('done-with', { status: 'pending' });
    const r = run(['prompts', 'archive', 'done-with']);
    strictEqual(r.status, 0, r.stderr);
    const listed = run(['prompts', 'list']);
    ok(!listed.stdout.includes('done-with'), `archived prompt should leave the list:\n${listed.stdout}`);
  });

  it('`prompts next` reports an empty queue when nothing is pending', () => {
    const r = run(['prompts', 'next']);
    ok(r.status !== 0, 'non-zero exit when no pending');
    ok(r.stderr.includes('No pending prompts'), `expected empty-queue error:\n${r.stderr}`);
  });
});

describe('runlist prompts new', () => {
  beforeEach(setupProject);

  it('creates a new prompt with given body', () => {
    const r = run(['prompts', 'new', 'fresh-prompt', 'inline body content']);
    strictEqual(r.status, 0, r.stderr);

    const created = path.join(promptsDir, 'fresh-prompt.md');
    ok(existsSync(created), 'file created');
    const content = readFileSync(created, 'utf8');
    ok(content.includes('type: prompt'));
    ok(content.includes('status: pending'));
    ok(content.includes('inline body content'));
  });

  it('errors without slug', () => {
    const r = run(['prompts', 'new']);
    ok(r.status !== 0);
    ok(r.stderr.includes('Usage'));
  });
});

describe('a prompt named as session start lists it', () => {
  beforeEach(() => setupProject());
  it('`use <name>` takes the live prompt over its consumed copies under archived/', () => {
    writePrompt('resume-twin', { body: 'the live one' });
    mkdirSync(path.join(promptsDir, 'archived'), { recursive: true });
    writeFileSync(path.join(promptsDir, 'archived', 'resume-twin.md'), '---\ntype: prompt\nstatus: archived\ncreated: 2024-01-01\n---\nthe old one\n');
    const r = run(['use', 'resume-twin']);
    strictEqual(r.status, 0, r.stderr);
    ok(r.stdout.includes('the live one'), r.stdout);
  });
});
