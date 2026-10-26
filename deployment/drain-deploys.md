# Drain deploys — zero-disconnect releases

Problem: every deploy kills the process → rooms die, players disconnect.
`DEPLOYMENT/server.md` already flags it. Fix without serialization:
**drain the old build instead of killing it.**

## Pattern (researched — Unity Multiplay A/B, PlayServ snapshot)

Two builds can coexist on the box. A deploy becomes:

1. deploy_server.sh pushes build N+1, starts it on a second port
2. matchmaker marks build-N rooms `draining` — /join skips them,
   existing players stay
3. Old process exits when its last room ends (or a grace timeout)
4. New process already serves new joins — players never see a cut

What players experience: a match ends normally, their next join lands
on the new build. No disconnect, no lost state — the room lifecycle
itself does the migration.

## Implementation sketch

- Room gains `draining` flag; matchmaker filter: skip draining rooms
  in /join + quickRoom.
- Deploy flow: new process binds port+1 → POST /admin/drain on old →
  old exits when rooms empty → port swap (or Caddy picks up both).
- Edge: bots-only rooms drain instantly (no humans to wait for).

## The harder alternative (deferred)

Snapshot room state → new process restores → players reconnect in a
grace window. simJournal is half the serializer; costs the state
between snapshot and restart. Only needed if drain-waiting is ever
unacceptable — it isn't for 10-minute matches.

Refs: Unity Multiplay zero-downtime (A-B build pattern);
PlayServ replication docs (declared state + grace rejoin).
