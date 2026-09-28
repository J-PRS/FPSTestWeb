import type { WebGLRenderer } from 'three';

// Live perf readout — per-phase frame ms (EMA-smoothed) + renderer.info
// (draw calls, tris, programs, geometries) + entity counts. Toggled with
// the stats.js panels (backquote); updates at 4Hz so the text itself is
// free. This is the "where is the frame going" answer before reaching for
// devtools.
export function createPerfHud() {
  const el = document.createElement('pre');
  el.style.cssText =
    // Sits directly above the stats.js chart row (40px + 48px chart height).
    'position:fixed;bottom:94px;right:20px;z-index:10000;display:none;' +
    'color:#8f8;background:rgba(0,0,0,0.55);padding:4px 8px;font:11px/1.35 monospace;' +
    'margin:0;pointer-events:none;text-align:right;';
  document.body.appendChild(el);

  const phases = new Map<string, number>(); // EMA ms
  let frameMs = 0, frameStart = 0, lastMark = 0, lastText = 0;

  function begin(): void { frameStart = lastMark = performance.now(); }

  /** Records ms since the previous mark under `name` — place marks at
   *  coarse boundaries (sim/fx/hud/render); no code wrapping needed. */
  function mark(name: string): void {
    const now = performance.now();
    const d = now - lastMark;
    lastMark = now;
    phases.set(name, (phases.get(name) ?? d) * 0.9 + d * 0.1);
  }

  /** Called once per frame after render; refreshes the text at 4Hz. */
  function end(renderer: WebGLRenderer, counts: () => string): void {
    frameMs = frameMs * 0.9 + (performance.now() - frameStart) * 0.1;
    const now = performance.now();
    if (el.style.display === 'none' || now - lastText < 250) return;
    lastText = now;
    const i = renderer.info;
    const lines = [`frame ${frameMs.toFixed(1)}ms`];
    for (const [k, v] of phases) lines.push(`${k} ${v.toFixed(1)}`);
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
    for (const [k, v] of phases) o[k] = +v.toFixed(2);
    o.frame = +frameMs.toFixed(2);
    return o;
  }

  return { mark, begin, end, setVisible, isVisible, snapshot };
}

export type PerfHud = ReturnType<typeof createPerfHud>;
