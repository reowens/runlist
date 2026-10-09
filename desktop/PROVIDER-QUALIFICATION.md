# External provider qualification

gmax remains optional and is never bundled or installed by Runlist. Missing or incompatible providers leave text search available. This document describes maintainer qualification of an explicitly selected provider artifact, using synthetic IPC and temporary checkouts rather than the installed daemon or index.

Provider qualification runs separately through `provider.yml`, either explicitly with workflow dispatch or from another workflow selecting that provider. Normal desktop builds and npm publication do not depend on this optional provider job. Supply `artifact_url` and `artifact_sha256` for an accessible HTTPS tarball and its lowercase SHA-256. Missing inputs, a checksum mismatch, install/engine errors or a failed provider fixture stop qualification. The workflow has no conditional provider skip. Selecting or publishing that external artifact is a separate release action; a successful local run does not establish a successful hosted workflow.

The job tests Node 22.12.0 (gmax's supported minimum) and 24.21.0 (Runlist's bundled runtime). It resolves a fresh consumer lockfile, installs with lifecycle scripts disabled and engine requirements enforced, refuses dependency links outside the consumer install, checks Lance JS/native pins and provenance, and exercises the actual packaged bridge through Runlist's private helper. Native compatibility uses a bounded 2 MiB Session and a compaction-containment check that forbids store connection. This does not prove live resource admission, native retrieval or watcher health. No model, watcher, daemon, indexer or desktop window is started.

Run locally from the repository:

```sh
node desktop/scripts/qualify-provider.mjs /path/to/grepmax.tgz SHA256 /new/consumer/directory desktop/src-tauri/resources
```

The consumer directory must be new. Omit the final engine directory only when qualifying source without a prepared bundle. Keep its `package-lock.json`, `qualification.json` and test output with the artifact manifest. Both runtimes must pass against the same tarball hash; their resolved lockfiles are retained independently. Generated consumer dependencies are qualification data, never a Runlist runtime dependency.

`RUNLIST_REQUIRE_GMAX_QUALIFICATION=1` makes both the actual-provider fixture and bundle checker fail when `RUNLIST_GMAX_QUALIFICATION_ENTRY` is absent. Ordinary source tests retain the dependency-free unavailable-provider path. A release claiming qualified semantic search must invoke the required runner rather than count an optional skipped test as provider evidence. A text-search desktop or CLI release makes no provider-qualification claim.

For identifiable local builds, `desktop/scripts/freeze-source.mjs REPOSITORY NEW_OUTPUT_DIRECTORY PRERELEASE_VERSION` captures tracked and nonignored untracked regular files, their original/candidate hashes and the base revision. It applies candidate versions only inside the new snapshot. It never stages, commits, tags, publishes or changes the checkout's version. Build and qualify that snapshot; any subsequent source correction requires an explicit new recorded inventory and relevant reruns.
