/**
 * Typed settings store — all localStorage `fps-*` keys funnel through here.
 * New settings add one line to the table; corrupted values get defaults
 * back instead of NaN/garbage leaking into gameplay.
 */

type Schema = {
  'fps-pixelated': number;   // pixel scale factor (1 = off)
  'fps-postpro': boolean;
  'fps-bloom': boolean;
  'fps-invert-y': boolean;
  'fps-sens': number;
  'fps-minimap': number;      // 0 = corner radar, 1 = crosshair threat overlay
  'fps-loadout': string;      // "0,2,6,7" — weapon id per slot (active class's kit)
  'fps-loadout-light': string;  // remembered kit per armor tier — '' = never set
  'fps-loadout-medium': string;
  'fps-loadout-heavy': string;
  'fps-belt': string;         // BeltItem id — see Player.BELT_ITEMS
  'fps-sidearm': string;      // 'pistol' | 'revolver' | 'shotgun' | 'repair'
  'fps-pack': string;         // DeployKind — 'turret' | 'mine' | 'station' | 'drone' | 'shield'
  'fps-skill': string;        // SkillId
  'fps-perk': string;         // PerkId
  'fps-class': string;        // ArmorClass (light|medium|heavy)
  'fps-mode': string;         // '' | 'nuggets' | 'ctf' | 'dm' | 'classic'
  'fps-spawns': number;       // 1 = all-random creature spawns, no scripted beats
  'fps-debug': number;        // dev overlays / verbose combat logging
  'fps-volume': number;       // master volume 0..1
  'fps-keys': string;         // "forward=KeyW,back=KeyS,..." — see core/keybinds.ts
  'fps-server': string;       // remote host (trycloudflare name or full host) — '' = same-host dev
  'fps-p2p': string;          // 'host:CODE' | 'join:CODE' | 'quick' — WebRTC duel, '' = off
  'fps-lobby': number;        // 1 = host's p2p room is listed publicly (/rtc/lobbies)
  'fps-fav-rooms': string;    // JSON string[] — server-browser favorites column
  'fps-shadows': boolean;     // shadow map pass — off on potatoes (whole second scene raster per frame)
  'fps-tts-chat': boolean;    // speak typed chat aloud via system TTS (VGS lines always use the robot voice)
  'fps-vgs-physical': boolean; // VGS chord letters by physical position (QWERTY mnemonic) instead of layout letter
  'fps-autoq': boolean;       // dynamic quality ladder — off = stay at user's manual picks
  'fps-cap': number;          // render cap (0 = every rAF; sim still runs uncapped)
  'fps-filter': number;       // upscale filter for fractional resScale: 0 = nearest, 1 = bilinear, 2 = xBR-lv2
  'fps-pscale': number;       // integer pixel-size divisor 1-4 (retro chunk)
  'fps-pmode': number;        // pixel mode: 0 raw / 1 smooth(xBR) / 2 dithered / 3 atkinson
  'fps-aa': number;           // antialiasing: 0 off / 1 FXAA / 2 SMAA / 3 MSAA2x / 4 MSAA4x
  'fps-fov': number;          // world camera FOV degrees (viewmodel cam stays fixed)
};

const DEFAULTS: Schema = {
  'fps-pixelated': 0,
  'fps-postpro': false,
  'fps-bloom': false,
  'fps-invert-y': false,
  'fps-sens': 1,
  'fps-minimap': 0,
  'fps-loadout': '0,2,6,7',
  'fps-loadout-light': '',
  'fps-loadout-medium': '',
  'fps-loadout-heavy': '',
  'fps-belt': 'disc',
  'fps-sidearm': 'pistol',
  'fps-pack': 'turret',
  'fps-skill': 'bounce',
  'fps-perk': 'none',
  'fps-class': 'medium',
  'fps-mode': '',
  'fps-spawns': 0,
  'fps-debug': 0,
  'fps-volume': 0.7,
  'fps-keys': '',
  'fps-server': '',
  'fps-p2p': '',
  'fps-lobby': 0,
  'fps-fav-rooms': '[]',
  'fps-shadows': true,
  'fps-tts-chat': false,
  'fps-vgs-physical': false,
  'fps-autoq': true,
  'fps-cap': 0,
  'fps-filter': 0,
  'fps-pscale': 1,
  'fps-pmode': 0,
  'fps-aa': 0,
  'fps-fov': 90,
};

const parse = {
  boolean: (raw: string | null, def: boolean) => (raw === null ? def : raw === 'true'),
  number: (raw: string | null, def: number) => {
    if (raw === null) {return def;}
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : def;
  },
};

// Keys that once stored 'true'/'false' but are numeric now — 'true' reads as 1.
const LEGACY_TRUE_AS_ONE = new Set<keyof Schema>(['fps-pixelated']);

export const settings = {
  get<K extends keyof Schema>(key: K): Schema[K] {
    const raw = localStorage.getItem(key);
    const def = DEFAULTS[key];
    if (LEGACY_TRUE_AS_ONE.has(key) && raw === 'true') {return 1 as Schema[K];}
    // `as Schema[K]` — parse.* returns the right runtime type per declared type
    if (typeof def === 'string') {return (raw ?? def) as Schema[K];}
    return (typeof def === 'boolean' ? parse.boolean(raw, def as boolean) : parse.number(raw, def as number)) as Schema[K];
  },
  set<K extends keyof Schema>(key: K, value: Schema[K]): void {
    localStorage.setItem(key, String(value));
    // Live-toggle consumers (debug overlays) subscribe to this — the event
    // fires same-tab only, which is the only place a toggle can happen.
    window.dispatchEvent(new CustomEvent('fps:set', { detail: { key, value } }));
  },
};
