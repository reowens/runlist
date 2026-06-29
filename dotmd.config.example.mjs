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

// Document types — each type has its own status vocabulary and context layout.
// Defaults: plan, doc, prompt. Override to customize statuses per type, or add new types.
//
// Statuses can be defined as an array (names only) or as an object (rich form).
// The object form co-locates all behavioral properties with each status,
// eliminating the need for separate lifecycle, staleDays, context, and taxonomy sections.

// ─── Rich status definitions (recommended) ──────────────────────────────────
// Each status is an object with optional properties:
//   context:        'expanded' | 'listed' | 'counted' (default: 'counted')
//   staleDays:      number | null — stale threshold (default: null = never stale)
//   requiresModule: boolean — require `module` frontmatter (default: false)
//   archive:        boolean — auto-move to archiveDir on transition (default: false)
//   terminal:       boolean — closed state; excluded from active-work stats/coverage scope (default: false)
//   skipStale:      boolean — exempt from stale checks (default: false)
//   skipWarnings:   boolean — exempt from validation warnings (default: false)
//   quiet:          boolean — sugar for `skipStale: true, skipWarnings: true`. Use for visible-but-quiet
//                   statuses (e.g. `partial`) where you want no nagging but DO want them in scope.
//                   Setting `skipStale: false` or `skipWarnings: false` explicitly overrides the sugar.
//
// `terminal` and `quiet` are orthogonal. Mark a status `terminal` only when it represents closure
// (excluded from active-work scope). Use `quiet` for noise suppression without closure semantics.
//
// Contradiction check (since 0.36.2): dotmd `warn()`s at config-load when a status combines
// `skipStale: true` with a `staleDays` value (the number is silently ignored) or
// `skipWarnings: true` with `requiresModule: true` (the module requirement can never fire).
// The same check applies via the `quiet: true` sugar. Drop one of the conflicting fields to silence.
//
// Each plan stop-status maps to a distinct unstuck-action — the test for whether
// the vocabulary earns its weight. blocked = monitor (external arrival on its own
// schedule), awaiting = ask (chase the human/decision), queued-after = check the
// predecessor, paused = re-evaluate, partial = spawn successor plans for the
// deferred tail.
//
// export const types = {
//   plan: {
//     statuses: {
//       'in-session':   { context: 'expanded', staleDays: 1, requiresModule: true },
//       'active':       { context: 'expanded', staleDays: 14, requiresModule: true },
//       'planned':      { context: 'listed', staleDays: 30, requiresModule: true },
//       'blocked':      { context: 'listed', staleDays: 30, requiresModule: true },
//       'partial':      { context: 'expanded', requiresModule: true, quiet: true },     // shipped + deferred tail; visible, no nagging
//       'paused':       { context: 'listed', staleDays: 3, requiresModule: true },      // stopped mid-work, near-term review — loud (short stale threshold)
//       'awaiting':     { context: 'listed', staleDays: 14, requiresModule: true },     // human input/decision wait — NOT quiet (pings get forgotten)
//       'queued-after': { context: 'counted', requiresModule: true, quiet: true },      // sequenced behind another plan
//       'archived':     { context: 'counted', archive: true, terminal: true, quiet: true },
//     },
//   },
//   doc: {
//     statuses: {
//       'draft':      { context: 'listed', staleDays: 30 },
//       'active':     { context: 'expanded', staleDays: 14 },
//       'review':     { context: 'listed', staleDays: 14 },
//       'reference':  { context: 'counted', skipStale: true },
//       'deprecated': { context: 'counted', terminal: true, skipStale: true },
//       'archived':   { context: 'counted', archive: true, terminal: true, quiet: true },
//     },
//   },
//   prompt: {
//     // Saved prompts that seed future Claude sessions. `dotmd hud` surfaces
//     // pending prompts on session start; `dotmd prompts next` claims the oldest.
//     statuses: {
//       'pending':  { context: 'expanded', staleDays: 30 },
//       'held':     { context: 'counted', quiet: true },   // saved but not next: hidden from hud/briefing, skipped by no-arg `use`
//       'shelved':  { context: 'counted', quiet: true },   // legacy alias for held
//       'claimed':  { context: 'counted', quiet: true },
//       'archived': { context: 'counted', archive: true, terminal: true, quiet: true },
//     },
//   },
// };

// ─── Array form (also supported) ────────────────────────────────────────────
// When using array form, define behavior in separate statuses/lifecycle/taxonomy sections.
// export const types = {
//   plan: {
//     statuses: ['in-session', 'active', 'planned', 'blocked', 'partial', 'paused', 'awaiting', 'queued-after', 'archived'],
//     context: {
//       expanded: ['in-session', 'active', 'partial'],
//       listed: ['planned', 'blocked', 'paused', 'awaiting'],
//       counted: ['queued-after', 'archived'],
//     },
//     staleDays: { 'in-session': 1, active: 14, planned: 30, blocked: 30, awaiting: 14 },
//   },
// };

// Status workflow — fallback for docs without a type field. Order determines display grouping.
// When using rich status definitions, statuses.order and staleDays are derived automatically.
export const statuses = {
  order: ['active', 'ready', 'planned', 'scoping', 'blocked', 'reference', 'archived'],
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
    scoping: 30,
  },
};

// Lifecycle behavior — which statuses trigger special handling.
//
// IMPORTANT: only enable this block if you're using ARRAY-form types (above) or
// no `types` definition. With rich-form types, the runtime derives these from
// per-status `terminal` / `archive` / `skipStale` / `skipWarnings` / `quiet`
// flags. An explicit `lifecycle` export sitting alongside rich-form types will
// SILENTLY OVERRIDE the per-status flags — `dotmd statuses` will warn you
// before writing into a config in that state.
//
// export const lifecycle = {
//   archiveStatuses: ['archived'],      // auto-move to archiveDir on transition
//   skipStaleFor: ['archived'],         // skip staleness checks
//   skipWarningsFor: ['archived'],      // skip validation warnings (summary, etc.)
//   terminalStatuses: ['archived', 'deprecated', 'reference'],  // skip current_state/next_step warnings, exclude from stats scope
//   archiveNestedTypes: ['prompt'],     // types that archive under <typeDir>/<archiveDir>
//                                       // (e.g. docs/prompts/archived/) instead of the
//                                       // shared <root>/<archiveDir>; set [] to disable
// };

// Taxonomy validation — set fields to null to skip validation.
// moduleRequiredFor is derived from requiresModule when using rich status definitions.
export const taxonomy = {
  surfaces: ['web', 'ios', 'android', 'mobile', 'full-stack', 'frontend', 'backend', 'api', 'docs', 'ops', 'platform', 'infra', 'design'],
  moduleRequiredFor: ['active', 'ready', 'planned', 'blocked'],
};

// Index file generation — remove this section to disable
export const index = {
  path: 'docs/docs.md',
  startMarker: '<!-- GENERATED:dotmd:start -->',
  endMarker: '<!-- GENERATED:dotmd:end -->',
  snapshot: 'status', // default; use 'state' to include live current_state text
  archivedLimit: 8,
};

// Context briefing layout (`dotmd context`)
export const context = {
  expanded: ['active'],
  listed: ['ready', 'planned'],
  counted: ['blocked', 'scoping', 'reference', 'archived'],
  recentDays: 3,
  recentStatuses: ['active', 'ready', 'planned'],
  recentLimit: 10,
  truncateNextStep: 80,
  // Cap on slugs shown in the "Stale: …" tail before "…and N more (run `dotmd stale`)"
  // takes over (since 0.36.2). Raise on wide terminals; lower for tighter briefings.
  staleTailLimit: 8,
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
// Built-in: plans, stale, actionable. Add your own here:
export const presets = {
  // plans: ['--type', 'plan', '--sort', 'status', '--all'],           // built-in
  // stale: ['--status', '...', '--stale', '--sort', 'updated', '--all'], // built-in
  // actionable: ['--status', 'active,ready', '--has-next-step', ...],   // built-in
  mine: ['--owner', 'robert', '--status', 'active', '--all'],
};

// ─── Templates ───────────────────────────────────────────────────────────────
// Define new types or override builtins. `dotmd new <type> <name>` looks here first.
//
// Properties:
//   description:    string — shown in `dotmd new --list-types`
//   defaultStatus:  string — initial status if `--status` not passed
//   acceptsBody:    boolean — allow body input (inline / --body / @file / piped stdin).
//                   REQUIRED if you want `cat draft.md | dotmd new <type> <slug>` (or @path,
//                   --body, heredoc) to work. Your `body` fn must also interpolate the input,
//                   e.g. `${ctx?.bodyInput?.trim() ?? ''}`. See the body-acceptance guard below.
//   requiresBody:   boolean — error if no body input (implies acceptsBody; see `prompt` builtin)
//   targetRoot:     string — name (basename or suffix) of the root this type lives in.
//                   In flat-array `root` configs (e.g. ['docs/plans', 'docs/prompts']),
//                   the new doc lands in the matching root. Falls back to `config.docsRoot`
//                   if no root matches. The `--root` CLI flag still overrides.
//   dir:            string — subdirectory under `docsRoot` to use when `targetRoot` doesn't
//                   match anything. Builtin `plan` and `prompt` set both for portability:
//                   under `docsRoot='docs'`, `dir` puts files in `docs/plans/` and `docs/prompts/`;
//                   under flat-array roots, `targetRoot` routes directly to the type-specific root.
//   frontmatter:    (status, isoTime, ctx) => string
//   body:           (title, ctx) => string — slot user-supplied body via `ctx.bodyInput`
//
// Body-acceptance guard (the #1 custom-template gotcha):
//   When you override a builtin and supply your OWN `body` fn that NEVER references
//   `bodyInput`, dotmd assumes the fn would silently discard piped input — so it strips
//   the inherited `acceptsBody`/`requiresBody` and rejects body input with a fail-fast
//   error. Two ways to keep piped/@path/heredoc bodies working in a custom template:
//     1. interpolate `${ctx?.bodyInput?.trim() ?? ''}` somewhere in your `body` fn, OR
//     2. set `acceptsBody: true` explicitly (do BOTH if you want the input to actually land).
//   A `body: (t) =>` that ignores `ctx` is the classic trap — it scaffolds fine but
//   `dotmd new <type> <slug> < draft.md` errors until you wire in `bodyInput`.
//
// Custom type example — adds a `spike` type that lives in the `spikes` root (or
// under `docs/spikes/` in single-root layouts):
// export const templates = {
//   spike: {
//     description: 'Timeboxed investigation',
//     defaultStatus: 'active',
//     targetRoot: 'spikes',  // for flat-array root configs
//     dir: 'spikes',          // for single-root configs
//     frontmatter: (s, d) => `type: spike\nstatus: ${s}\ncreated: ${d}\ntimebox: 2d`,
//     body: (t) => `\n# ${t}\n\n## Hypothesis\n\n\n\n## Findings\n\n`,
//   },
//
//   // Override a builtin (e.g. project-specific prompt frontmatter shape).
//   // Overrides shallow-merge OVER the builtin: any property you omit is inherited
//   // (`targetRoot`, `dir`, `defaultStatus`, `requiresBody`, …), and anything you declare
//   // wins. EXCEPTION: if you supply your own `body` fn that doesn't reference `bodyInput`,
//   // the inherited `acceptsBody`/`requiresBody` are dropped (see the guard above) — so
//   // re-declare `acceptsBody: true` and wire in `ctx.bodyInput` if you want piped bodies.
//   // prompt: {
//   //   description: 'Project resume prompt',
//   //   defaultStatus: 'pending',
//   //   requiresBody: true,
//   //   targetRoot: 'prompts',
//   //   dir: 'prompts',
//   //   frontmatter: (s, d, ctx) => `type: prompt\nstatus: ${s}\nproject_field: yes`,
//   //   body: (t, ctx) => `\n${ctx?.bodyInput ?? ''}\n`,
//   // },
// };

// ─── Notion ──────────────────────────────────────────────────────────────────
// IMPORTANT: Use environment variables for tokens — never hardcode secrets in config files.
// export const notion = {
//   token: process.env.NOTION_TOKEN,
//   database: process.env.NOTION_DATABASE_ID,
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

// Render hooks — override any renderer by wrapping the default.
// export function renderContext(index, defaultRenderer) { return defaultRenderer(index); }
// export function renderCompactList(index, defaultRenderer) { return defaultRenderer(index); }
// export function renderCheck(index, defaultRenderer) { return defaultRenderer(index); }
// export function renderStats(stats, defaultRenderer) { return defaultRenderer(stats); }
// export function renderGraph(graph, defaultRenderer) { return defaultRenderer(graph); }
// export function formatSnapshot(doc, defaultFormatter) { return defaultFormatter(doc); }

// Post-parse doc transformation — add computed fields.
// export function transformDoc(doc) {
//   return doc;
// }

// Lifecycle callbacks — fire after the operation completes.
// export function onArchive(doc, { oldPath, newPath }) {}
// export function onStatusChange(doc, { oldStatus, newStatus, path }) {}
// export function onTouch(doc, { path, date }) {}
// export function onNew({ path, status, title, template }) {}
// export function onRename({ oldPath, newPath, referencesUpdated }) {}
// export function onLint({ path, fixes }) {}
// export function onPickup({ path, oldStatus, newStatus }) {}

// AI hooks — override summarization (replaces local MLX model).
// export function summarizeDoc(body, meta) { return 'Custom summary'; }
// export function summarizeDiff(diffOutput, filePath) { return 'Custom diff summary'; }
