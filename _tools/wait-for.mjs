#!/usr/bin/env node
// _tools/wait-for.mjs - poll a URL until HTTP 200 (or timeout).
//
// CLI:  node _tools/wait-for.mjs <url> [timeoutMs=30000] [intervalMs=500]
//       exits 0 on ready, 1 on timeout, 2 on bad args.
// Module: import { waitForUrl } from './wait-for.mjs'
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

export async function waitForUrl(url, { timeoutMs = 30000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) return true;
    } catch { /* not ready yet */ }
    await sleep(intervalMs);
  }
  return false;
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  const url = process.argv[2];
  const timeoutMs = Number(process.argv[3]) || 30000;
  const intervalMs = Number(process.argv[4]) || 500;
  if (!url) {
    console.error('usage: wait-for.mjs <url> [timeoutMs=30000] [intervalMs=500]');
    process.exit(2);
  }
  const ok = await waitForUrl(url, { timeoutMs, intervalMs });
  console.log(ok ? `[wait-for] ready: ${url}` : `[wait-for] TIMEOUT after ${timeoutMs}ms: ${url}`);
  process.exit(ok ? 0 : 1);
}