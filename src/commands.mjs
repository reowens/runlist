// Canonical list of CLI verbs the dispatcher in bin/dotmd.mjs handles.
// Source of truth for both the unknown-command suggester and the self-check
// that asserts every `dotmd <verb>` reference in generated slash-command
// templates points at a real command.
export const KNOWN_COMMANDS = [
  'list', 'json', 'check', 'coverage', 'stats', 'graph', 'deps', 'briefing', 'context', 'agent-context', 'hud',
  'focus', 'query', 'grep', 'plans', 'prompts', 'stale', 'actionable', 'index', 'status', 'set', 'use', 'next', 'archive', 'bulk', 'bulk-tag', 'touch', 'doctor', 'runlist', 'runlists',
  'unblocks', 'health', 'glossary', 'modules', 'module',
  'fix-refs', 'lint', 'rename', 'migrate', 'notion', 'export', 'summary',
  'watch', 'diff', 'new', 'init', 'completions', 'statuses', 'journal',
  'guard', 'misuse', 'update',
  'ship', 'self-check', 'baton',
];
