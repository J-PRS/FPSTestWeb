# Bot host unification plan — client vs server drift surface

Measured surface (2026-11-10):

| Layer | Server | Client | Duplicated |
|---|---|---|---|
| Arsenal | `server_bun/src/botArsenal.ts` (1160) | `client/src/game/bots/botFire.ts` (340) | weapon pick, throwBelt/lobAt, support nades, self-splash vetoes |
| Senses/ctx | `serverSenses.build` (423) | `botBrain.ts` ctx literal (~90) | every `BrainCtx` field needs 2 wiring sites |
| Orchestration | `ServerBots.ts` (1010) | `index.ts` (1064) | roster, roles, Q-skill rolls, think loop |
| Brain | shared/botBrain+moves+goals | same | **already unified** |

Failure mode this session proved twice: a policy change lands on one
host and silently misses the other (`thrift`/`airLove`/`speedScale`
needed 2 ctx sites each; the Hook belt gate needed 2 throwBelt sites).
`undefined` ctx fields read as "not equipped" — the bugs are silent.

## Plan (value-ordered)

### Phase 1 — ctx parity (~1-2 days)
Extract `shared/buildBrainCtx(common inputs)`; both hosts supply their
senses through one typed assembler. Retires the silent-dead-channel
class permanently. Cheap because both call sites already pass the same
data — it's assembly, not logic.

### Phase 2 — arsenal policy (~2-3 days)
Move decisions to `shared/botArsenalPolicy`: pickWeapon, throwBelt
gating (Hook-refusal, wounded-explosive, belt-dry), support nades,
self-splash vetoes. Hosts keep only `spawn()` + FX/anim. The client's
340-line subset is strictly a fork of the 1160-line original — port
server policy down rather than reconcile two versions.

### Phase 3 — orchestration (3-5 days, lowest value)
Roster/respawn legitimately differs (authority vs approximated); only
role-assignment and kit-pick policy unify. Skippable if 1+2 land.

Phases 1+2 retire ~70% of the drift surface for ~a week of work.

## Verification
- Existing `server_bun/tests` scenario suite + vitest stay green per phase
- `jetProbe`/`classProbe`/`evoSkill` before/after each phase to confirm
  zero behavioral delta (asw buckets + jet-duty within noise)
