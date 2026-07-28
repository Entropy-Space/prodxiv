#!/bin/sh

# Vercel exits 0 to skip a build and 1 to continue it.
# Fail open when the target or a reliable comparison range is unavailable.
set -eu

target="${1:-}"
previous_sha="${2:-${VERCEL_GIT_PREVIOUS_SHA:-}}"
current_sha="${3:-${VERCEL_GIT_COMMIT_SHA:-HEAD}}"
default_branch_refs="${PRODXIV_VERCEL_DEFAULT_BRANCH_REF:-origin/main main}"

repository_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Git repository root is unavailable; building."
  exit 1
}
cd "$repository_root"

case "$target" in
  api | web) ;;
  *)
    echo "Unknown Vercel build target '$target'; building."
    exit 1
    ;;
esac

current_commit="$(git rev-parse --verify "${current_sha}^{commit}" 2>/dev/null)" || {
  echo "Current deployment commit is unavailable; building $target."
  exit 1
}

baseline_commit=""
baseline_source=""
if [ -n "$previous_sha" ]; then
  baseline_commit="$(
    git rev-parse --verify "${previous_sha}^{commit}" 2>/dev/null || true
  )"
  if [ -n "$baseline_commit" ]; then
    baseline_source="previous deployment"
  fi
fi

if [ -z "$baseline_commit" ]; then
  for default_branch_ref in $default_branch_refs; do
    default_branch_commit="$(
      git rev-parse --verify "${default_branch_ref}^{commit}" 2>/dev/null ||
        true
    )"
    if [ -z "$default_branch_commit" ]; then
      continue
    fi
    candidate_commit="$(
      git merge-base "$current_commit" "$default_branch_commit" 2>/dev/null ||
        true
    )"
    if [ "$candidate_commit" = "$current_commit" ]; then
      continue
    elif [ -n "$candidate_commit" ]; then
      baseline_commit="$candidate_commit"
      baseline_source="merge base with $default_branch_ref"
      break
    else
      baseline_commit=""
    fi
  done
fi

if [ -z "$baseline_commit" ]; then
  echo "No reliable deployment baseline is available; building $target."
  exit 1
fi

set +e
case "$target" in
  api)
    git diff --quiet "$baseline_commit" "$current_commit" -- \
      .dockerignore \
      Cargo.lock \
      Cargo.toml \
      Containerfile.vercel \
      crates \
      migrations \
      scripts/vercel-api-ignore-build.sh \
      scripts/vercel-ignore-build.sh
    diff_status=$?
    ;;
  web)
    git diff --quiet "$baseline_commit" "$current_commit" -- \
      apps/web \
      bun.lock \
      examples/papers \
      .npmrc \
      bunfig.toml \
      package.json \
      packages/api-client \
      packages/contracts \
      schemas \
      scripts/vercel-ignore-build.sh
    diff_status=$?
    ;;
esac
set -e

case "$diff_status" in
  0)
    echo "No $target deployment inputs changed since $baseline_source; skipping."
    exit 0
    ;;
  1)
    echo "$target deployment inputs changed since $baseline_source; building."
    exit 1
    ;;
  *)
    echo "Unable to compare $target deployment inputs; building."
    exit 1
    ;;
esac
