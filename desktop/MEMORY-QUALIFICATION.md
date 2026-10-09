# Memory and latency qualification

Release-audit item 13 is **partial**. Terminal workloads now measure the exact
packaged helper, document refresh/edit/switch operations, isolated lifecycle/Git
workers, idle CPU and process cleanup. Source fixes reduce editor undo allocation
and bound history. The October 8 helper overlay passed the 256 MiB RSS gate,
but the earlier 0.91.0-rc.2 package's full run failed RSS and three latency gates.
The latest selected-source rc.3 has only a short allocation diagnostic, not a
comparable full performance pass. Prior runs do not qualify it. Current native core/WebView
memory and typing-to-frame latency remain
unmeasured because no native window was opened.

The frozen `0.91.0-rc.1` app predates these source fixes. Its hashes and previous
qualification remain evidence for that exact earlier snapshot. An isolated copy
of its engine with the source-editor and helper optimizations was measured separately; it
was never installed or turned into a replacement app. The editor benchmark uses
the current frontend source independently.

## Repeat the terminal workloads

From the repository root, select an exact extracted app engine and a report path:

```sh
node desktop/scripts/measure-memory.mjs \
  --engine /path/Runlist.app/Contents/Resources/engine \
  --synthetic 5000 --cycles 10 --environment diagnostic \
  --output /tmp/runlist-memory.json
```

An optional `--checkout /path/to/platform` replaces `--synthetic` for a separate read-only run; the runner refuses mixing both workloads in one report. Edits, recovery drafts and saves occur only
in the generated temporary corpus, which is removed after the run. The corpus
contains 5,001 Markdown files: 500 archived plans, 100 hubs, 500 other documents,
500 flags, 4,000 scanned legacy decisions and a 2,151,100-byte Unicode document.
Each cycle refreshes the library and records, runs metadata search, switches
documents, writes/discards drafts, saves and verifies restored source bytes.
Ten cycles yield nine warm timing samples per large operation and 27 per small operation; the large-operation P95 is the maximum. The runner reports sample counts and `p95IsMaximum`. Reports contain metrics and hashes rather than document bodies.

Add `--workers 1` to the synthetic workload to run reviewed lifecycle transitions
and path-limited Git preview/commit in a disposable repository. These operations
use a separate temporary home, disabled signing/hooks and fixture identity.
The sampler follows the helper's descendants, records operation phases, and
checks that observed children are gone after the helper exits. It does not
attribute unrelated processes by name. An independent Worker runs non-overlapping asynchronous process commands: ordinary runs request 250 ms sampling, and worker runs request 50 ms. Command costs and actual sampling gaps are reported; a requested interval is not a claim that every peak was captured. Summed RSS counts shared
pages more than once and is **not** macOS physical footprint.

Run the actual block editor in Node/linkedom, without browser automation:

```sh
node --max-old-space-size=256 desktop/scripts/measure-editor-memory.mjs \
  --assets assets/app --edits 120 --output /tmp/runlist-editor-memory.json
```

This fixture measures loading and 120 separate paste-style undo actions for
small and large documents. It stops above 220 MiB heap used or 512 MiB process
RSS to keep fixture allocation bounded. Those ceilings apply to the measurement
process; they do not qualify WebKit memory. The benchmark has the real block
editor, with a source callback and linkedom, but omits application dirty/diff/
recovery handlers, native selection/focus and painting. No benchmark forces GC.

## Budgets and interpretation

| Metric | Gate or target | Evidence required |
| --- | ---: | --- |
| Helper peak RSS | 256 MiB | Exact engine, platform and full synthetic edit workload |
| Owned helper/worker summed RSS | 512 MiB | Sampled process tree during lifecycle and Git jobs; component ceiling |
| Helper startup handshake | 2,000 ms | Spawn through trusted config/service handshake |
| Warm library P95 | 2,000 ms | Repeated refresh; archive handling stated |
| Full flag refresh P95 | 15,000 ms | Actual record scan; UI responsiveness measured separately |
| Warm small document open P95 | 250 ms | Includes any invalidated-library refresh |
| Large document open P95 | 1,500 ms | Exact large fixture size stated |
| Small / large save P95 | 1,000 / 3,000 ms | Durable fixture save, including receipts |
| Idle CPU | 1% | 15-second helper CPU-time delta; native process set separately |
| Helper exit/child cleanup | 2,000 ms | EOF drains accepted work; zero remaining observed children |
| Undo storage | 100 entries and 32 MiB estimated source/object bytes | Combined undo/redo stacks; nearest snapshot retained if individually oversized |
| Native settled / peak footprint | Provisional 256 / 512 MiB | Attributed core/helper/workers/WebContent/GPU/Networking together |
| Native small / large edit-to-frame P95 | Provisional 100 / 250 ms | Packaged window and application handlers, including paint |

The helper RSS ceiling originated with an older read-only workload. It remains a provisional component budget for the heavier editing workload; it is distinct from the 256 MiB V8 old-space limit, which does not bound total RSS. Existing numerical targets are unchanged. New latency targets make slow operations visible without converting old medians into promises. Native targets are
provisional until measured on the selected shipping host. Do not compare summed
RSS, Node heap, macOS footprint or independently sampled component peaks as if
they were the same whole-app metric. Compression and a busy host affect RSS and
timings; paired terminal runs are not a controlled percentage improvement claim.
Heap deltas without forced GC are diagnostics, not proof of a leak or its absence.

## Source fixes and remaining work

Undo snapshots now copy flat mutable block objects while sharing immutable text.
The editor avoids joining two full source strings for the common single-block
comparison. History uses a conservative 32 MiB byte estimate across both undo
and redo, preserving up to 100 ordinary-document actions and the nearest action
for an individually oversized snapshot. The measured large fixture retains four
actions under this budget. Switching documents clears both stacks. Exact source,
managed history, typing groups, undo/redo and branch behavior have regressions.

Source validation now rejects malformed Unicode with native `isWellFormed()`
instead of allocating a UTF-8 buffer and decoded copy for every validation.
NUL/8 MiB limits, source hashes, exact disk-byte verification, locks and durable
receipts remain enforced. Node 22.12 and bundled Node 24.21 source-editor checks
pass. This allocation reduction does not establish that helper RSS is fixed.

The [October 7 validation record](VALIDATION.md#release-audit-item-13-terminal-memory--2026-10-07)
retains the initial failed gates. The October 8 overlay passed its terminal helper gates; the actual rc.2 package later failed four. Remaining item 13 work is to establish a controlled current baseline and qualify the complete current
native process set through repeated refresh/edit/switch/quit cycles. Use `scripts/measure-processes.mjs` only with an
already running instance and independently verified WebKit attribution; current
computer-use restrictions still apply. External gmax daemon/model/GPU costs are
separate and unmeasured in this task. No semantic request or service startup is
part of these workloads.

## Helper allocation follow-up — 2026-10-08

Owner selected profiling and reducing draft/save temporary allocations. The
helper now retains incoming byte chunks and joins them once per newline frame,
instead of copying every growing prefix. The 32 MiB frame limit, 64-request
queue limit, UTF-8 decoding, accepted-work drain and unterminated-frame rejection
remain enforced. The new module is included in the bundle preparation inventory.

Save-history discovery retains at most 256 validated terminal receipt metadata
entries. Every reuse hashes the complete file through a 64 KiB scratch buffer
and verifies a stable file generation. Changed/new receipts receive full JSON,
schema and before/after revision validation; prepared receipts always follow
the full recovery path. Before/after strings are not cached. Replay, inspection,
undo, actor/claim/authority checks and durable receipt publication retain their
existing full-body behavior. Same-size corruption with restored mtime and
symlink replacement both refuse a warm save.

The final isolated overlay has 165 engine files and differs from the frozen app
at `src/source-editor.mjs`, `desktop/helper.mjs` and the added
`desktop/line-framer.mjs`. Ten 5,001-document refresh/draft/save/restore/switch
cycles plus disposable lifecycle/Git workers measured **227.88 MiB helper RSS**
and **255.55 MiB summed owned-tree RSS**, with 50 ms tree sampling. All terminal
gates passed, including large-save P95 **2,799.55 ms** and cleanup **56.58 ms**.
No GC was forced and the production 256/4 MiB V8 limits were unchanged. This is
component evidence on one host, not native footprint or a universal RAM promise.
A separate fresh helper validated 80 retained receipts after ten editing cycles
in a 101-document corpus, including 20 large before/after receipts. Three restart
cycles plus fixture workers peaked at 184.05 MiB helper RSS; cleanup left no
pending request or observed descendant. This checks an empty receipt cache,
not only the optimized warm path.

The new fragmented large Unicode/CRLF test exposed per-chunk decoding in the
terminal test client. Both terminal clients now use stream UTF-8 decoding, and
the workload checks each opened fixture against disk before editing. The native
Rust reader already reads complete UTF-8 lines. The final stress measurement
uses these strengthened checks; previous reports remain historical evidence.

Fixture-only allocation profiles include objects collected by normal GC and
open no inspector network port. Three matched 101-document cycles attributed
625.06 MiB of Buffer.concat allocation before the fixes and 24.80 MiB afterward;
sampled allocation under receipt `readState` fell from 826.08 to 122.34 MiB.
These totals are diagnostic allocation, not RSS or retained heap. Sampling,
profiling overhead and host variation preclude a controlled speedup claim.

To collect a diagnostic profile separately from release measurements:

```sh
node desktop/scripts/measure-memory.mjs \
  --engine /path/to/exact/engine --synthetic 100 --cycles 3 \
  --profile-dir /tmp/runlist-fixture-allocations \
  --output /tmp/runlist-allocation-diagnostic.json
```

Profiling refuses a real `--checkout`, writes local fixture call stacks and
allocation metrics, and always leaves `componentBudgetsPass` false. Use an
unprofiled full workload for budget qualification. The
[latest validation record](VALIDATION.md#helper-allocation-follow-up--2026-10-08)
contains regression and restart evidence. Native process-set and application
edit-to-frame qualification, a new current package and shipping-host acceptance
remain open. External gmax work remains held; Apple work and computer use remain
stopped.

## Current package follow-up — 2026-10-08

Owner selected a new local candidate followed by owner-run native acceptance.
Runlist **0.91.0-rc.2** was built separately with signing disabled, incorporating
the bounded undo, source-validation, chunk-framing and receipt-allocation fixes.
Source/resource/runtime identities and archive CRC/private-state exclusion pass;
54 packaged and 11 native controller tests pass with network denied.

The exact package's ten-cycle 5,001-document workload measured **268.33 MiB
helper RSS**, above 256 MiB. Small/large open P95 was **383.57/2,005.38 ms**
against 250/1,500 ms; large-save P95 was **4,234.42 ms** against 3,000 ms.
These four gates failed. Owned-tree RSS was 278.06 MiB, idle CPU 0.00%, and EOF
cleanup 56.03 ms with zero pending/remaining observed children. No GC was forced
and production heap limits were unchanged. Preserve the earlier 227.88 MiB
overlay result as its own evidence; do not retry until a pass or relax gates.

An attempted combined network-denied measurement completed edit/worker cycles
but macOS refused the external ps sampler. Its incomplete report is retained;
the final memory run used ordinary process sampling. Offline evidence comes
from the separate passing packaged/native suites. Comparing engines found only
version/bundle metadata and the updated block editor differed from the earlier
overlay. The helper workload does not load that editor. This comparison does
not establish the cause of the different results or a host-contention diagnosis.

The candidate and evidence are in `releases/helper-memory-20261008/runlist/`.
Its owner-run native procedure
uses a disposable 5,001-document corpus. Native acceptance requires the owner
to open the candidate and operate it; automated computer use remains prohibited.
Physical footprint needs the complete verified native/helper/WebKit process
set. Owner interaction reports do not establish painted-frame P95. The owner cannot run the checks now, so step 2 is deferred and all native
fields remain pending until evidence arrives. The installed app, older frozen
candidate, gmax and Apple work are unchanged.


## Measurement method and host admission — 2026-10-08

The owner authorized correcting the measurement method before changing targets.
Schema 2 keeps the original numeric budgets. A separate Worker now runs async
process-table and host commands; it never receives document bodies or imports
Runlist/provider modules. Slow scans cannot block the reply-timing event loop.
The observer still consumes host resources, reports command costs/actual gaps,
and cannot turn delayed sampling into a reliable peak estimate. Errors retain
exit/signal/killed information in new reports. Both helper and observer close on
failed requests; failure reports retain cleanup and host telemetry.

Host observations include interval CPU utilization, load averages, available
memory, swap occupancy and counter deltas, compression counters on macOS, active
power source/mode, and `pmset` thermal/performance warnings. An absence of warnings
is not a direct `ProcessInfo.thermalState` measurement. No apps, processes, power
settings, caches, daemons or OS admission policies are changed.

The declared, provisional macOS baseline admission policy requires CPU-busy P95
no higher than 20%, swap traffic no higher than 1 MiB/s, at least three host
intervals, AC power, a known stable power mode and no reported thermal warning.
These are measurement controls, not vendor standards or requirements imposed on
people using Runlist. Occupied swap alone is not a rejection. Unsupported or
incomplete host telemetry prevents qualification; Linux gets CPU/swap diagnostics
but its power/thermal admission is not implemented. Windows sampling is unqualified.

A `baseline` run checks the host before creating a fixture or starting a helper,
and checks each run's preflight and entire observation period. It records an
inconclusive result/exit 2 when environment, sampling cadence, coverage or series
completion is unsuitable. It never retries until a pass. A completed baseline
with adequate evidence but exceeded targets exits 1. A successful component
baseline still leaves draft-latency, whole-app and release qualification open.

Choose the fixed series and a new output path before running. Existing evidence paths are refused. Use the selected package’s bundled Node for the timing client as well as the helper, and keep that client version fixed:

```sh
/path/Runlist.app/Contents/Resources/engine/runtime/RunlistHelper \
  desktop/scripts/measure-memory.mjs \
  --engine /path/Runlist.app/Contents/Resources/engine \
  --synthetic 5000 --workers 1 --cycles 20 --runs 6 \
  --environment baseline --output /tmp/runlist-controlled-baseline.json
```

Each helper and corpus starts fresh. Six 20-cycle runs provide 114 warm large
observations and 342 small observations. Per-run results and pooled timing
distributions remain available; every gated warm operation needs at least 100
samples. This floor is a practical tail-sampling policy, not a confidence claim.
The sampler must collect samples without errors and its P95 actual gap must be
no more than twice the requested interval. Cold initialization and worker actions
are reported separately. A busy host or failed scan does not qualify the RSS peak.

A separate `--environment ordinary-load --cycles 10 --runs 1` run characterizes
behavior with background work. Its host observations describe the actual load;
selecting that label does not make extreme saturation representative of normal
usage. Neither ordinary-load nor diagnostic runs can set `componentBudgetsPass`.

Timing now distinguishes immediate repeat opens, opens after refresh, and opens
after save invalidation, plus small/large saved opens, durable saves/restores and
draft preservation/discard. Repeat opens express cache intent; the unmodified
helper does not expose exact refresh generation with document replies. Switching
in the actual GUI may await draft preservation. Draft timings therefore remain
explicitly unqualified until a budget is calibrated, rather than silently passing.
No new draft budget or relaxed existing target was invented.

The extra repeat opens, longer idle interval and new sampling method change the
workload. Historical and schema-2 results are not a controlled speedup comparison.
The 256/512 MiB provisional native settled/peak footprint targets and 100/250 ms
edit-to-frame targets still require the owner-run native checks, now deferred.

## Selected-source rc.3 allocation diagnostic — 2026-10-08

First-release steps 1–4 produced unsigned selected-source **0.91.0-rc.3** with
library invalidation/race fixes and fewer redundant editor-route reads. Its
candidate record retains the
exact source/runtime hashes, full terminal tests and allocation profile.

The packaged Node 24.21.0 caller/helper ran one 101-document, three-cycle synthetic
workload with allocation profiling and no forced GC. All observed targets passed:
helper peak/settled RSS **196.22/189.22 MiB**, idle CPU **0.13%**, cleanup
**16.95 ms** and large-save P95 **346.73 ms** from only two warm samples.
`componentBudgetsPass`, `wholeAppQualified` and `releaseQualified` remain false.
This diagnostic is not a controlled baseline, a comparable 5,001-document pass
or native footprint/paint evidence. It does not supersede the rc.2 failed gates.

Sampled allocation stacks include objects collected by GC; cumulative allocation
is not retained RAM. Canonical path/ownership-directory checks, exact receipt/
source snapshots and receipt JSON remain visible costs. Preserve their correctness
guards. No numeric gate, heap setting, global host policy or forced GC changed.
The next separately selected step is the existing fixed performance series on
an adequate host using these exact bytes, with all runs retained. Owner-native
checks remain deferred and existing app/gmax/Apple holds persist.
