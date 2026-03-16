import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, replaceFrontmatter } from './frontmatter.mjs';
import { toRepoPath, escapeRegex, warn } from './util.mjs';
import { buildIndex, collectDocFiles } from './index.mjs';
import { green, dim, yellow } from './color.mjs';

export function runFixRefs(argv, config, opts = {}) {
  const { dryRun } = opts;
  const result = fixBrokenRefs(config, { dryRun });
  if (result.totalFixed === 0 && result.bodyLinksFixed === 0 && result.unfixableCount === 0) {
    process.stdout.write(green('No broken references found.') + '\n');
  }
}

/**
 * Core logic for fixing broken references. Returns { totalFixed, unfixableCount }.
 * Shared by `dotmd fix-refs` and `dotmd check --fix`.
 */
export function fixBrokenRefs(config, opts = {}) {
  const { dryRun, quiet } = opts;
  const index = buildIndex(config);
  const allFiles = collectDocFiles(config);

  // Build a map of basename → absolute path for all docs
  const basenameMap = new Map();
  const duplicateBasenames = new Set();
  for (const filePath of allFiles) {
    const basename = path.basename(filePath);
    if (basenameMap.has(basename)) {
      duplicateBasenames.add(basename);
    } else {
      basenameMap.set(basename, filePath);
    }
  }

  const prefix = dryRun ? dim('[dry-run] ') : '';
  let totalFixed = 0;
  let unfixableCount = 0;
  let bodyLinksFixed = 0;

  // ── Fix broken frontmatter references ────────────────────────────────

  const brokenRefErrors = index.errors.filter(e =>
    e.message.includes('does not resolve to an existing file')
  );

  if (brokenRefErrors.length > 0) {
    const fixesByDoc = new Map();

    for (const err of brokenRefErrors) {
      const match = err.message.match(/entry `([^`]+)` does not resolve/);
      if (!match) { unfixableCount++; continue; }

      const brokenRef = match[1];
      const brokenBasename = path.basename(brokenRef);

      if (duplicateBasenames.has(brokenBasename)) { unfixableCount++; continue; }

      const resolved = basenameMap.get(brokenBasename);
      if (!resolved) { unfixableCount++; continue; }

      const docAbsPath = path.join(config.repoRoot, err.path);
      const docDir = path.dirname(docAbsPath);
      const correctRelPath = path.relative(docDir, resolved).split(path.sep).join('/');

      if (correctRelPath === brokenRef) { unfixableCount++; continue; }

      if (!fixesByDoc.has(err.path)) fixesByDoc.set(err.path, []);
      fixesByDoc.get(err.path).push({ brokenRef, correctRelPath });
    }

    for (const [docPath, fixes] of fixesByDoc) {
      const absPath = path.join(config.repoRoot, docPath);
      let raw = readFileSync(absPath, 'utf8');
      const { frontmatter: fm } = extractFrontmatter(raw);
      if (!fm) continue;

      let newFm = fm;
      for (const { brokenRef, correctRelPath } of fixes) {
        newFm = newFm.split(brokenRef).join(correctRelPath);
      }

      if (newFm !== fm && !dryRun) {
        raw = replaceFrontmatter(raw, newFm);
        writeFileSync(absPath, raw, 'utf8');
      }

      if (!quiet) {
        process.stdout.write(`${prefix}${green('Fixed')}: ${docPath} (${fixes.length} ref${fixes.length > 1 ? 's' : ''})\n`);
        for (const { brokenRef, correctRelPath } of fixes) {
          process.stdout.write(`${prefix}  ${dim(`${brokenRef} → ${correctRelPath}`)}\n`);
        }
      }
      totalFixed += fixes.length;
    }
  }

  // ── Fix broken body links ────────────────────────────────────────────

  for (const doc of index.docs) {
    const brokenBodyWarnings = doc.warnings.filter(w =>
      w.message.startsWith('body link') && w.message.includes('does not resolve')
    );
    if (!brokenBodyWarnings.length) continue;

    const absPath = path.join(config.repoRoot, doc.path);
    let raw = readFileSync(absPath, 'utf8');
    const { frontmatter: fm, body } = extractFrontmatter(raw);
    let newBody = body;
    const docDir = path.dirname(absPath);
    const bodyFixes = [];

    for (const warn of brokenBodyWarnings) {
      const match = warn.message.match(/body link `([^`]+)` does not resolve/);
      if (!match) continue;

      const brokenHref = match[1];
      const brokenBasename = path.basename(brokenHref);

      if (duplicateBasenames.has(brokenBasename)) continue;
      const resolved = basenameMap.get(brokenBasename);
      if (!resolved) continue;

      const correctHref = path.relative(docDir, resolved).split(path.sep).join('/');
      if (correctHref === brokenHref) continue;

      const linkRegex = new RegExp(
        '(?<!!)\\[([^\\]]+)\\]\\(' + escapeRegex(brokenHref) + '(#[^)]*)?\\)',
        'g'
      );
      newBody = newBody.replace(linkRegex, (_, text, anchor) =>
        `[${text}](${correctHref}${anchor ?? ''})`
      );
      bodyFixes.push({ brokenHref, correctHref });
    }

    if (bodyFixes.length > 0 && newBody !== body) {
      if (!dryRun) {
        writeFileSync(absPath, `---\n${fm}\n---\n${newBody}`, 'utf8');
      }
      if (!quiet) {
        process.stdout.write(`${prefix}${green('Fixed')}: ${doc.path} (${bodyFixes.length} body link${bodyFixes.length > 1 ? 's' : ''})\n`);
        for (const { brokenHref, correctHref } of bodyFixes) {
          process.stdout.write(`${prefix}  ${dim(`${brokenHref} → ${correctHref}`)}\n`);
        }
      }
      bodyLinksFixed += bodyFixes.length;
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────

  const allFixed = totalFixed + bodyLinksFixed;
  if (!quiet && allFixed > 0) {
    process.stdout.write(`\n${prefix}${allFixed} fix${allFixed !== 1 ? 'es' : ''} applied.\n`);
  }
  if (!quiet && unfixableCount > 0) {
    process.stdout.write(`${yellow(`${unfixableCount} broken reference(s) could not be auto-resolved`)} (file not found by basename).\n`);
  }

  return { totalFixed, unfixableCount, bodyLinksFixed };
}
