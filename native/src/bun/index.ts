import { BrowserWindow } from "electrobun/main";

// FPSWebTest native shell spike:
//  1. One window at the live/dev client URL — no bundled assets, updates ride
//     the normal client deploy.
//  2. ws://127.0.0.1:8787/udp — a loopback WS→UDP relay so the web page can
//     reach a raw datagram lane WITHOUT any RPC bridge: ws binary in -> UDP
//     datagram to TARGET, UDP datagram back -> ws binary out. Works in any
//     webview (and a plain Node/Bun proxy for testing).

// The game page the window loads — dev default points at the local
// server so the UDP lane answers (gameState.udp). For live play point
// CLIENT_URL at https://play.jprice.app/?server=wss%3A%2F%2Fplay.jprice.app%2Fws
const CLIENT_URL = process.env.CLIENT_URL
  ?? "http://localhost:5400/?server=ws%3A%2F%2Flocalhost%3A8000%2Fws";
const RELAY_PORT = 8787;
// Where datagrams go — the server UDP lane (FPS_UDP_PORT on the box).
// Local dev: 127.0.0.1:9898. Live: UDP_TARGET_HOST=92.5.61.55.
const TARGET_HOST = process.env.UDP_TARGET_HOST ?? "127.0.0.1";
const TARGET_PORT = Number(process.env.UDP_TARGET_PORT ?? 9898);
// Fullscreen is the real-game default; FULLSCREEN=0 for a bordered window.
const FULLSCREEN = process.env.FULLSCREEN !== "0";

const udp = await Bun.udpSocket({
  socket: {
    data(_socket, buf, _port, _addr) {
      // Server datagram -> every attached ws client (one window, one conn).
      ws?.send(buf);
    },
  },
});
let ws: { send(d: string | ArrayBuffer | Uint8Array): void } | null = null;

Bun.serve({
  port: RELAY_PORT,
  fetch(req, server) {
    if (server.upgrade(req)) { return; }
    return new Response("udp relay — ws://127.0.0.1:8787/udp");
  },
  websocket: {
    open(conn) {
      ws = conn;
      console.log("relay client attached");
    },
    message(_conn, data) {
      // Page datagram -> server UDP socket.
      udp.send(data as Uint8Array, TARGET_PORT, TARGET_HOST);
    },
    close() {
      ws = null;
      console.log("relay client detached");
    },
  },
});
console.log(`udp relay: ws://127.0.0.1:${RELAY_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`);

const mainWindow = new BrowserWindow({
  title: "Kribes",
  url: CLIENT_URL,
  titleBarStyle: "hidden", // no chrome — the game IS the window
  frame: {
    width: 1600,
    height: 900,
    x: 100,
    y: 60,
  },
});
if (FULLSCREEN) { mainWindow.setFullScreen(true); }
void mainWindow;

console.log(`window -> ${CLIENT_URL}`);
