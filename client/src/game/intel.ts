// Client-side IFF contact store - fed ONLY by the server's 'intel'
// message (~1Hz). The server owns every expiry; this map is a render
// cache, not a truth source. A hacked client gains nothing: it can only
// draw contacts the server already stamped for it.
//
// seen  = detected in the latest sweep - marker rides the live body.
// mem   = lingering contact - marker sits at last-known, ghosted 50%.
// Channel dead >2.5s (disconnect, old server) = empty set.

import type { IntelContact } from '../../../shared/protocol.js';

export interface IntelMark extends IntelContact {
  /** false = remembered contact (mem list) - ghost marker at last-known. */
  fresh: boolean;
}

const contacts = new Map<string, IntelMark>();
let at = 0;
const STALE_MS = 2500;

export function setIntel(seen: IntelContact[], mem: IntelContact[]): void {
  contacts.clear();
  for (const c of seen) {contacts.set(c.id, { id: c.id, x: c.x, y: c.y, z: c.z, fresh: true });}
  for (const c of mem) {
    if (!contacts.has(c.id)) {contacts.set(c.id, { id: c.id, x: c.x, y: c.y, z: c.z, fresh: false });}
  }
  at = performance.now();
}

/** The contact this client may mark `id` with, or undefined when the
 *  server says it's not detected (or the feed went quiet). */
export function intelContact(id: string): IntelMark | undefined {
  if (at === 0 || performance.now() - at > STALE_MS) {return undefined;}
  return contacts.get(id);
}
