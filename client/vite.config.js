import { defineConfig } from 'vite';
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// GET /gunsheet?wt=12 → image/png of gunlab's 4-up reference sheet.
// Drives ONE warm headless Chrome (SwiftShader WebGL) against this same
// dev server: open gunlab, click the weapon, click "▦ sheet", poll
// window.__sheetPNG, hand the dataURL back as the response. Serialised
// — SwiftShader renders are slow and concurrent pages would thrash.
const gunSheet = {
  name: 'gun-sheet',
  configureServer(server) {
    const require = createRequire(join(server.config.root, '../_tools/package.json'));
    let browserP = null; // lazy — agents may never hit the endpoint
    let queue = Promise.resolve();
    const chrome = process.env.CHROME_PATH
      ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe',
        '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
    const getBrowser = () => (browserP ??= require('puppeteer-core').launch({
      executablePath: chrome,
      headless: true,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
        '--mute-audio', '--no-sandbox'],
    }));
    const render = async (wt, port) => {
      const browser = await getBrowser();
      const page = await browser.newPage();
      // Wide buffer like a desktop window — the fps cell right-crops a
      // square out of it, and a narrow page crops the viewmodel off.
      await page.setViewport({ width: 1600, height: 900 });
      try {
        await page.goto(`http://localhost:${port}/gunlab.html`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('document.querySelectorAll("#rail button").length > 0', { timeout: 30000 });
        await page.evaluate((w) => {
          [...document.querySelectorAll('#rail button')].find(b => b.textContent?.trim().startsWith(`${w} `))?.click();
        }, wt);
        await new Promise(r => setTimeout(r, 800));
        await page.evaluate(() => {
          [...document.querySelectorAll('#rail button')].find(b => b.textContent?.includes('sheet'))?.click();
        });
        await page.waitForFunction('window.__sheetPNG', { timeout: 30000 });
        const dataUrl = await page.evaluate('window.__sheetPNG');
        return Buffer.from(dataUrl.split(',')[1], 'base64');
      } finally { await page.close(); }
    };
    server.middlewares.use('/gunsheet', (req, res) => {
      const wt = Number(new URL(req.url, 'http://x').searchParams.get('wt'));
      if (!Number.isInteger(wt)) { res.statusCode = 400; res.end('usage: /gunsheet?wt=N'); return; }
      queue = queue.then(() => render(wt, server.config.server.port)).then(
        (png) => { res.setHeader('content-type', 'image/png'); res.end(png); },
        (err) => { res.statusCode = 500; res.end(String(err)); },
      );
    });
  },
};


// POST /shot?name=w25_sheet.png with a PNG body → client/shots/<name>.
// Lets gunlab (and tests) drop reference renders where an agent can
// read them straight off disk — no download round-trip.
const shotSaver = {
  name: 'shot-saver',
  configureServer(server) {
    server.middlewares.use('/shot', (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
      const name = new URL(req.url, 'http://x').searchParams.get('name') ?? 'shot.png';
      if (!/^[\w.-]+\.png$/.test(name)) { res.statusCode = 400; res.end('bad name'); return; }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const dir = join(server.config.root, 'shots');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, name), Buffer.concat(chunks));
        res.end('ok');
      });
    });
  },
};

// public/ doubles as the .old graveyard — every corpse file gets copied
// into dist and shipped (~27MB dead weight). Strip .old from the OUTPUT
// only: sources stay for the scheduled cleanup pass, dev server still
// serves them if anything old needs checking live.
const stripOldAssets = {
  name: 'strip-old-assets',
  apply: 'build',
  closeBundle() {
    const dist = fileURLToPath(new URL('dist', import.meta.url));
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name.endsWith('.old')) rmSync(p, { recursive: true, force: true });
          else walk(p);
        }
        else if (e.name.endsWith('.old')) rmSync(p);
      }
    };
    if (existsSync(dist)) walk(dist);
  },
};

export default defineConfig(({ mode }) => ({
  // `vite --mode noreload` (npm run dev:noreload): agentic edit batches were
  // nuking in-world state on every file save. HMR socket stays alive but the
  // stale-notify plugin SWALLOWS every update and instead pushes a custom
  // event — the client counts changed files in a corner badge.
  // Manual Ctrl+R when you want the new code.
  plugins: [shotSaver, gunSheet, stripOldAssets, ...(mode === 'noreload' ? [{
    name: 'stale-notify',
    configureServer(server) {
      // Vite hard-codes a full-reload for ANY .html change (client env,
      // dist chunks/node.js — "page reload" on empty module set and on
      // isClientHtmlChange). Returning [] from handleHotUpdate can't stop
      // it, so filter the wire: drop full-reload sends in noreload mode.
      const env = server.environments?.client;
      const chan = env?.hot ?? server.ws;
      const orig = chan.send.bind(chan);
      chan.send = (...args) => {
        const p = args[0];
        if (p && p.type === 'full-reload') return;
        return orig(...args);
      };
    },
    handleHotUpdate({ server, modules, file }) {
      // index.html never reaches the module graph — count it directly.
      const files = modules.length
        ? modules.map(m => m.file).filter(Boolean)
        : [file];
      server.ws.send({ type: 'custom', event: 'stale:changed', data: { count: files.length, files } });
      return []; // swallow — no HMR, no full-reload
    },
  }] : [])],
  optimizeDeps: {
    include: [], // colyseus.js is .old-retired + uninstalled; leaving it here 504s the server
    // Prebundling three.quarks embeds a SECOND three copy inside the dep
    // bundle; registerShaderChunks() then patches that copy's ShaderChunk
    // while the game renders with the other — "Can not resolve #include
    // <tile_pars_vertex>" on the first particle draw. Keep it unbundled so
    // it shares the app's three instance.
    exclude: ['three.quarks'],
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 600,
    // Disable rolldown for better CommonJS compatibility
    rollupOptions: {
      output: {
        codeSplitting: false,
        entryFileNames: 'game.js',
        // The net worker is the only secondary chunk (codeSplitting off) —
        // a fixed 'game.js' here would collide with the entry bundle.
        chunkFileNames: 'net-worker-[hash].js',
        assetFileNames: 'game.[ext]',
      },
    },
  },
  worker: { format: 'es' },
  server: {
    port: 5400,
    host: '0.0.0.0',
    allowedHosts: ['.trycloudflare.com'],
    cors: true,
    hmr: {
      // Conditionally use WSS/443 only when accessing through cloudflared tunnel
      protocol: process.env.VITE_HMR_URL ? "wss" : "ws",
      host: process.env.VITE_HMR_URL, // undefined = auto-detect from page URL (works for LAN access)
      clientPort: process.env.VITE_HMR_URL ? 443 : 5400,
      overlay: true, // Show error overlay
    },
    watch: {
      usePolling: true, // Enable polling for reliable HMR in WSL2/Docker
    },
    // Pre-transform the boot chain at server start so an F5's import
    // waterfall hits warm cache instead of per-module transform latency.
    warmup: {
      clientFiles: ['./src/main.ts'],
    },
    // API proxy — lets a single cloudflared tunnel carry the whole app
    // (game ws + demo clips + map assets). Only reachable on tunneled
    // origins; localhost dev still hits :8000 directly. /clips and
    // /server.json must stay UN-proxied: /clips is the client's own SPA
    // route and /server.json is a public asset (prefix-match footgun —
    // the stale /server proxy that used to live here WS-proxied it to
    // :8080 and spammed ECONNREFUSED).
    proxy: {
      '/ws': { target: 'ws://localhost:8000', ws: true },
      '/demos': 'http://localhost:8000',
      '/maps': 'http://localhost:8000',
      '/rooms': 'http://localhost:8000',
      '/status': 'http://localhost:8000',
      '/metrics': 'http://localhost:8000',
      '/client-log': 'http://localhost:8000',
      '/weaponstats.html': 'http://localhost:8000',
    },
  },
}));
