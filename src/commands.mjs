// Canonical list of CLI verbs the dispatcher in bin/dotmd.mjs handles.
// Source of truth for both the unknown-command suggester and the self-check
// that asserts every `dotmd <verb>` reference in generated slash-command
// templates points at a real command.
export const KNOWN_COMMANDS = [
  'list', 'json', 'check', 'coverage', 'stats', 'graph', 'deps', 'briefing', 'context', 'hud',
  'focus', 'query', 'plans', 'prompts', 'stale', 'actionable', 'index', 'pickup', 'release', 'finish', 'status', 'archive', 'bulk', 'bulk-tag', 'touch', 'doctor',
  'unblocks', 'health', 'glossary', 'modules', 'module',
  'fix-refs', 'lint', 'rename', 'migrate', 'notion', 'export', 'summary',
  'watch', 'diff', 'new', 'init', 'completions', 'statuses', 'journal',
];
