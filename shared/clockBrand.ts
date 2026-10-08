/**
 * clockBrand — sim-time vs wall-time brands, shared across server and
 * client: PlayerState lives on both sides (P2P host runs server code on
 * the client), so the brands must too. A SimMs can't pass where a WallMs
 * is expected without an explicit cast — a sim/wall mix fails at tsc
 * instead of desyncing a fast-forwarded soak.
 */
declare const simBrand: unique symbol;
export type SimMs = number & { [simBrand]: 'sim' };
export const simMs = (n: number): SimMs => n as SimMs;

declare const wallBrand: unique symbol;
export type WallMs = number & { [wallBrand]: 'wall' };
export const wallMs = (n: number): WallMs => n as WallMs;
