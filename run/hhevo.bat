@echo off
rem hhEvo — headhunt evolution pit (tools/sweeps/hhEvo.ts).
rem Team-genome evolution: each genome = 5 skill-axis tiers
rem (aim/move/react/jitter/temper: e/m/h/i) + full-arsenal kit
rem (near/mid/far/belt/side/perk). Hall-of-fame round-robin pool,
rem fitness = held-token margin, sides swapped, worst-map admission.
rem
rem Usage:   run\hhevo.bat            (defaults below)
rem          run\hhevo.bat --gens 30 --pop 8 --mins 5 --wall 3600
rem
rem Args (all optional, --name value):
rem   --pop N       pool size, default 6. 8 = 28 pairings/gen.
rem   --gens N      generations, default 3.
rem   --mins N      sim-minutes per match, default 4. 2 = fast screening
rem                 (biases toward aggression), 5+ = honest fitness.
rem   --per N       bots per team, default 6.
rem   --matches N   matches per pairing per map (sides alternate), dflt 2.
rem   --maps a,b    map matrix — worst-map margin is fitness, dflt flat.
rem                 'all' = every maps/*.json with a resolvable non-t2
rem                 bin (~29). --map a works as shorthand.
rem   --mapsel M    'matrix' (dflt, every pairing on every map) or
rem                 'random' — each match draws a seeded map index.
rem                 Random + all = map-generalization runs.
rem   --seed N      master seed, default 1. Per-match seeds derive from
rem                 it — identical results at any --workers count.
rem   --wall N      wall-clock cap in seconds, default 1800. Aborts
rem                 cleanly mid-run (gen-granular — a gen's match batch
rem                 always completes once dispatched).
rem   --workers N   parallel bun children sharding the gen's matches.
rem                 ~9x at 12 workers on a 24-core box; ~800 sim-min per
rem                 wall-min. Machine has 24 logical cores — 12-16 sane.
rem   --race N      skip a pairing's remaining matches once |margin|>N.
rem                 0=off. UNVALIDATED vs late hoard-scatter comebacks —
rem                 screening-tier evidence only, keep 0 for conclusions.
rem   --tie N       pairings with worst-map margin within +-N get extra
rem                 matches. Default = 3*mins (coin-flip scale).
rem   --tiebreak N  extra matches per map per tiebreak round, dflt 1.
rem   --mode M      dm/ctf/headhunt/nuggets/conquest/rabbit (dflt
rem                 headhunt) or 'chaos' — each match draws a seeded
rem                 mode; fitness is each mode's own score. Duel =
rem                 --mode dm --per 1. CTF/conquest need maps whose
rem                 spec provides stands/zones or they degrade to dm.
rem   --qd            MAP-Elites archive: (agg,mob,air) cells each keep
rem                 their best genome across gens — monoculture can't
rem                 evict specialists. Adds per-gen 'archive' records +
rem                 a final 'roster' (tier hard/med/easy personalities)
rem                 and a 'freq' gene-occupancy record (balance signal).
rem   --arena N     flat-arena radius, default 300.
rem   --genomes F   seed pool from a JSON genome-array file.
rem   --pairs spec  replay mode, no evolution: 'gnameA,gnameB;gnameC,gnameD'
rem                 gname = 'immih:Shotgun+Chaingun+Mortar+Grenade+Revolver/none'
rem                 (tier letters : weapons+perk). Any board row replays.
rem   --out F       JSONL under tools/sweeps/out/, default hhevo.jsonl.
rem                 ~1.5KB/gen — boards + exploiters only, never per-match.
rem   --eval F      worker mode (internal — parents spawn this; don't use).
rem
rem Output columns: margin=sum of worst-map pairing margins, worst=
rem exploitability floor (worst single pairing), Nash % = fictitious-play
rem weight over the payoff matrix (blend > dominance = healthy meta).
rem Regrab-lock experiments: set FPS_HH_REGRAB_LOCK_S=N (env-gated, off
rem by default). Profile buckets: set FPS_HHPROF=1.
rem
rem Findings live in _docs/2026-10-19_HHEVO_FINDINGS_*.md
setlocal
cd /d "%~dp0.."
set PATH=%PATH%;%USERPROFILE%\.bun\bin
if "%~1"=="" (
  bun _tools/sweeps/hhEvo.ts --pop 8 --gens 10 --mins 5 --matches 2 --maps flat,rimrock --workers 12
) else (
  bun _tools/sweeps/hhEvo.ts %*
)
endlocal
