import { describe, it, expect } from 'bun:test';
import { mkRoom, watch } from './harness.ts';
import { CTF_PTS, CTF_DMG_PER_PTS } from '../../../shared/teams.ts';

// CTF personal score (the PTS column): kills pay 1, doubled in a flag
// zone, caps pay 10, returns 3 — and none of it ends the match.
describe('scenario: ctf personal score', () => {
  const setup = () => {
    const room = mkRoom({
      mode: 'ctf', bots: 2,
      bases: { alpha: { x: -70, y: 60, z: 0 }, bravo: { x: 70, y: 60, z: 0 } },
    }, 'ctf');
    const alpha = [...room.players.getAllPlayers().values()].find((p) => p.team === 'alpha')!;
    const bravo = [...room.players.getAllPlayers().values()].find((p) => p.team === 'bravo')!;
    return { room, alpha, bravo };
  };

  it('a frag pays 1; a frag near either stand pays 2', () => {
    const { room, alpha, bravo } = setup();
    bravo.position = { x: 0, y: 60, z: 0 }; // midfield — 70m from both stands
    room.scoring.onKill(bravo.id, alpha.id);
    expect(room.ffaScores.get(alpha.id)).toBe(CTF_PTS.kill);

    bravo.position = { ...room.flags!.flags.get('alpha')!.home }; // on alpha's stand
    room.scoring.onKill(bravo.id, alpha.id);
    expect(room.ffaScores.get(alpha.id)).toBe(CTF_PTS.kill + CTF_PTS.flagZoneKill);

    bravo.position = { ...room.flags!.flags.get('bravo')!.home }; // on bravo's stand — same bonus
    room.scoring.onKill(bravo.id, alpha.id);
    expect(room.ffaScores.get(alpha.id)).toBe(CTF_PTS.kill + CTF_PTS.flagZoneKill * 2);
  });

  it('a capture pays the carrier 10 on top of the team point', () => {
    const { room, alpha } = setup();
    const bravoFlag = room.flags!.flags.get('bravo')!;
    alpha.position = { ...bravoFlag.pos };
    room.tickFlags(0.05); // grab
    expect(bravoFlag.carrier).toBe(alpha.id);
    alpha.position = { ...room.flags!.flags.get('alpha')!.home };
    room.tickFlags(0.05); // cap
    expect(room.scores.alpha).toBe(1);
    expect(room.ffaScores.get(alpha.id)).toBe(CTF_PTS.cap);
  });

  it('touching your own dropped flag home pays the returner 3', () => {
    const { room, alpha, bravo } = setup();
    const bravoFlag = room.flags!.flags.get('bravo')!;
    alpha.position = { ...bravoFlag.pos };
    room.tickFlags(0.05); // alpha grabs bravo's flag
    room.flagCarrierDied(alpha.id); // drops on the spot
    expect(bravoFlag.state).toBe('dropped');
    // Staged teleports sweep a touch capsule from the OLD pos — alpha
    // stepping off the flag would re-grab it through its own sweep.
    // Park the dropped flag on neutral midfield instead.
    bravoFlag.pos = { x: 0, y: 60, z: 0 };
    bravo.position = { ...bravoFlag.pos };
    room.tickFlags(0.05); // bravo touches it home
    expect(bravoFlag.state).toBe('home');
    expect(room.ffaScores.get(bravo.id)).toBe(CTF_PTS.flagReturn);
  });

  it('every 100 enemy damage pays 1, remainder pools across hits', () => {
    const { room, alpha, bravo } = setup();
    room.scoring.onDamage(alpha.id, bravo.id, 40);   // chip, nothing yet
    expect(room.ffaScores.get(alpha.id)).toBeUndefined();
    room.scoring.onDamage(alpha.id, bravo.id, 60);   // pools over the line
    expect(room.ffaScores.get(alpha.id)).toBe(CTF_PTS.dmg);
    room.scoring.onDamage(alpha.id, bravo.id, CTF_DMG_PER_PTS * 2.5);
    expect(room.ffaScores.get(alpha.id)).toBe(CTF_PTS.dmg * 3);
    // Self, same-team, and missing players never bank.
    room.scoring.onDamage(alpha.id, alpha.id, 1000);
    room.scoring.onDamage('environment', bravo.id, 1000);
    expect(room.ffaScores.get(alpha.id)).toBe(CTF_PTS.dmg * 3);
    expect(room.ffaScores.get('environment')).toBeUndefined();
  });

  it('damage pays nothing outside flag modes', () => {
    const room = mkRoom({ mode: 'tdm', bots: 2 }, 'tdm');
    const [a, b] = [...room.players.getAllPlayers().values()];
    room.scoring.onDamage(a!.id, b!.id, 500);
    expect(room.ffaScores.get(a!.id)).toBeUndefined();
  });

  it('personal points never end a team match', () => {
    const { room, alpha, bravo } = setup();
    const w = watch(room);
    // winAt is 5 caps — a player at 100+ personal pts still hasn't won.
    for (let i = 0; i < 120; i++) {
      bravo.position = { x: 0, y: 60, z: 0 };
      room.scoring.onKill(bravo.id, alpha.id);
    }
    expect(room.ffaScores.get(alpha.id)).toBe(120);
    expect(w.count('matchEnd')).toBe(0);
    expect(w.count('ffaScore')).toBeGreaterThan(0); // the PTS column echoes
  });
});
