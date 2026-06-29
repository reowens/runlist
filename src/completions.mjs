import { die } from './util.mjs';
import { KNOWN_COMMANDS } from './commands.mjs';

// Derive the completable command list from the dispatcher's canonical verb list
// so completions never drift behind new commands. A tiny denylist drops verbs
// that exist but shouldn't be tab-completed (internal self-test).
const COMPLETION_DENYLIST = new Set(['self-check']);
const COMMANDS = KNOWN_COMMANDS.filter(c => !COMPLETION_DENYLIST.has(c));

const GLOBAL_FLAGS = ['--config', '--dry-run', '--verbose', '--root', '--type', '--help', '--version'];

// Shared filter flags for the query-style commands (mirrors QUERY_FLAGS in
// bin/dotmd.mjs). Kept as one array so query/grep/stale/actionable/plans stay
// in lockstep.
const QUERY_FLAGS = [
  '--type', '--status', '--keyword', '--body', '--owner', '--surface', '--module',
  '--domain', '--audience', '--execution-mode', '--updated-since', '--limit', '--sort',
  '--group', '--all', '--include-archived', '--exclude-archived', '--stale',
  '--has-next-step', '--has-blockers', '--checklist-open', '--json', '--git',
  '--summarize', '--summarize-limit', '--model',
];

const COMMAND_FLAGS = {
  query: QUERY_FLAGS,
  grep: QUERY_FLAGS,
  stale: QUERY_FLAGS,
  actionable: QUERY_FLAGS,
  plans: ['status', ...QUERY_FLAGS],
  list: ['--verbose', '--json'],
  briefing: ['--json'],
  context: ['--json', '--compact', '--summarize', '--model'],
  'agent-context': ['--json'],
  hud: ['--json', '--subagent'],
  index: ['--write'],
  coverage: ['--json'],
  stats: ['--json'],
  graph: ['--dot', '--json', '--status', '--module', '--surface'],
  deps: ['--json', '--depth'],
  unblocks: ['--json'],
  health: ['--json'],
  glossary: ['--list', '--json'],
  modules: ['--sort', '--json'],
  module: ['--json'],
  surfaces: ['--json'],
  runlists: ['--json', '--limit', '--sort'],
  runlist: ['next', '--json', '--full', '--no-index', '--show-files'],
  prompts: ['list', 'next', 'use', 'show', 'archive', 'new', 'hold', 'unhold',
            '--json', '--status', '--include-archived', '--sort', '--limit', '--all'],
  use: [],
  next: [],
  baton: ['--status', '--note', '--body', '--message', '--dry-run'],
  set: [],
  status: [],
  archive: ['--note', '--no-index', '--show-files', '--closeout-template'],
  bulk: ['archive', 'tag'],
  statuses: ['list', 'add', '--type', '--like', '--json'],
  update: ['--check', '--cli-only', '--plugin-only'],
  misuse: ['--json', '--tail', '--by-rule', '--repo'],
  journal: ['--tail', '--errors', '--session', '--since', '--by-command', '--json'],
  new: ['--status', '--title', '--template', '--list-templates', '--root', '--message', '--body'],
  notion: ['import', 'export', 'sync', '--force', '--dry-run'],
  export: ['--format', '--output', '--status', '--module', '--root', '--type'],
  focus: ['--json'],
  summary: ['--model', '--max-tokens', '--json'],
  diff: ['--stat', '--since', '--summarize', '--model'],
  touch: ['--git'],
  check: ['--fix', '--errors-only', '--no-collapse', '--json', '--verbose'],
  doctor: ['--apply', '--yes', '--dry-run', '--statuses', '--migrate-template',
           '--migrate-prompts', '--frontmatter-fix', '--project', '--json', '--include-archived'],
  lint: ['--fix'],
  ship: [],
  rename: [],
  migrate: [],
  'fix-refs': [],
};

function bashCompletion() {
  return `# dotmd bash completion
# Add to ~/.bashrc: eval "$(dotmd completions bash)"
_dotmd() {
  local cur prev cmd
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  # Find the subcommand
  cmd=""
  for ((i=1; i < COMP_CWORD; i++)); do
    case "\${COMP_WORDS[i]}" in
      -*) ;;
      *) cmd="\${COMP_WORDS[i]}"; break ;;
    esac
  done

  # Complete commands if no subcommand yet
  if [[ -z "$cmd" ]]; then
    COMPREPLY=( $(compgen -W "${COMMANDS.join(' ')} ${GLOBAL_FLAGS.join(' ')}" -- "$cur") )
    return
  fi

  # Per-command flag completion
  case "$cmd" in
${Object.entries(COMMAND_FLAGS).map(([cmd, flags]) =>
    `    ${cmd}) COMPREPLY=( $(compgen -W "${flags.join(' ')} ${GLOBAL_FLAGS.join(' ')}" -- "$cur") ) ;;`
  ).join('\n')}
    *) COMPREPLY=( $(compgen -W "${GLOBAL_FLAGS.join(' ')}" -- "$cur") ) ;;
  esac
}
complete -F _dotmd dotmd`;
}

function zshCompletion() {
  return `# dotmd zsh completion
# Add to ~/.zshrc: eval "$(dotmd completions zsh)"
_dotmd() {
  local -a commands global_flags
  commands=(
${COMMANDS.map(c => `    '${c}'`).join('\n')}
  )
  global_flags=(
${GLOBAL_FLAGS.map(f => `    '${f}'`).join('\n')}
  )

  if (( CURRENT == 2 )); then
    _describe 'command' commands
    _describe 'flag' global_flags
    return
  fi

  local cmd=\${words[2]}
  case "$cmd" in
${Object.entries(COMMAND_FLAGS).map(([cmd, flags]) =>
    `    ${cmd}) _values 'flags' ${flags.map(f => `'${f}'`).join(' ')} ;;`
  ).join('\n')}
  esac

  _describe 'flag' global_flags
}
compdef _dotmd dotmd`;
}

export function runCompletions(argv) {
  const shell = argv[0];
  if (!shell) {
    die('Usage: dotmd completions <bash|zsh>');
  }
  if (shell === 'bash') {
    process.stdout.write(bashCompletion() + '\n');
  } else if (shell === 'zsh') {
    process.stdout.write(zshCompletion() + '\n');
  } else {
    die(`Unsupported shell: ${shell}\nSupported: bash, zsh`);
  }
}
