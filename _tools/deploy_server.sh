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

dirty=$(git status --porcelain -- server_bun shared client/src/demo maps/rimrock.json maps/rimrock.bin maps/duel.json maps/headhunt.json maps/igunffa.json)
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
  maps/duel.json maps/headhunt.json maps/igunffa.json
echo "$BUILD" > /tmp/kribes_build.txt

scp -i "$KEY" /tmp/kribes_sync.tgz /tmp/kribes_build.txt "$HOST:/tmp/"
ssh -i "$KEY" "$HOST" "
  cd ~/$RDIR && tar -xzf /tmp/kribes_sync.tgz &&
  cp /tmp/kribes_build.txt server_bun/build.txt &&
  if systemctl cat kribes-fleet >/dev/null 2>&1; then
    # Drain-deploy: arm the flag on every worker -> joins refused,
    # humans finish or leave, then restart. Empty workers self-exit on
    # the drain checker anyway; the cap keeps a parked human from
    # blocking forever (fallback = the hard restart it replaced).
    AKEY=\$(grep -h '^FPS_ADMIN_TOKEN' ~/$RDIR/.env ~/$RDIR/server.env 2>/dev/null | cut -d= -f2 | tr -d '\r' | head -1)
    for p in 8001 8002 8003; do curl -s -m 3 -X POST -H \"Authorization: Bearer \$AKEY\" \"http://127.0.0.1:\$p/admin/drain\" >/dev/null || true; done
    for i in \$(seq 1 24); do
      humans=\$(for p in 8001 8002 8003; do curl -s -m 3 \"http://127.0.0.1:\$p/metrics?key=\$AKEY\"; echo; done | python3 -c 'import json,sys;print(sum(json.loads(l).get(\"humans\",0) for l in sys.stdin if l.strip()))' 2>/dev/null || echo '?')
      echo \"deploy: drain wait \${i}x5s humans=\$humans\"
      [ \"\$humans\" = \"0\" ] && break
      sleep 5
    done
    sudo systemctl restart kribes-fleet; sleep 8; systemctl is-active kribes-fleet;
  else
    pgrep -f '^[^ ]*bin/bun src/server.ts' | xargs -r kill; sleep 2;
    cd ~/$RDIR/server_bun &&
    set -a; [ -f ~/$RDIR/.env ] && . ~/$RDIR/.env; set +a;
    nohup ~/$BUN src/server.ts > ~/$RDIR/server.log 2>&1 &
    sleep 4;
    pgrep -fa '^[^ ]*bin/bun src/server.ts' | head -2;
  fi;
  grep -ci 'failed to start' ~/$RDIR/server.log || true" </dev/null
echo "deploy: verifying..."
curl -s --max-time 8 "https://${FPS_DEPLOY_URL:-play.jprice.app}/health"
