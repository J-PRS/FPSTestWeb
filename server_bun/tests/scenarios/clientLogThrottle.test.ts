import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clientLogRoute } from '../../src/clientLogs.ts';

const req = () => ({ headers: new Headers(), text: async () => '[WARN] probe' }) as unknown as Request;
const cors = (_b: BodyInit | null, init?: ResponseInit) => new Response(null, init);
// Appends go to a throwaway dir — the route's default LOGS_DIR is the
// live logs/, and 1400 probe lines per suite run drowned real warns.
const dir = mkdtempSync(join(tmpdir(), 'clientlog-'));
const call = (ip: string) => clientLogRoute(req(), cors, ip, dir);

// postIps evicts the eldest entry past 1024 rather than clearing the map.
// Any eviction can reset SOME window — the property that matters is that
// churn must not reset EVERYONE (the old clear() amnestied all live IPs).
describe('clientLogRoute post throttle', () => {
  test('address churn does not amnesty a recently throttled IP', async () => {
    // Flood the map past its 1024-entry bound with one-post churn IPs.
    for (let i = 0; i < 1100; i++) await call(`10.0.${(i >> 8) & 255}.${i & 255}`);
    // Throttle a spammer — its entry is the newest, so further churn
    // evicts the stale churn entries, never its live window.
    for (let i = 0; i < 25; i++) await call('10.9.9.9');
    const blocked = await call('10.9.9.9');
    expect(blocked.status).toBe(429);
    for (let i = 0; i < 200; i++) await call(`10.1.${(i >> 8) & 255}.${i & 255}`);
    const stillBlocked = await call('10.9.9.9');
    expect(stillBlocked.status).toBe(429);
  });

  test('a declared-giant body is refused before it buffers', async () => {
    // content-length alone must 413 — waiting for the real size means
    // an honest giant already buffered into memory.
    let read = false;
    const giant = {
      headers: new Headers({ 'content-length': String(600 * 1024) }),
      text: async () => { read = true; return ''; },
    } as unknown as Request;
    const res = await clientLogRoute(giant, cors, '10.5.5.5', dir);
    expect(res.status).toBe(413);
    expect(read).toBe(false);

    // A lied header still hits the real cap after buffering.
    const liar = {
      headers: new Headers({ 'content-length': '10' }),
      text: async () => 'x'.repeat(600 * 1024),
    } as unknown as Request;
    const res2 = await clientLogRoute(liar, cors, '10.5.5.6', dir);
    expect(res2.status).toBe(413);
  });
});
