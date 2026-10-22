# Test plan — server-side bots in a live match (HEADLESS)

Env: bun game server on :8000 (`bun src/server.ts` in server_bun — running,
/metrics OK), vite dev on :5302. Headless puppeteer-core + system Chrome
(SwiftShader WebGL). Pointer lock stubbed element-correct. Temp `__test` hook
exposes { demoManager, player, entities, world, networkManager, rendererCanvas }.

Primary flow: join `?room=bottest_<ts>&map=erg&bots=6` — erg spec is
mode 'nuggets' with bots:6; the join's bots=6 sets spec.bots + botFill, so
ServerBots fills to 6. Bots appear as world.remotePlayers keys 'bot:*'.

## Assertions (page.evaluate + screenshots)

1. **Join + fill**: after ~10s, `world.remotePlayers` contains ≥6 entries with
   id starting `bot:`. `/metrics` room 'bottest_*' shows players ≥7
   (6 bots + 1 human).
2. **Roam**: sample each bot's `position` twice ~5s apart; ≥4 of 6 bots moved
   >2m (rules out idle standing).
3. **Combat**: over a 60s observation window, watch for bot-caused evidence:
   `world.projectiles` belonging to bots is hard to attribute — instead use
   kill/death signals: `world.killCounts` changes, remotePlayer `isDead`
   toggles true (death), and later becomes alive again (respawn), and the
   human's `player.health` may drop (bots shooting at us — we stand still as
   bait). PASS if ≥1 bot death+respawn cycle observed OR player takes damage.
4. **Objective (nuggets)**: `networkManager`/world scores — `world.ffaScores`
   or `getPlayers()` stats change over 60s (bots farm creatures → nuggets →
   scoreboard moves). PASS if any bot's score > 0 or kills > 0.
5. **Spectator view**: press V (KeyV) → `#spectate-hint` element exists/visible;
   take a screenshot from the fly camera showing terrain + bots.
6. **Visuals**: screenshot with ≥1 remote player model visible in frame
   (teleport-fly camera near a bot if needed via player.pos — acceptable in
   spectator mode).
7. **Console hygiene**: no pageerrors; errors limited to expected dev noise.

Secondary (if time): join a second tab `?room=bottest2&map=ctf&bots=4` and
check `onGameState` flags array shows a flag 'carried' or 'dropped' (bot
grabbed the flag) within 90s.
