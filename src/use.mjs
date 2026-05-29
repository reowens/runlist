import { readFileSync } from 'node:fs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, die, resolveDocPath, toRepoPath } from './util.mjs';
import { consumePrompt, pendingPromptsOldestFirst, resolvePromptInput } from './prompts.mjs';
import { runPickup } from './lifecycle.mjs';

// Top-level `dotmd use [file]` — the single "start engaging with this doc"
// verb. Dispatches by the target doc's `type:` so agents don't have to know
// the verb-per-type rule:
//   - prompt → print body + archive (one-shot consume)
//   - plan   → acquire lease + print body (same as `set in-session`)
//   - doc    → print body (read-only)
// With no argument, consumes the oldest pending prompt.
export async function runUse(argv, config, opts = {}) {
  const positional = argv.find(a => !a.startsWith('-'));

  if (!positional) {
    const queue = pendingPromptsOldestFirst(config);
    if (queue.length === 0) die('No pending prompts. Pass a file to use a plan or doc.');
    const head = queue[0];
    if (!head.abs) die(`Could not resolve path: ${head.doc.path}`);
    return consumePrompt(head.abs, config, opts);
  }

  const filePath = resolveDocPath(positional, config) ?? resolvePromptInput(positional, config, { dieOnMiss: false });
  if (!filePath) die(`File not found: ${positional}`);

  const raw = readFileSync(filePath, 'utf8');
  const { frontmatter } = extractFrontmatter(raw);
  const parsed = parseSimpleFrontmatter(frontmatter);
  const type = asString(parsed.type);

  if (type === 'prompt') {
    return consumePrompt(filePath, config, opts);
  }
  if (type === 'plan') {
    // Delegate to the lease-acquisition path. Same flow as `set in-session`.
    return runPickup([filePath, ...argv.filter(a => a !== positional)], config, opts);
  }
  // Anything else (doc, untyped, custom): print the body. The frontmatter
  // already names everything an agent needs to know about lifecycle for that
  // type, so the verb stays a no-op read for non-actionable types.
  process.stdout.write(raw);
  if (!raw.endsWith('\n')) process.stdout.write('\n');
  process.stderr.write(`${toRepoPath(filePath, config.repoRoot)} (${type ?? 'untyped'})\n`);
}
