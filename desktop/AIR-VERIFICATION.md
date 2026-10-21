---
type: doc
status: active
updated: 2026-10-20
summary: Prepare a signed Runlist test payload for the explicit Air verification lane.
---

# Air verification payload

Prepare a portable payload from an existing Developer ID signed application and
its matching frozen source. Run from `desktop/` with a new output directory
whose parent already exists:

```bash
npm run prepare:air-tests -- --prepare /path/to/Runlist.app /path/to/frozen/source /path/to/source-manifest.json /path/to/new-payload
```

The preparer verifies the signature, version, engine fingerprint and frozen
source provenance. It copies the app, matching helper tests, their installed
JavaScript dependencies and the native harness. `manifest.json` hashes the
complete app, source and harness inventories. The payload contains no Rust
compiler requirement, and preparation does not launch or install the app.
The source and dependency directories must already be complete; preparation
does not fetch packages.

The current Air continuation is planned in [Platform machine-control
consolidation](../../../platform/docs/plans/developer-machine-control-consolidation.md).
Its Developer/Worker route must qualify remote unlocking and replace the older
SSH implementation before another Air run. The former `just runlist-air`
entry is retained source history, not an instruction to retry that transport or
request manual unlocking. The fixed `installed-helper` and `native-window`
profiles retain separate verdicts. Native-window execution is Air-only. The lane requires Runlist and its bundled helper to have
Robert Owens's personal Developer ID signature; the verification service signs its own
execution infrastructure. The native harness requires Xcode's macOS UI-testing
support and macOS 14 or newer; this does not change the product's minimum OS.
Source checks use `just typecheck runlist-desktop`,
`just test runlist-desktop desktop/test/prepare-air-tests.test.mjs` and
`just typecheck runlist-native-tests` from that checkout. The last command
compiles the harness without running the app.

The native test opens a disposable checkout through the native folder chooser,
reviews and saves an edit, compares exact source bytes, inspects the status
confirmation controls and checks ordinary Quit and observed helper cleanup.
Edit Markdown focuses the native Markdown text view. The harness sends select-all
and replacement text to that element through XCTest's keyboard APIs; typing
requires keyboard focus. This workflow does not qualify pointer hit testing of
the Markdown editor.
Screenshots and accessibility trees remain in the job's `native.xcresult`.
An inaccessible control fails the native test. See
[source validation](AIR-VALIDATION.md).
The [Platform execution record](../../../platform/docs/plans/runlist-air-verification.md)
owns Runlist worker policy and retained remote acceptance evidence; the linked
consolidation plan owns its current machine-control dependency.

