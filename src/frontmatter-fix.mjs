import { readFileSync, writeFileSync } from 'node:fs';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, escapeRegex, warn } from './util.mjs';
import { collectDocFiles } from './index.mjs';
import { bold, green, dim } from './color.mjs';

// Caps must stay in lockstep with the warnings emitted by validatePlanShape in
// src/validate.mjs — that's where the user first sees these numbers. Targets
// are deliberately under the cap so a fix-then-edit cycle doesn't reintroduce
// the warning on the next few-word touch-up.
const FIELDS = [
  { name: 'current_state', cap: 1500, target: 1200, heading: '## Current State' },
  { name: 'next_step',     cap: 800,  target: 600,  heading: '## Next Step' },
];

export function runFrontmatterFix(config, opts = {}) {
  const { dryRun, out = process.stdout } = opts;
  const allFiles = collectDocFiles(config);
  const results = [];

  for (const filePath of allFiles) {
    const raw = readFileSync(filePath, 'utf8');
    const { frontmatter: fm, body } = extractFrontmatter(raw);
    if (!fm) continue;
    const parsed = parseSimpleFrontmatter(fm);
    const docType = asString(parsed.type);
    // The warnings only fire for type: plan (validatePlanShape). Untyped docs
    // skip the warning too, so skip them here as well — auto-injecting a
    // `## Current State` into a non-plan doc would be surprising.
    if (docType !== 'plan') continue;

    const ops = [];
    for (const { name, cap, target, heading } of FIELDS) {
      const value = asString(parsed[name]);
      if (!value || value.length <= cap) continue;
      const { head, tail } = splitAtBoundary(value, target);
      if (!tail) continue;
      ops.push({ field: name, heading, before: value.length, head, tail });
    }
    if (ops.length === 0) continue;

    let newFm = fm;
    let newBody = body;
    for (const op of ops) {
      newFm = replaceFrontmatterField(newFm, op.field, op.head);
      newBody = insertOrAppendSection(newBody, op.heading, op.tail);
    }

    if (!dryRun) {
      writeFileSync(filePath, `---\n${newFm}\n---\n${newBody}`, 'utf8');
      try { config.hooks.onLint?.({ path: toRepoPath(filePath, config.repoRoot), fixes: ops.map(o => ({ field: o.field, type: 'frontmatter-fix' })) }); } catch (err) { warn(`Hook 'onLint' threw: ${err.message}`); }
    }
    results.push({ filePath, repoPath: toRepoPath(filePath, config.repoRoot), ops });
  }

  const prefix = dryRun ? dim('[dry-run] ') : '';
  const banner = dryRun ? dim(' [preview — run without --dry-run to write]') : '';
  out.write(bold('dotmd doctor --frontmatter-fix') + banner + '\n\n');

  if (results.length === 0) {
    out.write(green('No over-cap fields found.') + '\n');
    return { results };
  }

  out.write(`${results.length} file(s) with over-cap fields:\n\n`);
  for (const r of results) {
    out.write(`  ${r.repoPath}\n`);
    for (const op of r.ops) {
      const moved = op.before - op.head.length;
      out.write(dim(`    ${prefix}${op.field}: ${op.before} → ${op.head.length} chars (moved ${moved} to \`${op.heading}\`)\n`));
    }
  }
  out.write(`\n${prefix}${green(dryRun ? 'Would fix' : 'Fixed')}: ${results.length} file(s)\n`);
  return { results };
}

// Splits at the last sentence-ending punctuation (`.!?` + space/newline/EOS)
// within `target` chars. If no good sentence boundary lands in the back half of
// the window, falls back to the last whitespace. If even that fails, a hard
// cut at `target` — the result still parses; readability just suffers.
export function splitAtBoundary(value, target) {
  if (value.length <= target) return { head: value, tail: '' };

  const windowStr = value.slice(0, target);
  // Sentence boundary: greedy match capturing everything up to the last `.!?`
  // followed by whitespace or end-of-string inside the window.
  const sentenceRe = /^[\s\S]*[.!?](?=\s|$)/;
  const sentenceMatch = windowStr.match(sentenceRe);
  if (sentenceMatch && sentenceMatch[0].length >= Math.floor(target / 2)) {
    const splitIdx = sentenceMatch[0].length;
    return {
      head: value.slice(0, splitIdx).trim(),
      tail: value.slice(splitIdx).trim(),
    };
  }

  const wsIdx = Math.max(windowStr.lastIndexOf(' '), windowStr.lastIndexOf('\n'));
  if (wsIdx >= Math.floor(target / 2)) {
    return {
      head: value.slice(0, wsIdx).trim(),
      tail: value.slice(wsIdx + 1).trim(),
    };
  }

  return {
    head: value.slice(0, target).trim(),
    tail: value.slice(target).trim(),
  };
}

// Replace a single frontmatter scalar with a folded block scalar (`key: >\n  …`).
// Folded form is safe regardless of YAML-special chars in the value (colons,
// quotes, leading dashes) and matches what `parseSimpleFrontmatter` already
// reads. Consumes the existing key's continuation block if it was multi-line.
export function replaceFrontmatterField(fm, key, newValue) {
  const lines = fm.split('\n');
  const out = [];
  let i = 0;
  let replaced = false;

  while (i < lines.length) {
    const line = lines[i];
    const keyRe = new RegExp(`^${escapeRegex(key)}:(.*)$`);
    const match = !replaced && line.match(keyRe);
    if (match) {
      const rest = match[1].trim();
      const isBlock = /^[>|][-+]?\s*$/.test(rest);
      i++;
      if (isBlock || rest === '') {
        // Consume continuation: blank or indented lines until the next
        // top-level key. The parser uses the same dedent rule (block scalar
        // ends when indent returns to 0 and the line is non-blank).
        while (i < lines.length) {
          if (/^[A-Za-z0-9_-]+:/.test(lines[i])) break;
          i++;
        }
      }
      const folded = foldBlockScalar(newValue);
      out.push(`${key}: >`);
      for (const fLine of folded) out.push(`  ${fLine}`);
      replaced = true;
      continue;
    }
    out.push(line);
    i++;
  }

  if (!replaced) {
    const folded = foldBlockScalar(newValue);
    out.push(`${key}: >`);
    for (const fLine of folded) out.push(`  ${fLine}`);
  }

  return out.join('\n');
}

// Collapse whitespace into a single line — folded block scalar joins on a
// single space anyway, so writing one wide line keeps the diff tight and
// round-trips identically.
function foldBlockScalar(value) {
  const single = value.replace(/\s+/g, ' ').trim();
  return [single];
}

// Ensure a `## <heading>` section exists in the body and contains `content`.
// If the section is present (case-insensitive heading match), append the new
// content to its end. If absent, insert a new section just before the first
// H2 (so it lands above other content sections) — or append at end if no H2
// exists.
export function insertOrAppendSection(body, heading, content) {
  const headingPattern = new RegExp(`^${escapeRegex(heading)}\\s*$`, 'mi');
  const existing = body.match(headingPattern);
  if (existing && existing.index !== undefined) {
    const startIdx = existing.index + existing[0].length;
    const after = body.slice(startIdx);
    const nextHeaderRel = after.search(/\n#{1,2}\s+/);
    const sectionEnd = nextHeaderRel >= 0 ? startIdx + nextHeaderRel : body.length;
    const before = body.slice(0, sectionEnd).replace(/\s+$/, '');
    const rest = body.slice(sectionEnd);
    return `${before}\n\n${content}\n${rest.startsWith('\n') ? rest : '\n' + rest}`;
  }

  const firstH2 = body.match(/^##\s+/m);
  if (firstH2 && firstH2.index !== undefined) {
    const insertIdx = firstH2.index;
    const before = body.slice(0, insertIdx).replace(/\s+$/, '');
    const rest = body.slice(insertIdx);
    return `${before}\n\n${heading}\n\n${content}\n\n${rest}`;
  }

  const trimmed = body.replace(/\s+$/, '');
  return `${trimmed}\n\n${heading}\n\n${content}\n`;
}
