// Canonical command grammar. Execution stays in bin/dotmd.mjs; this schema owns
// names, aliases, visibility, options, positional arity, help groups, and policy.
const none = Object.freeze({ mutation: 'none', pathPolicy: 'read-only' });
const mutates = (pathPolicy) => Object.freeze({ mutation: 'conditional', pathPolicy });

const flag = (...names) => Object.freeze({ names: Object.freeze(names), arity: 0 });
const value = (...names) => Object.freeze({ names: Object.freeze(names), arity: 1 });
const optionalValue = (...names) => Object.freeze({ names: Object.freeze(names), arity: 'optional' });
const positionals = (min = 0, max = min) => Object.freeze({ min, max });
const form = (syntax, { subcommands = [], args = positionals(), options = [], passthrough = false, dashPositionalsAfter = Infinity } = {}) => Object.freeze({
  syntax,
  subcommands: Object.freeze(subcommands),
  positionals: args,
  options: Object.freeze(options),
  passthrough,
  dashPositionalsAfter,
});

export const GLOBAL_OPTIONS = Object.freeze([
  value('--config'), value('--root'), value('--type'),
  flag('--dry-run', '-n'), flag('--verbose'), flag('--help', '-h'), flag('--version', '-v'),
]);

const QUERY_OPTIONS = Object.freeze([
  value('--type'), value('--status'), value('--keyword'), flag('--body'), value('--owner'),
  value('--surface'), value('--module'), value('--domain'), value('--audience'),
  value('--execution-mode'), value('--updated-since'), value('--limit'), value('--sort'),
  value('--group'), flag('--all'), flag('--include-archived'), flag('--exclude-archived'),
  flag('--stale'), flag('--has-next-step'), flag('--has-blockers'), flag('--checklist-open'),
  flag('--json'), flag('--git'), flag('--summarize'), value('--summarize-limit'), value('--model'),
]);
const LIFECYCLE_OPTIONS = Object.freeze([
  value('--note'), flag('--no-index'), flag('--show-files'), flag('--force'),
]);
const STATUS_PROPERTY_OPTIONS = Object.freeze([
  value('--type'), value('--like'), flag('--yes', '-y'), flag('--ignore-lifecycle-override'), flag('--json'),
  value('--context'), value('--staleDays'),
  flag('--requiresModule', '--no-requiresModule'), flag('--terminal', '--no-terminal'),
  flag('--archive', '--no-archive'), flag('--skipStale', '--no-skipStale'),
  flag('--skipWarnings', '--no-skipWarnings'), flag('--quiet', '--no-quiet'),
]);

const command = (name, policy, group, forms, extra = {}) => Object.freeze({
  name,
  policy,
  group,
  forms: Object.freeze(forms),
  aliases: Object.freeze(extra.aliases ?? []),
  visibility: extra.visibility ?? 'public',
});

const definitions = [
  command('help', none, 'setup', [form('[topic]', { args: positionals(0, 1) })]),
  command('completions', none, 'setup', [form('<bash|zsh>', { args: positionals(1, 1) })]),
  command('init', mutates('repository setup paths and config files'), 'setup', [form('', { options: [flag('--force')] })]),
  command('watch', mutates('proxy: child command policy applies'), 'setup', [form('[command...]', { args: positionals(0, Infinity), passthrough: true })]),

  command('list', none, 'read', [form('', { options: [flag('--json'), flag('--verbose')] })]),
  command('json', none, 'read', [form('')]),
  command('coverage', none, 'read', [form('', { options: [flag('--json')] })]),
  command('stats', none, 'read', [form('', { options: [flag('--json')] })]),
  command('graph', none, 'read', [form('', { options: [flag('--dot'), flag('--json'), value('--status'), value('--module'), value('--surface')] })]),
  command('deps', none, 'read', [form('[file]', { args: positionals(0, 1), options: [flag('--json'), value('--depth')] })]),
  command('briefing', none, 'read', [form('', { options: [flag('--json')] })]),
  command('context', none, 'read', [form('', { options: [flag('--json'), flag('--compact'), flag('--summarize'), value('--model')] })]),
  command('agent-context', none, 'read', [form('', { options: [flag('--json')] })]),
  command('hud', none, 'read', [form('', { options: [flag('--json'), flag('--subagent')] })]),
  command('focus', none, 'read', [form('[status]', { args: positionals(0, 1), options: [flag('--json')] })]),
  command('query', none, 'read', [form('[terms...]', { args: positionals(0, Infinity), options: QUERY_OPTIONS })]),
  command('grep', none, 'read', [form('<term> [terms...]', { args: positionals(1, Infinity), options: QUERY_OPTIONS })]),
  command('plans', none, 'read', [
    form('[terms...]', { args: positionals(0, Infinity), options: QUERY_OPTIONS }),
    form('status [terms...]', { subcommands: ['status'], args: positionals(0, Infinity), options: QUERY_OPTIONS }),
  ]),
  command('runlists', none, 'read', [form('', { options: [flag('--json'), value('--limit'), value('--sort')] })]),
  command('roadmaps', none, 'read', [form('', { options: [flag('--json')] })]),
  command('diff', none, 'read', [form('[file]', { args: positionals(0, 1), options: [flag('--stat'), value('--since'), flag('--summarize'), value('--model')] })]),
  command('summary', none, 'read', [form('<file>', { args: positionals(1, 1), options: [value('--model'), value('--max-tokens'), flag('--json')] })]),
  command('unblocks', none, 'read', [form('<file>', { args: positionals(1, 1), options: [flag('--json')] })]),
  command('health', none, 'read', [form('', { options: [flag('--json')] })]),
  command('glossary', none, 'read', [form('[term]', { args: positionals(0, 1), options: [flag('--list'), flag('--json')] })]),
  command('modules', none, 'read', [form('', { options: [value('--sort'), value('--limit'), flag('--all'), flag('--json')] })]),
  command('module', none, 'read', [form('<name>', { args: positionals(1, 1), options: [value('--sort'), flag('--json')] })]),
  command('surfaces', none, 'read', [form('', { options: [flag('--json')] })]),
  command('journal', none, 'read', [form('', { options: [value('--tail'), flag('--errors'), value('--session'), value('--since'), flag('--by-command'), flag('--json')] })]),
  command('misuse', none, 'read', [form('', { options: [flag('--json'), value('--tail'), flag('--by-rule'), value('--repo')] })]),

  command('roadmap', mutates('managed source when `next`; otherwise read-only'), 'workflow', [
    form('[hub]', { args: positionals(0, 1), options: [flag('--json')] }),
    form('next [hub]', { subcommands: ['next'], args: positionals(0, 1), options: [flag('--json'), flag('--full'), flag('--no-index')] }),
  ]),
  command('prompts', mutates('managed sources/destinations by subcommand'), 'workflow', [
    form('', { options: [flag('--json'), value('--status'), flag('--include-archived'), value('--sort'), value('--limit'), flag('--all')] }),
    form('list', { subcommands: ['list', 'status'], options: [flag('--json'), value('--status'), flag('--include-archived'), value('--sort'), value('--limit'), flag('--all')] }),
    form('next', { subcommands: ['next'] }),
    form('use [file]', { subcommands: ['use', 'resume'], args: positionals(0, 1), options: [flag('--no-index'), flag('--show-files'), flag('--force')] }),
    form('show [file]', { subcommands: ['show', 'peek'], args: positionals(0, 1), options: [flag('--json')] }),
    form('archive <file>', { subcommands: ['archive'], args: positionals(1, 1), options: [flag('--no-index'), flag('--show-files')] }),
    form('new <slug> [body...]', { subcommands: ['new'], args: positionals(1, Infinity), options: [value('--body', '--message'), value('--title'), value('--status')] }),
    form('hold <file>', { subcommands: ['hold', 'shelve'], args: positionals(1, 1) }),
    form('unhold <file>', { subcommands: ['unhold', 'unshelve'], args: positionals(1, 1) }),
  ], { aliases: ['prompt'] }),
  command('use', mutates('managed source when starting/consuming; docs remain read-only'), 'workflow', [form('[file]', { args: positionals(0, 1), options: [flag('--json'), flag('--full'), flag('--no-index'), flag('--show-files'), flag('--force')] })]),
  command('next', mutates('managed prompt source and same-root archive destination'), 'workflow', [form('', { options: [flag('--json'), flag('--no-index'), flag('--show-files'), flag('--force')] })]),
  command('baton', mutates('managed plan/prompt sources and managed prompt destination'), 'workflow', [form('[plan|slug] <@draft|->', { args: positionals(0, 2), options: [value('--status'), value('--note'), value('--body', '--message'), flag('--force'), flag('--json')] })]),
  command('runlist', mutates('managed hubs/children and managed scaffold destinations'), 'workflow', [
    form('<hub>', { args: positionals(1, 1), options: [flag('--json')] }),
    form('next <hub>', { subcommands: ['next'], args: positionals(1, 1), options: [flag('--json'), flag('--full'), flag('--no-index'), flag('--show-files')] }),
    form('add <hub> <child...>', { subcommands: ['add'], args: positionals(2, Infinity), options: [flag('--json')] }),
    form('remove <hub> <child...>', { subcommands: ['remove'], args: positionals(2, Infinity), options: [flag('--json'), flag('--clear-parent')] }),
    form('reorder <hub> <child...>', { subcommands: ['reorder'], args: positionals(2, Infinity), options: [flag('--json'), value('--before'), value('--after')] }),
  ]),

  command('export', mutates('external output path intentionally unrestricted'), 'mutate', [form('[file]', { args: positionals(0, 1), options: [value('--format'), value('--output'), value('--status'), value('--module'), value('--root'), value('--type')] })]),
  command('guard', mutates('global misuse log; no managed document writes'), 'mutate', [form('')]),
  command('update', mutates('global CLI and plugin installation state'), 'mutate', [form('', { options: [flag('--check'), flag('--cli-only'), flag('--plugin-only')] })]),
  command('status', mutates('managed source and same-root destination'), 'mutate', [form('<file> [status]', { args: positionals(1, 2), options: LIFECYCLE_OPTIONS })]),
  command('set', mutates('managed source and same-root destination'), 'mutate', [form('<status> [file]', { args: positionals(1, 2), options: LIFECYCLE_OPTIONS })]),
  command('ship', mutates('repository release/index paths and global release tooling'), 'mutate', [form('[patch|minor|major]', { args: positionals(0, 1) })]),
  command('archive', mutates('managed source and same-root destination'), 'mutate', [form('<file>', { args: positionals(1, 1), options: [...LIFECYCLE_OPTIONS, flag('--closeout-template')] })]),
  command('bulk', mutates('managed source sweep; archive destinations preserve roots'), 'mutate', [
    form('archive <files...>', { subcommands: ['archive'], args: positionals(1, Infinity), options: [flag('--json'), flag('--no-index'), flag('--show-files')] }),
    form('tag [files...]', { subcommands: ['tag'], args: positionals(0, Infinity), options: [value('--type'), value('--status'), flag('--json')] }),
  ]),
  command('bulk-tag', mutates('managed source sweep'), 'mutate', [form('[files...]', { args: positionals(0, Infinity), options: [value('--type'), value('--status'), flag('--json')] })]),
  command('touch', mutates('managed source or managed source sweep'), 'mutate', [form('[file]', { args: positionals(0, 1), options: [flag('--git')] })]),
  command('new', mutates('managed document destination; external body input unrestricted'), 'mutate', [form('[type] <name> [body...]', {
    args: positionals(0, Infinity),
    options: [value('--status'), value('--title'), value('--runlist'), flag('--coordination'), flag('--roadmap'), flag('--lite', '--minimal'), flag('--audit', '--findings'), value('--body', '--message'), value('--root'), flag('--show-files'), flag('--list-templates', '--list-types')],
    dashPositionalsAfter: 1,
  })]),
  command('lint', mutates('managed source sweep with --fix; otherwise read-only'), 'mutate', [form('', { options: [flag('--fix')] })]),
  command('rename', mutates('managed source, same-root destination, and rewrite sweep'), 'mutate', [form('<old> [new]', { args: positionals(1, 2), options: [flag('--show-files')] })]),
  command('migrate', mutates('managed source sweep'), 'mutate', [form('<field> <old> <new> [files...]', { args: positionals(3, Infinity), options: [flag('--show-files')] })]),
  command('fix-refs', mutates('managed source sweep'), 'mutate', [form('', { options: [flag('--show-files')] })]),
  command('doctor', mutates('managed sweeps, repo index, and maintenance config paths by mode'), 'mutate', [form('[path]', { args: positionals(0, 1), options: [flag('--apply', '--yes'), flag('--statuses'), optionalValue('--migrate-template'), flag('--migrate-prompts'), flag('--frontmatter-fix'), flag('--project'), flag('--json'), flag('--include-archived')] })]),
  command('statuses', mutates('project config path; document scan is read-only'), 'mutate', [
    form('list', { subcommands: ['list'], options: [value('--type'), flag('--json')] }),
    form('add <name>', { subcommands: ['add'], args: positionals(1, 1), options: STATUS_PROPERTY_OPTIONS }),
    form('set <name>', { subcommands: ['set'], args: positionals(1, 1), options: STATUS_PROPERTY_OPTIONS }),
    form('remove <name>', { subcommands: ['remove'], args: positionals(1, 1), options: STATUS_PROPERTY_OPTIONS }),
    form('migrate <type>', { subcommands: ['migrate'], args: positionals(1, 1), options: [flag('--yes', '-y'), flag('--json'), flag('--ignore-lifecycle-override')] }),
    form('', { options: [value('--type'), flag('--json')] }),
  ]),
  command('check', mutates('managed fix sweeps and repo-generated index; otherwise validation'), 'mutate', [form('[paths...]', { args: positionals(0, Infinity), options: [flag('--fix'), flag('--errors-only'), flag('--no-collapse'), flag('--json'), flag('--verbose')] })]),
  command('index', mutates('repo-generated index destination; --print is read-only'), 'mutate', [form('', { options: [flag('--print')] })]),

  command('self-check', none, 'internal', [form('', { options: [flag('--json')] })], { visibility: 'internal' }),
  command('pickup', none, 'removed', [form('[args...]', { args: positionals(0, Infinity) })], { visibility: 'removed' }),
  command('unpickup', none, 'removed', [form('[args...]', { args: positionals(0, Infinity) })], { visibility: 'removed' }),
  command('release', none, 'removed', [form('[args...]', { args: positionals(0, Infinity) })], { visibility: 'removed' }),
  command('finish', none, 'removed', [form('[args...]', { args: positionals(0, Infinity) })], { visibility: 'removed' }),
  command('handoff', none, 'removed', [form('[args...]', { args: positionals(0, Infinity) })], { visibility: 'removed' }),

  command('stale', none, 'preset', [form('[terms...]', { args: positionals(0, Infinity), options: QUERY_OPTIONS })]),
  command('actionable', none, 'preset', [form('[terms...]', { args: positionals(0, Infinity), options: QUERY_OPTIONS })]),
];

function schemaErrors(schema) {
  const errors = [];
  const names = new Set();
  const aliases = new Set();
  for (const entry of schema) {
    if (!entry.name || names.has(entry.name)) errors.push(`duplicate or empty command name: ${entry.name}`);
    names.add(entry.name);
    if (!entry.group) errors.push(`${entry.name}: missing help group`);
    if (!entry.forms.length) errors.push(`${entry.name}: missing forms`);
    for (const alias of entry.aliases) {
      if (!alias || names.has(alias) || aliases.has(alias)) errors.push(`${entry.name}: duplicate alias ${alias}`);
      aliases.add(alias);
    }
    const formKeys = new Set();
    for (const commandForm of entry.forms) {
      const key = commandForm.subcommands.join('|') || '<default>';
      if (formKeys.has(key)) errors.push(`${entry.name}: duplicate form ${key}`);
      formKeys.add(key);
      const { min, max } = commandForm.positionals;
      if (!Number.isInteger(min) || min < 0 || !(max === Infinity || Number.isInteger(max)) || max < min) {
        errors.push(`${entry.name} ${key}: malformed positional arity`);
      }
      const optionNames = new Set();
      for (const option of commandForm.options) {
        if (![0, 1, 'optional'].includes(option.arity) || !option.names.length) errors.push(`${entry.name} ${key}: malformed option`);
        for (const optionName of option.names) {
          if (!optionName.startsWith('-') || optionNames.has(optionName)) errors.push(`${entry.name} ${key}: duplicate or malformed option ${optionName}`);
          optionNames.add(optionName);
        }
      }
    }
  }
  for (const alias of aliases) if (names.has(alias)) errors.push(`alias collides with command: ${alias}`);
  return errors;
}

const errors = schemaErrors(definitions);
if (errors.length) throw new Error(`Invalid command schema:\n${errors.join('\n')}`);

export const COMMAND_SCHEMA = Object.freeze(Object.fromEntries(definitions.map(entry => [entry.name, entry])));
const ALIASES = Object.freeze(Object.fromEntries(definitions.flatMap(entry => entry.aliases.map(alias => [alias, entry.name]))));

export const COMMAND_POLICIES = Object.freeze(Object.fromEntries(definitions.map(entry => [entry.name, entry.policy])));
export const KNOWN_COMMANDS = Object.freeze(definitions.map(entry => entry.name));
export const PUBLIC_COMMANDS = Object.freeze(definitions.filter(entry => entry.visibility === 'public').map(entry => entry.name));
export const COMPLETION_COMMANDS = Object.freeze(definitions
  .filter(entry => entry.visibility === 'public')
  .flatMap(entry => [entry.name, ...entry.aliases]));
export const MUTATION_CAPABLE_COMMANDS = Object.freeze(new Set(
  definitions.filter(entry => entry.policy.mutation !== 'none').map(entry => entry.name),
));

export function canonicalCommand(name) {
  return ALIASES[name] ?? name;
}

export function commandDefinition(name) {
  return COMMAND_SCHEMA[canonicalCommand(name)] ?? null;
}

export function commandPolicy(name) {
  return commandDefinition(name)?.policy ?? null;
}

export function commandOwnsOption(name, optionName) {
  const definition = commandDefinition(name);
  return Boolean(definition?.forms.some(commandForm => commandForm.options.some(option => option.names.includes(optionName))));
}

export function commandCompletionWords(name) {
  const definition = commandDefinition(name);
  if (!definition) return [];
  const words = new Set();
  for (const commandForm of definition.forms) {
    for (const subcommand of commandForm.subcommands) words.add(subcommand);
    for (const option of commandForm.options) for (const optionName of option.names) words.add(optionName);
  }
  return [...words];
}

export function commandUsage(name) {
  const definition = commandDefinition(name);
  if (!definition) return null;
  return definition.forms.map(commandForm => `dotmd ${definition.name}${commandForm.syntax ? ` ${commandForm.syntax}` : ''}`).join('\n');
}

function optionMap(forms) {
  const map = new Map();
  for (const commandForm of forms) {
    for (const option of commandForm.options) {
      for (const optionName of option.names) map.set(optionName, option);
    }
  }
  return map;
}

function scanArgs(name, argv, options, passthrough = false, dashPositionalsAfter = Infinity) {
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-') { positional.push(arg); continue; }
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    const option = options.get(arg);
    if (!option) {
      if (passthrough) continue;
      if (positional.length >= dashPositionalsAfter) { positional.push(arg); continue; }
      throw new Error(`Unknown flag for \`dotmd ${name}\`: ${arg}`);
    }
    if (option.arity === 1) {
      const next = argv[i + 1];
      if (next === undefined || options.has(next)) {
        throw new Error(`Missing value for \`${arg}\` in \`dotmd ${name}\`.`);
      }
      i += 1;
    } else if (option.arity === 'optional' && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) {
      i += 1;
    }
  }
  return positional;
}

export function normalizeCommandArgs(name, argv) {
  const canonical = canonicalCommand(name);
  if (canonical !== 'roadmap') return [...argv];
  const positionalIndexes = [];
  const options = optionMap(commandDefinition(canonical).forms);
  for (let i = 0; i < argv.length; i += 1) {
    const option = options.get(argv[i]);
    if (option) {
      if (option.arity === 1) i += 1;
      else if (option.arity === 'optional' && argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) i += 1;
      continue;
    }
    if (!argv[i].startsWith('-')) positionalIndexes.push(i);
  }
  if (positionalIndexes.length === 2 && argv[positionalIndexes[1]] === 'next' && argv[positionalIndexes[0]] !== 'next') {
    const normalized = [...argv];
    const hub = normalized[positionalIndexes[0]];
    normalized[positionalIndexes[0]] = 'next';
    normalized[positionalIndexes[1]] = hub;
    return normalized;
  }
  return [...argv];
}

export function validateCommandArgs(name, argv, { preset = false } = {}) {
  const definition = preset ? COMMAND_SCHEMA.query : commandDefinition(name);
  if (!definition) return argv;
  const canonical = definition.name;
  const normalized = normalizeCommandArgs(canonical, argv);
  const allOptions = optionMap(definition.forms);
  const allPassthrough = definition.forms.some(commandForm => commandForm.passthrough);
  const dashPositionalsAfter = Math.min(...definition.forms.map(commandForm => commandForm.dashPositionalsAfter));
  const preliminary = scanArgs(canonical, normalized, allOptions, allPassthrough, dashPositionalsAfter);
  const selected = definition.forms.find(commandForm => commandForm.subcommands.includes(preliminary[0]))
    ?? definition.forms.find(commandForm => commandForm.subcommands.length === 0);
  if (!selected) throw new Error(`Unknown subcommand for \`dotmd ${canonical}\`: ${preliminary[0] ?? '(missing)'}`);
  const selectedOptions = optionMap([selected]);
  const positional = scanArgs(canonical, normalized, selectedOptions, selected.passthrough, selected.dashPositionalsAfter);
  const args = selected.subcommands.includes(positional[0]) ? positional.slice(1) : positional;
  if (args.length < selected.positionals.min || args.length > selected.positionals.max) {
    throw new Error(`Usage: ${commandUsage(canonical)}`);
  }
  return normalized;
}

export function validateCommandSchema(schema = definitions) {
  return schemaErrors(schema);
}
