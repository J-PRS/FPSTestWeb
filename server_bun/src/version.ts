import { readFileSync } from 'node:fs';

// Manifest version, read once at boot so /health and /serverinfo can say
// which code a box runs. CI advances the patch on every push to master.
function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    // An image built without the manifest must still boot; the version is informational.
    return '0.0.0';
  }
}

// Deploy-stamped build hash — _tools/deploy_server.sh writes build.txt
// next to this dir with the source commit, so /health can report exactly
// what the box runs (the box has no .git). Absent locally = dev build.
function readBuild(): string | null {
  try {
    const s = readFileSync(new URL('../build.txt', import.meta.url), 'utf8').trim();
    return s || null;
  } catch {
    return null;
  }
}

export const SERVER_VERSION = readVersion();
export const SERVER_BUILD = readBuild();
