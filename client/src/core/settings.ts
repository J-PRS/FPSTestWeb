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
  'fps-loadout': string;      // "0,2,6,7" — weapon id per slot
  'fps-belt': string;         // 'disc' | 'grenade'
  'fps-skill': string;        // SkillId
  'fps-volume': number;       // master volume 0..1
};

const DEFAULTS: Schema = {
  'fps-pixelated': 0,
  'fps-postpro': false,
  'fps-bloom': false,
  'fps-invert-y': false,
  'fps-sens': 1,
  'fps-minimap': 0,
  'fps-loadout': '0,2,6,7',
  'fps-belt': 'disc',
  'fps-skill': 'bounce',
  'fps-volume': 0.7,
};

const parse = {
  boolean: (raw: string | null, def: boolean) => (raw === null ? def : raw === 'true'),
  number: (raw: string | null, def: number) => {
    if (raw === null) return def;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : def;
  },
};

// Keys that once stored 'true'/'false' but are numeric now — 'true' reads as 1.
const LEGACY_TRUE_AS_ONE = new Set<keyof Schema>(['fps-pixelated']);

export const settings = {
  get<K extends keyof Schema>(key: K): Schema[K] {
    const raw = localStorage.getItem(key);
    const def = DEFAULTS[key];
    if (LEGACY_TRUE_AS_ONE.has(key) && raw === 'true') return 1 as Schema[K];
    // `as Schema[K]` — parse.* returns the right runtime type per declared type
    if (typeof def === 'string') return (raw ?? def) as Schema[K];
    return (typeof def === 'boolean' ? parse.boolean(raw, def as boolean) : parse.number(raw, def as number)) as Schema[K];
  },
  set<K extends keyof Schema>(key: K, value: Schema[K]): void {
    localStorage.setItem(key, String(value));
  },
};
