---
type: doc
status: active
updated: 2026-10-20
summary: Source checks for Runlist's portable payload and macOS native acceptance harness.
---

# Air harness source verification (2026-10-20)

The portable payload preparer and standalone macOS UI-test project are source
verified. The preparer freezes a signed app with its provenance-matched helper
tests, installed dependencies and native harness; it refuses changed payloads
or a different installed app before starting a helper. The native source uses
an isolated Git fixture with private state ignored and repository hooks disabled.
Its interactions use native accessibility queries, with no coordinate fallback.

- `desktop/test/prepare-air-tests.test.mjs`: 5 passed, 0 failures or skips through
  `just test runlist-desktop desktop/test/prepare-air-tests.test.mjs`.
- `desktop/native-tests/RunlistAcceptance.xcodeproj`: guarded
  `just typecheck runlist-native-tests` build-for-testing passed. No app or
  WebView was launched by this compile.
- The tests cover exact app/source/harness identity, safe internal app symlinks,
  dependency copying, stale provenance, changed source or installed app, unsafe
  output paths, added files, escaping symlinks and launch-error propagation.
- Initial focused failures exposed macOS temporary-path aliases in output
  ancestry handling. Output parents are now resolved before containment checks;
  the failed and corrected logs remain in the invoking verification lane.

This is source evidence, not a native-window pass. The harness preserves the
[existing dialog investigation](VALIDATION.md#confirmation-fix-and-native-investigation-2026-10-20)
as a failing result if native controls remain inaccessible. Installation,
worker readiness and actual helper/native-window receipts have 1 owner, the
Platform execution plan at `../../../platform/docs/plans/runlist-air-verification.md`.
The [payload entry](AIR-VERIFICATION.md) describes preparation.

