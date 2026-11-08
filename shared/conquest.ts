// Conquest — UT-Onslaught-style power lattice, procedurally generated.
// The map span is split into an NxN grid of cells; each cell center
// carries a node. Opposite corner cells hold the team cores. Nodes start
// neutral; a team may act only on nodes 4-adjacent to its own territory —
// capture (touch → build), or attack (presence-raze / blast damage →
// neutral). Reaching the enemy core's neighborhood makes it attackable;
// destroying it ends the match.
//
// Everything here is pure math + constants so the server sim, the client
// link renderer and the tests all read one source of truth.

import type { TeamId } from './teams.ts';

export const CONQUEST = {
  /** Seconds from first touch to captured — the "building" window. */
  BUILD_S: 10,
  /** Seconds of uncontested enemy presence to un-build an owned node. */
  RAZE_S: 10,
  /** Same, on a core — the win condition sits longer because it's the game. */
  CORE_RAZE_S: 20,
  /** Touch ring — generous enough for a ski graze. */
  TOUCH_R: 8,
  /** Blast durability of a built node (0 → neutral). A node under
   *  construction has hp ∝ build progress, so it's fragile on purpose. */
  NODE_HP: 500,
  CORE_HP: 2000,
  /** Respawn sphere minted at each owned node — frontier-forward spawns. */
  NODE_SPAWN_R: 12,
  /** Coordinator: seconds a bot keeps its node assignment before a
   *  re-assess — UT's ReAssessStrategy cadence in miniature. */
  ASSIGN_TTL_S: 18,
  /** Occupancy cap per node — the ObjectiveCovered rule: a fully
   *  staffed target doesn't need another body. */
  NODE_STAFF_MAX: 3,
} as const;

/** Who can hold a node — 'neutral' is the empty state, never a team. */
export type NodeOwner = TeamId | 'neutral';

export interface NodeCell { gx: number; gz: number; }

/** One lattice site — sim record and wire row share these fields. */
export interface ConquestNode extends NodeCell {
  id: number;
  pos: { x: number; y: number; z: number };
  owner: NodeOwner;
  hp: number;
  /** Build progress 0..BUILD_S while under construction (owner neutral). */
  buildT: number;
  /** The team building it — a building node still belongs to nobody. */
  buildBy: TeamId | null;
  /** Uncontested-enemy-presence timer — drains an owned node toward neutral. */
  razeT: number;
  core: boolean;
}

/** Grid dimension for a map span: ~200-350m cells keeps nodes a ski hop
 *  apart — small arenas stay tense, big terrain stays navigable. */
export function conquestN(span: number): number {
  return span >= 1200 ? 5 : span >= 550 ? 4 : 3;
}

/** Cell centers across a span-wide square centered on the origin. */
export function conquestCells(span: number, n: number): (NodeCell & { x: number; z: number })[] {
  const cells: (NodeCell & { x: number; z: number })[] = [];
  const cell = span / n;
  for (let gz = 0; gz < n; gz += 1) {
    for (let gx = 0; gx < n; gx += 1) {
      cells.push({ gx, gz, x: -span / 2 + (gx + 0.5) * cell, z: -span / 2 + (gz + 0.5) * cell });
    }
  }
  return cells;
}

/** 4-adjacent in-bounds neighbors — the link graph. Diagonals are NOT
 *  links: porous corners would dissolve the frontier into guerrilla pokes. */
export function conquestN4(gx: number, gz: number, n: number): NodeCell[] {
  const out: NodeCell[] = [];
  if (gx > 0) {out.push({ gx: gx - 1, gz });}
  if (gx < n - 1) {out.push({ gx: gx + 1, gz });}
  if (gz > 0) {out.push({ gx, gz: gz - 1 });}
  if (gz < n - 1) {out.push({ gx, gz: gz + 1 });}
  return out;
}

/** The rule the whole mode hinges on: a team may only act on nodes that
 *  touch its territory (an owned node or its core sits 4-adjacent).
 *  Cores count as owned territory of their team — they never go neutral. */
export function conquestActionable(nodes: Pick<ConquestNode, 'gx' | 'gz' | 'owner'>[], node: NodeCell, team: TeamId, n: number): boolean {
  for (const nb of conquestN4(node.gx, node.gz, n)) {
    const other = nodes.find((o): boolean => o.gx === nb.gx && o.gz === nb.gz);
    if (other?.owner === team) {return true;}
  }
  return false;
}

/** Corner cores: alpha at (0,0), bravo at the opposite corner. */
export function conquestCores(n: number): { alpha: NodeCell; bravo: NodeCell } {
  return { alpha: { gx: 0, gz: 0 }, bravo: { gx: n - 1, gz: n - 1 } };
}
