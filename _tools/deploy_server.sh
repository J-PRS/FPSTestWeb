#!/usr/bin/env bash
# Server deploy to the A1 — the /health 'build' stamp only tells the
# truth if the tree that produced it was committed, so dirty server_bun/
# or shared/ aborts the push. Usage: bash _tools/deploy_server.sh
# Box identity lives in env (DEPLOYMENT/server.md): FPS_DEPLOY_HOST,
# FPS_SSH_KEY, FPS_REMOTE_DIR (kribes home), FPS_BUN (bun binary).
set -euo pipefail
cd "$(dirname "$0")/.."
KEY="${FPS_SSH_KEY:-$HOME/.ssh/oci_anabatic}"
HOST="${FPS_DEPLOY_HOST:?set FPS_DEPLOY_HOST — see DEPLOYMENT/server.md}"
RDIR="${FPS_REMOTE_DIR:-kribes}"
BUN="${FPS_BUN:-.bun/bin/bun}"

dirty=$(git status --porcelain -- server_bun shared client/src/demo maps/rimrock.json maps/rimrock.bin maps/duel.json maps/headhunt.json)
if [ -n "$dirty" ]; then
  echo "deploy: uncommitted changes under server/shared — commit first:"
  echo "$dirty" | head -20
  exit 1
fi
BUILD=$(git rev-parse --short HEAD)
echo "deploy: stamping build $BUILD"

tar -czf /tmp/kribes_sync.tgz \
  server_bun/src server_bun/tests server_bun/package.json \
  shared client/src/demo maps/rimrock.json maps/rimrock.bin \
  maps/duel.json maps/headhunt.json
echo "$BUILD" > /tmp/kribes_build.txt

scp -i "$KEY" /tmp/kribes_sync.tgz /tmp/kribes_build.txt "$HOST:/tmp/"
ssh -i "$KEY" "$HOST" "
  cd ~/$RDIR && tar -xzf /tmp/kribes_sync.tgz &&
  cp /tmp/kribes_build.txt server_bun/build.txt &&
  pgrep -f '^[^ ]*bin/bun src/server.ts' | xargs -r kill; sleep 2;
  cd ~/$RDIR/server_bun &&
  set -a; [ -f ~/$RDIR/.env ] && . ~/$RDIR/.env; set +a;
  nohup ~/$BUN src/server.ts > ~/$RDIR/server.log 2>&1 &
  sleep 4;
  pgrep -fa '^[^ ]*bin/bun src/server.ts' | head -2;
  grep -ci 'failed to start' ~/$RDIR/server.log" </dev/null
echo "deploy: verifying..."
curl -s --max-time 8 "https://${FPS_DEPLOY_URL:-play.jprice.app}/health"
