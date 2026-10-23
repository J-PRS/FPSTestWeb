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

export const SERVER_VERSION = readVersion();
