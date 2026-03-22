// dotmd.config.mjs — document management configuration
// All exports are optional. Omitted values use built-in defaults.
// Place this file at the root of your project.

// ─── Static Config ───────────────────────────────────────────────────────────

// Directory containing your markdown docs (relative to this config file)
export const root = 'docs';

// Subdirectory for archived docs (used by `dotmd archive` and `dotmd status`)
export const archiveDir = 'archived';

// Directories to skip when scanning
export const excludeDirs = ['evidence'];

// Document types — each type has its own status vocabulary and context layout
// Defaults: plan, doc, research. Override to customize statuses per type.
// export const types = {
//   plan: {
//     statuses: ['in-session', 'active', 'planned', 'blocked', 'done', 'archived'],
//     context: { expanded: ['in-session', 'active'], listed: ['planned', 'blocked'], counted: ['done', 'archived'] },
//     staleDays: { 'in-session': 1, active: 14, planned: 30, blocked: 30 },
//   },
//   doc: {
//     statuses: ['draft', 'active', 'review', 'reference', 'deprecated', 'archived'],
//     context: { expanded: ['active'], listed: ['draft', 'review'], counted: ['reference', 'deprecated', 'archived'] },
//     staleDays: { draft: 30, active: 14, review: 14 },
//   },
//   research: {
//     statuses: ['active', 'reference', 'archived'],
//     context: { expanded: ['active'], listed: [], counted: ['reference', 'archived'] },
//     staleDays: { active: 30 },
//   },
// };

// Status workflow — fallback for docs without a type field. Order determines display grouping.
export const statuses = {
  order: ['active', 'ready', 'planned', 'research', 'blocked', 'reference', 'archived'],
  // Additional statuses valid only in specific roots (merged with order)
  // Useful when different doc areas track different things (e.g. plans vs module docs)
  // rootStatuses: {
  //   'docs/modules': ['implemented', 'partial', 'draft', 'deprecated'],
  //   'docs/core':    ['implemented', 'partial'],
  // },
  // Days after which a doc is considered stale (null = never stale)
  staleDays: {
    active: 14,
    ready: 14,
    planned: 30,
    blocked: 30,
    research: 30,
  },
};

// Lifecycle behavior — which statuses trigger special handling
export const lifecycle = {
  archiveStatuses: ['archived'],      // auto-move to archiveDir on transition
  skipStaleFor: ['archived'],         // skip staleness checks
  skipWarningsFor: ['archived'],      // skip validation warnings (summary, etc.)
};

// Taxonomy validation — set fields to null to skip validation
export const taxonomy = {
  surfaces: ['web', 'ios', 'android', 'mobile', 'full-stack', 'frontend', 'backend', 'api', 'docs', 'ops', 'platform', 'infra', 'design'],
  moduleRequiredFor: ['active', 'ready', 'planned', 'blocked'],
};

// Index file generation — remove this section to disable
export const index = {
  path: 'docs/docs.md',
  startMarker: '<!-- GENERATED:dotmd:start -->',
  endMarker: '<!-- GENERATED:dotmd:end -->',
  archivedLimit: 8,
};

// Context briefing layout (`dotmd context`)
export const context = {
  expanded: ['active'],
  listed: ['ready', 'planned'],
  counted: ['blocked', 'research', 'reference', 'archived'],
  recentDays: 3,
  recentStatuses: ['active', 'ready', 'planned'],
  recentLimit: 10,
  truncateNextStep: 80,
};

// Display settings
export const display = {
  lineWidth: 0,         // 0 = auto-detect terminal width
  truncateTitle: 30,
  truncateNextStep: 80,
};

// Reference fields for bidirectional link checking
export const referenceFields = {
  bidirectional: ['related_docs'],    // warn if A→B but B↛A
  unidirectional: ['supports'],       // one-way, no symmetry check
};

// Query presets — expand to filter args when used as commands
export const presets = {
  stale: ['--status', 'active,ready,planned,blocked,research', '--stale', '--sort', 'updated', '--all'],
  actionable: ['--status', 'active,ready', '--has-next-step', '--sort', 'updated', '--all'],
};

// ─── Notion ──────────────────────────────────────────────────────────────────
// IMPORTANT: Use environment variables for tokens — never hardcode secrets in config files.
// export const notion = {
//   token: process.env.NOTION_TOKEN,
//   databaseId: process.env.NOTION_DATABASE_ID,
// };

// ─── Function Hooks ──────────────────────────────────────────────────────────
// Hooks are optional. Each receives a default implementation it can wrap or replace.

// Custom validation — called after built-in validation for each doc.
// Return { errors: [], warnings: [] } to add issues.
// export function validate(doc, ctx) {
//   const warnings = [];
//   if (doc.status === 'active' && !doc.owner) {
//     warnings.push({ path: doc.path, level: 'warning', message: 'Active docs should have an owner.' });
//   }
//   return { errors: [], warnings };
// }

// Override the context briefing output.
// export function renderContext(index, defaultRenderer) {
//   return defaultRenderer(index);
// }

// Override the index file rendering.
// export function renderIndex(index, defaultRenderer) {
//   return defaultRenderer(index);
// }

// Override the status snapshot display format.
// export function formatSnapshot(doc, defaultFormatter) {
//   return defaultFormatter(doc);
// }

// Post-parse doc transformation — add computed fields.
// export function transformDoc(doc) {
//   return doc;
// }

// Lifecycle callbacks — fire after the operation completes.
// export function onArchive(doc, { oldPath, newPath }) {}
// export function onStatusChange(doc, { oldStatus, newStatus, path }) {}
// export function onTouch(doc, { path, date }) {}
