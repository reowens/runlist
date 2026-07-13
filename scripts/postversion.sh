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

release_failed() {
  echo "✗ release incomplete. Do not bump again; resume this version with:" >&2
  echo "    npm run release:resume" >&2
}
trap release_failed ERR

VERSION="${npm_package_version:-$(node -p "require('./package.json').version")}"
TAG="v${VERSION}"
node scripts/release-intent.mjs verify "${VERSION}"
SHA="$(git rev-list -n 1 "${TAG}" 2>/dev/null || true)"
if [ -z "${SHA}" ]; then
  echo "✗ local tag ${TAG} does not exist; run this through \`npm version\` first." >&2
  exit 1
fi
HEAD_SHA="$(git rev-parse HEAD)"
BRANCH="$(git branch --show-current)"
if [ "${BRANCH}" != "main" ] || ! git merge-base --is-ancestor "${SHA}" "${HEAD_SHA}"; then
  echo "✗ refusing release: ${TAG} must be contained by main." >&2
  echo "  branch=${BRANCH:-detached} tag=${SHA} head=${HEAD_SHA}" >&2
  exit 1
fi

echo "→ pushing main + ${TAG}"
PUSHED=""
for attempt in 1 2 3; do
  if git push --atomic origin "HEAD:refs/heads/main" "refs/tags/${TAG}:refs/tags/${TAG}"; then
    PUSHED=1
    break
  fi
  echo "⚠ push attempt ${attempt}/3 failed; retrying in 3s" >&2
  sleep 3
done
if [ -z "${PUSHED}" ]; then
  echo "✗ release not pushed after 3 attempts." >&2
  echo "  Resume the same release without bumping again:" >&2
  echo "    npm run release:resume" >&2
  echo "  If origin/main advanced, fetch and merge it into local main first; keep ${TAG} unchanged." >&2
  exit 1
fi

REMOTE_MAIN=""
read -r REMOTE_MAIN _ < <(git ls-remote origin refs/heads/main)
REMOTE_TAG=""
while IFS=$'\t' read -r remote_sha remote_ref; do
  if [ "${remote_ref}" = "refs/tags/${TAG}^{}" ]; then
    REMOTE_TAG="${remote_sha}"
  elif [ -z "${REMOTE_TAG}" ] && [ "${remote_ref}" = "refs/tags/${TAG}" ]; then
    REMOTE_TAG="${remote_sha}"
  fi
done < <(git ls-remote origin "refs/tags/${TAG}" "refs/tags/${TAG}^{}")
git fetch --quiet origin main
if ! git merge-base --is-ancestor "${SHA}" FETCH_HEAD || [ "${REMOTE_TAG}" != "${SHA}" ]; then
  echo "✗ remote main does not contain ${SHA}, or the release tag differs." >&2
  echo "  origin/main=${REMOTE_MAIN:-missing} ${TAG}=${REMOTE_TAG:-missing}" >&2
  exit 1
fi

if gh release view "${TAG}" >/dev/null 2>&1; then
  echo "→ GitHub release ${TAG} already exists (resume mode)"
else
  echo "→ creating GitHub release ${TAG}"
  gh release create "${TAG}" --generate-notes --title "${TAG}"
fi

# Find the publish.yml run for THIS commit (not just the latest run). The
# push-triggered workflow can take several seconds to register, so poll.
echo "→ locating publish run for ${SHA:0:8} (up to ~160s)"
RID=""
for _ in $(seq 1 40); do
  RID="$(gh run list --workflow=publish.yml --limit 20 \
    --json databaseId,headSha,headBranch \
    --jq "[.[] | select(.headSha==\"${SHA}\" and .headBranch==\"${TAG}\")][0].databaseId" 2>/dev/null || true)"
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
  echo "  Then resume this version with: npm run release:resume" >&2
  exit 1
fi

echo "→ watching publish run ${RID}"
if ! gh run watch "${RID}" --exit-status; then
  echo "⚠ publish run ${RID} failed; rerunning failed jobs once" >&2
  gh run rerun "${RID}" --failed
  gh run watch "${RID}" --exit-status
fi

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
  echo "  Publish CI passed, so this is registry lag. Resume without bumping:" >&2
  echo "    npm run release:resume" >&2
  exit 1
fi

echo "→ installing dotmd-cli@${VERSION} globally"
npm install -g "dotmd-cli@${VERSION}"

# A release shell and an agent host can resolve different Node installations
# from PATH (for example NVM first during release, Homebrew first in OpenCode).
# Update every visible copy and verify them all before claiming local success.
echo "→ checking every PATH-visible dotmd installation"
node scripts/sync-global-cli.mjs "${VERSION}"

# The Claude Code plugin ships from this repo in lockstep with the CLI, but
# `npm install -g` doesn't refresh the installed plugin copy (the CLI's
# postinstall only nudges, and allow-scripts policies can suppress even that).
# Refresh it here, where `claude` is known to be on the release machine. Local
# plugin refresh remains recoverable, but success is only reported after the
# installed plugin record agrees with the released version.
PLUGIN_VERIFIED=""
if command -v claude >/dev/null 2>&1; then
  echo "→ refreshing Claude Code plugin dotmd@dotmd"
  if claude plugin update dotmd@dotmd; then
    if node scripts/verify-installed-plugin.mjs "${VERSION}"; then
      PLUGIN_VERIFIED=1
      echo "  restart your Claude Code session (or /reload-plugins) to apply."
    else
      echo "⚠ plugin command completed but installed version is not ${VERSION}; run \`dotmd update --plugin-only\`." >&2
    fi
  else
    echo "⚠ plugin refresh failed — run \`dotmd update --plugin-only\` manually." >&2
  fi
else
  echo "⚠ \`claude\` not on PATH — plugin not refreshed; run \`dotmd update --plugin-only\`." >&2
fi

node scripts/release-intent.mjs clear
trap - ERR
if [ -n "${PLUGIN_VERIFIED}" ]; then
  echo "✓ released dotmd-cli@${VERSION}; all visible Node prefixes and the plugin are in sync"
else
  echo "✓ released and installed dotmd-cli@${VERSION} across all visible Node prefixes"
  echo "⚠ local plugin verification remains incomplete; the published CLI release is complete." >&2
fi
