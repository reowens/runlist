import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert';
import { detectMarker, findActivePhase, isPhaseHeading, phaseMarkerConflict, summarizePhases, walkSections } from '../src/section.mjs';

// Every heading below is synthetic. Each one preserves the SHAPE of a heading
// form measured against a real plan corpus — marker-before-the-word, a
// qualifier inverting a done-word, commentary-vs-phase, a glyph outranking
// prose, emoji-presentation selectors, sub-section boxes — with a neutral
// vocabulary. The shape is what the reader parses; the words never mattered.

const h3 = heading => ({ level: 3, heading });

describe('isPhaseHeading', () => {
  it('counts a plain phase heading', () => {
    ok(isPhaseHeading(h3('Phase 1 — Import route')));
    ok(isPhaseHeading(h3('Phase 0: Config loader unification')));
    ok(isPhaseHeading(h3('phase 12 lowercase')));
  });

  it('counts a phase whose marker sits BEFORE the word Phase', () => {
    // The test was anchored at ^phase, so these were not phases at all — an
    // empty phase set, not a miscount; whole plans lost their visible phases.
    ok(isPhaseHeading(h3('⬜ Phase 1 — Import route + schema')));
    ok(isPhaseHeading(h3('✅ Phase 2 — delete the duplicated helpers')));
    ok(isPhaseHeading(h3('🟡 Phase 3 — in flight')));
    ok(isPhaseHeading(h3('🚧 Phase 4')));
    ok(isPhaseHeading(h3('⏭ Phase 5')));
  });

  it('counts a phase led by a glyph in emoji-presentation form', () => {
    // The base codepoint plus a variation selector. `detectMarker` is a
    // substring test so it never noticed, but the decoration strip is a
    // character CLASS — the selector sits between glyph and space, is not \s,
    // and ended the run, so these were not phase headings at all while their
    // bare-codepoint twins were.
    for (const heading of ['⏭️ Phase 3 — superseded', '☑️ Phase 2 — done', '✔️ Phase 4 — done']) {
      ok(isPhaseHeading(h3(heading)), heading);
    }
    // The bare forms must keep working.
    for (const heading of ['⏭ Phase 3', '☑ Phase 2', '✔ Phase 4']) {
      ok(isPhaseHeading(h3(heading)), heading);
    }
  });

  it('counts a phase behind emphasis punctuation, alone or with a marker', () => {
    ok(isPhaseHeading(h3('**Phase 6 — bolded**')));
    ok(isPhaseHeading(h3('_Phase 7_')));
    ok(isPhaseHeading(h3('`Phase 8`')));
    ok(isPhaseHeading(h3('**⬜ Phase 9**')));
    ok(isPhaseHeading(h3('⬜ ✅ Phase 10 — two markers')));
  });

  it('rejects commentary ABOUT a phase', () => {
    // Worse than a miscount: findActivePhase ranks blocked above todo, so
    // "Phase 3 smoke findings — BLOCKER" was picked as the active phase over
    // a real unstarted one.
    ok(!isPhaseHeading(h3('Phase 1 outcome (2026-06-12)')));
    ok(!isPhaseHeading(h3('Phase 3 progress (2026-06-12, in-flight)')));
    ok(!isPhaseHeading(h3('Phase 3 smoke findings (2026-06-12) — BLOCKER, decision needed')));
    ok(!isPhaseHeading(h3('Phase 2 notes')));
    ok(!isPhaseHeading(h3('Phase 4 retro')));
    ok(!isPhaseHeading(h3('⬜ Phase 5 outcome')), 'decoration does not smuggle commentary back in');
  });

  it('still counts a phase whose TITLE merely contains a commentary word', () => {
    // The exclusion is "phase <id> <noun>", not "the word appears somewhere".
    // Over-excluding hides real work, which is the worse failure.
    ok(isPhaseHeading(h3('Phase 2 — review the query planner')));
    ok(isPhaseHeading(h3('Phase 3 — smoke test harness')));
    ok(isPhaseHeading(h3('Phase 4 — outcome tracking for retries')));
  });

  it('rejects non-phase headings and wrong levels', () => {
    ok(!isPhaseHeading(h3('Problem')));
    ok(!isPhaseHeading(h3('Phasing out the old API')), 'word boundary, not a prefix match');
    ok(!isPhaseHeading({ level: 2, heading: 'Phase 1' }));
    ok(!isPhaseHeading({ level: 4, heading: 'Phase 1' }));
  });
});

describe('detectMarker', () => {
  it('reads a marker wherever it sits in the heading', () => {
    strictEqual(detectMarker('Phase 1 ✅'), 'shipped');
    strictEqual(detectMarker('✅ Phase 1'), 'shipped');
    strictEqual(detectMarker('Phase 1 — done (2026-06-12) — notes'), 'shipped');
  });

  it('reads prose state words, not only glyphs', () => {
    strictEqual(detectMarker('Phase 0: Config Loader Unification — COMPLETE'), 'shipped');
    strictEqual(detectMarker('Phase 3 — not started'), 'todo');
    strictEqual(detectMarker('Phase 2 — WIP'), 'in-progress');
  });

  it('knows 🟡 for in-progress', () => {
    // Used more than twice as often as 🚧 in the corpus measured.
    strictEqual(detectMarker('Phase 0 — Feed ingestion spike 🟡'), 'in-progress');
  });

  it('returns null when nothing is readable', () => {
    strictEqual(detectMarker('Phase S1: Audit trail groundwork'), null);
    strictEqual(detectMarker('Phase 4'), null);
  });

  describe('a glyph outranks a prose word', () => {
    // All three reproduce a shape found in the corpus. In each the prose word
    // is about something else in the sentence, and interleaved first-match-wins
    // order called them all shipped — so findActivePhase skipped a phase the
    // author had explicitly marked unstarted.
    it('the prose word describes a different noun', () => {
      strictEqual(
        detectMarker('⬜ Phase 4: Retry budget rework (scoping COMPLETE 2026-08-05)'),
        'todo',
        'the SCOPING completed, not the phase',
      );
      strictEqual(
        detectMarker('Phase 2 — schema migrated ⬜ todo (column rename half DONE)'),
        'todo',
        'half a RENAME is done, not the phase',
      );
      strictEqual(
        detectMarker('Phase 3 (original scope) — ⏭ superseded by the shipped Phase 3 above'),
        'skipped',
        'a DIFFERENT phase shipped',
      );
    });

    it('prose still decides when no glyph is present', () => {
      strictEqual(detectMarker('Phase 0: Config Loader Unification — COMPLETE'), 'shipped');
      strictEqual(detectMarker('Phase 9 — blocked on vendor'), 'blocked');
    });

    it('a qualifier inverts the word it modifies', () => {
      // Both read as shipped before these patterns landed, so findActivePhase
      // skipped a phase whose own checklist still had open boxes.
      strictEqual(detectMarker('Phase C: Queue draining & backpressure — Mostly Done'), 'in-progress');
      strictEqual(detectMarker('Phase 2 — Cache tiers & eviction (PARTIALLY COMPLETE)'), 'in-progress');
      strictEqual(detectMarker('Phase 3 — half done'), 'in-progress');
      strictEqual(detectMarker('Phase 4 — not done yet'), 'todo');
      strictEqual(detectMarker('Phase 5 — never shipped'), 'todo');
    });

    it('an unqualified done-word still reads as shipped', () => {
      strictEqual(detectMarker('Phase 1 — COMPLETE'), 'shipped');
      strictEqual(detectMarker('Phase 2 — shipped 2026-05-01'), 'shipped');
    });

    it('priority order still decides within a tier', () => {
      strictEqual(detectMarker('Phase 5 ✅ ⬜'), 'shipped', 'two glyphs: priority order holds');
      strictEqual(detectMarker('Phase 6 — complete, todo cleanup'), 'shipped', 'two prose words: priority order holds');
    });
  });
});

describe('phaseMarkerConflict', () => {
  const phase = (heading, body) => walkSections(`## Phases\n\n### ${heading}\n\n${body}\n`).find(isPhaseHeading);

  it('flags shipped with an open box', () => {
    const c = phaseMarkerConflict(phase('Phase 2 — Retry backoff ✅ shipped', '- [x] a\n- [x] b\n- [x] c\n- [ ] d'));
    strictEqual(c.declared, 'shipped');
    strictEqual(c.implied, 'in progress');
    strictEqual(c.checked, 3);
    strictEqual(c.total, 4);
  });

  it('flags todo with every box checked', () => {
    const c = phaseMarkerConflict(phase('⬜ Phase 14 — token store', '- [x] a\n- [x] b'));
    strictEqual(c.declared, 'todo');
    strictEqual(c.implied, 'shipped');
  });

  it('is silent when the marker and the tally agree', () => {
    strictEqual(phaseMarkerConflict(phase('Phase 1 ✅', '- [x] a\n- [x] b')), null);
    strictEqual(phaseMarkerConflict(phase('Phase 1 ⬜', '- [ ] a\n- [ ] b')), null);
  });

  it('is silent on judgements a tally cannot refute', () => {
    // blocked at 0/7 is coherent; skipped is a decision; in-progress with
    // everything checked usually means work the checklist does not enumerate.
    // Including these took the count 13 → 19 on a real corpus, every extra
    // one arguable.
    strictEqual(phaseMarkerConflict(phase('Phase 2 🚧 blocked', '- [ ] a\n- [ ] b')), null);
    strictEqual(phaseMarkerConflict(phase('Phase 3 ⏭ skipped', '- [ ] a')), null);
    strictEqual(phaseMarkerConflict(phase('Phase 4 🟡', '- [x] a\n- [x] b')), null);
  });

  it('is silent with no checklist and with no marker', () => {
    strictEqual(phaseMarkerConflict(phase('Phase 5 ✅ shipped', 'prose only, no boxes')), null);
    strictEqual(phaseMarkerConflict(phase('Phase 6 — no marker', '- [x] a\n- [ ] b')), null);
  });

  it('counts only the phase\'s own boxes, not a sub-section\'s', () => {
    const s = walkSections('## Phases\n\n### Phase 1 ✅\n\n- [x] mine\n\n#### Sub\n\n- [ ] not mine\n').find(isPhaseHeading);
    strictEqual(phaseMarkerConflict(s), null, 'the nested open box is not this phase\'s evidence');
  });
});

describe('summarizePhases and findActivePhase', () => {
  const body = [
    '## Phases',
    '',
    '### ✅ Phase 1 — shipped work',
    '',
    '### Phase 2 outcome (2026-06-12) — BLOCKER',
    '',
    '### ⬜ Phase 3 — the real next one',
    '',
  ].join('\n');

  it('counts marker-led phases and skips commentary', () => {
    const summary = summarizePhases(walkSections(body));
    strictEqual(summary.total, 2, 'the outcome heading is not a phase');
    deepStrictEqual(summary.counts, { shipped: 1, todo: 1 });
  });

  it('picks the real unstarted phase over a blocked-looking retrospective', () => {
    const active = findActivePhase(walkSections(body));
    strictEqual(active.heading, '⬜ Phase 3 — the real next one');
  });

  it('treats a phase with no readable marker as todo', () => {
    const summary = summarizePhases(walkSections('## Phases\n\n### Phase S1: Audit trail groundwork\n'));
    deepStrictEqual(summary.counts, { todo: 1 });
  });
});
