// Barrel export for the demo system — only the symbols external code
// imports through here live here; internal modules import siblings
// directly (knip keeps this honest).

export { DemoManager } from './DemoManager.js';
export type { CoolShotEntry } from './DemoManager.js';
