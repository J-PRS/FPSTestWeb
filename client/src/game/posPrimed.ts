// posPrimed — shared flag for the per-frame position-jump watch in
// gameLoop. Extracted from gameLoop so world.ts can reset it on a local
// snap (terrain swap, teleport) without importing gameLoop — which was
// a real value cycle (gameLoop -> world for sessionVeil, world ->
// gameLoop for noteLocalSnap).
let _posPrimed = false;
export function noteLocalSnap(): void { _posPrimed = false; }
export function isPosPrimed(): boolean { return _posPrimed; }
export function setPosPrimed(v: boolean): void { _posPrimed = v; }
