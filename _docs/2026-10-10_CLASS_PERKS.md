# Class Perks — design reference

Status: **DESIGN ONLY — nothing implemented.** Perk system today is one
`PerkId` string end-to-end (`join.perk` → `sendPerkUpdate` →
`PlayerManager` → `perkMods(id)` lookups at each read site in
`shared/perks.ts`). This doc pins the class-locked extension before
anyone touches the table.

## Principle

Perks pay for **doing the role**, not for **refusing to play**.

Rejected during design, with reasons:

- "While speed < 3m/s: knockback immune" — statue-cheese anywhere on the
  map, and moving becomes a tax. Posture-triggers are pathological
  incentives: the optimal play becomes boring.
- "+regen while stationary" — same shape, inverted: the perk is a
  *punishment for moving*, which reads as "be boring or be weak."
- Free-resource scaling (near-zero jet drain at capper speed) — a
  "hold W and win" perk; resource economies that go to ~0 remove the
  decision the economy exists to force.

The line that survived review: **place-triggers are fine, posture-triggers
are not.** "Near your own flag" is a role context you opt into by
positioning; "while slow" is a state you can farm anywhere.

## Design shape

```ts
// shared/perks.ts — one row per perk, legality tag on the same table
export const PERKS: Record<PerkId, {
  name: string; blurb: string; mods: Partial<PerkMods>;
  classes?: ArmorClass[];               // absent = universal (today's rows)
}> = { ... };

export function perkForClass(cls: ArmorClass, id: string | null | undefined): PerkMods {
  const p = PERKS[(id ?? 'none') as PerkId];
  return p && (!p.classes || p.classes.includes(cls)) ? { ...ZERO, ...p.mods } : { ...ZERO };
}
```

- **Wire unchanged** — still one `perk` string; validity is derived
  server-side (`perkForClass` everywhere `perkMods` is called today —
  a heavy claiming a light perk silently gets `none`).
- **Menu** — `classes`-locked perks get `[H]/[M]/[L]` prefix + `disabled`
  in the drop, same pattern as tier-locked weapons (`TIER_TAG`/
  `lockedForClass`). Armor-tile change with a banked-illegal perk =
  swap-out, same as `unshoulderLocked`.
- **Bots** — `botLoadouts`/`botRoster` pick from class-legal ids; the
  pinned kit-consistency test catches violations automatically.
- **Second slot explicitly deferred** — tagged pool first; a dedicated
  class slot can layer on as `perk2` later if the pool feels thin.
  Double-slot doubles the wire/UX surface for marginal gain now.

## The nine

| Class | Perk | Effect | Role (canon source) |
|---|---|---|---|
| Light | **Rage** | Enemy grabs your flag while you're within ~250m of the stand: 10s window — −25% self-damage, energy refill. One window per grab, dies on damage taken | Chaser (T:A light armor perk, verbatim) |
| Light | **Slipstream** | `knockbackTaken` ×1.3 — all sources incl. own blasts | Conc-riding movement tech; double-edged, zero free damage |
| Light | **First Strike** | `directDamage` ×1.25 vs targets at full health (clears on first tag, resets at full heal) | Sentinel/LD pickoff |
| Medium | **Skeet** | `directDamage` ×1.25 vs `onGround === false` targets | Punish hoverers/landings — the medium AA fantasy ("flyswatter") |
| Medium | **Sapper** | ×1.4 damage vs deployables/objectives | MO / gen-hate (T1's word for the role) |
| Medium | **Field Medic** | Repair tool heals teammates ~8hp/s in beam range | Technician/escort |
| Heavy | **Super Heavy** | Within ~15m of *own* flag (stand or dropped): `knockbackTaken` ×0.15 | THE canon HoF perk — place-gated, not posture-gated |
| Heavy | **Siege Engine** | `aoeRadius` ×1.15 (stacks onto bombardier → 1.61 total) | HO bombardment |
| Heavy | **Armorer** | Deployables you place get +50% hp | T1 heavy = inventory-station mule / builder-defender |

### Naming notes (decided)

- "Flak Battery" → **Skeet**: the game already has a Flak Cannon in
  `MEDIUM_ONLY`; "flak" reads as the shotgun weapon to anyone from UT.
- "Demolitionist" → **Sapper**: T1's word for the gen-killer role;
  avoids colliding with a future belt/demolitions group.
- "Anchor" → dropped entirely (posture-trigger). **Armorer** fills the
  slot and is active by construction.

### Balance guardrails

- Same-field class perks stack multiplicatively with universal picks
  (Siege Engine × Bombardier = 1.61 radius). If it lands hot: same-field
  class perk and its universal counterpart become mutually exclusive.
- First Strike at ×1.25 one-taps a light with a rail (140×1.25=175 ≥ 75+
  100=175... marginal — tune to ×1.2 or scope to >30m if it reads as a
  delete button rather than a pickoff bonus).
- Super Heavy's ×0.15 is sharper than flat `juggernaut` (×0.2 always) —
  deliberately: it's the HoF-only version, mobility stays with the
  universal pick.

## Implementation surface

New `PerkMods` fields: `flagBurst`, `vsDeployable`, `airborneBonus`,
`firstStrike`, `deployableHp`. Conditional reads:

- `flagBurst` — RoomFlags grab event → window on the *defending* team's
  nearby lights.
- `vsDeployable` — deployable damage funnel (server-owned).
- `airborneBonus` — applyDamage, `target.onGround === false` already exists
  in both sims.
- `firstStrike` — applyDamage, `health >= maxHealth` check.
- `deployableHp` — deployable spawn hp read site.
- Super Heavy — `knockbackTaken` conditional on distance to own flag;
  the flag's home/dropped pos already lives in RoomFlags.

Pure table rows needing no new code: Slipstream (`knockbackTaken: 1.3`),
Siege Engine (`aoeRadius: 1.15`).

Suggested pilot order: legality layer + the two table-row perks first,
then the conditional fields one at a time (each = one new field + one
server-owned read site), `flagBurst` last since it's the only
event-driven one.
