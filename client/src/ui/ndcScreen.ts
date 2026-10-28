// NDC → client-pixel mapping for all projected HUD elements.
//
// The GL canvas is intentionally oversized to a canonical 16:9 and
// center-cropped (renderer.ts overscan). Projecting through
// window.innerWidth/innerHeight therefore misplaces every marker by the
// cropped margin — the error grows with aspect divergence, which is why
// head markers drifted at wide/narrow windows and edge angles. The
// correct frame is the canvas's own client rect.
let gl: HTMLElement | null = null;

export function ndcToClient(x: number, y: number, out: { x: number; y: number }): void {
  if (!gl) {gl = document.getElementById('gl');}
  const r = gl ? gl.getBoundingClientRect()
    : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  out.x = r.left + (x * 0.5 + 0.5) * r.width;
  out.y = r.top + (0.5 - y * 0.5) * r.height;
}
