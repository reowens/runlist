# Source editing v1

`src/source-editor.mjs` is the shared local core for an existing-plan narrative
editing loop. It supports unambiguous legacy plans and valid native v1 plans,
flags, and decisions. It does not itself start a web server or change existing
domain CLI writers. Trusted adapters may opt into configured legacy document
types with `legacyTypes` and allow read-only unconfigured/untyped sources with
`allowUnconfiguredRead`. These are host options, never browser request fields.
Prompts stay excluded; frontmatter and history protections apply to every type.
The working document application in `src/app.mjs` supplies a
trusted local human adapter and consumes this core.

## Actor and authority

The trusted local host constructs `createSourceEditor({config, authenticate,
authorize})`. Both callbacks are required and synchronous; asynchronous
authentication can happen at the host boundary before calling the core, with
the callback resolving a verified, revocable session from server-owned state.
The factory/config/callbacks/test hooks are never request data. This is an
in-process boundary, not protection against arbitrary code with filesystem
access.

`authenticate(context)` returns `{kind:'human'|'agent', id, label?, session_id?}`.
An agent requires its actual session ID. The core never reads the launching
process's identity from environment variables and ignores an actor supplied in
the request. A human browser session remains a human even when an agent started
the server. A browser adapter must authenticate its own session and
protect mutation requests against cross-site/unauthorized access.

`authorize({actor, action, path})` verifies authority against trusted runtime
policy. It returns `{allowed:true}` for an authorized human; an authorized agent
also requires a nonempty `grant_id`. The adapter must verify that the grant is
current, binds the actor/session and selected checkout/path, permits the exact
action, and has not expired or been revoked. A grant reference in Markdown is
evidence to look up, never authority by itself. The core rechecks identity and
policy after waiting for save locks, and policy again before source publication.
The receipt attributes the operation to the verified actor and initial grant.

Actions are `read`, `save`, `undo`, `read-draft`, `write-draft`, `discard-draft`,
`inspect-operation`, and `settle-operation`. Drafts and receipts are additionally
bound to their owner. Agents include their session in that binding. Inspecting,
settling, or undoing another actor's operation is not supported by this v1 API.

Future domain operations for rulings, delegation, resolution, lifecycle, task
allocation, relationships, and migration must use separate action permissions.
An agent ruling requires a verified delegation permitting that specific ruling,
not merely permission to edit narrative. Recommendations or accepted awareness
do not create execution authority. Those writers append shared provenance to
native metadata through domain operations; this API cannot edit those fields.

## Source, revisions, and conflicts

`read(context,{path})` returns `{path,source,revision,type,editable,diagnostics}`.
`revision` is `sha256:<64 lowercase hex>` over the exact UTF-8 bytes. It is not a
Git commit, timestamp, frontmatter `updated`, or inferred current revision.
CRLF, Unicode, unknown metadata, tables, fences, links, comments, and attachments
are preserved because the core writes the supplied source without serialization.
Invalid/unsupported records remain readable and draftable, with `editable:false`.
The core accepts valid UTF-8 documents up to 8 MiB, without NUL bytes.

`save(context,{path,operationId,expectedRevision,source})` requires an exact base
revision and a caller-generated lowercase UUID v4. Frontmatter, lifecycle
`Version History` sections, and the sequence of stable native item anchors must
remain byte-identical/identity-identical. Narrative and existing task text or
checkboxes may change. New/removal/reordering of anchored items belongs to future
domain operations. Every native result is validated before publication. No
source serializer drops unknown fields or silently repairs invalid metadata.

A stale save throws `SourceEditError` with `code:'revision-conflict'` and
`details:{expectedRevision,currentRevision,currentSource}`. The application keeps
the draft, displays base/draft/current source and diff, and asks the user to
review a merge or reload. It submits a new operation ID against the explicitly
reviewed current revision. The core does not silently merge, retry a stale save
against a new revision, or choose a timestamp winner. Read/modify/save is a
compare-and-swap operation under the existing atomic-mutation path locks.

Configured Markdown roots authorize paths. Symlink sources, escapes, and
unmanaged types are rejected. A save also locks the canonical CLI ownership
record and checks its generation before publication. Corrupt ownership or a
claim held by another actor blocks saving. A human browser does not borrow the
launching agent's claim; the owner coordinates/releases it through the CLI.
Even a dead claim is not implicitly taken over by this API. An agent may save
its own claimed plan with verified edit authority. Saves never claim, release,
archive, run lifecycle hooks, repair references, stage Git, or commit Git.

Trusted checkout adapters may opt into `allowStageEdits:true`. This permits only
a plan's `ships:` field to change alongside narrative edits; all other envelope
bytes, lifecycle history and stable item identities remain protected. Stage
values are checked against the configured vocabulary, with an unset choice
allowed. Generic editor adapters retain the byte-identical frontmatter default.
The same save request, receipts, claims, revision checks and recovery path apply.
Compensating undo restores the retained exact before-image, including its prior
stage, without validating that old value as a new stage assignment.

## Durable operations and repair

Before replacing source, the core durably writes a private `prepared` receipt
containing the operation ID, request kind, path, actor/grant, timestamp, exact
before/after source and revisions, and optional `undoOf`. The canonical file is
then atomically replaced with its existing mode and its directory synchronized.
Finally the receipt becomes `committed`. A successful result contains the
operation ID/state, resulting revision, actor/grant, and affected files.

The same operation ID with identical owner/path/kind/base/source (or undo target)
returns the retained outcome and does not write source again. Different payload
reuse is `operation-reused`. A replay also reports `currentRevision`, which may
have changed since the historical save; the host rereads before editing further.

After a crash, a prepared receipt is reconciled against current source:

| Current source | Result |
| --- | --- |
| Exact after-image | Mark committed/recovered; do not write source again. |
| Exact before-image | The original owner may retry the original request; a different operation is blocked as pending. |
| Neither image | Report `repair-required`; preserve all images and current source, write nothing to source. |

This is content-generation recovery. It cannot prove which external writer
published identical bytes, or reconstruct a missing/corrupt local receipt.
New saves inspect pending receipts for that document before obscuring their
publication evidence. Source/durability errors after preparation retain the
receipt rather than blindly rolling source back over a later external edit.

`inspectOperation(context,{operationId})` returns the retained images and current
revision to the authorized owner. After explicit inspection,
`settleOperation(context,{operationId,expectedRevision,disposition:'leave-current'})`
checks that revision and leaves source untouched. It records `committed` for
the after-image, `not-applied` for the before-image, or `settled-unknown` for a
third generation. Unknown is never relabeled success/failure. The settled
operation cannot be retried to write; further reviewed edits use a new ID.
Malformed state requires manual inspection and is never silently reset. These
receipts are separate from existing move/lifecycle transaction manifests and
are inspected through this API, not `doctor --transactions`.

The existing locking and filesystem authorization are cooperative local
controls. Uncooperative filesystem writes can still race the final checks and
rename; descriptor-relative I/O is not implemented. Do not describe this as a
filesystem security boundary or a cross-clone transaction. A lost receipt or
a checkout moved to a new local path needs explicit recovery review.

## Draft recovery

`putDraft(context,{path,draftId,expectedDraftRevision,baseSource,baseRevision,source})`
stores a private draft, including the exact base snapshot for a later three-way
review. The base source must match its revision, but need not be the current
source; autosaving a stale draft never overwrites the document. Use `null` for a
new draft's expected revision. Later writes require the returned draft revision,
so two tabs cannot silently replace each other's recovery data.

`readDraft(context,{path,draftId})` returns the owner's draft and `stale` when the
canonical source differs from its base. It never applies the draft automatically.
`discardDraft(context,{path,draftId,expectedDraftRevision})` durably replaces it
with a body-free tombstone after explicit discard. A discarded ID can be used
again with expected revision `null`. Saves do not implicitly delete drafts;
the host clears them only after receiving/verifying the committed outcome.
Draft persistence survives host reload/disconnection after the core acknowledges
the draft. The plan app also keeps browser recovery snapshots before its disk
autosave acknowledges, and retains pending save/undo operation IDs across reload.
Missing, moved, or deleted canonical files require manual
inspection of local state in this first version; no create/rename recovery API
is provided yet.

State lives under the checkout's `.runlist/editor/` (or existing legacy state
directory), in owner-scoped draft files and an operation ledger. Files are
created with mode 0600 and directories with 0700; Windows uses its normal user
filesystem access controls. State may not traverse symlinks. In a Git checkout,
storage must be ignored and untracked before any body/before-image is persisted;
the core does not edit ignore rules. This storage is local, not shared record
history. No automatic expiry discards recovery data. Cleanup/retention controls
and a disk-wide draft inventory UI remain further work; the first app discovers
its browser recovery entries for each selected plan.

## Compensating undo

`undo(context,{path,operationId,undoOf,expectedRevision})` creates a new receipt
and save operation referencing a retained committed operation. The requester
must own the original receipt and have current undo authority. The expected
revision must equal both the current file and the original result. The new
source reverses that operation's changes; its own exact before/after images and
actor are retained. If anything changed subsequently, undo reports a conflict
and requires explicit review. It does not merge over later edits or replay
claims, hooks, reference repairs, migrations, or Git operations. Undoing the
compensating operation is a redo with the same revision protections.

The first application exposes the reviewed diff, Save, preserved draft,
conflict review, and Undo through these operations. Git commit, sharing across
clones, lifecycle actions, and record migrations remain distinct operations.

## Local document adapter

`runlist app [document] [--port <port>]` selects the configured checkout at startup
and binds only to `127.0.0.1`. A random access capability in the printed URL
fragment establishes a separate human browser session. The fragment is removed
after connection. Sessions use a port-scoped HttpOnly/SameSite=Strict cookie,
expire after twelve hours, and can be revoked with Disconnect. The adapter uses
the local OS user identity, not an agent session inherited from the environment.
This is a local capability, not a remote multi-user login service.

API mutations require the authenticated cookie, exact allowed local Origin,
and the session's random CSRF token. Host checks reject DNS-rebinding hosts;
cross-origin API requests are refused. Static content has a restrictive CSP
and no external scripts/styles. Markdown is escaped and unsafe link schemes
are refused. No browser request can select a new repository/config, inject an
actor/policy, release a claim, or start a lifecycle/domain operation. The adapter
homes configured hubs, plans and documents in a paged library. A hub is the
organizing document older guidance calls a runlist; its ordered child plans
live on that same document. Coordination, ordered and roadmap hubs are shapes
of this concept, not separate required container levels. Only
unambiguous configured narratives or valid native records are editable; untyped
and unsupported sources remain read only. Private prompts, excluded corpora and
generated indexes stay outside this adapter. Domain record views retain separate
action scopes.

The browser persists recovery data before Save/Undo requests, retries the same
payload/operation kind after an uncertain acknowledgement, and exposes retained
before/after/current evidence for explicit leave-current settlement. It does not
discard an interrupted operation merely because a request failed. Concurrent
source conflicts preserve the draft and require explicit merged-draft review
against the current revision. Saves/undo freeze the workspace while in flight
so a response cannot silently replace typing entered during the request.


The default document view edits supported Markdown blocks inline. It retains
raw source for untouched blocks, comments, and gaps; line-diff publication
preserves their original line endings. Enter and slash/plus menus create
blocks, task controls change existing checkboxes, and selected text supports
basic formatting. Code edits as plain text. Tables, nested lists, unclosed
fences, and unsupported block syntax have an explicit Markdown fallback.
Managed lifecycle history is read only in the block view. New/removal/reordering
of native anchors still belongs to domain operations; the core remains the
final validator. Draft undo/redo is distinct from compensating Undo save.
Inline changes autosave only the private draft; reviewed Save publishes source.
Pasted/dropped content is inserted as text, never authored HTML.
