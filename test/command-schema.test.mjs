import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  COMMAND_POLICIES,
  COMMAND_SCHEMA,
  COMPLETION_COMMANDS,
  KNOWN_COMMANDS,
  PUBLIC_COMMANDS,
  canonicalCommand,
  commandCompletionWords,
  commandOwnsOption,
  commandUsage,
  normalizeCommandArgs,
  validateCommandArgs,
  validateCommandSchema,
} from '../src/commands.mjs';

describe('command schema', () => {
  it('is valid and derives command names and policies from one inventory', () => {
    deepStrictEqual(validateCommandSchema(), []);
    deepStrictEqual(KNOWN_COMMANDS, Object.keys(COMMAND_SCHEMA));
    deepStrictEqual(KNOWN_COMMANDS, Object.keys(COMMAND_POLICIES));
    for (const command of KNOWN_COMMANDS) {
      ok(COMMAND_SCHEMA[command].group, `${command} has a help group`);
      ok(commandUsage(command)?.startsWith(`dotmd ${command}`), `${command} has generated usage`);
    }
  });

  it('detects duplicate and malformed entries', () => {
    const duplicate = validateCommandSchema([COMMAND_SCHEMA.help, COMMAND_SCHEMA.help]);
    ok(duplicate.some(error => error.includes('duplicate')));

    const malformed = validateCommandSchema([{
      name: 'bad', group: 'test', aliases: [], forms: [{
        syntax: '', subcommands: [], positionals: { min: 2, max: 1 }, options: [], passthrough: false,
      }],
    }]);
    ok(malformed.some(error => error.includes('positional arity')));
  });

  it('owns aliases, visibility, and completion words', () => {
    strictEqual(canonicalCommand('prompt'), 'prompts');
    ok(COMPLETION_COMMANDS.includes('prompt'));
    ok(!COMPLETION_COMMANDS.includes('pickup'));
    ok(!PUBLIC_COMMANDS.includes('self-check'));
    ok(commandCompletionWords('runlist').includes('reorder'));
    ok(commandCompletionWords('index').includes('--print'));
    ok(commandOwnsOption('bulk-tag', '--type'));
    strictEqual(commandOwnsOption('health', '--type'), false);
  });

  it('normalizes roadmap grammar and enforces options and arity', () => {
    deepStrictEqual(normalizeCommandArgs('roadmap', ['hub', 'next', '--json']), ['next', 'hub', '--json']);
    deepStrictEqual(validateCommandArgs('roadmap', ['hub', 'next']), ['next', 'hub']);
    deepStrictEqual(validateCommandArgs('roadmap', ['next', 'hub']), ['next', 'hub']);
    throws(() => validateCommandArgs('roadmap', ['hub', 'extra']), /Usage:/);
    throws(() => validateCommandArgs('health', ['--wat']), /Unknown flag/);
    throws(() => validateCommandArgs('summary', ['doc', '--model']), /Missing value/);
    deepStrictEqual(validateCommandArgs('query', ['one', 'two', '--status', 'active']), ['one', 'two', '--status', 'active']);
  });

  it('covers every literal dispatcher command branch', () => {
    const bin = readFileSync(path.resolve(import.meta.dirname, '..', 'bin', 'dotmd.mjs'), 'utf8');
    const dispatched = [...bin.matchAll(/command === '([^']+)'/g)]
      .map(match => match[1])
      .filter(command => !command.startsWith('-'));
    const missing = [...new Set(dispatched)].filter(command => !KNOWN_COMMANDS.includes(command));
    deepStrictEqual(missing, []);
  });
});
