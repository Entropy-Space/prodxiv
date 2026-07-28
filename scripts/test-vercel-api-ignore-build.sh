#!/bin/sh

set -eu

repository_root="$(git rev-parse --show-toplevel)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT

mkdir -p "$fixture/scripts" "$fixture/apps/web"
cp \
  "$repository_root/scripts/vercel-api-ignore-build.sh" \
  "$fixture/scripts/vercel-api-ignore-build.sh"

git -C "$fixture" init --quiet
git -C "$fixture" config user.email "paperbot@example.invalid"
git -C "$fixture" config user.name "Paperbot Tests"
touch "$fixture/Cargo.toml"
git -C "$fixture" add Cargo.toml scripts/vercel-api-ignore-build.sh
git -C "$fixture" commit --quiet -m "test: establish baseline"
baseline="$(git -C "$fixture" rev-parse HEAD)"

echo "web-only" >"$fixture/apps/web/change.txt"
git -C "$fixture" add apps/web/change.txt
git -C "$fixture" commit --quiet -m "test: change website"
web_commit="$(git -C "$fixture" rev-parse HEAD)"
if ! (
  cd "$fixture"
  sh scripts/vercel-api-ignore-build.sh "$baseline" "$web_commit"
); then
  echo "Expected a web-only change to skip the API build." >&2
  exit 1
fi

echo "[workspace]" >"$fixture/Cargo.toml"
git -C "$fixture" add Cargo.toml
git -C "$fixture" commit --quiet -m "test: change API input"
api_commit="$(git -C "$fixture" rev-parse HEAD)"
if (
  cd "$fixture"
  sh scripts/vercel-api-ignore-build.sh "$web_commit" "$api_commit"
); then
  echo "Expected an API input change to continue the build." >&2
  exit 1
fi

if (
  cd "$fixture"
  sh scripts/vercel-api-ignore-build.sh "" "$api_commit"
); then
  echo "Expected a missing previous SHA to continue the build." >&2
  exit 1
fi

echo "Vercel API ignored-build checks passed."
