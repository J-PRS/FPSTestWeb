# UI Benchmark Audit — KRIBES vs. Browser-FPS Greats

Date: 2026-11-09. Scope: HUD + menu chrome (gameplay balance excluded).
Benchmarks: Krunker (prime), Narrow One, with notes from Shell Shockers,
Venge.io, War Brokers, Kirka.io. Prior art in repo:
`2026-06-21_BROWSER_FPS_GENRE_OVERVIEW.md`, `2026-06-21_NARROW_ONE_ANALYSIS.md`.

Verdict up front: **our bones are better than theirs were; their skin is
better.** Layout contract, tokens, rebind depth, and input honesty are
ahead of anything Krunker ever shipped. Type cohesion, iconography,
restraint, and juice are behind. That's the right ordering — skin is the
fun part and it's exactly what the restyle pass is for.

## What the goats did right

| Dimension | Krunker (prime) | Narrow One | Principle |
|---|---|---|---|
| HUD density | ~5 elements: crosshair, HP, ammo, killfeed, score | Even leaner — one dominant readout | One glance = full state; nothing decorative survives |
| Typography | One bold condensed sans, huge numerals | One face, two sizes | Absorbed, never read |
| Color | Saturated flat fills, thick outlines, playful | Soft pastels, outlined icon chips | Each element owns exactly one hue |
| Iconography | Gun icons, skull killfeed, no words | Class icons, not labels | Legible at 1cm on a laptop |
| Menu funnel | PLAY dominates; all else is secondary tiles | Literally one button | Zero decision friction to first match |
| Juice | Snappy hitmarker, physical buttons, animated states | Clean micro-animations everywhere | Controls feel like objects, not divs |
| Settings | Functional but famously clunky | Thin | Not their strength — our opening |

Shell Shockers/Venge.io confirm the same pattern: near-zero HUD weight,
chunky readable primitives, personality through color+type rather than
ornament. None of them solve a Tribes-class information problem — they
don't have to. Skiing, energy, and pack state are genuinely denser than
hitscan arena needs, so our floor is higher; that's a license for
*discipline*, not more widgets.

## Where we stand today

Already shipped (the bones):
- **Region-stack HUD layout** (`client/src/ui/hud/hud.css`, `regions.ts`)
  — 8 dock zones, flex order maps, zero self-positioned chrome. Beats
  anything these games had; they hand-placed like we used to.
- **Tokenized palette + tile skeleton** (`client/src/ui/chrome.css`) —
  `--ui-*` channels, one shared button material, zero `rgba()` left in
  menu chrome.
- **Rebindable everything** — fire/jet/scoreboard/map/chat/VGS all in
  `BIND_DEFS`; fixed set reduced to genuine system keys, dev-gated.
- **Input honesty** — digits-only filtering, cm/360 sens input with
  two-way sync, dual v°/h° FOV fields with derived-value tooltips and
  clamp-on-blur.
- **Collapsible side menu** — sections fold, profile stays open.
- **Vitals redesign in progress** — one-hue-per-stat readouts
  (`#hp` red / `#nrg` cyan / `#armor` amber), speedo folded into the
  labels row, Oxanium in `#hud-bc`.

Beaten on:

1. **Typography cohesion** — we run Courier New (HUD root), Rajdhani,
   Oxanium, Segoe UI, and monospace fallbacks across five families.
   Krunker runs one. Oxanium is the right candidate (squared techno is
   the genre's face); it just isn't the system yet.
2. **Icons over text** — killfeed, status chips, and the weapon row are
   all words. `wslot` labels, `kf-row` text, `.status-hint` strings.
   Krunker's skull-feed and gun icons resolve at glancing speed.
3. **Restraint** — we show speedo + 5 reticle readouts + buffs +
   weapons + dual bars + held counter. Some is Tribes-required
   (energy/speed ARE the game), some is dev-cruft on the player surface.
   Test: "would a new player miss this in 10 seconds?"
4. **Juice budget** — our state changes are tasteful-subtle. Theirs
   punch: hitmarker scale-pop, button press depth, animated transitions
   on every toggle.
5. **Funnel clarity** — their first screen is one button; ours is a
   dense side menu where PLAY competes with eleven tiles.

## Steal list for the restyle

Ordered by impact-per-effort:

1. **One typeface everywhere** — promote Oxanium (or the chosen face)
   from `#hud-bc` to HUD-wide + menu chrome; kill Courier New and the
   Segoe fallbacks except where monospace is load-bearing (log panel,
   perf tables — tabular data wants mono).
2. **One hue per element, extended** — the vitals recolor is the right
   pattern; killfeed already team-tints. Carry it to status chips,
   buffs, and the weapons row.
3. **Icon + number feeds** — weapon glyphs or kill icons in the feed;
   shape-tinted status chips instead of text strings. Biggest
   glance-speed win available.
4. **Physical state feedback** — press depth (translateY + shadow
   collapse), accent-fill active states instead of border-only, hover
   lift. The chunky-skeuo direction the user picked wants exactly this.
5. **HUD prune** — audit every element against the 10-second rule;
   dev-tier readouts (ent-counts, perf, loco columns on scoreboard)
   already hide correctly — extend the discipline to reticle readouts.
6. **PLAY dominance** — the side menu's core row is small; consider a
   stronger primary action treatment (size or hue), not a new surface.

## Watch-items (do NOT copy)

- Krunker's settings menu was a meme for a reason — ours is already
  better; don't flatten it toward theirs.
- Narrow One's minimalism would starve a skiing game — speed/energy
  need presence they never had to afford.
- Chunky skeuo ≠ heavy chrome: Tribes Ascend's failure mode was panels
  that weighed more than the game under them. Keep fills saturated,
  keep borders thin-ish, keep text readable before bevels.

## Sources

Audit performed against `client/src/ui/hud/hud.css` (region contract,
~70 `rgba(` literals pending sweep), `client/src/ui/chrome.css`
(fully tokenized), `client/index.html` (menu markup), and live
competitor builds from memory; benchmark notes predate this doc and
are qualitative, not measured.
