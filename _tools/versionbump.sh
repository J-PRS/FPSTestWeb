#!/usr/bin/env bash
# pre-commit hook: bump patch in the VERSION of each area the commit
# touches. client/ -> client/VERSION, server_bun/ -> server_bun/VERSION,
# shared/ or anything else -> both (a shared sim change shifts both ends).
set -e
root="$(git rev-parse --show-toplevel)"
bump() {
  local f="$1" v maj min pat rest
  [ -f "$f" ] || return 0
  v=$(tr -d '[:space:]' < "$f")
  maj=${v%%.*}; rest=${v#*.}; min=${rest%%.*}; pat=${rest##*.}
  printf '%s.%s.%s\n' "$maj" "$min" "$((pat + 1))" > "$f"
  git add "$f"
}
paths=$(git diff --cached --name-only)
client=0; server=0
while IFS= read -r p; do
  case "$p" in
    client/VERSION|server_bun/VERSION|_tools/versionbump.sh) ;;
    client/*) client=1 ;;
    server_bun/*) server=1 ;;
    shared/*) client=1; server=1 ;;
    *) ;;
  esac
done <<< "$paths"
[ "$client" = 1 ] && bump "$root/client/VERSION"
[ "$server" = 1 ] && bump "$root/server_bun/VERSION"
exit 0
