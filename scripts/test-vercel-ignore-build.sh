#!/bin/sh

set -eu

commit_all() {
  fixture_path="$1"
  message="$2"
  git -C "$fixture_path" add .
  git -C "$fixture_path" commit --quiet -m "$message"
}

expect_skip() {
  expect_result skip "$@"
}

expect_build() {
  expect_result build "$@"
}

expect_skip_default_ref() {
  fixture_path="$1"
  target="$2"
  previous_sha="$3"
  current_sha="$4"
  if ! (
    cd "$fixture_path"
    sh scripts/vercel-ignore-build.sh \
      "$target" \
      "$previous_sha" \
      "$current_sha"
  ); then
    echo "Expected $target to skip using the default branch ref fallback." >&2
    exit 1
  fi
}

expect_build_with_ref() {
  fixture_path="$1"
  target="$2"
  previous_sha="$3"
  current_sha="$4"
  default_ref="$5"
  if (
    cd "$fixture_path"
    PRODXIV_VERCEL_DEFAULT_BRANCH_REF="$default_ref" \
      sh scripts/vercel-ignore-build.sh \
      "$target" \
      "$previous_sha" \
      "$current_sha"
  ); then
    echo "Expected $target to build without a reliable baseline." >&2
    exit 1
  fi
}

expect_result() {
  expected="$1"
  fixture_path="$2"
  target="$3"
  previous_sha="$4"
  current_sha="$5"

  if (
    cd "$fixture_path"
    PRODXIV_VERCEL_DEFAULT_BRANCH_REF=main \
      sh scripts/vercel-ignore-build.sh \
      "$target" \
      "$previous_sha" \
      "$current_sha"
  ); then
    actual="skip"
  else
    actual="build"
  fi

  if [ "$actual" != "$expected" ]; then
    echo "Expected $target to $expected, got $actual." >&2
    exit 1
  fi
}

repository_root="$(git rev-parse --show-toplevel)"
temporary_root="$(mktemp -d)"
fixture="$temporary_root/fixture"
remote="$temporary_root/remote.git"
shallow_fixture="$temporary_root/shallow"
trap 'rm -rf "$temporary_root"' EXIT

mkdir -p \
  "$fixture/apps/paperbot" \
  "$fixture/apps/web" \
  "$fixture/crates/prodxiv-api" \
  "$fixture/examples/papers" \
  "$fixture/packages/api-client" \
  "$fixture/packages/contracts" \
  "$fixture/schemas" \
  "$fixture/scripts"
cp \
  "$repository_root/scripts/vercel-api-ignore-build.sh" \
  "$fixture/scripts/vercel-api-ignore-build.sh"
cp \
  "$repository_root/scripts/vercel-ignore-build.sh" \
  "$fixture/scripts/vercel-ignore-build.sh"

git -C "$fixture" init --quiet --initial-branch=main
git -C "$fixture" config user.email "paperbot@example.invalid"
git -C "$fixture" config user.name "Paperbot Tests"
touch \
  "$fixture/.dockerignore" \
  "$fixture/apps/web/index.ts" \
  "$fixture/bun.lock" \
  "$fixture/Cargo.lock" \
  "$fixture/Cargo.toml" \
  "$fixture/Containerfile.vercel" \
  "$fixture/package.json"
git -C "$fixture" add .
git -C "$fixture" commit --quiet -m "test: establish baseline"
baseline="$(git -C "$fixture" rev-parse HEAD)"

git -C "$fixture" switch --quiet -c feature

echo "paperbot-only" >"$fixture/apps/paperbot/change.ts"
commit_all "$fixture" "test: change Paperbot"
paperbot_commit="$(git -C "$fixture" rev-parse HEAD)"
expect_skip "$fixture" api "" "$paperbot_commit"
expect_skip "$fixture" web "" "$paperbot_commit"
expect_skip "$fixture" api missing "$paperbot_commit"
expect_skip_default_ref "$fixture" web "" "$paperbot_commit"

git clone --quiet --bare "$fixture" "$remote"
git clone --quiet --depth=1 --single-branch --branch feature \
  "file://$remote" "$shallow_fixture"
expect_skip "$shallow_fixture" api "$baseline" "$paperbot_commit"
expect_skip_default_ref "$shallow_fixture" web "" "$paperbot_commit"

echo "# filter-only change" >>"$fixture/scripts/vercel-ignore-build.sh"
echo "# wrapper-only change" >>"$fixture/scripts/vercel-api-ignore-build.sh"
commit_all "$fixture" "test: change deployment filters"
filter_commit="$(git -C "$fixture" rev-parse HEAD)"
expect_skip "$fixture" api "$paperbot_commit" "$filter_commit"
expect_skip "$fixture" web "$paperbot_commit" "$filter_commit"

echo "web-only" >"$fixture/apps/web/change.ts"
commit_all "$fixture" "test: change website"
web_commit="$(git -C "$fixture" rev-parse HEAD)"
expect_skip "$fixture" api "$filter_commit" "$web_commit"
expect_build "$fixture" web "$filter_commit" "$web_commit"

echo "{}" >"$fixture/schemas/paper.schema.json"
commit_all "$fixture" "test: change shared web schema"
schema_commit="$(git -C "$fixture" rev-parse HEAD)"
expect_skip "$fixture" api "$web_commit" "$schema_commit"
expect_build "$fixture" web "$web_commit" "$schema_commit"

echo "[workspace]" >"$fixture/Cargo.toml"
commit_all "$fixture" "test: change API input"
api_commit="$(git -C "$fixture" rev-parse HEAD)"
expect_build "$fixture" api "$schema_commit" "$api_commit"
expect_skip "$fixture" web "$schema_commit" "$api_commit"

echo "docs-only" >"$fixture/notes.md"
commit_all "$fixture" "test: add a later unrelated commit"
multi_commit="$(git -C "$fixture" rev-parse HEAD)"
expect_build "$fixture" api "" "$multi_commit"
expect_build "$fixture" web "" "$multi_commit"

expect_build_with_ref "$fixture" api "" "$multi_commit" missing

git -C "$fixture" switch --quiet main
expect_build "$fixture" api "" "$baseline"
expect_build "$fixture" web "" "$baseline"

expect_build "$fixture" api "" missing
expect_build "$fixture" unknown "$baseline" "$baseline"

if ! (
  cd "$fixture"
  sh scripts/vercel-api-ignore-build.sh "$baseline" "$paperbot_commit"
); then
  echo "Expected the API compatibility wrapper to skip a Paperbot-only change." >&2
  exit 1
fi

echo "Vercel ignored-build checks passed."
