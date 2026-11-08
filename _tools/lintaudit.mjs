#!/usr/bin/env node
// _tools/lintaudit.mjs — type-aware oxlint pass (.oxlintrc.audit.json).
//
//   node _tools/lintaudit.mjs [oxlint args...]
//
// oxlint resolves the tsgolint bin as <cwd>/node_modules/.bin/tsgolint,
// but the toolchain only exists under client/ - so this wrapper runs the
// client-installed oxlint from the repo root and points
// OXLINT_TSGOLINT_PATH at the matching .bin shim (.cmd on Windows).
// Deliberately slow (type-aware); advisory, not part of check.sh.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const shim = join('client', 'node_modules', '.bin',
  process.platform === 'win32' ? 'tsgolint.cmd' : 'tsgolint');
const shimPath = join(REPO, shim);
if (!existsSync(shimPath)) {
  console.error(`[lintaudit] tsgolint shim missing: ${shimPath} - run npm install in client/`);
  process.exit(2);
}

const args = process.argv.slice(2);
const r = spawnSync(process.execPath,
  [join(REPO, 'client/node_modules/oxlint/bin/oxlint'),
    ...(args.length ? args : ['client/src', 'server_bun/src', 'shared',
      '--config', '.oxlintrc.audit.json']),
  ], {
  cwd: REPO,
  env: { ...process.env, OXLINT_TSGOLINT_PATH: shimPath },
  stdio: 'inherit',
});
process.exit(r.status ?? 1);
