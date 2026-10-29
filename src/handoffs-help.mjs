// Per-command help where planning is off (a handoffs-only project,
// src/handoffs-mode.mjs), for the commands that still work there but whose
// usual help describes plans. `runlist help <cmd>` and `runlist <cmd> --help`
// both read this through the dispatcher's one help renderer. A planning
// command's help there is the planning-off line itself.

const OFF = '(planning is off in this project)';
const SETUP = '`runlist setup` turns it on (your prompts stay where they are).';

const HELP = {
  baton: `runlist baton — save a resume prompt for the next session ${OFF}

Usage (write the resume to a file first):
  runlist baton <slug> @<draft-file>   # saves resume-<slug> in docs/prompts/
  The resume can also come from stdin (\`-\`, or a pipe) or --message "..." for one-liners.
  Baton prints the prompt name it saved as its last line.

The resume (10–20 lines): the next concrete decision plus any gotchas, and the
paths it concerns — not a recap. The next session's hud lists the prompt and
\`runlist use <name>\` resumes it. When a handoff for the same work is already
pending, baton saves nothing and names it: inspect it with
\`runlist prompts show <name>\`, then pass --replace to refresh its text.

Options:
  --message / --body     Inline body (one-liners; prefer @path or stdin)
  --subagent             Save subagent-<name> instead of resume-<name>
  --parent <resume-name>  Group this --subagent handoff under its parent in prompts listings
  --template             Print a resume draft (or --subagent draft)
  --replace              Replace exactly one pending handoff; archive its prior text
  --json                 Structured result
  --dry-run, -n          Preview without writing

Examples:
  runlist baton --template > <draft-file>
  runlist baton checkout-fixes @<draft-file>
  runlist baton checkout-fixes @<new-draft-file> --replace
  runlist baton --subagent totals-review --parent resume-checkout-fixes @<child-draft-file>

Handing off a plan comes with planning; ${SETUP}`,

  new: `runlist new prompt <name> [body] — save a prompt under a name of its own ${OFF}

The prompt lands in docs/prompts/<name>.md as pending; the next session's hud
lists it and \`runlist use <name>\` resumes it. A name with a folder in it must
stay inside docs/prompts/.

Body: @<file> (preferred for more than one line), - (stdin), --message "...",
or inline for one-liners.

Options:
  --title "..."          Title (default: from the name)
  --message / --body     Inline body
  --dry-run, -n          Preview without writing

Examples:
  runlist new prompt look-at-retries @<draft-file>
  runlist new prompt cleanup --message "look at the remaining lint warnings"

Plans and docs come with planning; ${SETUP}`,

  set: `runlist set <status> <prompt> — change a saved prompt's status ${OFF}

A prompt is pending (waiting for a session) or archived (consumed or set
aside). \`runlist set archived <prompt>\` sets one aside, as
\`runlist prompts archive <prompt>\` does.

Options:
  --dry-run, -n          Preview without writing

Plan statuses come with planning; ${SETUP}`,

  status: `runlist status <prompt> <status> — deprecated; use \`runlist set <status> <prompt>\` ${OFF}

A prompt is pending or archived. Plan statuses come with planning; ${SETUP}`,

  statuses: `runlist statuses — the prompt statuses ${OFF}

  runlist statuses                  Table of the prompt statuses and their flags
  runlist statuses list --json      The same as JSON
  runlist statuses add|set|remove <name> --type prompt
                                    Edit the prompt statuses in runlist.config.mjs

Plan and doc statuses come with planning; ${SETUP}`,

  archive: `runlist archive <prompt> — set a saved prompt aside without reading it ${OFF}

Sets the prompt to archived and moves it to docs/prompts/archived/, as
\`runlist prompts archive <prompt>\` does. <prompt> is a path or a name.

Options:
  --dry-run, -n          Preview without writing`,

  prompts: `runlist prompts — saved prompts ${OFF}

Prompts are the handoffs runlist keeps in docs/prompts/. Consuming one prints
its body and archives it (one-shot). Only an agent session consumes; in a plain
terminal \`use\` and \`next\` print the body and the command the session runs.

Subcommands:
  list                       List pending prompts (default)
  next                       Consume the oldest pending prompt
  use <name>                 Consume a named prompt (\`resume\` is an alias)
  show <name...>             Read prompts without consuming them (\`peek\` is an alias)
  archive <name>             Set a prompt aside without reading it
  link <child...> --parent <resume-name>
                             Attach existing child handoffs to their parent
  new <slug> [body]          Save a prompt (\`runlist new prompt <slug>\`)

A prompt is pending or archived.

Examples:
  runlist prompts                     # pending prompts
  runlist prompts show resume-foo     # peek without consuming
  runlist prompts show a b c          # peek several by name
  runlist prompts use resume-foo      # in a session: consume it
  runlist prompts archive old-thing   # set one aside`,

  briefing: `runlist briefing — the check counts ${OFF}

Shows the stale, error and warning counts, then says planning is off;
\`runlist prompts\` lists the saved prompts. Plan pipelines come with
planning; ${SETUP}

Options:
  --json                 Output as JSON`,

  hud: `runlist hud — what a new session is told at startup ${OFF}

Prints the pending prompts, saying to resume one only when asked
(\`runlist use <name>\`), and actionable notices; silent when nothing needs
attention. --prompt-submit reads a hook JSON payload from stdin: save requests
get baton instructions; pickup requests get a hint only when prompts are
pending. Text hooks read prompt frontmatter without building the index.

Options:
  --prompt-submit        Request-specific save/pickup hint (hook JSON on stdin)
  --subagent             Compact workflow primer for child agents
  --json                 Output as JSON`,
};

export function handoffsCommandHelp(command) {
  return HELP[command] ?? null;
}
