// Auto-reload when a new client deploys: _surge_deploy.bat stamps
// public/version.txt each build; poll it and reload on change so
// connected clients don't run a stale bundle against a live server.
// Skipped on localhost (dev rebuilds shouldn't yank the page).
export function watchDeployVersion(): void {
  if (/^(localhost|127\.|192\.168\.|10\.)/.test(location.hostname)) return;
  let baseline: string | null = null;
  const poll = async (): Promise<void> => {
    try {
      const r = await fetch('/version.txt', { cache: 'no-cache' });
      if (!r.ok) return;
      const v = (await r.text()).trim();
      if (baseline === null) { baseline = v; return; }
      if (v !== baseline) location.reload();
    } catch { /* offline/transient — try again next tick */ }
  };
  void poll();
  setInterval(poll, 60000);
}
