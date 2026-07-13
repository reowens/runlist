import { die } from './util.mjs';
import { COMPLETION_COMMANDS, GLOBAL_OPTIONS, PUBLIC_COMMANDS, commandCompletionWords } from './commands.mjs';

const GLOBAL_FLAGS = GLOBAL_OPTIONS.flatMap(option => option.names);
const COMMAND_WORDS = Object.freeze(Object.fromEntries(
  PUBLIC_COMMANDS.map(command => [command, commandCompletionWords(command)]),
));

function bashCompletion() {
  return `# dotmd bash completion
# Add to ~/.bashrc: eval "$(dotmd completions bash)"
_dotmd() {
  local cur cmd expect_value
  cur="\${COMP_WORDS[COMP_CWORD]}"
  cmd=""
  expect_value=0

  # Find the command while skipping pre-command global flags and their values.
  for ((i=1; i < COMP_CWORD; i++)); do
    if (( expect_value )); then expect_value=0; continue; fi
    case "\${COMP_WORDS[i]}" in
      --config|--root|--type) expect_value=1 ;;
      --dry-run|-n|--verbose|--help|-h|--version|-v) ;;
      -*) ;;
      *) cmd="\${COMP_WORDS[i]}"; break ;;
    esac
  done

  if [[ -z "$cmd" ]]; then
    COMPREPLY=( $(compgen -W "${COMPLETION_COMMANDS.join(' ')} ${GLOBAL_FLAGS.join(' ')}" -- "$cur") )
    return
  fi

  case "$cmd" in
${Object.entries(COMMAND_WORDS).map(([command, words]) =>
    `    ${command}) COMPREPLY=( $(compgen -W "${words.join(' ')} ${GLOBAL_FLAGS.join(' ')}" -- "$cur") ) ;;`
  ).join('\n')}
    prompt) COMPREPLY=( $(compgen -W "${commandCompletionWords('prompts').join(' ')} ${GLOBAL_FLAGS.join(' ')}" -- "$cur") ) ;;
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
${COMPLETION_COMMANDS.map(command => `    '${command}'`).join('\n')}
  )
  global_flags=(
${GLOBAL_FLAGS.map(option => `    '${option}'`).join('\n')}
  )

  local cmd=''
  local expect_value=0
  for ((i=2; i < CURRENT; i++)); do
    if (( expect_value )); then expect_value=0; continue; fi
    case "\${words[i]}" in
      --config|--root|--type) expect_value=1 ;;
      --dry-run|-n|--verbose|--help|-h|--version|-v) ;;
      -*) ;;
      *) cmd="\${words[i]}"; break ;;
    esac
  done

  if [[ -z "$cmd" ]]; then
    _describe 'command' commands
    _describe 'flag' global_flags
    return
  fi

  case "$cmd" in
${Object.entries(COMMAND_WORDS).map(([command, words]) =>
    `    ${command}) _values 'arguments' ${words.map(word => `'${word}'`).join(' ')} ;;`
  ).join('\n')}
    prompt) _values 'arguments' ${commandCompletionWords('prompts').map(word => `'${word}'`).join(' ')} ;;
  esac

  _describe 'flag' global_flags
}
compdef _dotmd dotmd`;
}

export function runCompletions(argv) {
  const shell = argv[0];
  if (!shell) die('Usage: dotmd completions <bash|zsh>');
  if (shell === 'bash') process.stdout.write(bashCompletion() + '\n');
  else if (shell === 'zsh') process.stdout.write(zshCompletion() + '\n');
  else die(`Unsupported shell: ${shell}\nSupported: bash, zsh`);
}
