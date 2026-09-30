import io, re
p = 'src/game/remotes.ts'
s = io.open(p, encoding='utf-8').read()

def cut(a_marker, b_marker, repl):
    global s
    a = s.index(a_marker); b = s.index(b_marker)
    blk = s[a:b]
    s = s[:a] + repl + s[b:]
    return blk

cut("  // RemoteSet lifecycle hooks", "  function getLastSentPos()", "  deps.world.remotePlayers.hooks = makeRemoteHooks(deps);\n\n")
cut("  // Status bitmask → per-effect visuals.", "  // Friend-or-foe marker:", "")
cut("  // Ski dust off a networked ski flag", "  // Per-remote-player frame work:", "")
cut("  // Per-remote-player frame work:", "  // Remove disconnected players", "")
cut("  // Remove disconnected players", "  // Scoreboard rows:", "")
cut("  // Scoreboard rows: local player first", "  return { networkTick", "")

mod = '''function makeRemoteHooks(deps: RemotesDeps) {
  return {
    create: (id: string, state: WirePlayerState) => {
      if (state.isDead) return undefined;
      const rp = new RemotePlayer(deps.lazyScene(), id, state.position, deps.lazyTerrain(), state.armorClass);
      rp.setClass(state.armorClass);
      return rp;
    },
    // Bots are hosted in the room sim — they never ping, so the
    // dead-socket gate can't apply to them or they render as ghosts.
    isLive: (id: string, state: WirePlayerState | undefined) => id.startsWith('BOT-') || state?.ping != null,
    onCreate: (id: string, rp: RemotePlayer) => deps.logger.debug('CREATED remote player', { instanceId: rp.instanceId, playerId: id, total: deps.world.remotePlayers.size }),
    onRemove: (id: string) => {
      deps.lazyHud().removePlayerIndicator(id);
      deps.lazyHealthBarSystem().removeBar(id);
      sfxWorld.remoteMoveAudioGone(id);
    },
  };
}

type WirePlayerState = import('../networking/NetworkManager.js').RemotePlayerState;

function isRemoteActive(deps: RemotesDeps, playerId: string, players: Map<string, WirePlayerState>): boolean {
  return deps.world.remotePlayers.active(playerId, deps.world.remotePlayers.get(playerId), players.get(playerId));
}

// Status bitmask → per-effect visuals. One bit = one row; the next
// toggle effect lands here, nowhere else in the netcode. Returns false
// when cloaked — an enemy's HUD must give no trace (dust off an
// invisible skier is a giveaway).
function applyStatusVisuals(deps: RemotesDeps, playerId: string, remotePlayer: RemotePlayer, status: number): boolean {
  remotePlayer.setCloakHidden(!!(status & STATUS.CLOAK));
  remotePlayer.setShielded(!!(status & STATUS.SHIELD));
  remotePlayer.setMending(!!(status & STATUS.MEND));
  remotePlayer.setRegenAura(!!(status & STATUS.REGEN));
  remotePlayer.setDdAura(!!(status & STATUS.DD));
  if (!(status & STATUS.CLOAK)) return true;
  deps.lazyHud().removePlayerIndicator(playerId);
  deps.lazyHealthBarSystem().removeBar(playerId);
  return false;
}

// Ski dust off a networked ski flag near the ground, plus the HUD
// name marker from the extrapolated position.
function tickRemoteCosmetics(deps: RemotesDeps, playerId: string, remotePlayer: RemotePlayer, playerState: WirePlayerState): void {
  const hud = deps.lazyHud();
  let skiing = false;
  if (!playerState.isDead && playerState.ski) {
    const v = remotePlayer.vel;
    const terrain = deps.lazyTerrain();
    const groundY = terrain.getHeight(remotePlayer.position.x, remotePlayer.position.z);
    if (v.x * v.x + v.z * v.z > 10 && remotePlayer.feetY - groundY < 0.8) {
      skiing = true;
      deps.lazyEffects().spawnSkiDust(remotePlayer.position, v);
    }
  }
  // Jet audio has no wire bit — a sustained powered climb (vel.y past
  // jump apex) is the only honest tell, matching the remote animation.
  const jetting = !playerState.isDead && remotePlayer.vel.y > 4.5;
  sfxWorld.remoteMoveAudio(playerId, remotePlayer.position, remotePlayer.vel.length(), jetting, skiing);
  if (!playerState.isDead) {
    // Teammates read green, everything else stays enemy red — FFA and
    // teamless modes leave `team` undefined so nothing turns friendly.
    const friendly = !!playerState.team && playerState.team === deps.world.localTeam;
    hud.updatePlayerIndicator(playerId, remotePlayer.position, deps.lazyCamera(), false, friendly);
  } else {
    hud.removePlayerIndicator(playerId);
  }
}

// Per-remote-player frame work: create if new, hide if stale, tick, then cosmetics
function tickRemotePlayer(deps: RemotesDeps, lastTintOf: Map<string, string>,
    playerId: string, playerState: WirePlayerState, dt: number): void {
  const nm = deps.lazyNetworkManager();
  if (playerId === nm.getLocalPlayerId()) return;

  const remotePlayer = deps.world.remotePlayers.ensure(playerId, playerState);
  if (!remotePlayer) return;

  // Hide stale remote players — backgrounded tabs keep the socket open but
  // stop sending updates, leaving ghosts standing around. 60s grace covers
  // genuine packet loss; dead reckoning handles shorter gaps. Players that
  // never reported ping (>5s without one) are dead sockets — hide them too.
  const inactive = !deps.world.remotePlayers.active(playerId, remotePlayer, nm.getPlayers().get(playerId));
  deps.world.remotePlayers.setStale(remotePlayer, inactive);
  if (inactive) {
    deps.lazyHud().removePlayerIndicator(playerId);
    deps.lazyHealthBarSystem().removeBar(playerId);
    sfxWorld.remoteMoveAudioGone(playerId);
    return;
  }

  // tick() drives interpolation + dead reckoning and internally advances
  // the AnimationMixer — a second model.update here would 2x animations.
  remotePlayer.tick(dt, deps.lazyCamera().position);

  if (!applyStatusVisuals(deps, playerId, remotePlayer, playerState.status ?? 0)) return;
  applyTeamTint(deps, lastTintOf, playerId, remotePlayer, playerState.team);
  tickRemoteCosmetics(deps, playerId, remotePlayer, playerState);
}

// Friend-or-foe marker: teammates wear their team's color, enemies are
// always red. Tint applies only when the wire team changes.
function applyTeamTint(deps: RemotesDeps, lastTintOf: Map<string, string>,
    playerId: string, remotePlayer: RemotePlayer, theirTeam: string | undefined): void {
  if (!theirTeam || theirTeam === lastTintOf.get(playerId)) return;
  lastTintOf.set(playerId, theirTeam);
  remotePlayer.setGizmoColor(theirTeam === deps.world.localTeam ? TEAM_COLORS[theirTeam] : ENEMY_RED);
}

// Remove disconnected players and dead players that have shrunk to 0
function cleanupRemotePlayers(deps: RemotesDeps, players: Map<string, WirePlayerState>): void {
  // `bot:` entries are locally driven (Nugget Wars) — the network roster
  // knows nothing about them; cleanup is owned by TeamBots.
  // 'dummy' is the ?dummy debug body — gameLoop ticks it from a closure,
  // so pruning it would leave a disposed model animating forever.
  deps.world.remotePlayers.prune(
    (id) => id.startsWith('bot:') || id === 'dummy' || players.has(id),
    // Bots/dummies keep their body across death+respawn — the death
    // shrink must NOT reap them or they respawn invisible and off-board.
    (id) => id.startsWith('bot:') || id === 'dummy',
  );
}

// Scoreboard rows: local player first, then remotes sorted by frags desc
function updateScoreboard(deps: RemotesDeps): void {
  const hud = deps.lazyHud();
  if (!hud.scoreboardVisible) return;
  const nm = deps.lazyNetworkManager();
  const localId = nm.getLocalPlayerId();
  const ffa = deps.world.ffaScores;
  const rows = [{ name: localId, frags: deps.world.killCounts.get(localId) ?? 0, score: ffa.get(localId) ?? null, ping: nm.getPing(), net: nm.getTransportTier() ?? null, self: true, dead: deps.lazyPlayer().isDead, team: deps.world.localTeam }];
  // net is string|null — 'bot' rows carry a label, not a transport tier.
  const remoteRows: { name: string; frags: number; score: number | null; ping: number | null; net: string | null; self: boolean; dead: boolean; team?: 'alpha' | 'bravo' }[] = [...nm.getPlayers().keys()]
    .filter(id => id !== localId && isRemoteActive(deps, id, nm.getPlayers()))
    .map(id => {
      const ps = nm.getPlayers().get(id);
      return { name: id, frags: deps.world.killCounts.get(id) ?? 0, score: ffa.get(id) ?? null, ping: ps?.ping ?? null, net: ps?.transport ?? null, self: false, dead: ps?.isDead ?? false, team: ps?.team };
    });
  // Offline bots live in world.remotePlayers, not the network roster —
  // they'd be invisible on the scoreboard otherwise.
  for (const [id, rp] of deps.world.remotePlayers) {
    if (nm.getPlayers().has(id)) continue;
    // GameBot carries a team field; FFA bots get a self-id pseudo-team,
    // which must not count as a real team row.
    const t = (rp as { team?: string }).team;
    remoteRows.push({ name: id.replace('bot:', ''), frags: deps.world.killCounts.get(id) ?? 0, score: deps.world.ffaScores.get(id) ?? null, ping: null, net: 'bot', self: false, dead: rp.isDead, team: t === 'alpha' || t === 'bravo' ? t : undefined });
  }
  remoteRows.toSorted((a, b) => (b.score ?? b.frags) - (a.score ?? a.frags));
  hud.setScoreboardRows([...rows, ...remoteRows]);
}

export function createRemotes'''
s = s.replace("export function createRemotes", mod, 1)

# fix call sites inside remaining factory
s = s.replace("isRemoteActive(id, players)", "isRemoteActive(deps, id, players)")
s = s.replace("players.forEach((playerState, playerId) => tickRemotePlayer(playerId, playerState, dt));",
              "players.forEach((playerState, playerId) => tickRemotePlayer(deps, lastTintOf, playerId, playerState, dt));")
s = s.replace("cleanupRemotePlayers(players);", "cleanupRemotePlayers(deps, players);")
# remove leftover inner defs
s = re.sub(r"  type WirePlayerState = import\([^\n]+\n", "", s)
s = re.sub(r"  function ensureRemote[\s\S]+?\n  \}\n", "", s)
s = re.sub(r"  // Friend-or-foe marker[\s\S]+?\n  \}\n", "", s)
s = re.sub(r"  function isRemoteActive[\s\S]+?\n  \}\n", "", s)
s = s.replace("return { networkTick, updateScoreboard, getLastSentPos, setLastSentPos };",
              "return { networkTick, updateScoreboard: () => updateScoreboard(deps), getLastSentPos, setLastSentPos };")
io.open(p, 'w', encoding='utf-8').write(s)
print('ok')
