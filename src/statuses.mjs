// `dotmd statuses` — manage per-project status taxonomy without hand-editing
// the rich-form object in dotmd.config.mjs. Subcommands:
//
//   list                  table view of every status × type
//   add <name>            add a new status (use --like <existing> to clone)
//   set <name>            edit flags on an existing status
//   remove <name>         delete a status (refuses if any docs use it)
//   migrate <type>        convert array-form statuses to rich-form

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { collectDocFiles } from './index.mjs';
import { asString, toRepoPath, die } from './util.mjs';
import { bold, dim, green, yellow } from './color.mjs';
import { isInteractive, promptText } from './prompt.mjs';
import {
  parseStatusesBlock,
  renderEntryLine,
  spliceEntry,
  replaceEntry,
  deleteEntry,
  inferIndent,
  hasExplicitLifecycle,
  validateStatusName,
  writeConfigAtomic,
  ConfigEditError,
} from './config-edit.mjs';

const FLAG_PROPS = ['context', 'staleDays', 'requiresModule', 'terminal', 'archive', 'skipStale', 'skipWarnings', 'quiet'];
const BOOLEAN_FLAGS = ['requiresModule', 'terminal', 'archive', 'skipStale', 'skipWarnings', 'quiet'];

export async function runStatuses(argv, config, opts = {}) {
  const sub = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'list';
  const rest = sub === argv[0] ? argv.slice(1) : argv;
  // The dispatcher strips global `--type`; surface it back so subcommands see it.
  if (opts.type && !rest.includes('--type')) {
    rest.unshift('--type', opts.type);
  }
  try {
    switch (sub) {
      case 'list': return runListStatuses(rest, config);
      case 'add': return await runAddStatus(rest, config, opts);
      case 'set': return await runSetStatus(rest, config, opts);
      case 'remove': return await runRemoveStatus(rest, config, opts);
      case 'migrate': return await runMigrateType(rest, config, opts);
      default:
        die(`Unknown statuses subcommand: '${sub}'\nUse: list, add, set, remove, migrate`);
    }
  } catch (err) {
    if (err instanceof ConfigEditError) die(err.message);
    throw err;
  }
}

// ─── list ────────────────────────────────────────────────────────────────────

function runListStatuses(args, config) {
  const flags = parseFlags(args, { allowProps: false });
  const types = flags.type ? flags.type.split(',').map(t => t.trim()).filter(Boolean) : [...config.validTypes];

  // For each type, derive a flag table from config.raw.
  const out = { types: {} };
  for (const t of types) {
    if (!config.validTypes.has(t)) {
      die(`Unknown type: '${t}'. Known: ${[...config.validTypes].join(', ')}`);
    }
    out.types[t] = describeTypeStatuses(t, config);
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  for (const [t, statuses] of Object.entries(out.types)) {
    process.stdout.write(`${bold(`type: ${t}`)}\n`);
    if (Object.keys(statuses).length === 0) {
      process.stdout.write(`  (no statuses defined)\n\n`);
      continue;
    }
    const headers = ['status', ...FLAG_PROPS];
    const rows = [headers];
    for (const [name, props] of Object.entries(statuses)) {
      rows.push([name, ...FLAG_PROPS.map(p => formatPropDisplay(props[p]))]);
    }
    const widths = headers.map((_, c) => Math.max(...rows.map(r => String(r[c] ?? '').length)));
    for (let r = 0; r < rows.length; r++) {
      const cells = rows[r].map((v, c) => String(v ?? '').padEnd(widths[c]));
      const line = '  ' + cells.join('  ');
      process.stdout.write((r === 0 ? dim(line) : line) + '\n');
    }
    process.stdout.write('\n');
  }
}

function describeTypeStatuses(typeName, config) {
  const typeDef = config.raw?.types?.[typeName];
  if (!typeDef) return {};
  const result = {};
  // After resolveConfig, rich-form types have been normalized into an array.
  // Reconstruct each status's effective flags from derived sets.
  const statusList = Array.isArray(typeDef.statuses) ? typeDef.statuses : Object.keys(typeDef.statuses ?? {});
  const ctx = typeDef.context ?? {};
  const ctxByStatus = {};
  for (const [bucket, names] of Object.entries(ctx)) {
    for (const n of names) ctxByStatus[n] = bucket;
  }
  const stale = typeDef.staleDays ?? {};
  const lc = config.lifecycle;
  const moduleReq = config.moduleRequiredStatuses;

  for (const name of statusList) {
    const skipStale = lc.skipStaleFor.has(name);
    const skipWarnings = lc.skipWarningsFor.has(name);
    const quiet = skipStale && skipWarnings;
    result[name] = {
      context: ctxByStatus[name] ?? null,
      staleDays: stale[name] ?? null,
      requiresModule: moduleReq.has(name),
      terminal: lc.terminalStatuses.has(name),
      archive: lc.archiveStatuses.has(name),
      skipStale,
      skipWarnings,
      quiet,
    };
  }
  return result;
}

function formatPropDisplay(v) {
  if (v === null || v === undefined) return '—';
  if (v === true) return 'true';
  if (v === false) return 'false';
  return String(v);
}

// ─── add ─────────────────────────────────────────────────────────────────────

async function runAddStatus(args, config, opts) {
  const flags = parseFlags(args, { allowProps: true });
  const name = flags.positional[0];
  if (!name) die('Usage: dotmd statuses add <name> --type <type> [--like <existing>] [flags]');
  if (!flags.type) die('--type is required for `dotmd statuses add`.');

  const validationErr = validateStatusName(name);
  if (validationErr) die(validationErr);

  requireConfigPath(config);
  const content = readFileSync(config.configPath, 'utf8');
  const parsed = parseStatusesBlock(content, flags.type);
  if (parsed.form === 'array') {
    die(`Type '${flags.type}' uses array-form statuses. Run \`dotmd statuses migrate ${flags.type}\` first to convert to rich form.`);
  }

  if (parsed.entries.some(e => e.name === name)) {
    die(`Status '${name}' already exists in type '${flags.type}'. Use \`dotmd statuses set\` to edit it.`);
  }

  // Resolve --like base flags
  let baseProps = {};
  let likeName = null;
  if (flags.like) {
    likeName = flags.like;
    const likeEntry = parsed.entries.find(e => e.name === likeName);
    if (!likeEntry) {
      die(`--like target '${likeName}' is not defined in type '${flags.type}'.`);
    }
    if (likeEntry.multiLine) {
      die(`--like target '${likeName}' spans multiple lines in dotmd.config.mjs; this CLI only edits single-line entries.`);
    }
    baseProps = parseEntryProps(likeEntry.raw);
  }

  // Build final props by overlaying user flags on base.
  const finalProps = { ...baseProps };
  for (const [k, v] of Object.entries(flags.props)) finalProps[k] = v;
  if (Object.keys(finalProps).length === 0) {
    die(`Provide at least one flag (e.g. --context listed) or --like <existing>.`);
  }

  const overrideErr = checkLifecycleOverride(content, flags.ignoreLifecycle);
  if (overrideErr) die(overrideErr);

  // Determine insertion position: before first entry with terminal:true or archive:true.
  let beforeName = null;
  for (const e of parsed.entries) {
    const p = parseEntryProps(e.raw);
    if (p.terminal === true || p.archive === true) { beforeName = e.name; break; }
  }

  const indent = inferIndent(content, parsed);
  const newLine = renderEntryLine(name, finalProps, indent);

  printAddDiff(name, flags.type, likeName, baseProps, finalProps, flags.props);

  if (opts.dryRun) {
    process.stdout.write(`${dim('[dry-run]')} would write to ${path.relative(process.cwd(), config.configPath)}\n`);
    return;
  }

  if (!flags.yes && !await confirm()) {
    process.stdout.write('Aborted.\n');
    return;
  }

  const updated = spliceEntry(content, parsed, newLine, beforeName);
  await writeConfigAtomic(config.configPath, updated, config.configDir);
  process.stdout.write(`${green('Added')} '${name}' to types.${flags.type}.statuses\n`);
}

function printAddDiff(name, typeName, likeName, baseProps, finalProps, userProps) {
  process.stdout.write(`${bold(`Adding '${name}' to types.${typeName}.statuses`)}\n`);
  if (likeName) {
    process.stdout.write(`Cloned from '${likeName}' (--like ${likeName}):\n`);
  }
  const allKeys = [...new Set([...Object.keys(baseProps), ...Object.keys(finalProps)])];
  const keyOrder = FLAG_PROPS.filter(p => allKeys.includes(p)).concat(allKeys.filter(k => !FLAG_PROPS.includes(k)));
  const labelW = Math.max(...keyOrder.map(k => k.length)) + 1;
  for (const key of keyOrder) {
    const before = baseProps[key];
    const after = finalProps[key];
    const beforeStr = before === undefined ? '—' : formatPropDisplay(before);
    const afterStr = after === undefined ? '—' : formatPropDisplay(after);
    let suffix;
    if (beforeStr === afterStr) suffix = dim('(same)');
    else if (before === undefined) suffix = dim(`(set by ${labelOrigin(key, userProps)})`);
    else suffix = dim(`(${labelOrigin(key, userProps)})`);
    const arrow = beforeStr === afterStr ? beforeStr : `${beforeStr} → ${afterStr}`;
    process.stdout.write(`  ${(key + ':').padEnd(labelW)} ${arrow.padEnd(28)} ${suffix}\n`);
  }
  process.stdout.write('\n');
}

function labelOrigin(key, userProps) {
  if (key in userProps) {
    if (userProps.quiet === true && (key === 'skipStale' || key === 'skipWarnings') && !(key in userProps)) {
      return 'added by --quiet';
    }
    return `--${key}`;
  }
  if (userProps.quiet === true && (key === 'skipStale' || key === 'skipWarnings')) {
    return 'added by --quiet';
  }
  return 'inherited';
}

// ─── set ─────────────────────────────────────────────────────────────────────

async function runSetStatus(args, config, opts) {
  const flags = parseFlags(args, { allowProps: true });
  const name = flags.positional[0];
  if (!name) die('Usage: dotmd statuses set <name> --type <type> [flags]');
  if (!flags.type) die('--type is required for `dotmd statuses set`.');
  if (Object.keys(flags.props).length === 0) {
    die('At least one flag is required (e.g. --quiet, --staleDays 30).');
  }

  requireConfigPath(config);
  const content = readFileSync(config.configPath, 'utf8');
  const parsed = parseStatusesBlock(content, flags.type);
  if (parsed.form === 'array') {
    die(`Type '${flags.type}' uses array-form statuses. Run \`dotmd statuses migrate ${flags.type}\` first.`);
  }

  const existing = parsed.entries.find(e => e.name === name);
  if (!existing) {
    die(`Status '${name}' is not defined in type '${flags.type}'. Use \`dotmd statuses add\` to create it.`);
  }
  if (existing.multiLine) {
    die(`Status '${name}' spans multiple lines in dotmd.config.mjs; edit it by hand.`);
  }

  const oldProps = parseEntryProps(existing.raw);
  const newProps = { ...oldProps };
  for (const [k, v] of Object.entries(flags.props)) newProps[k] = v;

  const overrideErr = checkLifecycleOverride(content, flags.ignoreLifecycle);
  if (overrideErr) die(overrideErr);

  const indent = (existing.raw.match(/^(\s*)/) ?? [''])[1] || '    ';
  const newLine = renderEntryLine(name, newProps, indent);

  printSetDiff(name, flags.type, oldProps, newProps, flags.props);

  if (opts.dryRun) {
    process.stdout.write(`${dim('[dry-run]')} would write to ${path.relative(process.cwd(), config.configPath)}\n`);
    return;
  }
  if (!flags.yes && !await confirm()) {
    process.stdout.write('Aborted.\n');
    return;
  }

  const updated = replaceEntry(content, parsed, name, newLine);
  await writeConfigAtomic(config.configPath, updated, config.configDir);
  process.stdout.write(`${green('Updated')} '${name}' in types.${flags.type}.statuses\n`);
}

function printSetDiff(name, typeName, oldProps, newProps, userProps) {
  process.stdout.write(`${bold(`Updating '${name}' in types.${typeName}.statuses`)}\n`);
  const allKeys = [...new Set([...Object.keys(oldProps), ...Object.keys(newProps)])];
  const keyOrder = FLAG_PROPS.filter(p => allKeys.includes(p)).concat(allKeys.filter(k => !FLAG_PROPS.includes(k)));
  const labelW = Math.max(...keyOrder.map(k => k.length)) + 1;
  for (const key of keyOrder) {
    const before = oldProps[key];
    const after = newProps[key];
    const beforeStr = before === undefined ? '—' : formatPropDisplay(before);
    const afterStr = after === undefined ? '—' : formatPropDisplay(after);
    const changed = beforeStr !== afterStr;
    const arrow = changed ? `${beforeStr} → ${afterStr}` : beforeStr;
    const origin = key in userProps ? `--${key}` : 'unchanged';
    const suffix = changed ? dim(`(${origin})`) : dim('(same)');
    process.stdout.write(`  ${(key + ':').padEnd(labelW)} ${arrow.padEnd(28)} ${suffix}\n`);
  }
  process.stdout.write('\n');
}

// ─── remove ──────────────────────────────────────────────────────────────────

async function runRemoveStatus(args, config, opts) {
  const flags = parseFlags(args, { allowProps: false });
  const name = flags.positional[0];
  if (!name) die('Usage: dotmd statuses remove <name> --type <type>');
  if (!flags.type) die('--type is required for `dotmd statuses remove`.');

  requireConfigPath(config);
  const content = readFileSync(config.configPath, 'utf8');
  const parsed = parseStatusesBlock(content, flags.type);
  if (parsed.form === 'array') {
    die(`Type '${flags.type}' uses array-form statuses. Run \`dotmd statuses migrate ${flags.type}\` first.`);
  }
  if (!parsed.entries.find(e => e.name === name)) {
    die(`Status '${name}' is not defined in type '${flags.type}'.`);
  }

  // Check for docs using this status
  const offenders = findDocsByStatus(config, name);
  if (offenders.length > 0) {
    const list = offenders.slice(0, 10).map(p => `  - ${p}`).join('\n');
    const more = offenders.length > 10 ? `\n  ... and ${offenders.length - 10} more` : '';
    die(`${offenders.length} doc(s) currently use status '${name}':\n${list}${more}\n\nMigrate them first: \`dotmd migrate status ${name} <other> [files...]\``);
  }

  // Warn (don't refuse) if explicit lifecycle references the name.
  const lifeRef = scanLifecycleReferences(content, name);
  if (lifeRef.length > 0) {
    process.stderr.write(yellow(`Warning: explicit lifecycle export references '${name}' in: ${lifeRef.join(', ')}. Update those manually.\n`));
  }

  const overrideErr = checkLifecycleOverride(content, flags.ignoreLifecycle);
  if (overrideErr) die(overrideErr);

  process.stdout.write(`${bold(`Removing '${name}' from types.${flags.type}.statuses`)}\n`);
  if (opts.dryRun) {
    process.stdout.write(`${dim('[dry-run]')} would write to ${path.relative(process.cwd(), config.configPath)}\n`);
    return;
  }
  if (!flags.yes && !await confirm()) {
    process.stdout.write('Aborted.\n');
    return;
  }

  const updated = deleteEntry(content, parsed, name);
  await writeConfigAtomic(config.configPath, updated, config.configDir);
  process.stdout.write(`${green('Removed')} '${name}' from types.${flags.type}.statuses\n`);
}

function findDocsByStatus(config, statusName) {
  const offenders = [];
  for (const filePath of collectDocFiles(config)) {
    let raw;
    try { raw = readFileSync(filePath, 'utf8'); }
    catch { continue; }
    const { frontmatter } = extractFrontmatter(raw);
    if (!frontmatter) continue;
    const fm = parseSimpleFrontmatter(frontmatter);
    if (asString(fm.status) === statusName) {
      offenders.push(toRepoPath(filePath, config.repoRoot));
    }
  }
  return offenders;
}

function scanLifecycleReferences(content, name) {
  // Simple text scan inside the lifecycle block for the name.
  const m = content.match(/export\s+const\s+lifecycle\s*=\s*\{/);
  if (!m) return [];
  const start = m.index + m[0].length;
  const end = findMatchingBrace(content, start - 1);
  if (end === -1) return [];
  const block = content.slice(start, end);
  const buckets = ['archiveStatuses', 'skipStaleFor', 'skipWarningsFor', 'terminalStatuses'];
  const found = [];
  for (const b of buckets) {
    const re = new RegExp(`${b}\\s*:[^\\]]*\\b${name}\\b`);
    if (re.test(block)) found.push(b);
  }
  return found;
}

function findMatchingBrace(content, openPos) {
  if (content[openPos] !== '{') return -1;
  let depth = 1;
  let i = openPos + 1;
  while (i < content.length && depth > 0) {
    const c = content[i];
    if (c === '\'' || c === '"') {
      const q = c;
      i++;
      while (i < content.length && content[i] !== q) {
        if (content[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

// ─── migrate (array → rich) ──────────────────────────────────────────────────

async function runMigrateType(args, config, opts) {
  const flags = parseFlags(args, { allowProps: false });
  const typeName = flags.positional[0];
  if (!typeName) die('Usage: dotmd statuses migrate <type>');

  requireConfigPath(config);
  const content = readFileSync(config.configPath, 'utf8');
  const parsed = parseStatusesBlock(content, typeName);

  if (parsed.form === 'object') {
    process.stdout.write(`Type '${typeName}' is already in rich (object) form. Nothing to migrate.\n`);
    return;
  }

  const typeDef = config.raw?.types?.[typeName];
  if (!typeDef) die(`Type '${typeName}' not present in resolved config.`);

  const statusList = parsed.entries.map(e => e.name);
  const ctxByStatus = {};
  for (const [bucket, names] of Object.entries(typeDef.context ?? {})) {
    for (const n of names) ctxByStatus[n] = bucket;
  }
  const staleByStatus = typeDef.staleDays ?? {};
  const moduleRequired = new Set(config.raw?.taxonomy?.moduleRequiredFor ?? []);
  const lc = config.lifecycle;

  // Determine indent
  const openBracketPos = parsed.blockStart - 1;
  const lineStart = lastNewlineIndexBefore(content, openBracketPos) + 1;
  const lineLeading = content.slice(lineStart, openBracketPos).match(/^\s*/)[0];
  const itemIndent = lineLeading + '  ';

  const lines = ['{\n'];
  for (const name of statusList) {
    const props = {};
    if (ctxByStatus[name]) props.context = ctxByStatus[name];
    if (staleByStatus[name] != null) props.staleDays = staleByStatus[name];
    if (moduleRequired.has(name)) props.requiresModule = true;
    if (lc.archiveStatuses.has(name)) props.archive = true;
    if (lc.terminalStatuses.has(name)) props.terminal = true;
    // Apply quiet sugar when both skipStale and skipWarnings hold; otherwise emit the individual flag.
    const skipStale = lc.skipStaleFor.has(name);
    const skipWarnings = lc.skipWarningsFor.has(name);
    if (skipStale && skipWarnings) props.quiet = true;
    else {
      if (skipStale) props.skipStale = true;
      if (skipWarnings) props.skipWarnings = true;
    }
    lines.push(renderEntryLine(name, props, itemIndent));
  }
  lines.push(lineLeading + '}');

  const newBlock = lines.join('');
  let updatedContent = content.slice(0, openBracketPos) + newBlock + content.slice(parsed.blockEnd + 1);

  // The peer `context` and `staleDays` blocks inside types.<typeName> shadow the
  // rich-form flags at runtime (config.mjs preserves explicit user values over
  // derived ones). Removing them is part of the conversion: they were the
  // array-form's source of truth and are now structurally redundant.
  const cleanup = removePeerBlocks(updatedContent, typeName);
  updatedContent = cleanup.content;

  process.stdout.write(`${bold(`Migrating types.${typeName}.statuses to rich form`)}\n`);
  process.stdout.write(`  ${statusList.length} status(es): ${statusList.join(', ')}\n`);
  if (cleanup.removed.length > 0) {
    process.stdout.write(dim(`  removing redundant peer block(s): ${cleanup.removed.join(', ')}\n`));
  }
  process.stdout.write('\n');

  const overrideErr = checkLifecycleOverride(content, flags.ignoreLifecycle);
  if (overrideErr) die(overrideErr);

  if (opts.dryRun) {
    process.stdout.write(`${dim('[dry-run]')} would write to ${path.relative(process.cwd(), config.configPath)}\n`);
    return;
  }
  if (!flags.yes && !await confirm()) {
    process.stdout.write('Aborted.\n');
    return;
  }

  await writeConfigAtomic(config.configPath, updatedContent, config.configDir);
  process.stdout.write(`${green('Migrated')} types.${typeName}.statuses to rich form.\n`);
  if (config.raw?.taxonomy?.moduleRequiredFor) {
    process.stdout.write(dim(`Note: \`taxonomy.moduleRequiredFor\` is now also derived from per-status flags. You can remove it from your config (the rich form contains the same information).\n`));
  }
}

// Locate and remove `context: {...}` and `staleDays: {...}` peer blocks
// inside types.<typeName>. Returns { content, removed: [<keys>] }.
function removePeerBlocks(content, typeName) {
  const removed = [];
  let working = content;
  for (const key of ['context', 'staleDays']) {
    const r = removeOnePeerBlock(working, typeName, key);
    if (r) { working = r; removed.push(key); }
  }
  return { content: working, removed };
}

function removeOnePeerBlock(content, typeName, key) {
  // Find types.<typeName>.<key> and delete its property line(s) including
  // trailing comma/newline. Use a string scan with a small state machine.
  const typesIdx = content.search(/(^|[^A-Za-z0-9_$])types\s*[:=]\s*\{/);
  if (typesIdx < 0) return null;
  // Walk to find <typeName>: {  (similar to parseStatusesBlock helpers, but
  // simplified — we only need rough boundaries).
  const typeRe = new RegExp(`(['"]?)${escapeForRegex(typeName)}\\1\\s*:\\s*\\{`);
  const tm = typeRe.exec(content);
  if (!tm) return null;
  const typeStart = tm.index + tm[0].length - 1; // points at `{`
  const typeEnd = matchBraceClose(content, typeStart);
  if (typeEnd < 0) return null;
  // Find the property
  const propRe = new RegExp(`\\n([ \\t]*)${escapeForRegex(key)}\\s*:\\s*\\{`);
  propRe.lastIndex = typeStart;
  const pm = propRe.exec(content.slice(typeStart, typeEnd));
  if (!pm) return null;
  const propStartRel = pm.index + 1; // after the leading newline
  const propStart = typeStart + propStartRel;
  // Find the matching `{` … `}` for the value
  const valOpen = content.indexOf('{', propStart);
  const valClose = matchBraceClose(content, valOpen);
  if (valClose < 0) return null;
  // Eat trailing whitespace, optional comma, optional inline comment, and the
  // line's terminating newline so we don't leave a blank line.
  let after = valClose + 1;
  while (content[after] === ' ' || content[after] === '\t') after++;
  if (content[after] === ',') after++;
  while (content[after] === ' ' || content[after] === '\t') after++;
  if (content[after] === '\n') after++;
  // Eat the leading whitespace at propStart so we delete the full line.
  let before = propStart;
  while (content[before - 1] === ' ' || content[before - 1] === '\t') before--;
  return content.slice(0, before) + content.slice(after);
}

function matchBraceClose(content, openPos) {
  if (content[openPos] !== '{') return -1;
  let depth = 1;
  let i = openPos + 1;
  while (i < content.length && depth > 0) {
    const c = content[i];
    if (c === '\'' || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < content.length && content[i] !== q) {
        if (content[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lastNewlineIndexBefore(content, pos) {
  return content.lastIndexOf('\n', pos - 1);
}

// ─── shared helpers ──────────────────────────────────────────────────────────

function requireConfigPath(config) {
  if (!config.configPath || !existsSync(config.configPath)) {
    die(`No dotmd.config.mjs found in ${process.cwd()} — run \`dotmd init\` first.`);
  }
}

function checkLifecycleOverride(content, ignoreFlag) {
  if (!hasExplicitLifecycle(content)) return null;
  if (ignoreFlag) return null;
  return [
    'Your config has an explicit `lifecycle` block, which overrides the per-status flags this CLI edits.',
    'The new flags will be written but won\'t take effect at runtime until you either:',
    '  (a) remove the explicit `lifecycle` block (recommended with rich-form types), or',
    '  (b) update lifecycle.<bucket> manually to include the new status.',
    '',
    'Re-run with --ignore-lifecycle-override to write anyway.',
  ].join('\n');
}

async function confirm() {
  if (!isInteractive()) return false;
  const ans = await promptText('Apply? [y/N] ');
  return ans.toLowerCase() === 'y' || ans.toLowerCase() === 'yes';
}

// Parse the inner `{...}` of an entry line into a flag object.
function parseEntryProps(line) {
  const open = line.indexOf('{');
  const close = line.lastIndexOf('}');
  if (open === -1 || close === -1 || close < open) return {};
  const inner = line.slice(open + 1, close);
  const props = {};
  for (const part of splitTopLevelCommas(inner)) {
    const colon = findUnquotedColon(part);
    if (colon === -1) continue;
    let key = part.slice(0, colon).trim();
    if ((key.startsWith('\'') && key.endsWith('\'')) || (key.startsWith('"') && key.endsWith('"'))) {
      key = key.slice(1, -1);
    }
    const valRaw = part.slice(colon + 1).trim();
    props[key] = parseScalar(valRaw);
  }
  return props;
}

function findUnquotedColon(s) {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\'' || c === '"' || c === '`') {
      i++;
      while (i < s.length && s[i] !== c) { if (s[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (c === ':') return i;
    i++;
  }
  return -1;
}

function splitTopLevelCommas(s) {
  const out = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\'' || c === '"' || c === '`') {
      i++;
      while (i < s.length && s[i] !== c) { if (s[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (c === '{' || c === '[' || c === '(') { depth++; i++; continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; i++; continue; }
    if (c === ',' && depth === 0) { out.push(s.slice(start, i)); start = i + 1; }
    i++;
  }
  if (start < s.length) {
    const tail = s.slice(start).trim();
    if (tail) out.push(s.slice(start));
  }
  return out;
}

function parseScalar(s) {
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;
  if (s === 'undefined') return undefined;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s.startsWith('\'') && s.endsWith('\'')) return s.slice(1, -1);
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.startsWith('`') && s.endsWith('`')) return s.slice(1, -1);
  return s;
}

// ─── flag parser ─────────────────────────────────────────────────────────────

function parseFlags(args, { allowProps }) {
  const out = { positional: [], props: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--type') { out.type = args[++i]; continue; }
    if (a === '--like') { out.like = args[++i]; continue; }
    if (a === '--yes' || a === '-y') { out.yes = true; continue; }
    if (a === '--ignore-lifecycle-override') { out.ignoreLifecycle = true; continue; }
    if (a === '--json') { out.json = true; continue; }

    if (allowProps) {
      if (a === '--context') {
        const v = args[++i];
        if (!['expanded', 'listed', 'counted'].includes(v)) {
          die(`--context must be one of: expanded, listed, counted (got '${v}')`);
        }
        out.props.context = v;
        continue;
      }
      if (a === '--staleDays') {
        const v = args[++i];
        if (v === 'null') { out.props.staleDays = null; continue; }
        const n = Number(v);
        if (!Number.isFinite(n)) die(`--staleDays must be a number or 'null' (got '${v}')`);
        out.props.staleDays = n;
        continue;
      }
      let matched = false;
      for (const f of BOOLEAN_FLAGS) {
        if (a === '--' + f) { out.props[f] = true; matched = true; break; }
        if (a === '--no-' + f) { out.props[f] = false; matched = true; break; }
      }
      if (matched) continue;
    }

    if (a.startsWith('-')) die(`Unknown flag: ${a}`);
    out.positional.push(a);
  }
  return out;
}
