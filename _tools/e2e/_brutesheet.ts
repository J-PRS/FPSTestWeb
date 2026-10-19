// _brutesheet.ts — anim contact sheet: every state at 3 phases, one
// browser session. Individual PNGs land in shots/sheet/<state>-<i>.png
// and a labelled composite grid in shots/brute-sheet.png.
import { launchClient, closeClient } from './browser.ts';
import { spawn } from 'bun';
import { mkdirSync } from 'node:fs';

const PM = process.env.PMODEL || 'brute';
const STATES = ['idle', 'walk', 'run', 'jump', 'ski', 'jet', 'shoot', 'throw', 'hit', 'death'];
const PHASE_WAIT = [500, 900, 1400]; // ms into the clip per column

const vite = spawn([process.platform === 'win32' ? 'npx.cmd' : 'npx', 'vite', '--port', '5459', '--strictPort'],
  { cwd: 'client', stdout: 'ignore', stderr: 'ignore' });
try {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await fetch('http://localhost:5459/')).ok) {break;} } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  mkdirSync('_tools/e2e/shots/sheet', { recursive: true });
  const c = await launchClient(`http://localhost:5459/posedump.html?pmodel=${PM}&state=idle&gunArrow=1`, {});
  await c.page.waitForFunction('window.__ready === true', { timeout: 180000 });
  const cells: string[] = [];
  for (const state of STATES) {
    await c.page.evaluate(`window.__pm.forceAnimationState('${state}')`);
    for (let i = 0; i < PHASE_WAIT.length; i += 1) {
      await new Promise((r) => setTimeout(r, PHASE_WAIT[i]));
      const png = await c.page.screenshot();
      const b64 = `data:image/png;base64,${png.toString('base64')}`;
      await Bun.write(`_tools/e2e/shots/sheet/${PM}-${state}-${i}.png`, png);
      cells.push(b64);
    }
    console.log(state);
  }
  // composite: rows = states, cols = phases, labelled
  await c.page.setContent('<canvas id="c" style="display:block;background:#14161a"></canvas>');
  const out = await c.page.evaluate(async (cells64: string[], states: string[]) => {
    const cols = 3, cw = 320, ch = 240, lh = 22;
    const cv = document.getElementById('c') as HTMLCanvasElement;
    cv.width = cols * cw;
    cv.height = states.length * (ch + lh);
    const ctx = cv.getContext('2d')!;
    ctx.font = 'bold 16px monospace';
    for (let s = 0; s < states.length; s += 1) {
      ctx.fillStyle = '#8ad';
      ctx.fillText(states[s].toUpperCase(), 8, s * (ch + lh) + lh - 5);
      for (let i = 0; i < cols; i += 1) {
        const img = new Image();
        await new Promise<void>((res): void => {
          img.onload = (): void => res();
          img.src = cells64[s * cols + i];
        });
        ctx.drawImage(img, i * cw, s * (ch + lh) + lh, cw, ch);
      }
    }
    return cv.toDataURL('image/png');
  }, cells, STATES);
  await Bun.write(`_tools/e2e/shots/${PM}-sheet.png`, Buffer.from(out.split(',')[1], 'base64'));
  console.log(`wrote _tools/e2e/shots/${PM}-sheet.png`);
  await closeClient(c);
} finally { vite.kill(); }
