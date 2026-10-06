// Content-table fingerprint for the demo header.
//
// The file stores enum-index references, not names: creature targetTypes are
// 64 + index into DEMO_SPECIES, deploy/pickup kinds index DEMO_DEPLOY_KINDS /
// DEMO_PICKUP_KINDS, and ball targetType is an index into the shared variant
// arrays. A reorder or edit of any of those tables silently remaps every demo
// ever recorded — the one durability failure the format can't detect by
// itself. header.tableHash makes it loud: the writer stamps crc32 of the
// canonical table serialization, and demovalidate compares it against the
// running build so a drifted table surfaces as a warning on old clips.
import { BALL_VARIANT_HEALTH, BALL_VARIANT_SCALE } from '../../../shared/ballSim.js';
import { DEMO_DEPLOY_KINDS, DEMO_PICKUP_KINDS, DEMO_SPECIES } from './types.js';
import { crc32 } from './demoWriter.js';

export function demoTableHash(): number {
  const canonical = [
    DEMO_SPECIES.join(','),
    DEMO_DEPLOY_KINDS.join(','),
    DEMO_PICKUP_KINDS.join(','),
    BALL_VARIANT_SCALE.join(','),
    BALL_VARIANT_HEALTH.join(','),
  ].join('|');
  return crc32(new TextEncoder().encode(canonical));
}
