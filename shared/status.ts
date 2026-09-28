/**
 * Player status bitmask — toggle-state effects that ride inputMove
 * (client→server) and the tick frame's flag byte (server→client).
 *
 * Bits 1 (isDead) and 2 (skiing) are NOT here: they're part of the same
 * wire byte but owned by movement/death plumbing, not the status channel.
 * Status bits start at 4.
 *
 * Why a bitmask instead of fields: adding a toggle effect used to mean a
 * new field through ~10 layers (protocol, wire, server state, handler,
 * tick diff, client net, remote visual). Now it's: claim a bit below,
 * set it in the client's status computation, handle it in the remote
 * dispatch table. The server relays unknown bits untouched, so a new
 * effect can even ship client-only if no server logic needs it.
 */
export const STATUS = {
  CLOAK: 4,  // invisible to remotes (model, marker, shadow, indicators)
  SHIELD: 8, // energy bubble — damage routes to energy (server: no health damage)
  MEND: 16,  // medkit channel — server regenerates health while up
} as const;

/** Mask of every bit the status channel owns (bits ≥4). */
export const STATUS_MASK = 0xFC;
