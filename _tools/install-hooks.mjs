#!/usr/bin/env node
// _tools/install-hooks.mjs - point git at the tracked .githooks/ dir so
// the pre-commit/pre-push guards ship with the repo instead of being
// local-only. Run once after clone (also wired to `npm run prepare`).
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
if (!existsSync(join(root, '.githooks', 'pre-commit'))) {
  console.error('[install-hooks] .githooks/pre-commit missing - abort');
  process.exit(1);
}
try {
  execSync('git config core.hooksPath .githooks', { cwd: root, stdio: 'inherit' });
  console.log('[install-hooks] core.hooksPath = .githooks  (pre-commit + pre-push active)');
} catch (e) {
  console.error('[install-hooks] failed:', e.message);
  process.exit(1);
}