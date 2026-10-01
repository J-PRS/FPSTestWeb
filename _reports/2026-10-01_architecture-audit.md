# Architecture & quality audit — 2026-10-01

Scope: client/src, server_bun/src, shared. Goal: ease of future work, testability, debuggability.

## State (healthy)

- One authority model enforced: every damage/despawn path funnels through
  server sims; client only predicts/replays. `applyDamage` silent, callers
  emit events — honored everywhere.
- DI-lite deps objects (`GameContext` + 18 `*Deps` interfaces) — modules get
  lazy getters, no import cycles, constructor params stay narrow. The
  interface overlap (RemotesDeps/NetDeps/DemoLifecycleDeps redeclare lazy
  subsets) is deliberate: merging them would fatten every consumer's
  contract. Left as-is.
- Exhaustive typed dispatch both ends — `handlers` tables keyed by message
  `type` literal union; adding a message without a handler is a compile
  error now, not a runtime silent drop.
- Zero TODO/FIXME anywhere. `console.*` only inside Logger internals.
- `as any`/`as unknown` outside tests/deprecated: 5 total, all legitimate
  (webkitAudioContext compat, foreign WebSocket adapter shims, roster
  key-loop, setTimeout DOM typing).
- Determinism: creature sims carry per-creature LCG; ballSim enrage-teleport
  was the last unseeded authoritative `Math.random()` — fixed (StepWorld.rand).

## Fixes landed this audit

- `4d0e9c3` `debugGlobals.ts` — all `window.__x` probe/debug handles typed;
  a renamed field now type-errors instead of writing a key no probe reads.
- `7b67bb8` MessageHandler dispatch `Extract<ClientMessage,{type:K}>` — 20 casts → 1.
- `976fef8` server `bunx tsc` fully clean (was ~12 errors: RoomMatch casing
  clash, stale `mkRoom`/`pin` test signatures, missing ModeSpec fields).
- `8e94bf1` dump-bundle globals (`__pm/__clips/__ready/__glb/dump`) typed.
- `0192050` seeded `rand` through `StepWorld` for enrage teleport.
- `11a1b32` Logger `context?: any` → `unknown` (10 sites).
- `4c39ec3` `Targetable` declares optional swarm handles; `burstGibs` takes
  `Partial<SwarmSlotOwner>` — the last structural call-site cast gone.
- `d3c70b0`/`3053eeb` `shared/deployables.ts` — one kind/cap/HP table; the
  client's visual-cap mirror had silently drifted on mine/station/drone.
- `d50b53f` broadcast literals lose `as ServerMessage` casts — protocol
  drift is a compile error again (roomMatch keeps one: the ternary needs it).
- `083994a` protocol deploy-kind unions reference `DeployKind`; vestigial
  `as any` casts in vmdump removed (fields were public already).
- `5cc0fc5` oxlint fully clean.
- clip-surgery + GLSL extractions: `playerClipSurgery.ts` from PlayerModel
  (940→880), `rendererShaders.ts` from renderer.ts (825→601).
- net dispatch guarded — a malformed-but-parseable message logs a warn
  instead of throwing into the connection's onError path.
- `f73a74c` + `ArmorClass`/`TransportKind` commits — the literal-union
  drift class is closed: TeamId, DeployKind, PickupKind, ArmorClass,
  TransportKind now each have exactly one definition; adding a kind is a
  one-line edit + compile sweep. `perk`/`mode` stay `string` on the wire
  by design (boundary validators in perks.ts / mapSpec resolve them).

## Findings (ranked, not-yet-done)

1. **Big-file cohesion** (low risk, medium value): largest files are
   PlayerModel.ts (880), vfx.ts (817) — renderer.ts and PlayerModel already split, vfx.ts (817), NetworkManager.ts
   (788). Internally organized, no action needed today — but any growth past
   ~1k lines should split (e.g. NetworkManager's roster logic could become
   `net/roster.ts` when it next changes).
2. **Debug dump files keep loose typing intentionally** (`vmdump.ts`,
   `posedump.ts`, `demoExtract.ts`) — they poke private fields by design;
   the `as unknown` casts are honest boundaries. If they rot, they rot
   loudly; acceptable.
3. ~~**Test coverage gap**~~ — narrowed this round: `netMalformed` (dispatch
   robustness), `projsim`, `flagGoals`, `botlos` tests landed; server suite
   now 519 files. Re-checked the interpolation gap — already covered:
   `remoteSnapshots` (bracketing/bounded-extrapolation/stale-cap/±PI yaw),
   `rewind.test.ts` + `clampPing` on the server (lag-comp contract).
4. ~~**Module-state test seams**~~ — every mutable module-level cache now
   has a flush hook: `losMemoReset()` joined `setBotRand`/`setTauntClock`/
   `Room.rng`. Verified the rest (texture/pool caches) key on immutable
   params — infinite TTL is correct there.
5. **Import cycles**: re-verified via madge — all 68 flagged chains are
   `import type` back-edges (the intended deps pattern). Zero value cycles.
6. **Deps-interface drift risk**: 18 interfaces hand-mirrored from
   GameContext. If GameContext grows a getter a Deps interface forgot,
   callers see undefined. Mitigation if it ever bites: generate Deps
   interfaces as `Pick<GameContext, ...>` — today the explicit form is more
   readable.
7. **Respawn timers still wall-clock** (known server edge per AGENTS.md) —
   the only nondeterminism in server sims; flagged not fixed by design.
8. **ThreatTable wDmg is dead weight for 6/7 profiles** (found via
   targeting tests): challenger max score = wDist+wDmg; incumbent min =
   wDist+sticky — for hunter/rammer/artillery/sniper/siege/fodder the
   sticky bonus alone exceeds any challenger's max, so damage aggro can
   never flip a committed target (only death/leash/forget can). Only
   flyer (0.8 > ~0.4 slack) can flip. Docs say "a real damage-dealer
   pulls aggro" — if intended, sticky < wDist+wDmg or a separate
   threat lane; if commit-is-personality is intended, the doc string
   overpromises. Test pins current semantics.
9. **Client coverage caught up** (was the thinnest layer): 158 tests /
   26 files now cover targeting hysteresis, VGS chords, aggro roster
   freshness, anim cadence/locomotion picks, settings store, poissonDisc,
   ExplosionTracker, frameBudget, keybinds — plus the earlier wire/demo/
   interp files. DOM test stub gained append/createTextNode/setTimeout/
   HTMLElement classes (what kept DOM-touching modules untestable).
8. **`.old` accumulation**: 28 soft-deleted files; the biggest cluster is
   the old adapter stack (Colyseus/Naia/FastAPI/Tribes2/Ghost/Move/Event/
   Stream managers, all superseded by NetworkManager). Scheduled user
   cleanup — no action taken, noted for the next review pass.

## Verdict

No structural rot. The codebase's risky seams (wire boundary, dispatch,
debug globals, sim determinism) are now all compile-checked. Remaining items
are watch-items, not defects.
