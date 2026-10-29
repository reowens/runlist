import { commandHelpContext } from './commands.mjs';

export function unsupportedCommandHelp(command) {
  switch (command) {
    case 'edit':
      return 'Edit document text and ordinary frontmatter with your file editor.\n'
        + 'Change lifecycle status with `runlist set <status> <file>`.\n'
        + 'For ordered membership commands, read `runlist runlist --help`.';
    case 'claims':
      return 'Inspect ownership with `runlist doctor --claims` (read-only).\n'
        + 'Do not add --apply or --force merely to inspect another session\'s claim.';
    case 'link':
      return 'Inspect references with `runlist xref <file>`. Edit ordinary reference fields with your file editor.\n'
        + 'For ordered plan membership, use `runlist runlist add <hub> <child>`.\n'
        + 'Inspect saved prompts with `runlist prompts show <name>`; `runlist use` consumes them.';
    default:
      return null;
  }
}

function creationHelp(type) {
  return `runlist new ${type} <slug> @<draft-file> — create a ${type} from a draft

  runlist new ${type} example @<draft-file>
  runlist new ${type} example - < <draft-file>

Write the draft first. Its headings become the body; opening frontmatter
supplies scaffold fields while the command fixes type to ${type}.
${type === 'prompt' ? 'A saved prompt requires a body. Git policy: `runlist config get promptTracking`.' : type === 'plan' ? 'Creation does not claim the plan. Start authorized work with \`runlist use <plan>\`.' : 'Use a doc for reference material; creating it does not claim a plan.'}
Change lifecycle status later with \`runlist set <status> <file>\`.
Repository types, starting statuses and folders: \`runlist new --list-types\`.
Complete options and examples: \`runlist new --help\`.`;
}

const PROMPT_SHOW = `runlist prompts show <name...> — inspect saved prompts without consuming

  runlist prompts show resume-example
  runlist prompts show --all --limit 5

Showing a prompt does not archive it or claim its plan; safe to repeat.
Survey names with \`runlist prompts\`, then select the bodies you need.
To resume a selected prompt, use \`runlist use <name>\` inside an agent session.
Use --json for structured output. Keep --all batches bounded with --limit N.
Complete prompt commands: \`runlist prompts --help\`.`;

const CHILD_BATON = `runlist baton --subagent <task-slug> @<draft-file> [--parent resume-<name>]

  runlist baton --subagent task-example @<draft-file> --parent resume-example
  runlist baton --subagent --template --parent resume-example

Return completed results to the parent. Save unfinished work or an explicitly
requested handoff as subagent-<task-slug>; write the draft before saving.
Under a parent-owned plan, use a distinct slug that does not resolve to a plan
and preserve the parent's claim. A child owning its own plan may name that plan;
the baton releases that child's claim. --parent links the saved prompts and the
parent may be saved later. --template prints an outline without saving.
If a handoff exists, inspect it with \`runlist prompts show <name>\`; keep it if
current, or pass --replace with the new draft. Never consume it to replace it.
Complete handoff options: \`runlist baton --help\`.`;

export function focusedCommandHelp(command, argv) {
  if (!['new', 'prompts', 'baton'].includes(command)) return null;
  let context;
  try { context = commandHelpContext(command, argv); }
  catch { return { fallback: true }; }
  if (command === 'new' && ['plan', 'doc', 'prompt'].includes(context.positional[0])) {
    return { text: creationHelp(context.positional[0]) };
  }
  if (command === 'prompts' && context.subcommand === 'show') return { text: PROMPT_SHOW };
  if (command === 'baton' && argv.includes('--subagent')) return { text: CHILD_BATON };
  return context.positional.length ? { fallback: true } : null;
}
