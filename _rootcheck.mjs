#!/usr/bin/env node
/**
 * Root-clutter gate — part of `npm run check` in client/.
 * Lists every repo-root entry NOT on the allowlist and fails if any
 * appear. The point is a deliberate "does this belong at root?" —
 * scratch probes, captures, and stray dumps keep landing beside the
 * real project files. Move flagged entries into a subfolder (do not
 * delete) or extend ALLOW below when the entry is genuinely root-level.
 */
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

const ALLOW = new Set([
  // versioned project files
  'AGENTS.md', 'ROADMAP.md', 'TASKS.md', 'TEST_PLAN_bots.md', 'TEST_PLAN_demo.md',
  'changelog.txt', 'Dockerfile', 'stryker.vitest.config.ts', '_rootcheck.mjs',
  // project dirs
  '.agents', '.devin', '.git', '.github',
  '_DEMO', '_docs', '_ref', '_reference', '_reports', '_tmp', '_tools', '_zzz',
  'ZZZ_ROOT', 'TEMP_WEBual', 'build', 'client', 'concepts', 'demo', 'demos_flag',
  'demos_rich', 'demos_out', 'combo_clips', 'docs', 'logs', 'maps', 'node_modules',
  'reference', 'screenshots', 'screenshots_legacy', 'screenshots_web',
  'server_bun', 'shared', 'terrain_gen', 'tools', 'traps', 'zzz',
]);

const ALLOW_RE = [
  /^\.gitignore$/, /^\.dockerignore$/, /^\.oxlintrc.*\.json$/,
  /^_.*\.bat$/,          // run/deploy scripts are conventionally _-prefixed
  /^run(_all)?\.(bat|ps1)?$/, /^run$/,
];

const flagged = readdirSync(ROOT, { withFileTypes: true })
  .map((d) => d.name)
  .filter((n) => !ALLOW.has(n) && !ALLOW_RE.some((re) => re.test(n)));

if (flagged.length) {
  console.log(`\n[rootcheck] ${flagged.length} root entr${flagged.length === 1 ? 'y' : 'ies'} that look like they don't belong at repo root:`);
  for (const f of flagged.sort()) console.log(`  - ${f}`);
  console.log('Move them into a subfolder (do NOT delete) or extend the allowlist in _rootcheck.mjs.\n');
  process.exit(1);
}
console.log('[rootcheck] root is clean');
