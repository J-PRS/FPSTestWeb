# WebTransport on anabatic-server (ARM64)

Scope: building the native addon on the A1, wiring the cert, and renewing it.
Context and hosts are in `DEPLOYMENT/readme.md`.

## Why a source build

`@webtransport-bun/webtransport` ships a Rust napi-rs addon. Published prebuilds
cover darwin-arm64, darwin-x64, win32-x64-msvc and linux-x64-gnu. There is no
linux-arm64 prebuild, and the linux-x64-gnu build needs glibc 2.38. Oracle Linux 9
has glibc 2.34, so the x86 Micro cannot load it either. The only working path on the
A1 is to compile.

## Build (done once, 2026-10-24)

On the A1 (`ssh opc@92.5.61.55`):

```
export PATH="$HOME/.cargo/bin:$HOME/.bun/bin:$PATH"
git clone --depth 1 https://github.com/vmeansdev/webtransport-bun ~/webtransport-bun
cd ~/webtransport-bun && bun install
setsid nohup bun run build:native > /tmp/wtbuild.log 2>&1 < /dev/null &
```

- Rust toolchain is 1.99.1 (`rustup`, installed in `~/.cargo`).
- Build is `cargo build --release` in `crates/native`. It took about 2 min 40 s on
  the 2-core A1 after dependencies were cached. The first run was longer.
- Output: `~/webtransport-bun/crates/native/webtransport-native.linux-arm64-gnu.node`
  (about 9.4 MB).

Install the artifact into the server's module tree, both places (the loader
checks `../../../crates/native` and `../prebuilds`):

```
A=~/webtransport-bun/crates/native/webtransport-native.linux-arm64-gnu.node
D=~/kribes/server_bun/node_modules/@webtransport-bun/webtransport
mkdir -p ~/kribes/server_bun/node_modules/crates/native $D/prebuilds
cp "$A" ~/kribes/server_bun/node_modules/crates/native/
cp "$A" $D/prebuilds/
```

Re-copy after any `bun install` in `server_bun`. I have not confirmed whether
install removes these files, so check `ls` after installing.

## Cert (self-signed, pinned by hash)

Browsers accept a self-signed WebTransport cert only when the client pins its
SHA-256 (`serverCertificateHashes`). Chrome requires a validity period under 14 days
for that pin. The server advertises the pin at `/wthash`, and the client reads it
from there, so no client-side hash is hand-copied.

```
mkdir -p ~/kribes/certs && cd ~/kribes/certs
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 13 \
  -subj /CN=92.5.61.55 -addext subjectAltName=IP:92.5.61.55 \
  -keyout key.pem -out cert.pem
```

The first cert expires **2026-11-06**. Renew before then:

1. Re-run the command above. Keep the file names so the env paths still match.
2. Restart the server (see `readme.md`, Server).
3. Confirm `/wthash` shows a new `sha256`. The client picks it up on the next load.

`FPS_WT_CERT` and `FPS_WT_KEY` in `~/kribes/server.env` point at these two files.

## Ports

- The WT listener is UDP `9443` (`FPS_WT_PORT`, default FPS_PORT+1443).
- Clients dial the port in `/wthash`, which is `FPS_WT_ADVERTISE_PORT` when set,
  otherwise the listener port. On the A1 it is `443`, because the HTTPS origin
  `https://play.jprice.app` only accepts WT on 443.
- Public UDP 443 reaches the listener through a firewalld forward:
  `sudo firewall-cmd --permanent --add-forward-port=port=443:proto=udp:toport=9443`
  then `sudo firewall-cmd --reload`. Confirm with `firewall-cmd --list-forward-ports`.
- Open only UDP 443 on the OCI security list. Do not open 9443 publicly; the forward
  redirects 443 to the local listener. Verified 2026-10-24 with 9443 closed.
- Caddy must not use UDP 443 (HTTP/3 off, see `readme.md`).
- Verify from a browser on an https page at the same origin:
  `new WebTransport('https://play.jprice.app:443', {serverCertificateHashes:[{algorithm:'sha-256', value: <hash from /wthash>}]}).ready`
  resolves when the path works.

## Verify

1. `grep -c "failed to start" ~/kribes/server.log` returns 0.
2. `curl https://play.jprice.app/wthash` returns `"enabled":true` and `"port":443`.
3. `ss -ulpn | grep 9443` shows bun bound to UDP 9443.
4. In the client, the diagnostics line reads `tier: wt`. The tier log line is
   `[NetTiers] tier: WebTransport`. Watch for `wt session flapped` after a join.

## Known failure modes

- `Native addon not loaded` with `GLIBC_2.38 not found`: the wrong prebuild was
  loaded, or the arm64 file is missing. Re-check the two copy destinations.
- `Connection lost` right after connect, then `tier benched for 30s`: usually a
  session token reject (close 1008). That is an application reject, not a
  transport failure. It is tracked as a client fix in `readme.md`, Known issues.
- `E_SESSION_CLOSED` in the log: normal when a client closes. It is swallowed in
  `WtServer.ts`.
