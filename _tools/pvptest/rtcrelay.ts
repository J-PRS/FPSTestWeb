/**
 * RTC relay soak — the /rtc P2P signalling path never exercised: two
 * sockets in a room must shuttle SDP/ICE to each other, the host gets
 * the 'peer' kick, a third join is refused, and a leave notifies the
 * survivor with 'peer-left'.
 *
 * Usage: bun _tools/pvptest/rtcrelay.ts ws://127.0.0.1:PORT/rtc
 */
const BASE = (process.argv[2] ?? 'ws://localhost:8000/rtc');
const FAIL = (m: string): never => { console.log('FAIL:', m); process.exit(1); };
const ok = (m: string) => console.log('ok —', m);

function rtc(name: string, room: string): Promise<{ ws: WebSocket; msgs: any[] }> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`${BASE}?room=${room}`);
    const msgs: any[] = [];
    ws.onmessage = (ev) => { try { msgs.push(JSON.parse(ev.data)); } catch { msgs.push(ev.data); } };
    ws.onopen = () => res({ ws, msgs });
    ws.onerror = () => rej(new Error(`${name} ws error`));
    ws.onclose = (e) => { if (msgs.length === 0) rej(new Error(`${name} closed ${e.code}`)); };
    setTimeout(() => rej(new Error(`${name} open timeout`)), 5000);
  });
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const room = `PROBE${Math.floor(Math.random() * 1e5)}`;

const a = await rtc('A', room);
await sleep(200);
if (a.msgs[0]?.t !== 'role' || a.msgs[0]?.host !== true) FAIL(`A role msg: ${JSON.stringify(a.msgs[0])}`);
ok('first member = host');

const b = await rtc('B', room);
await sleep(300);
if (b.msgs[0]?.t !== 'role' || b.msgs[0]?.host !== false) FAIL(`B role msg: ${JSON.stringify(b.msgs[0])}`);
if (!a.msgs.some(m => m.t === 'peer')) FAIL('A never got the peer kick');
ok('second member = non-host, host got peer kick');

// Shuttle: A→B and B→A opaque payloads arrive verbatim
a.ws.send(JSON.stringify({ sdp: 'offer-xyz' }));
b.ws.send(JSON.stringify({ ice: 'candidate-1' }));
await sleep(300);
if (!b.msgs.some(m => m.sdp === 'offer-xyz')) FAIL('A→B shuttle lost');
if (!a.msgs.some(m => m.ice === 'candidate-1')) FAIL('B→A shuttle lost');
ok('opaque payloads shuttle both ways');

// Third member refused
const third = new WebSocket(`${BASE}?room=${room}`);
const closed = await new Promise<number>(res => {
  third.onclose = (e) => res(e.code);
  setTimeout(() => res(0), 3000);
});
if (closed !== 1008) FAIL(`third member close code ${closed}, want 1008`);
ok('room cap enforced (1008)');

// Leave → peer-left to the survivor
b.ws.close();
await sleep(300);
if (!a.msgs.some(m => m.t === 'peer-left')) FAIL('A never got peer-left');
ok('peer-left notify on close');

a.ws.close();
console.log('PASS: rtc relay verified over the wire');
process.exit(0);
