#!/usr/bin/env bash
# Dumps the current diff for a fresh-context verifier, then prints the
# prompt to feed it. Generator never grades itself — spawn a NEW agent
# with no access to this session's reasoning, give it only the diff +
# the claims, have it try to prove them false.
set -euo pipefail
cd "$(dirname "$0")/.."

mkdir -p _tools/scratch
OUT=_tools/scratch/review.diff
git diff HEAD > "$OUT"
LINES=$(wc -l < "$OUT")
if [ "$LINES" -eq 0 ]; then echo "review: clean tree — nothing to verify"; exit 0; fi
echo "review: $LINES diff lines -> $OUT"
cat <<'EOF'

Verifier prompt (paste into a fresh agent, attach the diff file):

  Verify this diff. The author claims it does what the commit/message
  says and breaks nothing. Do NOT trust the claim — prove it or disprove
  it against the actual code. Check: callers of touched functions still
  compile-agree, tests pin real behavior not the old contract, no
  determinism violations under shared/, no weakening of tests or skips.
  Report VERDICT: pass | fail, then a numbered list of findings with
  file:line evidence. You may not fix anything — report only.
EOF
