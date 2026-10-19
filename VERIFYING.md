# Verifying Runlist

Use local checks while developing. Run commands sequentially, and choose checks
for the changed behavior before running the full suite. A passed check applies
to the recorded source and toolchain; an unrun platform remains unqualified.

## Local source checks

Record the source and tools with `git rev-parse HEAD`, `node --version`,
`npm --version` and `git --version`. Uncommitted changes require retaining their
diff alongside the result; a commit SHA alone does not identify those inputs.

For example, after changing release fixtures:

```sh
node --import ./test/setup-env.mjs --test --test-concurrency=1 test/publication-release.test.mjs
```

Then run the publication privacy check and full source suite:

```sh
npm run check:public
npm test
```

`npm test` uses four test-file workers. On a constrained host, the same suite can
run with one worker instead:

```sh
node --import ./test/setup-env.mjs --test --test-concurrency=1 test/*.test.mjs
```

The privacy check reports whether the local private vocabulary key is available.
Generic checks alone do not establish a private vocabulary pass. Tagged npm
publication requires the key and runs its own privacy check and full source suite.
It does not depend on desktop or external-provider qualification.

## Git commit integration

The ordinary source suite can exercise platform-independent behavior while
unsupported Git commit integration cases are visibly skipped. Skips do not qualify
Git writes on that host. On a supported platform/architecture with an unqualified
Git version, one prerequisite fails and dependent integration cases are skipped.
On other platforms, qualification is skipped unless explicitly required.
For explicit Mac Git commit qualification, first run:

```sh
node scripts/check-git-commit-toolchain.mjs
```

If it passes, run the integration suite with qualification required:

```sh
RUNLIST_REQUIRE_GIT_COMMIT_QUALIFICATION=1 node --import ./test/setup-env.mjs --test --test-concurrency=1 test/app-git-commits.test.mjs
```

The preflight prints a single diagnostic and refuses an unqualified toolchain.
`macos-latest` selects a runner image; it does not pin Git. Manual Mac CLI
compatibility runs this preflight before the full suite. A maintainer must select an already
qualified Git installation or complete a separate qualification before adding a
new platform/version to the production matrix. Do not broaden the matrix merely
to make a runner pass.

## Hosted source and compatibility checks

Routine pushes to `main` and pull requests run one Linux/Node24 source job.
Superseded routine runs are cancelled. Manual runs are not cancelled by that rule.
The source workflow also accepts manual dispatch using GitHub's branch/tag
selection, for example:

```sh
gh workflow run ci.yml --ref candidate-branch
```

Record the resulting run URL and tested SHA. A PR run can test a synthetic merge
commit and is not a desktop source prerequisite.

CLI compatibility is manual and platform-selectable. The default `windows`
selection runs Windows on Node22 and Node24; `linux` runs Node20, `macos` runs
Node24, and `all` runs all four combinations. Select a full lowercase
40-character commit SHA, for example:

```sh
source_sha=$(git rev-parse HEAD)
gh workflow run compatibility.yml --ref main -f source_sha="$source_sha" -f platform=windows
```

The workflow must first be available on GitHub's default branch, and the selected
commit must be pushed. Until the selected Windows jobs pass, the fixture repair
has local coverage only and Windows execution remains unverified.

Each job verifies its checked-out SHA and records tool versions. macOS requires
the qualified Git preflight and required integration mode. Other hosts can still
report unsupported Git integration skips; passing the CLI suite does not expand
the Git write support matrix. A missing or failed manual run remains unqualified.

## Desktop qualification

Desktop packaging is explicitly selected, rather than running on every source
change. Choose `macos` (the default), `windows`, `linux` or `all`:

```sh
source_sha=$(git rev-parse HEAD)
gh workflow run desktop.yml --ref main -f source_sha="$source_sha" -f platform=macos
```

Before native jobs start, the workflow verifies that the selected commit exists
and has a successful `CI` push/manual run or `Publish` push run with exactly that
SHA. It inspects up to 100 successful runs for that SHA in each workflow, records
the source-verification URL, and refuses missing evidence. It excludes PR runs
because they can test a synthetic merge. If evidence is missing, run CI on a
branch/tag pointing to the selected commit, wait for success, then retry desktop
qualification. CI must support manual dispatch at that branch/tag.

Native jobs verify the checkout again, then run desktop source, native library,
build and prepared-helper/frontend checks. They reuse the recorded source-suite
pass rather than running the root suite again. Linux also tests extracted
installers. Mac/Windows prepared-resource checks alone do not prove installation,
upgrades or native-window behavior. These jobs do not sign, notarize or publish.
The packaged Git helper checks safe refusal when its Git version is unqualified;
desktop packaging can pass without qualifying writable Git on that toolchain.

For selected local desktop work, use the pinned Rust toolchain and the host build
dependencies documented in `.github/workflows/desktop.yml`.
After a source-suite pass for the same source, run:

```sh
npm ci --prefix desktop
npm --prefix desktop test
npm --prefix desktop run prepare:bundle
cargo +1.95.0 test --locked --manifest-path desktop/src-tauri/Cargo.toml --lib
npm --prefix desktop run build -- --ci
npm --prefix desktop run test:bundle
```

Select Rust 1.95.0 for the build command too (the workflow uses a toolchain
override). On Linux, additionally run
`npm --prefix desktop run test:linux-packages`. Keep the source SHA/diff, tool
versions, command output and artifact hashes with the qualification result.
Building does not establish support for an otherwise unqualified platform.

External gmax provider qualification stays separate and opt-in. Its workflow
requires an exact artifact URL and SHA256; see
[provider qualification](desktop/PROVIDER-QUALIFICATION.md). It does not start a
model, daemon or indexer and does not establish live-search readiness.
