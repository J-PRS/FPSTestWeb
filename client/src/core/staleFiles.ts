// Stale-code registry (noreload dev mode): the vite stale-notify plugin
// swallows reloads and pushes 'stale:changed' events — main.ts feeds them
// here so the corner badge AND the Alt+Q dump can both report how much
// new code is waiting behind Ctrl+R.
const files = new Set<string>();
let count = 0;

export function noteStale(paths: string[] | undefined, n: number): void {
  count += n;
  for (const f of paths ?? []) {
    // Keep just the repo-relative tail — full absolute paths bury the signal.
    const m = f.replace(/\\/g, '/').match(/(?:client|shared|server_bun|maps)\/.+$/);
    files.add(m ? m[0] : f.split('/').pop() ?? f);
  }
}

export function staleCount(): number {
  return count;
}

/** Alt+Q row: total plus up to 8 names so a paste answers "reload for
 *  WHAT" without guessing. */
export function staleLine(): string {
  if (!count) {return 'staleCode: 0 files changed';}
  const names = [...files].slice(0, 8);
  return `staleCode: ${count} file${count === 1 ? '' : 's'} changed${names.length > 0 ? ` — ${names.join(', ')}${files.size > 8 ? `, +${files.size - 8} more` : ''}` : ''} (Ctrl+R)`;
}
