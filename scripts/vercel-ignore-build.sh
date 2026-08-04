#!/bin/sh

# Vercel exits 0 to skip a build and 1 to continue it.
# Fail open when the target or a reliable comparison range is unavailable.
set -eu

target="${1:-}"
previous_sha="${2:-${VERCEL_GIT_PREVIOUS_SHA:-}}"
current_sha="${3:-${VERCEL_GIT_COMMIT_SHA:-HEAD}}"
default_branch_refs="${PRODXIV_VERCEL_DEFAULT_BRANCH_REF:-origin/main main}"
default_branch="${PRODXIV_VERCEL_DEFAULT_BRANCH:-main}"
git_remote="${PRODXIV_VERCEL_GIT_REMOTE:-origin}"

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

resolve_baseline() {
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
}

hydrate_git_history() {
  case "$git_remote" in
    "" | -* | *[!A-Za-z0-9._/-]*) return 1 ;;
  esac
  git check-ref-format --branch "$default_branch" >/dev/null 2>&1 || return 1

  case "$previous_sha" in
    *[!0-9A-Fa-f]*) ;;
    *)
      if { [ "${#previous_sha}" -eq 40 ] || [ "${#previous_sha}" -eq 64 ]; } &&
        git fetch --quiet --no-tags --depth=1 "$git_remote" "$previous_sha" \
          >/dev/null 2>&1; then
        return 0
      fi
      ;;
  esac

  history_hydrated=false
  shallow_file="$(git rev-parse --git-path shallow 2>/dev/null)" || return 1
  if [ -f "$shallow_file" ]; then
    if git fetch --quiet --no-tags --unshallow "$git_remote" \
      >/dev/null 2>&1; then
      history_hydrated=true
    fi
  fi
  if git fetch --quiet --no-tags "$git_remote" \
    "+refs/heads/$default_branch:refs/remotes/$git_remote/$default_branch" \
    >/dev/null 2>&1; then
    history_hydrated=true
  fi
  [ "$history_hydrated" = true ]
}

resolve_baseline
if [ -z "$baseline_commit" ] && hydrate_git_history; then
  resolve_baseline
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
      migrations
    diff_status=$?
    ;;
  web)
    git diff --quiet "$baseline_commit" "$current_commit" -- \
      apps/web \
      ':(exclude)apps/web/vercel.json' \
      bun.lock \
      examples/papers \
      .npmrc \
      bunfig.toml \
      package.json \
      packages/api-client \
      packages/contracts \
      schemas
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
