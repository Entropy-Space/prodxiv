#!/bin/sh

# Vercel exits 0 to skip a build and 1 to continue it.
# Fail open: when the deployment range is unavailable, build the API.
set -eu

previous_sha="${1:-${VERCEL_GIT_PREVIOUS_SHA:-}}"
current_sha="${2:-${VERCEL_GIT_COMMIT_SHA:-HEAD}}"

if [ -z "$previous_sha" ]; then
  echo "Previous deployment SHA is unavailable; building the API."
  exit 1
fi

if ! git cat-file -e "${previous_sha}^{commit}" 2>/dev/null; then
  echo "Previous deployment commit is unavailable; building the API."
  exit 1
fi

if ! git cat-file -e "${current_sha}^{commit}" 2>/dev/null; then
  echo "Current deployment commit is unavailable; building the API."
  exit 1
fi

if git diff --quiet "$previous_sha" "$current_sha" -- \
  .dockerignore \
  Cargo.lock \
  Cargo.toml \
  Containerfile.vercel \
  crates \
  migrations \
  scripts/vercel-api-ignore-build.sh
then
  echo "No API deployment inputs changed; skipping the API build."
  exit 0
fi

echo "API deployment inputs changed; building the API."
exit 1
