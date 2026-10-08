#!/usr/bin/env bash
# pre-commit hook: auto-bump patch in VERSION and stage it.
set -e
f="$(git rev-parse --show-toplevel)/VERSION"
[ -f "$f" ] || exit 0
v=$(cat "$f" | tr -d '[:space:]')
maj=${v%%.*}; rest=${v#*.}; min=${rest%%.*}; pat=${rest##*.}
pat=$((pat + 1))
printf '%s.%s.%s\n' "$maj" "$min" "$pat" > "$f"
git add "$f"
