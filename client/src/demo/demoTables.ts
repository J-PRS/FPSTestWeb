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
// demoTableHash moved to demoWriter.ts to break the demoWriter <-> demoTables
// cycle (demoTables imports crc32 from demoWriter). Re-export for callers
// that still import it from here.
export { demoTableHash } from './demoWriter.js';
