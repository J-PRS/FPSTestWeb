// The height in px of the buffer the scene actually rasterizes into —
// innerHeight/pscale in chunky modes, innerHeight*resScale on the plain
// path. FX shaders that convert world size → gl_PointSize must scale by
// THIS height, not window.innerHeight: the buffer is upscaled after
// rasterization, so a CSS-height-fed point renders pscale× too big.
// Renderer writes it on every buffer-size pass; effects read it lazily.

let bufferHeight = 800; // sane boot default until the first resize lands

export function setFxBufferHeight(h: number): void {
  bufferHeight = h;
}

export function fxBufferHeight(): number {
  return bufferHeight;
}
