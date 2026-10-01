// Demo/debug knob: FPS_SUPERBOT=<id-substring> gives the matching bot
// superpowers — faster drive, hit rolls that never miss, extra HP.
// Leaf module: botArsenal/botBeam/botDrive/botRoster all want it, and
// arsenal↔beam importing each other just for this made a runtime cycle.
const SUPERBOT = process.env.FPS_SUPERBOT ?? '';
export const isSuper = (id: string): boolean => SUPERBOT !== '' && id.includes(SUPERBOT);
