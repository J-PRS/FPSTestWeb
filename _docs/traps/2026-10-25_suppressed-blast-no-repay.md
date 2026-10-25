# Trap: suppressed predicted blast never repaid on the local branch

**Symptom:** direct hits on bodies produce NO visible explosion for the
shooter — the disc lands dead-center and silently damages. Replica
shells (other players' shots) explode fine; only YOUR direct hits are
invisible.

**Root cause:** `combat/impact.ts` suppresses the predicted blast on any
body-hit shell (`ghostBodyPop = true`) because the wire `gone` edge owns
the real detonation — "the wire owes us the blast." The repayment in
`net/projectiles.ts` painted it **only** on the `remoteProjectile`
branch; the `localProjectile` branch (your own predicted shells) called
`explode()` without repainting the suppressed blast.

**The rule:** when a suppression flag delegates an effect to a later
wire event, the repayment must cover EVERY shell class that suppression
touched. `ghostBodyPop` was set on the shared impact path (local +
replica) but repaid on one branch only.

**How it hides:** the suppression is silent-by-design — nothing logs a
skipped blast, and replicas keep working because they take the OTHER
branch. Only the shooter's own direct hits vanish, which reads like a
server/VFX problem, not a client bookkeeping bug.

**Fix:** `net/projectiles.ts` — the local-shell `gone` handler now
repaints `ghostBodyPop` blasts at the stamped contact point, same as
the replica branch. Client-side fix; no server change.

**Check if it regresses:** shoot a bot center-mass in a real match —
the blast must paint at the wire contact point, not skip.
