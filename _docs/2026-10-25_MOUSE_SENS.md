# Mouse sensitivity reference — our default vs the field

Written 2026-10-25. Sources: SensLab pro statistics (senslab.pro),
findmymouse.com Krunker converter, aiming.pro Krunker guide,
west-games coefficient table, arxiv 2203.12050 ("Mouse Sensitivity
Effects in FPS Targeting Tasks"), fpstrain.us conversion guide.

## Our math

`yaw -= dx * 0.002 * sens` rad/count (playerCtor.ts). At sens 1.0 =
0.11459°/count → at 800 DPI (314.96 counts/cm) **~10cm/360**.

Default `fps-sens: 0.8` (menu shows `8`) → **~12.5cm/360** — casual
flick default inside the real Tribes-player range (~13.8cm measured on
the forums); serious players tune down anyway.

## Measured defaults + pro medians

| Game | Factory default @800dpi | Pro/typical cm/360 |
|---|---|---|
| **Krunker** | **~8.3cm** (yaw 0.13751°/ct) | recommended band 18–30cm (aiming.pro) |
| KRIBES (old) | ~10cm | — |
| **KRIBES (new, sens 0.5)** | **~20cm** | — |
| Apex | ~10cm | median 40 (SensLab) |
| Overwatch 2 | ~11cm | median 34.6 |
| Valorant | ~16cm | median 58.3 |
| CS2 | ~21cm | median 49.5 |
| Fortnite | varies | median 31.7 |

Narrow One: no published constant — bow/charge-shot game, not
community-documented. KRIBES's likely player pool comes from the
Krunker/N1 browser-FPS world where defaults run *very* hot.

## Why defaults are faster than pros play

Every premiere FPS ships a default 2–6× hotter than its own pro median
— "feels responsive" beats "feels like a sim" for new installs, and
arm-aim players always tune down anyway. The arxiv paper notes defaults
sit beyond the top of the pro range entirely.

## Where we landed and why

- Old default (~10cm) was double a typical AAA default and 4–6× the
  aim-focused pro range — wrist-flick territory.
- New default (~20cm) = the recommended fast-FPS band for arena/mobility
  shooters. Slower than Krunker's own factory (8.3cm) — our risk was
  feeling *slow* to the browser-native audience, not fast.
- Saved settings are sticky — only fresh installs see 0.5.

## If we tune again

- 0.35 → ~28.5cm, mid-band typical (Apex/OW medians).
- Below ~0.3 we'd be tac-FPS territory — wrong genre; this game tracks
  40+ m/s crossings, not 15° angles.
