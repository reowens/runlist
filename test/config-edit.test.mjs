import { describe, it, beforeEach, afterEach } from 'node:test';
import { strictEqual, deepStrictEqual, ok, throws, rejects } from 'node:assert';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  parseStatusesBlock,
  spliceEntry,
  replaceEntry,
  deleteEntry,
  renderEntryLine,
  inferIndent,
  hasExplicitLifecycle,
  validateStatusName,
  writeConfigAtomic,
  ConfigEditError,
} from '../src/config-edit.mjs';

let tmpDir;
beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'dotmd-edit-'));
  mkdirSync(path.join(tmpDir, '.git'));
  mkdirSync(path.join(tmpDir, 'docs'));
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const RICH_TYPES_FILE = `// header
export const root = 'docs';

export const types = {
  plan: {
    statuses: {
      'in-session': { context: 'expanded', staleDays: 1, requiresModule: true },
      'active':     { context: 'expanded', staleDays: 14, requiresModule: true },
      // archived can't be removed
      'archived':   { context: 'counted', archive: true, terminal: true, quiet: true },
    },
  },
  doc: {
    statuses: {
      'draft':    { context: 'listed', staleDays: 30 },
      'archived': { context: 'counted', archive: true, terminal: true, quiet: true },
    },
  },
};
`;

const DEFAULT_EXPORT_FILE = `export default {
  root: 'docs',
  types: {
    plan: {
      statuses: {
        'active': { context: 'expanded', staleDays: 14 },
        'archived': { context: 'counted', archive: true, terminal: true, quiet: true },
      },
    },
  },
};
`;

const ARRAY_FORM_FILE = `export const root = 'docs';

export const types = {
  plan: {
    statuses: ['active', 'archived'],
    context: { expanded: ['active'], counted: ['archived'] },
    staleDays: { active: 14 },
  },
};
`;

describe('parseStatusesBlock', () => {
  it('locates the statuses block in `export const types = {...}` form', () => {
    const parsed = parseStatusesBlock(RICH_TYPES_FILE, 'plan');
    strictEqual(parsed.form, 'object');
    deepStrictEqual(parsed.entries.map(e => e.name), ['in-session', 'active', 'archived']);
  });

  it('locates the statuses block when types is nested in `export default {...}`', () => {
    const parsed = parseStatusesBlock(DEFAULT_EXPORT_FILE, 'plan');
    strictEqual(parsed.form, 'object');
    deepStrictEqual(parsed.entries.map(e => e.name), ['active', 'archived']);
  });

  it('skips strings/comments correctly when scanning braces', () => {
    // The "// archived can't be removed" comment is inside the block; it must
    // not be parsed as an entry, and the apostrophe in "can't" must not throw
    // off the scanner.
    const parsed = parseStatusesBlock(RICH_TYPES_FILE, 'plan');
    strictEqual(parsed.entries.length, 3);
  });

  it('refuses array form via form: array (handled per call site)', () => {
    const parsed = parseStatusesBlock(ARRAY_FORM_FILE, 'plan');
    strictEqual(parsed.form, 'array');
    deepStrictEqual(parsed.entries.map(e => e.name), ['active', 'archived']);
  });

  it('throws when type is not defined', () => {
    throws(() => parseStatusesBlock(RICH_TYPES_FILE, 'nope'), ConfigEditError);
  });

  it('flags multi-line entries as multiLine: true', () => {
    const file = `export const types = {
  plan: {
    statuses: {
      'active': {
        context: 'expanded',
        staleDays: 14,
      },
      'archived': { context: 'counted', archive: true, terminal: true },
    },
  },
};
`;
    const parsed = parseStatusesBlock(file, 'plan');
    const active = parsed.entries.find(e => e.name === 'active');
    ok(active);
    strictEqual(active.multiLine, true);
    const archived = parsed.entries.find(e => e.name === 'archived');
    strictEqual(archived.multiLine, false);
  });
});

describe('spliceEntry / replaceEntry / deleteEntry', () => {
  it('splices a new entry before the first terminal entry', () => {
    const parsed = parseStatusesBlock(RICH_TYPES_FILE, 'plan');
    const indent = inferIndent(RICH_TYPES_FILE, parsed);
    const line = renderEntryLine('paused', { context: 'listed', requiresModule: true, quiet: true }, indent);
    const updated = spliceEntry(RICH_TYPES_FILE, parsed, line, 'archived');
    const reparsed = parseStatusesBlock(updated, 'plan');
    deepStrictEqual(reparsed.entries.map(e => e.name), ['in-session', 'active', 'paused', 'archived']);
  });

  it('appends to end when no terminal entry exists', () => {
    const file = `export const types = {
  plan: {
    statuses: {
      'active': { context: 'expanded', staleDays: 14 },
    },
  },
};
`;
    const parsed = parseStatusesBlock(file, 'plan');
    const indent = inferIndent(file, parsed);
    const line = renderEntryLine('paused', { context: 'listed' }, indent);
    const updated = spliceEntry(file, parsed, line, null);
    const reparsed = parseStatusesBlock(updated, 'plan');
    deepStrictEqual(reparsed.entries.map(e => e.name), ['active', 'paused']);
  });

  it('replaces a single-line entry', () => {
    const parsed = parseStatusesBlock(RICH_TYPES_FILE, 'plan');
    const indent = inferIndent(RICH_TYPES_FILE, parsed);
    const newLine = renderEntryLine('active', { context: 'expanded', staleDays: 99, requiresModule: true }, indent);
    const updated = replaceEntry(RICH_TYPES_FILE, parsed, 'active', newLine);
    ok(updated.includes('staleDays: 99'));
    ok(!updated.includes('staleDays: 14'));
    const reparsed = parseStatusesBlock(updated, 'plan');
    strictEqual(reparsed.entries.length, 3);
  });

  it('deletes a single-line entry including its trailing newline', () => {
    const parsed = parseStatusesBlock(RICH_TYPES_FILE, 'plan');
    const updated = deleteEntry(RICH_TYPES_FILE, parsed, 'active');
    const reparsed = parseStatusesBlock(updated, 'plan');
    deepStrictEqual(reparsed.entries.map(e => e.name), ['in-session', 'archived']);
    // Resulting file should not have a stray blank line where 'active' lived
    ok(!/\n\s*\n\s*'archived':/.test(updated), 'no extra blank line after delete');
  });

  it('refuses to replace a multi-line entry', () => {
    const file = `export const types = {
  plan: {
    statuses: {
      'active': {
        context: 'expanded',
      },
    },
  },
};
`;
    const parsed = parseStatusesBlock(file, 'plan');
    const indent = inferIndent(file, parsed);
    const newLine = renderEntryLine('active', { context: 'listed' }, indent);
    throws(() => replaceEntry(file, parsed, 'active', newLine), ConfigEditError);
  });

  it('refuses to delete a multi-line entry', () => {
    const file = `export const types = {
  plan: {
    statuses: {
      'active': {
        context: 'expanded',
      },
    },
  },
};
`;
    const parsed = parseStatusesBlock(file, 'plan');
    throws(() => deleteEntry(file, parsed, 'active'), ConfigEditError);
  });

  it('throws when targeting an entry that does not exist', () => {
    const parsed = parseStatusesBlock(RICH_TYPES_FILE, 'plan');
    throws(() => replaceEntry(RICH_TYPES_FILE, parsed, 'missing', 'whatever'), ConfigEditError);
    throws(() => deleteEntry(RICH_TYPES_FILE, parsed, 'missing'), ConfigEditError);
  });
});

describe('validateStatusName', () => {
  it('accepts valid names', () => {
    for (const n of ['in-session', 'active', 'queued-after', 'partial', 'awaiting']) {
      strictEqual(validateStatusName(n), null, `should accept '${n}'`);
    }
  });
  it('rejects invalid forms', () => {
    for (const n of ['Active', '-leading', 'trailing-', 'double--dash', 'snake_case', '1numeric']) {
      ok(validateStatusName(n), `should reject '${n}'`);
    }
  });
  it('rejects flag-keyword collisions', () => {
    for (const n of ['terminal', 'archive', 'skipStale', 'skipWarnings', 'quiet']) {
      ok(validateStatusName(n), `should reject '${n}'`);
    }
  });
});

describe('hasExplicitLifecycle', () => {
  it('detects an explicit `export const lifecycle = {}`', () => {
    const f = `export const types = {};
export const lifecycle = { archiveStatuses: ['archived'] };
`;
    strictEqual(hasExplicitLifecycle(f), true);
  });
  it('returns false when no lifecycle export', () => {
    strictEqual(hasExplicitLifecycle(RICH_TYPES_FILE), false);
  });
  it('does not match `lifecycle` inside strings or comments', () => {
    const f = `// export const lifecycle = {}
export const types = {};
const note = 'export const lifecycle = {}';
`;
    strictEqual(hasExplicitLifecycle(f), false);
  });
});

describe('writeConfigAtomic', () => {
  it('writes when content is valid + warning-clean', async () => {
    const cfgPath = path.join(tmpDir, 'dotmd.config.mjs');
    writeFileSync(cfgPath, RICH_TYPES_FILE, 'utf8');
    const parsed = parseStatusesBlock(RICH_TYPES_FILE, 'plan');
    const indent = inferIndent(RICH_TYPES_FILE, parsed);
    const newLine = renderEntryLine('paused', { context: 'listed', requiresModule: true, quiet: true }, indent);
    const updated = spliceEntry(RICH_TYPES_FILE, parsed, newLine, 'archived');
    await writeConfigAtomic(cfgPath, updated, tmpDir);
    const after = readFileSync(cfgPath, 'utf8');
    ok(after.includes("'paused':"), 'paused written');
    // Tmp file cleaned up
    const stray = readdirSync(tmpDir).filter(n => n.includes('dotmd-edit'));
    strictEqual(stray.length, 0, 'no stray temp files');
  });

  it('refuses to write content that does not parse, leaving original intact', async () => {
    const cfgPath = path.join(tmpDir, 'dotmd.config.mjs');
    writeFileSync(cfgPath, RICH_TYPES_FILE, 'utf8');
    const broken = RICH_TYPES_FILE.replace('export const types', 'export const types =');
    await rejects(() => writeConfigAtomic(cfgPath, broken, tmpDir), /does not parse/);
    strictEqual(readFileSync(cfgPath, 'utf8'), RICH_TYPES_FILE, 'original untouched');
    const stray = readdirSync(tmpDir).filter(n => n.includes('dotmd-edit'));
    strictEqual(stray.length, 0, 'tmp file cleaned up');
  });
});
