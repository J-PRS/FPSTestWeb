import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { clientLogRoute } from '../../src/clientLogs.ts';

const req = () => ({ text: async () => '[WARN] probe' }) as unknown as Request;
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
});
