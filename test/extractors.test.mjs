import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert';
import {
  extractFirstHeading,
  extractSummary,
  extractStatusSnapshot,
  extractNextStep,
  extractChecklistCounts,
  extractBodyLinks,
} from '../src/extractors.mjs';

describe('extractFirstHeading', () => {
  it('extracts H1 heading', () => {
    strictEqual(extractFirstHeading('# My Document\nSome text.'), 'My Document');
  });

  it('returns null when no H1', () => {
    strictEqual(extractFirstHeading('## Not H1\nSome text.'), null);
  });

  it('finds H1 that is not on the first line', () => {
    strictEqual(extractFirstHeading('Some preamble.\n\n# Title Here\nText.'), 'Title Here');
  });

  it('trims whitespace', () => {
    strictEqual(extractFirstHeading('#   Spacey Title  '), 'Spacey Title');
  });
});

describe('extractSummary', () => {
  it('extracts blockquote summary', () => {
    strictEqual(extractSummary('> This is the summary.\nRegular text.'), 'This is the summary.');
  });

  it('skips Status note lines', () => {
    strictEqual(
      extractSummary('> Status note (2025-01-01): Phase 1 done.\n> The real summary.'),
      'The real summary.',
    );
  });

  it('falls back to Status note if no other blockquote', () => {
    strictEqual(
      extractSummary('> Status note: Only this.'),
      'Status note: Only this.',
    );
  });

  it('returns null when no blockquotes', () => {
    strictEqual(extractSummary('Regular text.\nNo blockquotes here.'), null);
  });
});

describe('extractStatusSnapshot', () => {
  it('extracts Status note format', () => {
    strictEqual(
      extractStatusSnapshot('> Status note (2025-01-15): Phase 1 shipped.'),
      'Phase 1 shipped.',
    );
  });

  it('extracts **Status:** format', () => {
    strictEqual(
      extractStatusSnapshot('**Status:** In progress.'),
      'In progress.',
    );
  });

  it('extracts - Status: format', () => {
    strictEqual(
      extractStatusSnapshot('- Status: Blocked on API.'),
      'Blocked on API.',
    );
  });

  it('returns null when no status pattern', () => {
    strictEqual(extractStatusSnapshot('Just regular text.'), null);
  });
});

describe('extractNextStep', () => {
  it('extracts next step from section', () => {
    const body = '## Next Step\n- Do the thing.\n- Also this.\n\n## Other Section\n';
    strictEqual(extractNextStep(body), 'Do the thing.');
  });

  it('extracts Suggested Next Step variant', () => {
    const body = '### Suggested Next Step\nImplement Phase 2.\n\n## Done\n';
    strictEqual(extractNextStep(body), 'Implement Phase 2.');
  });

  it('returns null when no next step section', () => {
    strictEqual(extractNextStep('## Some Other Section\nContent.'), null);
  });
});

describe('extractChecklistCounts', () => {
  it('counts checked and unchecked items', () => {
    const body = '- [x] Done\n- [ ] Not done\n- [X] Also done\n- [ ] Open\n';
    deepStrictEqual(extractChecklistCounts(body), { completed: 2, open: 2, total: 4 });
  });

  it('handles no checklist items', () => {
    deepStrictEqual(extractChecklistCounts('No checklists here.'), { completed: 0, open: 0, total: 0 });
  });

  it('handles indented checklist items', () => {
    const body = '  - [x] Nested done\n  - [ ] Nested open\n';
    deepStrictEqual(extractChecklistCounts(body), { completed: 1, open: 1, total: 2 });
  });

  it('handles * bullet variant', () => {
    const body = '* [x] Done\n* [ ] Open\n';
    deepStrictEqual(extractChecklistCounts(body), { completed: 1, open: 1, total: 2 });
  });
});

describe('extractBodyLinks', () => {
  it('extracts markdown links to .md files', () => {
    const body = 'See [the plan](plan-b.md) for details.';
    const links = extractBodyLinks(body);
    strictEqual(links.length, 1);
    strictEqual(links[0].text, 'the plan');
    strictEqual(links[0].href, 'plan-b.md');
  });

  it('extracts multiple links', () => {
    const body = 'See [A](a.md) and [B](b.md).';
    const links = extractBodyLinks(body);
    strictEqual(links.length, 2);
  });

  it('handles relative paths', () => {
    const body = 'See [doc](../other/doc.md) and [local](./local.md).';
    const links = extractBodyLinks(body);
    strictEqual(links.length, 2);
    strictEqual(links[0].href, '../other/doc.md');
    strictEqual(links[1].href, './local.md');
  });

  it('strips anchor fragments from href', () => {
    const body = 'See [section](doc.md?view=full#heading).';
    const links = extractBodyLinks(body);
    strictEqual(links[0].href, 'doc.md');
    strictEqual(links[0].rawHref, 'doc.md?view=full#heading');
    strictEqual(links[0].targetKind, 'document');
  });

  it('extracts a link whose text is a code span', () => {
    // The commonest idiom in a plan hub. Inline code used to be deleted before
    // matching, leaving `[](plan.md)` — empty text, no match — so a hub with
    // hundreds of these reported one link and none of them were ever validated.
    const body = 'Homed here: [`plan-b.md`](plan-b.md) and [`c.md`](c.md).';
    const links = extractBodyLinks(body);
    strictEqual(links.length, 2);
    strictEqual(links[0].href, 'plan-b.md');
    strictEqual(links[1].href, 'c.md');
  });

  it('extracts a link with code mixed into its text', () => {
    const body = 'See [the `plan-b.md` doc](plan-b.md).';
    const links = extractBodyLinks(body);
    strictEqual(links.length, 1);
    strictEqual(links[0].href, 'plan-b.md');
  });

  it('keeps extracting code-labelled links after a double-backtick example', () => {
    const body = [
      'Syntax: ``[`example.md`](example.md)`` is only an example.',
      '',
      'Real child: [`child.md`](child.md).',
    ].join('\n');
    const links = extractBodyLinks(body);
    strictEqual(links.length, 1);
    strictEqual(links[0].href, 'child.md');
  });

  it('still ignores a link that is itself inside inline code', () => {
    const body = 'Write it as `[text](target.md)` in the body.';
    strictEqual(extractBodyLinks(body).length, 0);
  });

  it('still ignores links inside fenced code blocks', () => {
    const body = '```\n[A](a.md)\n```\nBut [B](b.md) counts.';
    const links = extractBodyLinks(body);
    strictEqual(links.length, 1);
    strictEqual(links[0].href, 'b.md');
  });

  it('skips image links', () => {
    const body = '![alt](image.md)';
    const links = extractBodyLinks(body);
    strictEqual(links.length, 0);
  });

  it('skips external URLs', () => {
    const body = '[docs](https://example.com/docs.md)';
    const links = extractBodyLinks(body);
    strictEqual(links.length, 0);
  });

  it('skips http URLs', () => {
    const body = '[docs](http://example.com/docs.md)';
    const links = extractBodyLinks(body);
    strictEqual(links.length, 0);
  });

  it('extracts non-document files and directories as manual targets', () => {
    const body = '[pic](image.png) and [source](../src/index.mjs) and [folder](../assets/)';
    const links = extractBodyLinks(body);
    strictEqual(links.length, 3);
    deepStrictEqual(links.map(link => link.targetKind), ['file', 'file', 'file']);
  });

  it('supports escaped and angle-bracket destinations with spaces', () => {
    const body = '[one](my\\ file.md) and [two](<assets/my file.png> "asset") and [three](encoded%20file.md)';
    const links = extractBodyLinks(body);
    deepStrictEqual(links.map(link => link.href), ['my file.md', 'assets/my file.png', 'encoded file.md']);
    deepStrictEqual(links.map(link => link.angle), [false, true, false]);
  });

  it('skips renderer-only and external destination forms', () => {
    const body = [
      '[anchor](#part)', '[root](/site/path)', '[host](//example.com/x)',
      '[mail](mailto:a@example.com)', '[phone](tel:123)', '[data](data:text/plain,x)',
      '[custom](app:item)',
    ].join(' ');
    strictEqual(extractBodyLinks(body).length, 0);
  });

  it('documents unsupported nested-parenthesis destinations by ignoring them', () => {
    strictEqual(extractBodyLinks('[x](folder/name(1).md)').length, 0);
  });

  it('skips links inside fenced code blocks', () => {
    const body = '```\n[fake](fake.md)\n```\n\n[real](real.md)';
    const links = extractBodyLinks(body);
    strictEqual(links.length, 1);
    strictEqual(links[0].href, 'real.md');
  });

  it('returns empty array for empty body', () => {
    strictEqual(extractBodyLinks('').length, 0);
    strictEqual(extractBodyLinks(null).length, 0);
  });

  it('returns empty array when no links', () => {
    strictEqual(extractBodyLinks('Just plain text.').length, 0);
  });

  it('skips links inside inline code', () => {
    const body = 'Use `[text](fake.md)` syntax for links.';
    strictEqual(extractBodyLinks(body).length, 0);
  });

  it('extracts real links but skips inline code links in same line', () => {
    const body = 'See `[example](fake.md)` or [real link](real.md).';
    const links = extractBodyLinks(body);
    strictEqual(links.length, 1);
    strictEqual(links[0].href, 'real.md');
  });
});
