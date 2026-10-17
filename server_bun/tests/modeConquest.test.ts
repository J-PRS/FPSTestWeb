import { describe, expect, it } from 'bun:test';

import { mkRoom, step, freeze, watch } from './scenarios/harness.ts';
import type { RoomConquest } from '../src/modeConquest.ts';
import { CONQUEST } from '../../shared/conquest.ts';
import type { Room } from '../src/Room.ts';
import type { TeamId } from '../../shared/teams.ts';

const mkConq = (span = 300, bots = 4): { room: Room; conq: RoomConquest } => {
  const room = mkRoom({ tileSize: span, bots }, 'conquest');
  const conq = room.modeModule as RoomConquest | null;
  if (!conq) {throw new Error('modeModules registry did not mint conquest');}
  return { room, conq };
};

const botsOf = (room: Room) => [...room.players.getAllPlayers().values()].filter((p) => p.isBot);
const at = (conq: RoomConquest, gx: number, gz: number) =>
  conq.nodes.find((n) => n.gx === gx && n.gz === gz)!;
const seat = (room: Room, idx: number, team: TeamId, pos: { x: number; y: number; z: number }): void => {
  // Every OTHER bot parks its brain first — live brains path to frontier
  // nodes on their own (that's the mode working) and crash staged shots.
  for (const p of botsOf(room)) { room.bots.quiet.add(p.id); }
  const p = botsOf(room)[idx]!;
  p.team = team;
  freeze(room, p.id, pos);
};

describe('conquest lattice', () => {
  it('lays out an NxN grid with owned corner cores', () => {
    const { conq } = mkConq(300);
    // span 300 → n=3 → 9 nodes, two cores at opposite corners.
    expect(conq.nodes.length).toBe(9);
    expect(at(conq, 0, 0).owner).toBe('alpha');
    expect(at(conq, 0, 0).core).toBe(true);
    expect(at(conq, 2, 2).owner).toBe('bravo');
    expect(at(conq, 2, 2).core).toBe(true);
    expect(conq.nodes.filter((n) => n.owner === 'neutral').length).toBe(7);
  });

  it('seats each team at its own core spawn ring', () => {
    const { room, conq } = mkConq();
    const cores = conq.nodes.filter((n) => n.core);
    for (const p of botsOf(room)) {
      const core = cores.find((n) => n.owner === p.team)!;
      const d = Math.hypot(p.position.x - core.pos.x, p.position.z - core.pos.z);
      expect(d).toBeLessThan(CONQUEST.NODE_SPAWN_R + 10);
    }
  });

  it('linked touch starts a build that captures on its own', () => {
    const { room, conq } = mkConq();
    const node = at(conq, 1, 0); // 4-adjacent to the alpha core
    seat(room, 0, 'alpha', node.pos);
    step(room, 2);
    expect(node.buildBy).toBe('alpha');
    step(room, 210); // > BUILD_S at 20Hz
    expect(node.owner).toBe('alpha');
    expect(room.scores.alpha).toBe(2); // core + node
    // The capture minted a spawn ring — node-linked respawns are live.
    expect(room.players.teamSpawns?.alpha?.length).toBe(2);
  });

  it('unlinked nodes refuse the touch — you cannot skip the chain', () => {
    const { room, conq } = mkConq();
    const far = at(conq, 0, 2); // neighbors (1,0)? no — (0,1)/(1,2): unlinked to both cores
    seat(room, 0, 'alpha', far.pos);
    step(room, 220);
    expect(far.owner).toBe('neutral');
    expect(far.buildBy).toBeNull();
  });

  it('linked enemy presence razes an owned node to neutral', () => {
    const { room, conq } = mkConq();
    // Stage: bravo chain reaches (1,0) via (1,1); alpha owns (1,0).
    at(conq, 1, 1).owner = 'bravo';
    at(conq, 1, 0).owner = 'alpha';
    seat(room, 0, 'bravo', at(conq, 1, 0).pos);
    step(room, 210); // > RAZE_S
    // Fresh queries in the asserts — a held ref narrows .owner under
    // control flow and the literal toBe types turn red.
    expect(at(conq, 1, 0).owner).toBe('neutral');
    expect(room.scores.alpha).toBe(1); // just the core again
  });

  it('contested nodes freeze — defenders hold the raze clock', () => {
    const { room, conq } = mkConq();
    at(conq, 1, 1).owner = 'bravo';
    at(conq, 1, 0).owner = 'alpha';
    seat(room, 0, 'bravo', at(conq, 1, 0).pos);
    seat(room, 1, 'alpha', at(conq, 1, 0).pos);
    step(room, 220);
    expect(at(conq, 1, 0).owner).toBe('alpha'); // defended — no raze
  });

  it('blast damage razes a linked enemy node; unlinked nodes are immune', () => {
    const { room, conq } = mkConq();
    at(conq, 1, 1).owner = 'bravo';
    at(conq, 1, 0).owner = 'alpha';
    const bravo = botsOf(room)[0]!;
    bravo.team = 'bravo';
    // One big blast — radius must cover the node from its own center.
    room.events.emit({ type: 'blast', pos: at(conq, 1, 0).pos, damage: 4000, radius: 20, shooterId: bravo.id });
    expect(at(conq, 1, 0).owner).toBe('neutral');
    // Unlinked alpha node is blast-immune to bravo.
    const safe = at(conq, 0, 2);
    room.events.emit({ type: 'blast', pos: safe.pos, damage: 4000, radius: 20, shooterId: bravo.id });
    expect(safe.owner).toBe('neutral');
    expect(safe.hp).toBe(CONQUEST.NODE_HP); // untouched
  });

  it('a dead core ends the match for the attacker', () => {
    const { room, conq } = mkConq();
    const core = at(conq, 0, 0);
    at(conq, 1, 0).owner = 'bravo'; // bravo chain reaches the alpha core
    const bravo = botsOf(room)[0]!;
    bravo.team = 'bravo';
    const end = { winner: null as string | null };
    const prev = room.endMatch.bind(room);
    room.endMatch = (w: string): void => { end.winner = w; prev(w); };
    room.events.emit({ type: 'blast', pos: core.pos, damage: 9000, radius: 20, shooterId: bravo.id });
    expect(end.winner).toBe('bravo');
  });

  it('bot objective picks a frontier node, not a random spot', () => {
    const { room, conq } = mkConq();
    const bot = botsOf(room)[0]!;
    bot.team = 'alpha';
    const goal = conq.objectiveFor(bot)!;
    // Alpha's only actionable nodes at boot are (1,0) and (0,1).
    const frontier = [at(conq, 1, 0), at(conq, 0, 1)].map((n) => [n.pos.x, n.pos.z]);
    expect(frontier).toContainEqual([goal.pos.x, goal.pos.z]);
  });

  it('wire roster ships every node once — join replay is one message', () => {
    const { room, conq } = mkConq();
    const w = watch(room);
    step(room, 1);
    const updates = w.msgs.filter((m) => m.type === 'nodeUpdate');
    expect(updates.length).toBe(1);
    expect((updates[0] as { nodes: unknown[] }).nodes.length).toBe(conq.nodes.length);
  });
});
