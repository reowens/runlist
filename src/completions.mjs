import { die } from './util.mjs';

const COMMANDS = [
  'list', 'json', 'check', 'coverage', 'stats', 'graph', 'deps', 'context', 'focus', 'query',
  'index', 'status', 'archive', 'touch', 'doctor', 'lint', 'rename', 'migrate',
  'fix-refs', 'export', 'summary', 'watch', 'diff', 'init', 'new', 'completions',
];

const GLOBAL_FLAGS = ['--config', '--dry-run', '--verbose', '--root', '--help', '--version'];

const COMMAND_FLAGS = {
  query: ['--status', '--keyword', '--module', '--surface', '--domain', '--owner',
          '--updated-since', '--stale', '--has-next-step', '--has-blockers',
          '--checklist-open', '--sort', '--limit', '--all', '--git', '--json',
          '--summarize', '--summarize-limit', '--model'],
  index: ['--write'],
  list: ['--verbose'],
  coverage: ['--json'],
  new: ['--status', '--title', '--template', '--list-templates', '--root'],
  diff: ['--stat', '--since', '--summarize', '--model'],
  check: ['--errors-only', '--fix'],
  stats: ['--json'],
  graph: ['--dot', '--json', '--status', '--module', '--surface'],
  deps: ['--json', '--depth'],
  export: ['--format', '--output', '--status', '--module', '--root'],
  lint: ['--fix'],
  rename: [],
  migrate: [],
  'fix-refs': [],
  summary: ['--model', '--max-tokens', '--json'],
  context: ['--summarize', '--model'],
  touch: ['--git'],
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
