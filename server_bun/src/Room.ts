/**
 * Room — one match's worth of state: players, sockets, rate limits,
 * message routing, and its own BallSim. GameServer holds a rooms map and
 * dispatches connections to them; today every player lands in "default",
 * but the seam is what turns matchmaking/lobbies/multi-match servers into
 * plumbing instead of surgery.
 *
 * Deliberately owns NO transport specifics beyond the broadcast/send
 * closures it hands to its children — a room is just "everyone who shares
 * this match state."
 */
import { PlayerManager } from './PlayerManager.ts';
import { ConnectionManager } from './ConnectionManager.ts';
import { RateLimiter } from './RateLimiter.ts';
import { MessageHandler } from './MessageHandler.ts';
import { BallSim } from './BallSim.ts';
import { hmHeight, type Heightfield } from '../../shared/heightfield.ts';
import { type MapSpec, resolveMapSpec } from '../../shared/mapSpec.ts';
import { MODES, pickTeam, makeScores, bank, winner, type ModeId, type ModeSpec, type TeamScores } from '../../shared/teams.ts';
import { ServerBots } from './ServerBots.ts';
import { RoomFlags } from './RoomFlags.ts';
import type { PlayerState } from './types.ts';
import type { ServerWebSocket } from 'bun';
import type { WebSocketData } from './types.ts';

export class Room {
  readonly name: string;
  // First joiner's mode locks the match — later joins inherit it via
  // gameState rather than a per-client URL param.
  readonly mode: string;
  readonly players = new PlayerManager();
  readonly connections = new ConnectionManager();
  readonly rateLimiter = new RateLimiter();
  readonly messages: MessageHandler;
  readonly ballSim: BallSim;

  // Per-room session bookkeeping (was global — a grace-period slot belongs
  // to the match it was in, not the whole server).
  readonly disconnected = new Map<string, { timeout: ReturnType<typeof setTimeout> }>();
  readonly sessionTokens = new Map<string, string>();
  readonly lastSentPositions = new Map<string, { x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number; pitch: number; hp: number; dead: boolean; ski: number; t: number }>();
  tickSeq = 0;

  readonly spec: MapSpec;
  // Server-owned match scoreboard — only populated in team modes.
  readonly modeSpec: ModeSpec | null;
  readonly scores: TeamScores = makeScores();
  /** Server-driven filler players, populated from the map spec. */
  readonly bots: ServerBots;
  /** CTF flag authority — only when the mode has flags AND the map has bases. */
  readonly flags: RoomFlags | null = null;

  constructor(name: string, field: Heightfield | null, mode = '', spec?: MapSpec) {
    this.name = name;
    this.spec = spec ?? resolveMapSpec(null);
    this.mode = mode || this.spec.mode || '';
    this.modeSpec = MODES[this.mode as ModeId] ?? null;
    this.messages = new MessageHandler(
      this.players,
      this.rateLimiter,
      (msg, exclude) => this.connections.broadcast(msg, exclude),
      (pid, msg) => this.connections.sendToPlayer(pid, msg),
      {
        room: name,
        mode: this.mode,
        scores: this.scores,
        winAt: this.modeSpec?.winAt,
        ffaScores: () => Object.fromEntries(this.ffaScores),
        onBank: (pid, n) => this.bank(pid, n),
        bases: this.spec.bases,
        onKill: (pid, shooter) => this.onKill(pid, shooter),
        flags: () => this.flags?.snapshot() ?? [],
      },
    );
    this.ballSim = new BallSim(
      this.players,
      (msg) => this.connections.broadcast(msg),
      (data) => this.connections.broadcastBinary(data),
    );
    this.ballSim.population = this.spec.balls;
    this.ballSim.onKilled = (by) => this.creatureKill(by);
    if (this.spec.ballMix) this.ballSim.ballMix = this.spec.ballMix;
    if (this.spec.spawns) this.players.spawnPoints = this.spec.spawns;
    this.messages.setBallSim(this.ballSim);
    if (field) this.ballSim.attachField(field);
    this.bots = new ServerBots(this, field);
    // Bots populate before humans join so team balancing puts humans on
    // the emptier side.
    if (this.spec.bots) this.bots.populate(this.spec.bots);
    const bases = this.spec.bases;
    if (this.modeSpec?.flags && bases?.alpha && bases?.bravo) {
      // Spec y is advisory — flags live on the ground, so touch checks
      // measure feet-to-flag, not feet-to-arbitrary-height.
      const snap = (v: { x: number; y: number; z: number }) => ({
        ...v,
        y: field ? hmHeight(field, v.x, v.z) : v.y,
      });
      this.flags = new RoomFlags(this, { alpha: snap(bases.alpha), bravo: snap(bases.bravo) });
    }
  }

  /** Flag tick — called from GameServer's room tick. Captures feed the
   *  same bank→teamScore→matchEnd funnel nuggets use (worth winAt/5-ish:
   *  one capture = one score point). */
  tickFlags(dt: number): void {
    const scoredBy = this.flags?.tick(dt);
    if (scoredBy) this.score(scoredBy);
  }

  /** Any player death drops a carried flag — called from the damage funnel. */
  flagCarrierDied(playerId: string): void {
    this.flags?.dropIfCarrier(playerId);
  }

  /** Per-player scoreboard for FFA modes (dm). Bots are in the same map —
   *  a bot can legitimately win a deathmatch. */
  readonly ffaScores = new Map<string, number>();

  /** Creature kill — ballDie attribution from BallSim. FFA-only for now;
   *  team modes bank nuggets through the claim path instead. */
  private creatureKill(by: string): void {
    const spec = this.modeSpec;
    if (!spec?.ffa || spec.ptsCreatureKill <= 0 || !this.players.getPlayer(by)) return;
    this.awardFfa(by, spec.ptsCreatureKill);
  }

  private awardFfa(id: string, n: number): void {
    const spec = this.modeSpec!;
    const pts = (this.ffaScores.get(id) ?? 0) + n;
    this.ffaScores.set(id, pts);
    this.broadcast({ type: 'ffaScore', scores: Object.fromEntries(this.ffaScores), winAt: spec.winAt });
    if (pts >= spec.winAt) {
      this.broadcast({ type: 'ffaMatchEnd', winner: id, scores: Object.fromEntries(this.ffaScores) });
      this.ffaScores.clear();
      this.broadcast({ type: 'matchStart', mode: this.mode, scores: { ...this.scores } });
    }
  }

  /** Kill hook from the damage funnel: flag drop in every mode, frag
   *  points in FFA rooms. 'environment' shooters score nothing. */
  private onKill(targetId: string, shooterId: string): void {
    this.flagCarrierDied(targetId);
    const spec = this.modeSpec;
    if (!spec?.ffa || !this.players.getPlayer(shooterId)) return;
    this.awardFfa(shooterId, spec.ptsPlayerKill);
  }

  /** Team point from an objective (flag capture) — separate from bank()
   *  claims since the server itself is the source of truth. */
  score(team: 'alpha' | 'bravo', n = 1): void {
    if (!this.modeSpec?.teams) return;
    bank(this.scores, team, n);
    this.broadcast({ type: 'teamScore', scores: { ...this.scores }, winAt: this.modeSpec.winAt });
    const w = winner(this.scores, this.modeSpec.winAt);
    if (w) {
      this.broadcast({ type: 'matchEnd', winner: w, scores: { ...this.scores } });
      this.scores.alpha = 0;
      this.scores.bravo = 0;
      this.flags?.reset();
      this.broadcast({ type: 'matchStart', mode: this.mode, scores: { ...this.scores } });
    }
  }

  broadcast(msg: Parameters<ConnectionManager['broadcast']>[0], exclude?: string): void {
    this.connections.broadcast(msg, exclude);
  }

  playerCount(): number {
    return this.players.getPlayerCount();
  }

  socketOf(playerId: string): ServerWebSocket<WebSocketData> | undefined {
    return this.connections.getConnection(playerId);
  }

  /** Nothing left to serve: no humans, no grace-period ghosts. Bots don't
   *  keep a match alive — they exist to serve the humans in it. */
  get empty(): boolean {
    return this.players.getHumanCount() === 0 && this.disconnected.size === 0;
  }

  /** Balance join: smallest team takes the newcomer. FFA modes no-op. */
  assignTeam(player: PlayerState): void {
    if (!this.modeSpec?.teams) return;
    let alpha = 0, bravo = 0;
    for (const p of this.players.getAllPlayers().values()) {
      if (p.team === 'alpha') alpha++;
      else if (p.team === 'bravo') bravo++;
    }
    player.team = pickTeam({ alpha, bravo });
  }

  /** A nugget banked (or a flag capped, same channel). Server clamps the
   *  claim size in validation; here we just count and judge the match. */
  bank(playerId: string, n: number): void {
    const player = this.players.getPlayer(playerId);
    if (!player?.team || !this.modeSpec?.teams) return;
    bank(this.scores, player.team, n);
    this.broadcast({ type: 'teamScore', scores: { ...this.scores }, winAt: this.modeSpec.winAt });
    const w = winner(this.scores, this.modeSpec.winAt);
    if (w) {
      this.broadcast({ type: 'matchEnd', winner: w, scores: { ...this.scores } });
      this.scores.alpha = 0;
      this.scores.bravo = 0;
      this.broadcast({ type: 'matchStart', mode: this.mode, scores: { ...this.scores } });
    }
  }

  dispose(): void {
    this.ballSim.stop();
  }

  /** Full teardown — every store moves together or a slot/token leaks. */
  removePlayerCompletely(playerId: string, reason: string, log: (m: string, o?: object) => void): void {
    this.players.removePlayer(playerId);
    if (this.ffaScores.delete(playerId)) {
      this.broadcast({ type: 'ffaScore', scores: Object.fromEntries(this.ffaScores), winAt: this.modeSpec!.winAt });
    }
    this.messages.onPlayerRemoved(playerId);
    this.sessionTokens.delete(playerId);
    this.lastSentPositions.delete(playerId);
    this.connections.broadcast({ type: 'playerLeft', playerId });
    log('Player removed', { room: this.name, playerId, reason, remaining: this.playerCount() });
  }
}
