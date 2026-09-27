#!/bin/bash
# Commit-message editor: pop the next prepared message for each squash group.
Q=C:/TEMP/_WEB/FPSWebTest/_tools/rebase/queue.txt
head -1 "$Q" > "$1"
sed -i '1d' "$Q"
