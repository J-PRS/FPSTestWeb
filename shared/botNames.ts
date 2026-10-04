// Bot callsigns — one pool shared by the client-side team bots
// ('bot:VEKTOR') and server bots ('BOT-VEKTOR') so a roster reads
// like pilots, not like the map name glued to a counter. Sized so a
// full lobby never repeats — TTS shouldn't have to say digits, and
// "VEKTOR-04" reads as a serial, not a callsign.
export const BOT_NAMES = [
  'VEKTOR', 'SLATE', 'MARA', 'DUNE', 'PICO', 'RANCHO', 'OZONE', 'TALUS',
  'BRICK', 'SABLE', 'CINDER', 'FOX', 'HALO', 'JINX', 'KESTREL', 'LYNX',
  'MAGMA', 'NIMBUS', 'ONYX', 'PIKE', 'QUILL', 'RIDGE', 'SIEGE', 'TUNDRA',
  'URSA', 'VAPOR', 'WREN', 'YETI', 'ZEPHYR', 'ASPEN', 'BOULDER', 'COMET',
  'DRIFT', 'ECHO', 'FLINT', 'GORGE', 'HAVOC', 'IRIS', 'JET', 'KODIAK',
  'LOKI', 'MESA', 'NOMAD', 'ORBIT', 'PYRE', 'RAM', 'SPIRE', 'TEMPO',
  'UMBRA', 'VIPER', 'WOLF', 'XENO', 'YONDER', 'ZINC', 'AURORA', 'BLITZ',
  'CIPHER', 'DART', 'EMBER', 'FROST', 'GECKO', 'HERON', 'ION', 'JOKER',
];

/** Both hosting paths tag bot ids — 'bot:' (client-hosted GameBot) and
 *  'BOT-' (server room sim). HUD reads this to mark bots vs humans. */
export function isBotId(id: string): boolean {
  return id.startsWith('bot:') || id.startsWith('BOT-');
}

const SUFFIXED = /^BOT-([A-Z]+)-\d+$/;
/** What players and TTS see for an id. The '-NN' index stays on the wire
 *  (per-id seeds hash it, collisions need it) but it reads as a serial
 *  number, not a callsign — and a voice shouldn't have to say digits. */
export function botDisplayName(id: string): string {
  return id.replace(/^bot:/, '').replace(SUFFIXED, '$1');
}
/** Roster/boards show the bot badge — no pretense an entry is human.
 *  Chat lines use the plain callsign (bots naming each other don't
 *  speak 'bot'); listings want honesty over flavor. */
export function botRosterName(id: string): string {
  return isBotId(id) ? `[BOT] ${botDisplayName(id)}` : id;
}
/** Same strip inside free text — server notices compose raw ids into the
 *  sentence ('BOT-VEKTOR-04 ended the streak'), so feed lines rewrite
 *  them at render instead of making every composer id-aware. */
export function feedNames(text: string): string {
  return text.replace(/\bBOT-([A-Z]+)-\d+\b/g, '$1').replace(/\bbot:/g, '');
}
