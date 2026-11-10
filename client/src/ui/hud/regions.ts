// Body-level HUD regions - lazy so pieces created before the HUD DOM
// exists (chat, VGS, frag messages, debug panels) can still dock. The
// in-#hud regions are declared in dom.ts markup; these live on <body>
// because their tenants outlive the gameplay HUD element. The region
// owns anchor + flow: children never carry top/bottom/left/right, so
// two pieces can't land on the same pixels.
export type HudRegionId = 'uc' | 'bl' | 'br' | 'tc';

export function hudRegion(id: HudRegionId): HTMLElement {
  const domId = `hud-reg-${id}`;
  let el = document.getElementById(domId);
  if (!el) {
    el = document.createElement('div');
    el.id = domId;
    document.body.append(el);
  }
  return el;
}
