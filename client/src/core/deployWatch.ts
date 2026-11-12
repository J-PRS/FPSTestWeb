// Auto-reload when a new client deploys: _surge_deploy.bat stamps
// public/version.txt each build; poll it and reload on change so
// connected clients don't run a stale bundle against a live server.
// The reload defers to the next natural break (whenIdle — the
// intermission between matches) so a deploy doesn't yank a live
// match; graceMs bounds the wait. Skipped on localhost (dev rebuilds
// shouldn't yank the page).
const isLocal = /^(localhost|127\.|192\.168\.|10\.)/.test(window.location.hostname);
let baseline: string | null = null;

/** Fetch /version.txt; 'new' when the stamp changed, 'same' when it
 *  matches/set, 'unknown' when the check itself failed (never blocks). */
async function checkVersion(): Promise<'new' | 'same' | 'unknown'> {
  try {
    const r = await fetch('/version.txt', { cache: 'no-cache' });
    if (!r.ok) {return 'unknown';}
    const v = (await r.text()).trim();
    if (baseline === null) { baseline = v; return 'same'; }
    return v === baseline ? 'same' : 'new';
  } catch { return 'unknown'; }
}

/** Admission check — run before dialing a join/reconnect. A new deploy
 *  mid-session reloads AT the connect boundary (the client hasn't been
 *  admitted yet, so it's a free migration point — the match continues
 *  server-side either way). */
export async function checkDeployNow(): Promise<void> {
  if (isLocal) {return;}
  if (await checkVersion() === 'new') {window.location.reload();}
}

// Boot fetch — even on localhost the Alt+Q dump prints whatever stamp
// the server served this build as; 'unknown' stays '?'.
void checkVersion();
export function deployStamp(): string { return baseline ?? '?'; }

export function watchDeployVersion(opts: { whenIdle?: () => boolean; graceMs?: number } = {}): void {
  if (isLocal) {return;}
  const poll = async (): Promise<void> => {
    if (await checkVersion() === 'new') {
      // New build — reload at the next natural break (intermission:
      // match over, next not started), not mid-match. No idle
      // predicate or grace expired → reload now.
      const grace = opts.graceMs ?? 90_000;
      const t0 = Date.now();
      const iv = setInterval((): void => {
        if (!opts.whenIdle || opts.whenIdle() || Date.now() - t0 > grace) {
          clearInterval(iv);
          window.location.reload();
        }
      }, 1000);
    }
  };
  poll();
  setInterval(poll, 60_000);
}
