import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';
import { asString, toRepoPath, resolveDocPath, resolveRefPath } from './util.mjs';
import { walkSections, findSection, findActivePhase, summarizePhases, isPhaseHeading, detectMarker } from './section.mjs';
import { dim, green } from './color.mjs';

const CAPS = {
  blurb: 200,
  currentState: 500,
  nextStep: 300,
  versionHistoryEntry: 200,
};

function countBullets(body) {
  if (!body) return 0;
  return body.split('\n').filter(l => /^[-*]\s+\S/.test(l)).length;
}

function truncate(s, cap) {
  if (!s) return '';
  if (s.length <= cap) return s;
  return s.slice(0, cap - 3).trimEnd() + '...';
}

function statusSummary(counts) {
  const order = ['shipped', 'skipped', 'in-progress', 'blocked', 'todo'];
  const icons = { shipped: '✅', skipped: '⏭', 'in-progress': '🟡', blocked: '🚧', todo: '⬜' };
  return order.filter(k => counts[k]).map(k => `${counts[k]}${icons[k]}`).join(' ');
}

// `docDir` is the directory of the doc whose frontmatter we're reading.
// Pre-fix: this used `resolveDocPath` which only tries repo-root and docsRoots-
// relative, NOT doc-relative — so a bare basename like `sibling-plan.md` written
// in `docs/plans/foo.md`'s `related_plans:` always showed `(missing)`, even
// though graph/validate resolve the same ref fine via `resolveRefPath`. Now
// matches graph's resolver semantics: doc-relative first, then repo-relative;
// docsRoots-relative is kept as a final fallback for legacy refs.
function readRelatedSummary(rawList, config, docDir) {
  const list = Array.isArray(rawList) ? rawList : (typeof rawList === 'string' && rawList.trim() ? [rawList] : []);
  const out = [];
  for (const ref of list) {
    if (!ref) continue;
    const refStr = String(ref).trim();
    if (!refStr) continue;
    let abs = null;
    try {
      abs = resolveRefPath(refStr, docDir, config.repoRoot)
        ?? resolveDocPath(refStr, config);
    } catch { abs = null; }
    if (!abs || !existsSync(abs)) {
      out.push({ ref: refStr, status: null, missing: true });
      continue;
    }
    try {
      const raw = readFileSync(abs, 'utf8');
      const { frontmatter } = extractFrontmatter(raw);
      const fm = parseSimpleFrontmatter(frontmatter);
      out.push({
        ref: toRepoPath(abs, config.repoRoot),
        status: asString(fm.status) ?? null,
        missing: false,
      });
    } catch {
      out.push({ ref: refStr, status: null, missing: true });
    }
  }
  return out;
}

// Build the structured card object. Pure: no IO beyond what's passed in.
export function buildCard(filePath, raw, config) {
  const { frontmatter: fmRaw, body } = extractFrontmatter(raw);
  const fm = parseSimpleFrontmatter(fmRaw);
  const sections = walkSections(body);

  // Title + blurb
  const titleSection = sections.find(s => s.level === 1) ?? null;
  const title = titleSection ? titleSection.heading : path.basename(filePath, '.md');
  // Blurb = first blockquote line(s) after the H1, or first paragraph
  const lines = body.split('\n');
  let blurb = '';
  if (titleSection) {
    for (let i = titleSection.bodyLineStart - 1; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln.trim()) {
        if (blurb) break;
        else continue;
      }
      if (ln.startsWith('## ') || ln.startsWith('# ')) break;
      blurb += (blurb ? '\n' : '') + ln;
    }
  }
  blurb = truncate(blurb.replace(/^> ?/gm, '').trim(), CAPS.blurb);

  // Frontmatter pointers. The simple parser doesn't handle YAML multiline blocks
  // (`>`, `|`); when only the marker char survives, treat as empty.
  const cleanInline = (v) => {
    const s = asString(v);
    if (!s) return '';
    if (/^[>|][+-]?$/.test(s.trim())) return '';
    return s;
  };
  const status = asString(fm.status) ?? null;
  const updated = asString(fm.updated) ?? null;
  const currentState = truncate(cleanInline(fm.current_state), CAPS.currentState);
  const nextStep = truncate(cleanInline(fm.next_step), CAPS.nextStep);

  // Related plans (compressed: slug + status only — show all, don't cap count).
  // docDir lets the resolver try same-dir basenames first — graph/validate do this
  // already; pickup-card now matches.
  const docDir = path.dirname(filePath);
  const related = [
    ...readRelatedSummary(fm.parent_plan, config, docDir).map(r => ({ ...r, kind: 'parent' })),
    ...readRelatedSummary(fm.related_plans, config, docDir).map(r => ({ ...r, kind: 'related' })),
  ];

  // Phases summary + active phase (pointer only, no body)
  const phaseSummary = summarizePhases(sections);
  const activePhase = findActivePhase(sections);
  let activePhasePointer = null;
  if (activePhase) {
    activePhasePointer = {
      heading: activePhase.heading,
      lineStart: activePhase.lineStart,
      lineEnd: activePhase.lineEnd,
      marker: detectMarker(activePhase.heading),
    };
  }

  // Old-plan fallback: no ## Phases section → point to last H2 as "active content"
  let fallbackPointer = null;
  if (!findSection(sections, 'Phases') && !activePhase) {
    const h2s = sections.filter(s => s.level === 2);
    const lastH2 = h2s[h2s.length - 1] ?? null;
    if (lastH2) {
      fallbackPointer = {
        heading: lastH2.heading,
        lineStart: lastH2.lineStart,
        lineEnd: lastH2.lineEnd,
      };
    }
  }

  // Open Questions — count + pointer only, no body
  const oqSection = findSection(sections, 'Open Questions') ?? findSection(sections, 'Open questions');
  let openQuestions = null;
  if (oqSection && oqSection.body.trim()) {
    openQuestions = {
      heading: oqSection.heading,
      lineStart: oqSection.lineStart,
      lineEnd: oqSection.lineEnd,
      count: countBullets(oqSection.body),
    };
  }

  // Last Version History entry (newest = first bullet under the heading)
  const vhSection = findSection(sections, 'Version History');
  let lastVersion = null;
  if (vhSection && vhSection.body.trim()) {
    const firstBullet = vhSection.body.split('\n').find(l => /^[-*]\s/.test(l));
    if (firstBullet) lastVersion = truncate(firstBullet.replace(/^[-*]\s+/, ''), CAPS.versionHistoryEntry);
  }

  // Outline = all H2 headings with line ranges; phase summary inline if Phases present
  const outline = sections.filter(s => s.level === 2).map(s => {
    const isPhases = /^phases?$/i.test(s.heading.replace(/[^\w\s]+$/, '').trim());
    let suffix = `lines ${s.lineStart}-${s.lineEnd}`;
    if (isPhases && phaseSummary.total > 0) {
      suffix = `(${phaseSummary.total}: ${statusSummary(phaseSummary.counts)})  ${suffix}`;
    }
    return { heading: s.heading, lineStart: s.lineStart, lineEnd: s.lineEnd, suffix };
  });

  return {
    path: toRepoPath(filePath, config.repoRoot),
    title,
    status,
    updated,
    blurb,
    currentState,
    nextStep,
    related,
    phases: phaseSummary,
    activePhase: activePhasePointer,
    fallbackContent: fallbackPointer,
    openQuestions,
    lastVersion,
    outline,
    bodyBytes: body.length,
  };
}

// Render the card to human-format string.
export function renderCard(card) {
  const lines = [];
  lines.push(`[dotmd] holding ${card.path} — release with: dotmd release ${card.path}`);
  lines.push('---');
  lines.push(`# ${card.title}`);
  const meta = [card.status, card.updated && `updated ${card.updated}`].filter(Boolean).join(' · ');
  if (meta) lines.push(dim(meta));
  if (card.blurb) {
    lines.push('');
    lines.push(`> ${card.blurb.replace(/\n/g, '\n> ')}`);
  }

  if (card.currentState || card.nextStep) {
    lines.push('');
    if (card.currentState) lines.push(`${green('Current:')} ${card.currentState}`);
    if (card.nextStep) lines.push(`${green('Next:')}    ${card.nextStep}`);
  }

  if (card.related.length > 0) {
    lines.push('');
    lines.push(green('Related:'));
    for (const r of card.related) {
      const tag = r.kind === 'parent' ? '↑ parent' : '↔';
      if (r.missing) {
        lines.push(`  ${tag} ${r.ref} ${dim('(missing)')}`);
      } else {
        lines.push(`  ${tag} ${r.ref}${r.status ? ` ${dim(`(${r.status})`)}` : ''}`);
      }
    }
  }

  if (card.activePhase) {
    lines.push('');
    lines.push(`${green('Active phase:')} ${card.activePhase.heading}  ${dim(`(lines ${card.activePhase.lineStart}-${card.activePhase.lineEnd})`)}`);
  } else if (card.fallbackContent) {
    lines.push('');
    lines.push(`${green('Active section:')} ${card.fallbackContent.heading}  ${dim(`(lines ${card.fallbackContent.lineStart}-${card.fallbackContent.lineEnd})`)}`);
  } else if (card.phases.total > 0) {
    lines.push('');
    lines.push(dim(`All ${card.phases.total} phases shipped/skipped — ready for archive?`));
  }

  if (card.openQuestions) {
    lines.push(`${green('Open Questions:')} ${card.openQuestions.count}  ${dim(`(lines ${card.openQuestions.lineStart}-${card.openQuestions.lineEnd})`)}`);
  }

  if (card.lastVersion) {
    lines.push('');
    lines.push(`${green('Last change:')} ${card.lastVersion}`);
  }

  if (card.outline.length > 0) {
    lines.push('');
    lines.push(green('Outline:'));
    for (const o of card.outline) {
      lines.push(`  ## ${o.heading}  ${dim(o.suffix)}`);
    }
  }

  lines.push('');
  lines.push(dim(`Body: ${formatBytes(card.bodyBytes)}. \`dotmd pickup ${card.path} --full\` for everything, or Read the file with offset/limit to target a section by line number.`));
  return lines.join('\n') + '\n';
}

function formatBytes(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}
