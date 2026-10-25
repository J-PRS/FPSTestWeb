# Oracle Cloud: hosts, limits, networking, CLI

Scope: the Oracle account, instances, networking and the OCI CLI on Windows.
Status and index: `readme.md`. Server operations: `server.md`.

## Hosts

| Box | Shape | Public IP | Role | Notes |
|-----|-------|-----------|------|-------|
| `anabatic-server` | VM.Standard.A1.Flex (ARM64) | **92.5.61.55** | game server | 2 OCPU / 12 GB, Oracle Linux 9.8 aarch64, AD-1 |
| `anabatic-server` | VM.Standard.E2.1.Micro (x86) | 92.5.63.91 | spare | ~500 MB usable RAM (crashkernel reserves ~450 MB), AD-3. WT cannot load (glibc 2.34 vs 2.38) |
| `anabatic-server` | A1.Flex | none | dead | first failed attempt, TERMINATED. Still listed. Safe to delete |

Both live instances have ephemeral public IPs. An ephemeral IP stays with a running
instance but is released on termination. Reserved IPs are not used and cost money.

## Limits (Always Free)

- A1: 2 OCPU and 12 GB total for the tenancy. The old 4/24 figures are no longer free.
- Micro: 2 instances.
- Block storage: 200 GB across all boot and block volumes. Each boot volume is about 47 GB.
- Outbound transfer: listed as 10 TB/month on Oracle's free-tier page. Taken from memory, not re-checked.
- Home region `eu-frankfurt-1`, locked at account creation. Always Free resources exist only there.

## Billing

- The card is identity verification. Oracle's docs: "Your credit card will not be
  charged unless you upgrade your account."
- Tenancy audit 2026-10-24: no load balancers, NAT gateways, databases, buckets,
  reserved IPs or extra block volumes.
- Do not click Upgrade in Billing. Accounts idle 30 to 60 days can be suspended. Oracle's
  exact idle rule for this account is not verified here, so log into the console periodically.

## Networking

Resources (created via CLI): VCN `anabatic-vcn` 10.0.0.0/16, internet gateway
`anabatic-igw`, route table `anabatic-rt` (0.0.0.0/0 to IGW), public subnet
`anabatic-subnet` 10.0.0.0/24, security list `anabatic-sl`.

Security list ingress (as of 2026-10-24), replaced as one JSON file:

| Protocol | Port | Purpose |
|----------|------|---------|
| TCP | 22 | SSH |
| TCP | 80 | Let's Encrypt http-01 and redirect |
| TCP | 443 | HTTPS (Caddy) |
| UDP | 443 | WebTransport via firewall forward |

Egress: all.

Port 8000 (TCP and UDP) was removed on 2026-10-24. The game server is reached only through
Caddy on 443. Port 9443/udp was removed on 2026-10-24 (WebTransport goes through the 443 forward,
which firewalld redirects locally to 9443). WT was re-verified with 9443 closed.

**Replacing the list:** `update --ingress-security-rules` overwrites the whole list.
Keep the full set in one file (`C:/Users/JPrice/ingress3.json` pattern) and always
include every rule, or you silently delete SSH and the others.

Host firewall (firewalld, zone `public`): services `ssh http https dhcpv6-client`;
no ports open; forward `443/udp -> 9443` (local redirect). The security list and
the host firewall are separate. A port must be open in both.

## OCI CLI (Windows)

- Binary: `C:\Program Files (x86)\Oracle\oci_cli\oci.exe` (3.90.3, MSI install). Not on
  the Git Bash PATH, so call it by full path.
- Config: `C:\Users\JPrice\.oci\config`. Contains the user, fingerprint, tenancy, region
  and `key_file`. The key file is `C:\Users\JPrice\.oci\oci_api_key.pem`. Keep it private.
- `key_file` must be a Windows path. POSIX `/c/Users/...` paths fail.
- Auth check: `oci iam region list`.
- JSON arguments: use `file://C:/path.json`. Inline arrays with escaped quotes return
  HTTP 400 `CannotParseRequest`.
- JMESPath queries: single quotes in bash. Escaped JMESPath in PowerShell has broken
  before. Keep queries simple.
- The `oci.exe` Windows permission check can fail under some PowerShell sessions. Simplify the query rather than fighting it.

## SSH

- Key pair: `C:\Users\JPrice\.ssh\oci_anabatic` (private, mode 600) and `.pub`.
- Connect: `ssh -i C:/Users/JPrice/.ssh/oci_anabatic opc@92.5.61.55`. Use forward slashes.
- User `opc` on both boxes.

## Capacity (A1)

Frankfurt returned "Out of capacity" for A1 on the first attempts across all three ADs.
The A1 came up on a retry loop rotating ADs (script `~/retry_a1.sh` on the laptop; not
needed now). If a replacement A1 is ever needed and Frankfurt is full again, the same loop
works. Stop it on success, and stop it on any error that is not a capacity error.

## Host hardening (2026-10-24)

- `rpcbind` disabled (unused; was listening on 111).
- `fail2ban` installed from EPEL (`ol9_developer_EPEL`, enabled for this install only) with an
  `sshd` jail (`backend = systemd`, 5 failures in 10 min, 1 h ban). Check: `sudo fail2ban-client status sshd`.
- SSH: password auth off, root key-only (`permitrootlogin without-password`).
- Still open: the game server binds `0.0.0.0:8000` (blocked externally, but `127.0.0.1` would be stricter).

## History

- 2026-10-24: Frankfurt home region confirmed. A1 created in AD-1 at 2 OCPU / 12 GB.
  Micro created in AD-3. Subnet and security list created via CLI after a Windows quoting
  failure fixed with a JSON file. Public IPs assigned.
