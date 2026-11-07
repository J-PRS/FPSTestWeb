#!/usr/bin/env node
/**
 * Import-boundary ratchet — client/src must not import server_bun.
 *
 * The adjudication layer (PlayerManager, MessageHandler, claim
 * validation, Room* sims) is the moat; a client that imports it ships
 * the working authority to every visitor. The P2P path proved the leak
 * class is real — this gate keeps it from returning silently.
 *
 * Allowlist:
 *   - p2p/host.ts — statically gated behind P2P_ENABLED; its imports are
 *     tree-shaken out of prod builds, so the boundary holds where it
 *     matters (the shipped bundle, not the source).
 *   - test files — vitest imports run under the test runner, never in a
 *     shipped bundle.
 *
 *   node utils/_moatcheck.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '../client/src');
const ALLOW = new Set([
  'networking/p2p/host.ts',
]);
const TEST = /(__tests__|\.test\.|\.spec\.)/;

const hits = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.(ts|tsx|js|jsx|mjs)$/.test(e.name)) { continue; }
    const rel = relative(CLIENT, p).replace(/\\/g, '/');
    if (ALLOW.has(rel) || TEST.test(rel)) { continue; }
    const src = readFileSync(p, 'utf8');
    // Match any import specifier that reaches server_bun — static,
    // dynamic, or type-only (a leaked type import today is a leaked
    // module tomorrow).
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]*server_bun[^'"]*)['"]/g)) {
      hits.push(`${rel} -> ${m[1]}`);
    }
  }
};
walk(CLIENT);

if (hits.length) {
  console.error(`[moatcheck] ${hits.length} client->server_bun import(s) outside the allowlist:`);
  for (const h of hits) { console.error(`  ${h}`); }
  console.error('[moatcheck] adjudication stays server-side; share code via shared/ or gate it like P2P_ENABLED.');
  process.exit(1);
}
console.log('[moatcheck] clean — no ungated client->server_bun imports');
