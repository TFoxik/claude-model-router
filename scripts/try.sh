#!/bin/sh
# Usage: scripts/try.sh [folder] [claude options...]
# Starts Claude in <folder> (default: here) with this checkout of the mod in place of the installed one.
# The installed copy is switched off for that session only; other sessions keep it.
set -eu
router=$(cd "$(dirname "$0")/.." && pwd)
dir=${1:-$PWD}
[ $# -gt 0 ] && shift
cd "$dir"
out=$(claude plugin validate "$router" 2>&1) || { printf '%s\n' "$out"; exit 1; }
exec claude --plugin-dir "$router" --settings '{"enabledPlugins":{"model-router@claude-model-router":false}}' "$@"
