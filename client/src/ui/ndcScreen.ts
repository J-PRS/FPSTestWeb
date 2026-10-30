// NDC → client-pixel mapping for all projected HUD elements.
//
// The GL canvas is intentionally oversized to a canonical 16:9 and
// center-cropped (renderer.ts overscan). Projecting through
// window.innerWidth/innerHeight therefore misplaces every marker by the
// cropped margin — the error grows with aspect divergence, which is why
// head markers drifted at wide/narrow windows and edge angles. The
// correct frame is the canvas's own client rect.
let gl: HTMLElement | null = null;
let rectT = 0;
let rect: { left: number; top: number; width: number; height: number } | null = null;

export function ndcToClient(x: number, y: number, out: { x: number; y: number }): void {
  if (!gl) {gl = document.getElementById('gl');}
  // getBoundingClientRect forces layout — ~2.6% of a throttled frame
  // when every HUD marker reads it. The rect only moves on window
  // resize/overscan changes, so a 250ms TTL is plenty fresh.
  const now = performance.now();
  if (!rect || now - rectT > 250) {
    rectT = now;
    rect = gl ? gl.getBoundingClientRect()
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  }
  out.x = rect.left + (x * 0.5 + 0.5) * rect.width;
  out.y = rect.top + (0.5 - y * 0.5) * rect.height;
}
