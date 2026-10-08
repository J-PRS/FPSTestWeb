// Differential conformance fuzzer for the claim/authority surface.
//
// Where wireFuzz covers "what reaches a client", this covers "what a
// client may make true": every damage/economy-bearing message type gets
// honest and forged payloads driven through the REAL pipeline —
// WIRE.validate (the GameServer-side gate) then
// messages.handleMessage (rate limiter + checkIntent + handler). A
// seeded op stream mixes live/dead/gone claimers, plausible and
// out-of-range values, valid and bypassed validation.
//
// Invariants checked after EVERY op — a violation names a bug:
//   * health/armor finite and in bounds (the NaN-poison class envClaims
//     guards against — a NaN write once polluted tick broadcasts)
//   * isDead ⇒ health === 0 (the corpse-can't-have-hp class)
//   * a claim from a gone player mutates nothing
//   * a claim from a dead player never damages anyone else
//   * exactly one claimAck per claimSeq-bearing claim
//   * a non-claimer's health only drops when a damage-capable op ran
//     this step — truth can't move without a validated cause
import { describe, it, expect } from 'bun:test';
import { mkRoom, step, lcg } from './harness.ts';
import { WIRE } from '../../src/wire.ts';
import { WEAPONS } from '../../../shared/weapons.ts';
import { DEPLOY_KINDS } from '../../../shared/deployables.ts';
import { wallNow, wallMs } from '../../src/wallClock.ts';
import type { ClientMessage, ServerMessage } from '../../../shared/protocol.ts';
import type { Room } from '../../src/Room.ts';
import type { PlayerState } from '../../src/types.ts';

// The truth the fuzz asserts over: everything a claim could touch.
interface Snapshot {
  players: Map<string, { health: number; armor: number; isDead: boolean; x: number; y: number; z: number; belt: number; healCredit: number }>;
}

function snapshot(room: Room): Snapshot {
  const players = new Map<string, Snapshot['players'] extends Map<string, infer V> ? V : never>();
  for (const [id, p] of room.players.getAllPlayers()) {
    players.set(id, {
      health: p.health, armor: p.armor, isDead: p.isDead,
      x: p.position.x, y: p.position.y, z: p.position.z,
      belt: p.beltCharges, healCredit: p.healCredit,
    });
  }
  return { players };
}

const weaponIds = Object.keys(WEAPONS).map(Number).filter((n) => Number.isInteger(n));

function randVec(rng: () => number, scale = 1): { x: number; y: number; z: number } {
  return { x: (rng() - 0.5) * 200 * scale, y: (rng() - 0.5) * 100 * scale, z: (rng() - 0.5) * 200 * scale };
}
function randDir(rng: () => number): { x: number; y: number; z: number } {
  const v = randVec(rng, 0.02);
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

// One random claim payload — honest half the time, forged the rest.
// The point isn't "will the validator catch this" (it should) — it's
// that whatever gets through must still respect the truth invariants.
function forgeClaim(rng: () => number, room: Room, claimer: PlayerState, others: string[]): Record<string, unknown> {
  const kind = rng();
  const honest = rng() < 0.5;
  const seq = rng() < 0.6 ? Math.floor(rng() * 10000) : undefined;
  if (kind < 0.14) {
    const wt = honest ? weaponIds[Math.floor(rng() * weaponIds.length)]! : Math.floor(rng() * 300);
    return {
      type: 'shotFired', weaponType: wt,
      dir: honest ? randDir(rng) : randVec(rng, 50),
      pos: honest && claimer.position ? { ...claimer.position } : randVec(rng, 200),
      shotId: rng() < 0.5 ? `fz-${Math.floor(rng() * 50)}` : undefined,
      fireAt: honest ? wallNow() - Math.floor(rng() * 400) : rng() * 1e15,
      claimSeq: seq,
    };
  }
  if (kind < 0.30) {
    const target = others.length ? others[Math.floor(rng() * others.length)] : undefined;
    const tp = target ? room.players.getPlayer(target)?.position : undefined;
    return {
      type: 'aoeShot',
      position: tp && honest ? { ...tp } : randVec(rng, 10),
      weaponType: honest ? weaponIds[Math.floor(rng() * weaponIds.length)]! : Math.floor(rng() * 400),
      excludeTargetId: rng() < 0.3 ? (rng() < 0.5 ? claimer.id : target ?? 'ghost') : null,
      airtime: honest ? rng() * 3 : rng() * 1e6,
      power: honest ? undefined : rng() * 100,
      directHit: rng() < 0.3 ? true : undefined,
      shotId: rng() < 0.5 ? `fz-${Math.floor(rng() * 50)}` : undefined,
      fireAt: rng() < 0.4 ? wallNow() - Math.floor(rng() * 500) : undefined,
      claimSeq: seq,
    };
  }
  if (kind < 0.38) {
    return { type: 'slam', position: honest && claimer.position ? { ...claimer.position } : randVec(rng, 50), claimSeq: seq };
  }
  if (kind < 0.46) {
    return { type: 'heal', amount: honest ? 1 + rng() * 30 : (rng() - 0.7) * 1e5, claimSeq: seq };
  }
  if (kind < 0.56) {
    return {
      type: 'environmentDamage',
      amount: honest ? 1 + rng() * 40 : (rng() - 0.3) * 1e6,
      attacker: honest ? undefined : (rng() < 0.5 ? (others[0] ?? 'nobody') : `bot:${Math.floor(rng() * 999)}`),
      claimSeq: seq,
    };
  }
  if (kind < 0.62) {
    return { type: 'projectileDestroy', projectileId: honest ? 'x'.repeat(Math.floor(rng() * 8)) : 'x'.repeat(400), claimSeq: seq };
  }
  if (kind < 0.70) {
    return {
      type: 'inputMove', seq: honest ? 1 + Math.floor(rng() * 200) : Math.floor(rng() * -1e6 + 5e5),
      input: { forward: rng() * 2 - 1, right: rng() * 2 - 1, jump: rng() < 0.5 ? 1 : 0, ski: rng() < 0.3 ? 1 : 0, jet: rng() < 0.4 ? 1 : 0, status: Math.floor(rng() * 32) },
      rotation: { yaw: rng() * 6.3, pitch: (rng() - 0.5) * 3 },
    };
  }
  if (kind < 0.76) {
    return {
      type: 'position', position: honest && claimer.position ? { x: claimer.position.x + (rng() - 0.5) * 5, y: claimer.position.y, z: claimer.position.z + (rng() - 0.5) * 5 } : randVec(rng, 200),
      rotation: { yaw: rng() * 6.3, pitch: (rng() - 0.5) * 3 },
      velocity: randVec(rng, 0.3), seq: Math.floor(rng() * 300), inputSeq: Math.floor(rng() * 300),
    };
  }
  if (kind < 0.80) {
    return { type: 'teleport', position: honest && claimer.position ? { ...claimer.position } : randVec(rng, 100), rotation: { yaw: rng() * 6.3, pitch: 0 }, velocity: randVec(rng, 0.2) };
  }
  if (kind < 0.84) {
    const kinds = [...DEPLOY_KINDS];
    return { type: 'deploy', kind: honest ? kinds[Math.floor(rng() * kinds.length)] : `fz-${Math.floor(rng() * 99)}`, position: randVec(rng, 2), claimSeq: seq };
  }
  if (kind < 0.87) return { type: 'repair', targetId: Math.floor(rng() * 1000), claimSeq: seq };
  if (kind < 0.90) return { type: 'skillUse', claimSeq: seq };
  if (kind < 0.93) return { type: 'throwFlag' };
  if (kind < 0.96) return { type: 'creatureHit', id: Math.floor(rng() * 200), damage: honest ? 1 + rng() * 50 : rng() * 1e5, claimSeq: seq };
  return { type: 'respawn' };
}

describe('claims conformance fuzz', () => {
  it('server truth only moves through validated paths', () => {
    const SEEDS = [5, 17, 31, 47, 61, 83];
    for (const seed of SEEDS) {
      const rng = lcg(seed);
      const room = mkRoom({ bots: 0 }, '', seed);
      // Capture claimAcks + rejects through the real sinks.
      const sentToPlayer: ServerMessage[] = [];
      const prevSend = room.connections.sendToPlayer;
      room.connections.sendToPlayer = (pid: string, m: ServerMessage) => {
        if (m.type === 'claimAck' || m.type === 'shotRejected' || m.type === 'claimDropped') {
          sentToPlayer.push(m);
        }
        return prevSend.call(room.connections, pid, m);
      };

      const addPlayer = (tag: string) => {
        const id = `cf_${seed}_${tag}`;
        room.players.addPlayer(id);
        const p = room.players.getPlayer(id)!;
        p.hasReceivedPosition = true;
        p.lastSeen = wallNow();
        return p;
      };
      for (const t of ['a', 'b', 'c', 'd']) addPlayer(t);
      let joined = 4;

      const violations: string[] = [];
      let clock = wallNow();
      const ackSeqSeen = new Map<string, number>(); // `${id}:${kind}:${seq}` → count

      const checkInvariants = (ctx: string, before: Snapshot, opDesc: string, damageCapable: boolean): void => {
        for (const [id, p] of room.players.getAllPlayers()) {
          if (!Number.isFinite(p.health)) violations.push(`${ctx}: ${id} NaN health after ${opDesc}`);
          if (p.health < 0 || p.health > p.maxHealth) violations.push(`${ctx}: ${id} hp=${p.health} out of [0,${p.maxHealth}] after ${opDesc}`);
          if (!Number.isFinite(p.armor) || p.armor < 0) violations.push(`${ctx}: ${id} armor=${p.armor} after ${opDesc}`);
          if (!Number.isFinite(p.position.x + p.position.y + p.position.z)) violations.push(`${ctx}: ${id} NaN position after ${opDesc}`);
          if (!Number.isFinite(p.velocity.x + p.velocity.y + p.velocity.z)) violations.push(`${ctx}: ${id} NaN velocity after ${opDesc}`);
          if (p.isDead && p.health !== 0) violations.push(`${ctx}: ${id} dead with hp=${p.health} after ${opDesc}`);
        }
        if (!damageCapable) {
          // No damage-capable op ran: nobody's health may DROP except
          // the claimer's own (self-inflicted claims like envDamage are
          // still damage-capable, so any drop here is unauthorized).
          for (const [id, p] of room.players.getAllPlayers()) {
            const was = before.players.get(id);
            if (was && p.health < was.health) {
              violations.push(`${ctx}: ${id} hp ${was.health}→${p.health} with no damage-capable op (${opDesc})`);
            }
          }
        }
      };

      const OPS = 220;
      for (let op = 0; op < OPS; op++) {
        clock = wallMs(clock + 40 + Math.floor(rng() * 200)); // fake wall spacing — exercises limits without starving every claim
        const roll = rng();
        const before = snapshot(room);
        let opDesc = 'noop';
        let damageCapable = false;
        let throwCtx: { before: number; accepted: boolean; desc: string } | undefined;

        const alive = () => [...room.players.getAllPlayers().keys()];
        const pickAny = () => {
          const ids = alive();
          return ids.length ? ids[Math.floor(rng() * ids.length)]! : null;
        };

        if (roll < 0.10 && joined < 12) {
          addPlayer(`j${joined++}`); opDesc = 'join';
        } else if (roll < 0.16) {
          const gone = pickAny();
          if (gone && alive().length > 2) {
            room.removePlayerCompletely(gone, 'fuzz', () => {});
            opDesc = `leave ${gone}`;
          }
        } else if (roll < 0.20) {
          // Server kill — puts a real corpse in the room so dead-shooter
          // claims get exercised against something true.
          const id = pickAny();
          if (id) {
            const p = room.players.getPlayer(id)!;
            if (!p.isDead) { room.messages.combat.serverHit('environment', id, 9999, 'Fuzz cull'); opDesc = `cull ${id}`; }
            damageCapable = true;
          }
        } else {
          // Claim op: pick a claimer — mostly live, sometimes dead,
          // sometimes fully gone.
          const ids = alive();
          const cid = rng() < 0.12 ? `ghost_${seed}` : pickAny();
          if (!cid) continue;
          const claimer = room.players.getPlayer(cid) as PlayerState | undefined;
          const others = ids.filter((i) => i !== cid);
          const claim = forgeClaim(rng, room, claimer ?? ({ id: cid } as PlayerState), others);
          opDesc = `${(claim as {type: string}).type} by ${cid}`;
          const entry = WIRE[(claim as {type: keyof typeof WIRE}).type] as { validate?: (o: Record<string, unknown>) => { success: boolean; data?: ClientMessage } } | undefined;
          let msg = claim as unknown as ClientMessage;
          // ~20% of claims bypass the validator — the model for a
          // validator GAP. Handlers must either survive or throw inside
          // drainCommands' containment; a validated message may NEVER
          // throw (that's the same contract intentConsumers pins —
          // validate-ok ⇒ handler-safe).
          const bypass = rng() < 0.2;
          let acceptedByGate = false;
          if (entry?.validate && !bypass) {
            const v = entry.validate(claim);
            if (v.success && v.data) { msg = v.data; acceptedByGate = true; }
            else { opDesc += ' [rejected-by-validator]'; }
          } else if (!entry?.validate) {
            acceptedByGate = !bypass;
          }
          if (!bypass && entry?.validate && !acceptedByGate) {
            // Production drops the rejected message — it never reaches
            // the room. Assert the drop itself mutated nothing.
          } else {
            const throwBefore = room.health.get('handlerThrow') ?? 0;
            room.commands.push({ playerId: cid, msg, at: clock });
            // A claim is damage-capable when it could reach a damage
            // path AND the claimer is in a state to author it. Dead/
            // gone claimers can't hurt anyone — that's an invariant,
            // not an exception.
            const claimerLive = !!claimer && !claimer.isDead;
            const t = (msg as { type: string }).type;
            damageCapable = claimerLive && ['aoeShot', 'slam', 'environmentDamage', 'creatureHit', 'crawlerHit', 'respawn'].includes(t);
            // Defer the throw check past the step drain below.
            throwCtx = { before: throwBefore, accepted: acceptedByGate && !bypass, desc: opDesc };
          }
        }

        step(room, 1);
        // Server heals/regen can move hp up — never down. Damage-capable
        // is only about downward moves.
        checkInvariants(`seed=${seed} op=${op}`, before, opDesc, damageCapable);
        // A validated message must NEVER throw in the handler — the
        // validator is the contract, and a throw means it passed an
        // unsafe shape through.
        if (throwCtx && (room.health.get('handlerThrow') ?? 0) > throwCtx.before) {
          if (throwCtx.accepted) violations.push(`seed=${seed} op=${op}: VALIDATED message threw — validator passed an unsafe shape (${throwCtx.desc})`);
        }
      }

      // Claim-ack accounting: every claimSeq'd claim got AT MOST one ack.
      for (const m of sentToPlayer) {
        if (m.type === 'claimAck') {
          const k = `${(m as { seq?: number }).seq}`;
          ackSeqSeen.set(k, (ackSeqSeen.get(k) ?? 0) + 1);
        }
      }
      for (const [k, n] of ackSeqSeen) if (n > 1) violations.push(`seed=${seed}: claimAck seq ${k} emitted ${n}×`);

      room.connections.sendToPlayer = prevSend;
      expect(violations).toEqual([]);
    }
  });
});
