// Bot callsigns — one pool shared by the client-side team bots
// ('bot:VEKTOR-A') and server bots ('BOT-VEKTOR-03') so a roster reads
// like pilots, not like the map name glued to a counter.
export const BOT_NAMES = ['VEKTOR', 'SLATE', 'MARA', 'DUNE', 'PICO', 'RANCHO', 'OZONE', 'TALUS', 'BRICK', 'SABLE'];

/** Both hosting paths tag bot ids — 'bot:' (client-hosted GameBot) and
 *  'BOT-' (server room sim). HUD reads this to mark bots vs humans. */
export function isBotId(id: string): boolean {
  return id.startsWith('bot:') || id.startsWith('BOT-');
}
