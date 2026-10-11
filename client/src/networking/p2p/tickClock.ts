/**
 * Clock source for the P2P host. Window timers throttle to ~1Hz in
 * hidden tabs, which would stall the whole session for guests whenever
 * the host alt-tabs. Worker timers aren't subject to background-tab
 * throttling, so the 20Hz cadence survives — the sim itself still runs
 * on the main thread off the posted beats.
 */
const timer = setInterval((): void => postMessage(0), 50);
onmessage = (e): void => { if (e.data === 'stop') {clearInterval(timer);} };
