import type { WebGLRenderer } from 'three';
import { hudRegion } from '../ui/hud/regions.js';

// Live perf readout — per-phase frame ms (EMA-smoothed) + renderer.info
// (draw calls, tris, programs, geometries) + entity counts. Toggled with
// the stats.js panels (backquote); updates at 4Hz so the text itself is
// free. This is the "where is the frame going" answer before reaching for
// devtools.
export function createPerfHud() {
  const el = document.createElement('pre');
  el.id = 'perf-hud';
  el.style.cssText =
    // Topmost slot in the BR region stack — the debug row order map in
    // hud.css keeps it above the stats row, shot feed, census, and log.
    'display:none;' +
    // Height cap keeps the table from towering over the top-right rows
    // (hud-fps/timer) on short windows.
    'max-height:55vh;overflow:hidden;' +
    'color:#8f8;background:rgba(0,0,0,0.55);padding:4px 8px;font:11px/1.35 monospace;' +
    'margin:0;pointer-events:none;text-align:right;';
  hudRegion('br').append(el);

  const phases = new Map<string, number>(); // EMA ms
  const cur = new Map<string, number>();    // raw ms, current frame
  // Worst frame in the last ~5s keeps its OWN phase breakdown — the EMA
  // smooths a 25ms spike away long before anyone reaches Alt+Q.
  let worstMs = 0, worstAt = 0;
  let worstPhases = new Map<string, number>();
  let frameMs = 0, frameStart = 0, lastMark = 0, lastText = 0;

  /** `renderer.info.autoReset` makes each render pass wipe the counters —
   *  so the HUD/dump only ever saw the LAST pass (the composer quad).
   *  Take over the reset: manual at frame start, totals span all passes. */
  function begin(renderer?: WebGLRenderer): void {
    if (renderer) {
      renderer.info.autoReset = false;
      renderer.info.reset();
    }
    lastMark = performance.now();
    frameStart = lastMark;
  }

  /** Records ms since the previous mark under `name` — place marks at
   *  coarse boundaries (sim/fx/hud/render); no code wrapping needed. */
  function mark(name: string): void {
    const now = performance.now();
    const d = now - lastMark;
    lastMark = now;
    phases.set(name, (phases.get(name) ?? d) * 0.9 + d * 0.1);
    cur.set(name, d);
  }

  /** Called once per frame after render; refreshes the text at 4Hz. */
  function end(renderer: WebGLRenderer, counts: () => string): void {
    const rawMs = performance.now() - frameStart;
    frameMs = frameMs * 0.9 + rawMs * 0.1;
    const now = performance.now();
    if (rawMs > worstMs || now - worstAt > 5000) {
      worstMs = rawMs;
      worstAt = now;
      worstPhases = new Map(cur);
    }
    if (el.style.display === 'none' || now - lastText < 250) {return;}
    lastText = now;
    const i = renderer.info;
    const lines = [`frame ${frameMs.toFixed(1)}ms`];
    for (const [k, v] of phases) {lines.push(`${k} ${v.toFixed(1)}`);}
    lines.push(`calls ${i.render.calls} tris ${(i.render.triangles / 1000).toFixed(0)}k`);
    lines.push(`geo ${i.memory.geometries} tex ${i.memory.textures} prog ${i.programs?.length ?? 0}`);
    lines.push(counts());
    el.textContent = lines.join('\n');
  }

  function setVisible(v: boolean): void { el.style.display = v ? 'block' : 'none'; }
  function isVisible(): boolean { return el.style.display !== 'none'; }

  /** EMA ms per phase — watchdog dumps include this so a low-FPS log line
   *  says which subsystem was eating the frame. */
  function snapshot(): Record<string, number> {
    const o: Record<string, number> = {};
    for (const [k, v] of phases) {o[k] = Number(v.toFixed(2));}
    o.frame = Number(frameMs.toFixed(2));
    o['w:frame'] = Number(worstMs.toFixed(2));
    for (const [k, v] of worstPhases) {o[`w:${k}`] = Number(v.toFixed(2));}
    return o;
  }

  return { mark, begin, end, setVisible, isVisible, snapshot };
}

export type PerfHud = ReturnType<typeof createPerfHud>;
