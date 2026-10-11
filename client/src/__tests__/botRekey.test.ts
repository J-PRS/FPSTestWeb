import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { BotFire, type FireHost } from '../game/bots/botFire.js';
import { BotWatchdog } from '../game/bots/botWatchdog.js';
import { BotSenses, type SenseHost } from '../game/bots/botSenses.js';
import { CtfFlags, type FlagCtx } from '../game/ctfFlags.js';
import { FlagRunBridge, type FlagRunDeps, type FlagRunWiring } from '../game/flagRun.js';
import { RoomNoticer } from '../../../shared/roomNoticer.js';
import { makeScores } from '../../../shared/teams.js';

// Bots.rekeyBot fans a jersey swap out to every id-keyed meter — these
// pins lock each hop so a map added without a rekey fails loudly instead
// of leaking a dead-id receipt (the §2.88 bug class).
interface Peek { [k: string]: Map<string, unknown> | Set<string> | undefined }

const mkSenses = () => new BotSenses({
  bots: [],
  teamOf: new Map(),
  player: () => ({ pos: new THREE.Vector3(), vel: new THREE.Vector3(), isDead: false,
    isCloaked: false, lastFireAt: 0, health: 100, maxHealth: 100 }),
  world: () => ({ remotePlayers: new Map(), explosions: [], projectiles: [] }),
  mode: () => 'solo',
  targets: [],
} as unknown as SenseHost);

const mkFlags = () => {
  const ctx: FlagCtx = {
    lazyTerrain: () => ({ getHeight: () => 0 }) as unknown as ReturnType<FlagCtx['lazyTerrain']>,
    lazyScene: () => new THREE.Scene(),
    carrierPos: () => null,
    teamOf: () => undefined,
    pickupRadiusOf: () => 2,
    touchers: () => [],
    bots: [],
    scores: makeScores(),
    onCapture: vi.fn(),
    onFeed: vi.fn(),
    onFlagEvent: vi.fn(),
  };
  return new CtfFlags(ctx, new THREE.Vector3());
};

const mkFlagRun = () => new FlagRunBridge({
  lazyTerrain: () => ({ getHeight: () => 0 }) as unknown as ReturnType<FlagRunDeps['lazyTerrain']>,
  lazyScene: () => new THREE.Scene(),
  lazyCamera: () => new THREE.PerspectiveCamera(),
  lazyPlayer: () => ({ pos: new THREE.Vector3(), isDead: false,
    mods: { pickupRadius: 2 }, yaw: 0, pitch: 0 }),
  lazyHud: () => ({ updateFlagIndicator: vi.fn() }),
  world: { explosions: [] },
} as unknown as FlagRunDeps, {
  playerTeam: 'alpha',
  bots: [],
  teamOf: new Map(),
  scores: makeScores(),
  onFeed: vi.fn(),
  onCapture: vi.fn(),
} as unknown as FlagRunWiring, new THREE.Vector3());

describe('rekey migrates every id-keyed meter', () => {
  it('BotFire carries the shot-cadence receipt', () => {
    const fire = new BotFire({} as FireHost);
    const peek = fire as unknown as { lastShotAt: Map<string, number> };
    peek.lastShotAt.set('bot:a-A', 1234);
    fire.rekey('bot:a-A', 'bot:a-B');
    expect(peek.lastShotAt.has('bot:a-A')).toBe(false);
    expect(peek.lastShotAt.get('bot:a-B')).toBe(1234);
  });

  it('BotWatchdog carries samples, anchors and warn sets', () => {
    const wd = new BotWatchdog({ warn: vi.fn(), info: vi.fn() }, () => false);
    const peek = wd as unknown as {
      logic: Map<string, THREE.Vector3>; render: Map<string, THREE.Vector3>;
      anchor: Map<string, { p: THREE.Vector3; t: number }>;
      stalled: Set<string>; stuck: Set<string>;
    };
    const p = new THREE.Vector3(1, 2, 3);
    peek.logic.set('b-A', p); peek.render.set('b-A', p);
    peek.anchor.set('b-A', { p, t: 5 });
    peek.stalled.add('b-A'); peek.stuck.add('b-A');
    wd.rekey('b-A', 'b-B');
    for (const m of [peek.logic, peek.render, peek.anchor]) {
      expect(m.has('b-A')).toBe(false);
      expect(m.has('b-B')).toBe(true);
    }
    for (const s of [peek.stalled, peek.stuck]) {
      expect(s.has('b-A')).toBe(false);
      expect(s.has('b-B')).toBe(true);
    }
  });

  it('BotSenses carries the foeSeen raycast cache', () => {
    const senses = mkSenses();
    const peek = senses as unknown as { foeSeenCache: Map<string, { t: number; v: boolean }> };
    peek.foeSeenCache.set('c-A', { t: 10, v: true });
    senses.rekey('c-A', 'c-B');
    expect(peek.foeSeenCache.has('c-A')).toBe(false);
    expect(peek.foeSeenCache.get('c-B')).toEqual({ t: 10, v: true });
  });

  it('CtfFlags keeps the specialist role on the rekeyed body', () => {
    const flags = mkFlags();
    const peek = flags as unknown as { roles: Map<string, string> };
    peek.roles.set('cap-A', 'capper');
    flags.rekey('cap-A', 'cap-B');
    expect(peek.roles.has('cap-A')).toBe(false);
    expect(peek.roles.get('cap-B')).toBe('capper');
  });

  it('FlagRunBridge carries touch positions and speeds', () => {
    const run = mkFlagRun();
    const peek = run as unknown as { lastTouchPos: Map<string, THREE.Vector3>; lastTouchV: Map<string, number> };
    const p = new THREE.Vector3(4, 5, 6);
    peek.lastTouchPos.set('r-A', p); peek.lastTouchV.set('r-A', 42);
    run.rekey('r-A', 'r-B');
    expect(peek.lastTouchPos.has('r-A')).toBe(false);
    expect(peek.lastTouchPos.get('r-B')).toBe(p);
    expect(peek.lastTouchV.get('r-B')).toBe(42);
  });

  it('RoomNoticer carries receipts and re-points a pending actor', () => {
    const n = new RoomNoticer();
    n.notice('flagcap', 'actor', 'alpha', 1000);
    n.for('watcher-A', 'bravo', 1001); // consumes the event → seen receipt
    n.notice('flaggrab', 'watcher-A', 'bravo', 1500);
    n.rekey('watcher-A', 'watcher-B');
    const peek = n as unknown as { seen: Map<string, number>; pending: { actorId: string } | null };
    expect(peek.seen.has('watcher-A')).toBe(false);
    expect(peek.seen.get('watcher-B')).toBe(1000);
    expect(peek.pending?.actorId).toBe('watcher-B');
  });
});
