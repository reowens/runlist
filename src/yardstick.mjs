import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { extractFrontmatter, parseSimpleFrontmatter } from './frontmatter.mjs';

export const YARDSTICK_FIELDS = ['yardstick_disposition', 'yardstick_into', 'yardstick_reason', 'yardstick_revision'];
const DISPOSITIONS = new Set(['serves', 'folded', 'closed']);
const MAX_GOAL_BYTES = 1024 * 1024;

export function validateYardstickConfig(value) {
  if (value == null || value === false) return [];
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)
    || path.isAbsolute(value) || !value.endsWith('.md')) {
    return ['Config: yardstick must name one repository-relative Markdown file, or be unset/false.'];
  }
  return [];
}

function contained(root, file) {
  const rel = path.relative(root, file);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// No provider, index, account or model is involved: this reads a local document.
export function readYardstick(config) {
  const setting = config.yardstick ?? config.raw?.yardstick;
  if (setting == null || setting === false) return { enabled: false, state: 'disabled' };
  const errors = validateYardstickConfig(setting);
  if (errors.length) return { enabled: true, state: 'unavailable', message: errors[0] };
  const source = setting.trim();
  try {
    const file = path.resolve(config.repoRoot, source);
    const root = realpathSync(config.repoRoot);
    if (!contained(path.resolve(config.repoRoot), file) || !contained(root, realpathSync(file))) {
      throw new Error('The goal must stay inside this repository.');
    }
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_GOAL_BYTES) throw new Error('The goal must be a regular Markdown file of at most 1 MiB.');
    const raw = readFileSync(file, 'utf8');
    const { frontmatter, body } = extractFrontmatter(raw);
    if (raw.replace(/\r\n/g, '\n').startsWith('---\n') && extractFrontmatter(raw).bodyLineOffset === 0) throw new Error('The goal has malformed frontmatter.');
    if (parseSimpleFrontmatter(frontmatter).type === 'prompt') throw new Error('A saved prompt cannot be the product goal.');
    const statement = body.trim();
    if (!statement) throw new Error('The goal body is empty.');
    const revision = createHash('sha256').update(statement).digest('hex');
    const goal = { enabled: true, state: 'ready', source, statement, revision };
    // Guard the exact bytes from this read without exposing frontmatter in JSON.
    Object.defineProperty(goal, 'snapshot', { value: { path: file, expectedContent: raw } });
    return goal;
  } catch (err) {
    return { enabled: true, state: 'unavailable', source, message: err.message };
  }
}

export function assessmentIssues(fm, archived) {
  if (!YARDSTICK_FIELDS.some(field => Object.hasOwn(fm, field))) return [];
  const issues = [];
  const disposition = fm.yardstick_disposition;
  if (!DISPOSITIONS.has(disposition)) issues.push('Yardstick disposition must be serves, folded or closed.');
  if (typeof fm.yardstick_revision !== 'string' || !/^[a-f0-9]{64}$/.test(fm.yardstick_revision)) {
    issues.push('Yardstick assessment must record a valid goal revision.');
  }
  if (fm.yardstick_reason !== undefined && (typeof fm.yardstick_reason !== 'string' || !fm.yardstick_reason.trim())) {
    issues.push('Yardstick reason must be nonempty text.');
  }
  if (['closed', 'folded'].includes(disposition)) {
    if (typeof fm.yardstick_reason !== 'string' || !fm.yardstick_reason.trim()) issues.push('Closing or folding requires an owner reason.');
    if (!archived) issues.push('Closed/folded yardstick assessment is inconsistent with a live plan; archive explicitly.');
  }
  if (disposition === 'folded') {
    if (typeof fm.yardstick_into !== 'string' || !fm.yardstick_into.trim() || /[\r\n\0]/.test(fm.yardstick_into)) {
      issues.push('Folded yardstick assessment must link one replacement plan.');
    }
  } else if (fm.yardstick_into !== undefined) issues.push('Only a folded assessment can name a replacement plan.');
  return issues;
}

export function compareYardstick(fm, config, goal = readYardstick(config), archived = false) {
  const issues = assessmentIssues(fm, archived);
  const disposition = typeof fm.yardstick_disposition === 'string' ? fm.yardstick_disposition : null;
  const assessment = {
    disposition,
    into: typeof fm.yardstick_into === 'string' ? fm.yardstick_into : null,
    reason: typeof fm.yardstick_reason === 'string' ? fm.yardstick_reason : null,
    revision: typeof fm.yardstick_revision === 'string' ? fm.yardstick_revision : null,
    reviewedEarlierGoal: Boolean(disposition && goal.state === 'ready' && fm.yardstick_revision !== goal.revision),
    issues,
  };
  return { goal, delivers: typeof fm.delivers === 'string' ? fm.delivers.trim() : null, assessment };
}

export function renderYardstick(comparison, { compact = false } = {}) {
  const { goal, delivers, assessment } = comparison;
  if (!goal.enabled) return 'Product goal: Not configured\n';
  const excerpt = (text, cap) => compact && text.length > cap
    ? `${text.slice(0, cap).trimEnd()}… [shortened; read the source for the full text]` : text;
  const lines = [goal.state === 'ready'
    ? `Product goal: ${excerpt(goal.statement, 600)}`
    : `Product goal: Unavailable — ${goal.message}`];
  if (goal.source) lines.push(`Source: ${goal.source}`);
  if (assessment) {
    lines.push(`This plan delivers: ${delivers ? excerpt(delivers, 400) : 'Unset'}`);
    const label = assessment.issues.length ? 'Invalid assessment'
      : ({ serves: 'Serves the goal', folded: 'Folded into another plan', closed: 'Closed' }[assessment.disposition] ?? 'Not yet reviewed');
    lines.push(`Owner assessment: ${label}`);
    if (assessment.into) lines.push(`Replacement: ${assessment.into}`);
    if (assessment.reason) lines.push(`Reason: ${excerpt(assessment.reason, 400)}`);
    if (assessment.reviewedEarlierGoal) lines.push('Reviewed against an earlier goal — owner review needed.');
    for (const issue of assessment.issues) lines.push(`Warning: ${issue}`);
  }
  return `${lines.join('\n')}\n`;
}
