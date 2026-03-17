import { readFileSync, writeFileSync } from 'node:fs';
import { extractFrontmatter, parseSimpleFrontmatter, replaceFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, escapeRegex, warn } from './util.mjs';
import { buildIndex, collectDocFiles } from './index.mjs';
import { updateFrontmatter } from './lifecycle.mjs';
import { runMLX, checkUvAvailable } from './ai.mjs';
import { bold, green, yellow, dim } from './color.mjs';

const KEY_RENAMES = {
  nextStep: 'next_step',
  currentState: 'current_state',
  auditLevel: 'audit_level',
  sourceOfTruth: 'source_of_truth',
  relatedPlans: 'related_plans',
  supportsPlans: 'supports_plans',
};

export function runLint(argv, config, opts = {}) {
  const { dryRun } = opts;
  const fix = argv.includes('--fix');
  const allFiles = collectDocFiles(config);
  const fixable = [];

  for (const filePath of allFiles) {
    const raw = readFileSync(filePath, 'utf8');
    const { frontmatter } = extractFrontmatter(raw);
    if (!frontmatter) continue;
    const parsed = parseSimpleFrontmatter(frontmatter);
    const repoPath = toRepoPath(filePath, config.repoRoot);
    const fixes = [];

    // Missing status (fixable via AI inference)
    if (!asString(parsed.status)) {
      fixes.push({ field: 'status', oldValue: null, newValue: null, type: 'infer-status' });
    }

    // Missing updated
    if (!asString(parsed.updated) && asString(parsed.status) && !config.lifecycle.skipWarningsFor.has(asString(parsed.status))) {
      const today = new Date().toISOString().slice(0, 10);
      fixes.push({ field: 'updated', oldValue: null, newValue: today, type: 'add' });
    }

    // Status casing
    const status = asString(parsed.status);
    if (status && status !== status.toLowerCase() && config.validStatuses.has(status.toLowerCase())) {
      fixes.push({ field: 'status', oldValue: status, newValue: status.toLowerCase(), type: 'update' });
    }

    // Key renames
    for (const [oldKey, newKey] of Object.entries(KEY_RENAMES)) {
      if (parsed[oldKey] !== undefined && parsed[newKey] === undefined) {
        fixes.push({ field: oldKey, oldValue: oldKey, newValue: newKey, type: 'rename-key' });
      }
    }

    // Comma-separated surface → surfaces array
    const surfaceVal = asString(parsed.surface);
    if (surfaceVal && surfaceVal.includes(',')) {
      const values = surfaceVal.split(',').map(s => s.trim()).filter(Boolean);
      fixes.push({ field: 'surface', oldValue: surfaceVal, newValue: values, type: 'split-to-array' });
    }

    // Trailing whitespace in values
    for (const line of frontmatter.split('\n')) {
      const m = line.match(/^([A-Za-z0-9_-]+):(.+\S)\s+$/);
      if (m) {
        fixes.push({ field: m[1], oldValue: m[2] + line.slice(line.indexOf(m[2]) + m[2].length), newValue: m[2], type: 'trim' });
      }
    }

    // Missing newline at EOF
    if (!raw.endsWith('\n')) {
      fixes.push({ field: '(eof)', oldValue: 'missing', newValue: 'newline', type: 'eof' });
    }

    if (fixes.length > 0) {
      fixable.push({ filePath, repoPath, fixes });
    }
  }

  // Also get non-fixable issues from index, excluding issues we can already fix
  const index = buildIndex(config);
  const fixablePaths = new Set(fixable.map(f => f.repoPath));
  const nonFixable = [...index.errors, ...index.warnings].filter(issue => {
    if (issue.message.includes('Missing frontmatter `status`') && fixablePaths.has(issue.path)) return false;
    return true;
  });

  if (!fix) {
    // Report mode
    if (fixable.length > 0) {
      process.stdout.write(bold(`${fixable.length} file(s) with fixable issues:\n\n`));
      for (const { repoPath, fixes } of fixable) {
        process.stdout.write(`  ${repoPath}\n`);
        for (const f of fixes) {
          if (f.type === 'rename-key') {
            process.stdout.write(dim(`    ${f.oldValue} → ${f.newValue}\n`));
          } else if (f.type === 'infer-status') {
            process.stdout.write(dim(`    missing status (fixable via AI)\n`));
          } else if (f.type === 'split-to-array') {
            process.stdout.write(dim(`    ${f.field}: "${f.oldValue}" → surfaces: [${f.newValue.join(', ')}]\n`));
          } else if (f.type === 'eof') {
            process.stdout.write(dim(`    missing newline at end of file\n`));
          } else if (f.type === 'add') {
            process.stdout.write(dim(`    add ${f.field}: ${f.newValue}\n`));
          } else {
            process.stdout.write(dim(`    ${f.field}: ${f.oldValue} → ${f.newValue}\n`));
          }
        }
      }
      process.stdout.write(`\nRun ${bold('dotmd lint --fix')} to auto-fix.\n`);
    }

    if (nonFixable.length > 0) {
      process.stdout.write(`\n${yellow(`${nonFixable.length} non-fixable issue(s)`)} (manual attention needed):\n`);
      for (const issue of nonFixable) {
        process.stdout.write(`  ${issue.path}: ${issue.message}\n`);
      }
    }

    if (fixable.length === 0 && nonFixable.length === 0) {
      process.stdout.write(green('No issues found.') + '\n');
    }
    return;
  }

  // Fix mode
  const prefix = dryRun ? dim('[dry-run] ') : '';
  let totalFixes = 0;

  for (const { filePath, repoPath, fixes } of fixable) {
    const updates = {};
    const keyRenames = [];
    let needsEofFix = false;
    const trimFixes = [];
    const splitToArray = [];

    for (const f of fixes) {
      if (f.type === 'rename-key') {
        keyRenames.push(f);
      } else if (f.type === 'eof') {
        needsEofFix = true;
      } else if (f.type === 'trim') {
        trimFixes.push(f);
      } else if (f.type === 'split-to-array') {
        splitToArray.push(f);
      } else {
        updates[f.field] = f.newValue;
      }
    }

    if (!dryRun) {
      // Apply infer-status fixes via AI
      for (const f of fixes.filter(f => f.type === 'infer-status')) {
        const raw = readFileSync(filePath, 'utf8');
        const { body } = extractFrontmatter(raw);
        const statusList = config.statusOrder.join(', ');
        const prompt = `Given this markdown document, classify it into exactly one of these statuses: ${statusList}.\nReply with ONLY the status word, nothing else.\n\nFile: ${repoPath}\n\n${(body ?? '').slice(0, 4000)}`;
        const result = runMLX(prompt, { maxTokens: 10 });
        const suggested = result?.trim().toLowerCase().split(/\s+/)[0];
        if (suggested && config.validStatuses.has(suggested)) {
          updateFrontmatter(filePath, { status: suggested });
          f.newValue = suggested;
        }
      }

      // Apply split-to-array fixes (surface: a, b → surfaces: array)
      for (const sa of splitToArray) {
        let raw = readFileSync(filePath, 'utf8');
        const { frontmatter: fm } = extractFrontmatter(raw);
        // Remove the scalar surface line
        let newFm = fm.replace(new RegExp(`^${escapeRegex(sa.field)}:.*$`, 'm'), '').replace(/\n{2,}/g, '\n');
        // Check if surfaces: array already exists
        if (newFm.includes('surfaces:')) {
          // Append new values to existing array
          for (const val of sa.newValue) {
            if (!newFm.includes(`- ${val}`)) {
              newFm = newFm.replace(/^(surfaces:)$/m, `$1\n  - ${val}`);
            }
          }
        } else {
          // Create new surfaces: array
          newFm += `\nsurfaces:\n${sa.newValue.map(v => `  - ${v}`).join('\n')}`;
        }
        raw = replaceFrontmatter(raw, newFm.trim());
        writeFileSync(filePath, raw, 'utf8');
      }

      // Apply key renames and trim fixes via raw string manipulation
      if (keyRenames.length > 0 || trimFixes.length > 0) {
        let raw = readFileSync(filePath, 'utf8');
        const { frontmatter: fm } = extractFrontmatter(raw);
        let newFm = fm;
        for (const kr of keyRenames) {
          const regex = new RegExp(`^${escapeRegex(kr.oldValue)}:`, 'm');
          newFm = newFm.replace(regex, `${kr.newValue}:`);
        }
        for (const tf of trimFixes) {
          const regex = new RegExp(`^(${escapeRegex(tf.field)}:)${escapeRegex(tf.oldValue)}$`, 'm');
          newFm = newFm.replace(regex, `$1${tf.newValue}`);
        }
        if (newFm !== fm) {
          raw = replaceFrontmatter(raw, newFm);
          writeFileSync(filePath, raw, 'utf8');
        }
      }

      // Apply value updates via updateFrontmatter
      if (Object.keys(updates).length > 0) {
        updateFrontmatter(filePath, updates);
      }

      // EOF fix
      if (needsEofFix) {
        const current = readFileSync(filePath, 'utf8');
        if (!current.endsWith('\n')) {
          writeFileSync(filePath, current + '\n', 'utf8');
        }
      }
    }

    process.stdout.write(`${prefix}${green('Fixed')}: ${repoPath} (${fixes.length} issue${fixes.length > 1 ? 's' : ''})\n`);
    for (const f of fixes) {
      if (f.type === 'rename-key') {
        process.stdout.write(`${prefix}  ${dim(`${f.oldValue} → ${f.newValue}`)}\n`);
      } else if (f.type === 'eof') {
        process.stdout.write(`${prefix}  ${dim('added newline at EOF')}\n`);
      } else if (f.type === 'infer-status') {
        if (f.newValue) {
          process.stdout.write(`${prefix}  ${dim(`status: (missing) → ${f.newValue} (AI-inferred)`)}\n`);
        } else {
          process.stdout.write(`${prefix}  ${dim('status: (missing) — AI inference unavailable')}\n`);
        }
      } else if (f.type === 'split-to-array') {
        process.stdout.write(`${prefix}  ${dim(`${f.field}: "${f.oldValue}" → surfaces: [${f.newValue.join(', ')}]`)}\n`);
      } else if (f.type === 'add') {
        process.stdout.write(`${prefix}  ${dim(`add ${f.field}: ${f.newValue}`)}\n`);
      } else {
        process.stdout.write(`${prefix}  ${dim(`${f.field}: ${f.oldValue} → ${f.newValue}`)}\n`);
      }
    }
    totalFixes += fixes.length;

    if (!dryRun) {
      try { config.hooks.onLint?.({ path: repoPath, fixes }); } catch (err) { warn(`Hook 'onLint' threw: ${err.message}`); }
    }
  }

  process.stdout.write(`\n${prefix}${totalFixes} fix${totalFixes !== 1 ? 'es' : ''} applied across ${fixable.length} file(s).\n`);
}

