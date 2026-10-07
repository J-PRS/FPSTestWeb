# Hosting Costs — 1000 DAU Reference Workload

Date: 2026-10-01. Prices are list prices as of this date; re-check before committing.

## Reference workload

- 1000 DAU, 3 games/player, 20 min/game, 16v16 (32-seat) rooms.
- **1,000 player-hours/day** → ~42 CCU average; realistic daily peak
  **~150-300 CCU** (prime-time concentration) → **5-10 concurrent rooms**.
- Multi-tenancy: one Bun process hosts a named-room lobby; each room is an
  independent Room sim. Empty rooms hibernate (no audience → no tick cost).
- Bandwidth (dominant cost): 20Hz binary tick fanout with interest tiers ≈
  **8-15 KB/s downstream per player** → ~35-55 MB/player-hour →
  **~1.1-1.6 TB/month egress**. CPU is light — Bun is effectively
  single-threaded, so buy fast single-core, not many cores.

## Provider comparison (this workload)

| Provider | Spec | $/mo | Included egress | Fit |
|---|---|---|---|---|
| **Hetzner CX33/CX43** | 4-8 vCPU, 8-16GB | ~EUR 5-12 (~$6-13) | **20 TB** | Best value — covers workload ~10x |
| **Oracle Always Free** | 4 OCPU ARM64, 24GB | **$0** | ~10 TB | Free; ARM Bun + signup friction |
| **DigitalOcean droplet** | 4GB/2vCPU or 8GB/4vCPU | $24-48 | 4-6 TB | Works; 2-4x Hetzner price |
| **AWS Lightsail** | 4GB/2vCPU | $24 | 4 TB | OK; real EC2 ~$160+ (egress $0.09/GB kills it) |
| **Fly.io** | shared-cpu + metered egress | ~$45-80 | ~$0.03-0.05/GB | Works; egress fees hurt at TB scale |
| **Edgegap / per-match fleets** | orchestrated sessions | $$$ | — | Wrong model: we're a persistent lobby, not per-match containers |

Extras: domain ~$10/yr, Cloudflare free tier for TLS + DDoS cover.
TURN creds via `FPS_ICE_SERVERS` (coturn on the same box, or a free
metered tier) or ~15-20% of strict-NAT players can't P2P.

## Competitor architectures

- **Narrow One** (Pelican Party, public devlog 2023): fleet of **$4/mo
  DigitalOcean droplets**, ~200 players per box. A monitor app boots a
  droplet when one passes 200 players and kills it under 100
  (9 servers ≈ 1,023 CCU). Architecture: many small nodes + autoscaler.
- **Krunker**: Cloudflare front; game servers are bare-metal/dedicated
  boxes in player regions (provider unpublished — inference). At their
  scale, regional latency coverage is the requirement, not elasticity.

**Are their choices optimal in late 2026?**

- The *architecture* (many small nodes + scaler) is the standard .io
  playbook and is the correct answer to our single-process ceiling —
  but only once we need it.
- The *provider choice* (DO $4 fleet) is not cost-optimal anymore: a $4
  droplet is 1 vCPU/512MB; Hetzner gives ~4x machine + 10x bandwidth per
  dollar. DO sells ecosystem polish now, not price.
- At our workload (~300 peak CCU) a fleet buys failure domains and
  complexity without saving money — autoscaling-to-zero doesn't help
  when 2+ boxes must be always-on anyway. One CX43 covers it ~10x over.

## Recommendation

**Hetzner CX43 (~EUR 10/mo)** as the beta box — 8 vCPU/16GB/160GB +
20TB included traffic. Oracle Always Free as the $0 alternative
(ARM64, tolerable friction). Cloudflare free tier in front.

## Bootstrapped-indie playbook (researched 2026-10)

What small global-multiplayer games actually run on:

- **Agar.io / Diep.io** (Matheus Valadares, HN): one CPU-core box per
  room process; on 40+ core dedicated boxes he ran 40+ processes.
  Custom WebSocket stack; ~190 players/agar room, 72/diep room.
  Deliberately avoided cloud for bandwidth cost.
- **Slither.io** (Steve Howse): avoided AWS/Google — "incredibly
  expensive for the amount of bandwidth" — scrambled for cheap regional
  hosts during virality; ~$15k/mo across 158+ servers at peak.
- **DDNet / Teeworlds**: official servers in ~9 countries on cheap KVM
  VPS + community-hosted servers (they ship the server binary, players
  host their own). Main pain: booter DDoS getting them kicked off
  hosts without protection.
- **Xonotic-class open-source games**: fully community-hosted — dev
  infra cost is $0; the community runs the rooms.

Patterns:

1. **Cheap regional VPS matched to demand** — everyone converges here.
   Nobody bootstrapped pays cloud egress rates; bandwidth is the bill.
2. **Community-hosted servers = free global coverage.** Ship the server
   (our Dockerfile is already one command) and communities run regional
   rooms for $0 — solves "US rooms before US revenue exists" and builds
   community. THE indie answer.
3. **Fat shared boxes** (agario's 40 rooms/box) = cheapest per-player at
   scale — our multi-room lobby is already that shape.
4. **Bare metal beats VPS ~10x** at sustained scale — graduation move,
   not a starting move.

Applied: offer the self-hostable server early (community runs US/Asia
rooms free), one Hetzner EU box as the official lobby, official
regional boxes only where a community sustains real CCU. Caveats:
client code WILL get ripped → keep the server authoritative (we do);
expect booter DDoS once visible → Cloudflare in front is non-optional.

## Scaling thresholds (when the model changes)

- **>2-3k CCU**: single-core tick loop saturates → shard rooms across
  processes/boxes (the Narrow One pattern — just on Hetzner-class
  hardware). Rooms are already independent sims; sharding is a routing
  problem, not an architecture rewrite.
- **Transoceanic DAU**: latency demands regional servers → per-region
  nodes + geo routing. Krunker territory.
- **Egress math**: at ~50 MB/player-hour, each +1000 player-hours/day
  adds ~1.5 TB/mo — track the 20TB included cap before CPU becomes
  the limit.
