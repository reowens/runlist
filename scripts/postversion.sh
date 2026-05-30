#!/usr/bin/env bash
#
# Post-release: push, cut the GitHub release, wait for the publish workflow to
# finish, wait for the registry to actually serve the new version, then install
# it globally. Invoked by the `postversion` npm lifecycle script after
# `npm version` has bumped + committed + tagged.
#
# Why this isn't a one-liner anymore: the old inline version did
#   sleep 5 && gh run watch $(gh run list --workflow=publish.yml --limit 1 ...)
# which has two races:
#   1. `--limit 1` grabs the *latest* run. The tag-push-triggered workflow takes
#      a few seconds to register, so within 5s the latest run is often the
#      PREVIOUS release's run — already completed 'success'. `gh run watch`
#      returns instantly and we sail past without ever watching our publish.
#   2. `npm publish` succeeding in CI doesn't mean the registry serves the
#      version to *us* immediately, so the follow-up `npm install` hit ETARGET.
# This script fixes both: it finds the run for THIS commit's SHA (polling until
# it appears) and polls the registry until the exact version resolves.
set -euo pipefail

VERSION="${npm_package_version:?npm_package_version not set — run via \`npm version\`}"
TAG="v${VERSION}"
SHA="$(git rev-parse HEAD)"

echo "→ pushing main + tags"
git push origin main --tags

echo "→ creating GitHub release ${TAG}"
gh release create "${TAG}" --generate-notes --title "${TAG}"

# Find the publish.yml run for THIS commit (not just the latest run). The
# push-triggered workflow can take several seconds to register, so poll.
echo "→ locating publish run for ${SHA:0:8} (up to ~160s)"
RID=""
for _ in $(seq 1 40); do
  RID="$(gh run list --workflow=publish.yml --limit 20 \
    --json databaseId,headSha \
    --jq "[.[] | select(.headSha==\"${SHA}\")][0].databaseId" 2>/dev/null || true)"
  if [ -n "${RID}" ] && [ "${RID}" != "null" ]; then
    break
  fi
  RID=""
  sleep 4
done
if [ -z "${RID}" ]; then
  echo "✗ no publish run found for ${SHA} after waiting." >&2
  echo "  The tag is pushed, so CI is likely still spinning up — check:" >&2
  echo "    gh run list --workflow=publish.yml" >&2
  exit 1
fi

echo "→ watching publish run ${RID}"
gh run watch "${RID}" --exit-status

# CI's `npm publish` succeeding doesn't guarantee the registry serves the
# version to us yet. Poll until the exact version resolves before installing.
echo "→ waiting for registry to serve dotmd-cli@${VERSION} (up to ~120s)"
for _ in $(seq 1 40); do
  if npm view "dotmd-cli@${VERSION}" version >/dev/null 2>&1; then
    break
  fi
  sleep 3
done
if ! npm view "dotmd-cli@${VERSION}" version >/dev/null 2>&1; then
  echo "✗ dotmd-cli@${VERSION} not resolvable on the registry after waiting." >&2
  echo "  Publish CI passed, so this is registry lag — retry:" >&2
  echo "    npm install -g dotmd-cli@${VERSION}" >&2
  exit 1
fi

echo "→ installing dotmd-cli@${VERSION} globally"
npm cache clean --force >/dev/null 2>&1 || true
npm install -g "dotmd-cli@${VERSION}"

echo "✓ released and installed dotmd-cli@${VERSION}"
