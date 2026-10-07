# Game-server image. Build context = repo root (the server imports
# ../shared and reads ../maps relative to server_bun/src).
#
#   docker build -t fps .
#   docker run -p 8000:8000 -p 9443:9443/udp -e FPS_SECRET=... fps
#
# Public beta: add -e FPS_PUBLIC_BETA=1 (drops _t2 maps + t2 assets),
# -e FPS_ADMIN_TOKEN=<token> (ops surfaces), -e FPS_CORS_ORIGIN=<origin>,
# and FPS_ICE_SERVERS with a TURN entry for NATted p2p duels.
FROM oven/bun:1
WORKDIR /app
COPY server_bun/package.json server_bun/bun.lock server_bun/
RUN cd server_bun && bun install --frozen-lockfile
COPY shared/ shared/
COPY server_bun/src/ server_bun/src/
COPY maps/ maps/
ENV FPS_PORT=8000
EXPOSE 8000/tcp
# WebTransport tier listens on FPS_WT_PORT (default FPS_PORT+1443) over
# UDP — set FPS_WT_PORT=0 to disable when no QUIC cert is provisioned.
EXPOSE 9443/udp
CMD ["bun", "server_bun/src/server.ts"]
