#!/bin/sh

# Compatibility wrapper for the command already configured on prodxiv-api.
set -eu

exec sh scripts/vercel-ignore-build.sh api "$@"
