#!/usr/bin/env bash
# Definition of done — run after any change, before handing back.
# Changed-file scoped: lint+fix what you touched, typecheck always,
# test the clusters you reached. Exit 0 = done.
set -euo pipefail
cd "$(dirname "$0")/.."
# bun isn't on PATH in fresh agent shells (Windows Git Bash).
command -v bun >/dev/null || export PATH="$HOME/.bun/bin:$PATH"

CHANGED=$(git diff --name-only HEAD -- '*.ts' '*.tsx' | sort -u)
if [ -z "$CHANGED" ]; then
  echo "check: no changed ts/tsx files — nothing to verify"
  exit 0
fi
echo "check: $(echo "$CHANGED" | wc -l) changed files"

# Lint first — the fixer may rewrite files, so it runs before tests.
# (The fixer leaves edits UNSTAGED; staging is the caller's business.)
echo "$CHANGED" | xargs -n 50 npx -y oxlint --fix

# tsgo (native tsc) is ~3x faster for the same tsconfig; tsc is the fallback.
(cd client && npx -y -p @typescript/native-preview tsgo --noEmit) \
  || (cd client && ./node_modules/.bin/tsc --noEmit)

CLIENT_FILES=$(echo "$CHANGED" | grep '^client/' | sed 's|^client/||' || true)
if [ -n "$CLIENT_FILES" ]; then
  # related runs only tests covering the touched files; fall back to
  # the full suite when nothing relates (new files, dead ends).
  (cd client && echo "$CLIENT_FILES" | xargs ./node_modules/.bin/vitest related --run) \
    || (cd client && ./node_modules/.bin/vitest run)
fi

if echo "$CHANGED" | grep -qE '^(shared|server_bun)/'; then
  (cd server_bun && bun test)
fi

# Visual checkpoint: scene-visible code can't be verified by typecheck —
# boots the stack, frames a shot, and you MUST read the PNG it prints.
if echo "$CHANGED" | grep -qE '^client/src/(world|effects|structures|projectiles|shaders|entities)/'; then
  bun _tools/e2e/mapshot.ts && ls -t _tools/e2e/shots/*.png | head -1 | \
    xargs -I{} echo "check: READ THE SHOT — {} — render code changed; green tests do not see the screen"
fi

echo "check: DONE"
