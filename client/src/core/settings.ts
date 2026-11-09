/**
 * Typed settings store - all localStorage `fps-*` keys funnel through here.
 * New settings add one line to the table; corrupted values get defaults
 * back instead of NaN/garbage leaking into gameplay.
 */

type Schema = {
  'fps-pixelated': number;   // pixel scale factor (1 = off)
  'fps-postpro': boolean;
  'fps-wake': boolean;       // projectile wake-cone shell (disc/bolt proxy hitbox visual)
  'fps-ptrails': boolean;    // quarks smoke/particle trails - off isolates the ribbon path when chasing smears
  'fps-ribbons': boolean;    // line/ribbon trail batch - off isolates the particle path
  'fps-dots': boolean;       // ballTrailDots point trails - third trail kind, toggled alone
  'fps-wpos': boolean;       // worldpos pin trails (debugPins) - shows pins/connectors without F1
  'fps-bloom': boolean;
  'fps-sharpen': boolean;
  'fps-invert-y': boolean;
  'fps-sens': number;
  'fps-minimap': number;      // 0 = corner radar, 1 = crosshair threat overlay, 2 = off
  'fps-loadout': string;      // "0,2,6,7" - weapon id per slot (active class's kit)
  'fps-loadout-light': string;  // remembered kit per armor tier - '' = never set
  'fps-loadout-medium': string;
  'fps-loadout-heavy': string;
  'fps-gear-light': string;     // remembered belt/sidearm/pack/perk/skill per tier
  'fps-gear-medium': string;
  'fps-gear-heavy': string;
  'fps-belt': string;         // BeltItem id - see Player.BELT_ITEMS
  'fps-sidearm': string;      // SidearmId - PlayerLoadout.SIDEARM keys
  'fps-pack': string;         // DeployKind - 'turret' | 'mine' | 'station' | 'drone' | 'shield'
  'fps-skill': string;        // SkillId
  'fps-perk': string;         // PerkId
  'fps-class': string;        // ArmorClass (light|medium|heavy)
  'fps-mode': string;         // '' | 'nuggets' | 'ctf' | 'dm' | 'classic'
  'fps-spawns': number;       // 1 = all-random creature spawns, no scripted beats
  'fps-debug': number;        // dev overlays / verbose combat logging
  'fps-volume': number;       // master volume 0..1
  'fps-keys': string;         // "forward=KeyW,back=KeyS,..." - see core/keybinds.ts
  'fps-server': string;       // remote host (trycloudflare name or full host) - '' = same-host dev
  'fps-p2p': string;          // 'host:CODE' | 'join:CODE' | 'quick' - WebRTC duel, '' = off
  'fps-lobby': number;        // 1 = host's p2p room is listed publicly (/rtc/lobbies)
  'fps-unlisted': number;     // 1 = hosted server rooms stay off /rooms + quick-join
  'fps-nocreatures': number;  // 1 = hosted rooms mint without melee species
  'fps-creatures': number;    // 1 = opt back IN to species in offline pop (default balls-only)
  'fps-noballs': number;      // 1 = hosted rooms mint without the ball sim
  'fps-nolips': number;       // 1 = lip-sync flares off (speech-jam debug)
  'fps-fav-rooms': string;    // JSON string[] - server-browser favorites column
  'fps-shadows': boolean;     // shadow map pass - off on potatoes (whole second scene raster per frame)
  'fps-tts-chat': boolean;    // speak typed chat aloud via system TTS (VGS lines always use the robot voice)
  'fps-vgs-physical': boolean; // VGS chord letters by physical position (QWERTY mnemonic) instead of layout letter
  'fps-autoq': boolean;       // dynamic quality ladder - off = stay at user's manual picks
  'fps-cap': number;          // render cap (0 = every rAF; sim still runs uncapped)
  'fps-filter': number;       // upscale filter for fractional resScale: 0 = nearest, 1 = bilinear, 2 = xBR-lv2
  'fps-pscale': number;       // integer pixel-size divisor 1-4 (retro chunk)
  'fps-pmode': number;        // pixel mode: 0 raw / 1 smooth(xBR) / 2 dithered / 3 atkinson
  'fps-aa': number;           // antialiasing: 0 off / 1 FXAA / 2 SMAA / 3 MSAA2x / 4 MSAA4x
  'fps-retro': number;        // palette quantization: 0 full / 1 256 / 2 64 / 3 16 / 4 8 colors per channel
  'fps-fov': number;          // world camera FOV degrees (viewmodel cam stays fixed)
  'fps-player-id': string;    // claimed identity - survives F5/restarts
  'fps-name': string;         // chosen display name - cosmetic, rides the join
  'fps-session-token': string; // server-issued reclaim token
  'fps-muted': string;        // JSON string[] - playerIds muted client-side
  'fps-onboarded': number;    // 1 = first-run controls card already shown
  'fps-last-room': string;    // server room the client last joined - boot resume target
  'fps-solo': number;         // 1 = player chose a solo session (lobby stays shut on boot)
  'fps-solo-map': string;     // SOLO tab's map pick ('' = default field)
  'fps-solo-bots': number;    // SOLO tab's bot count (-1 = map default)
  'fps-lb-tab': string;       // lobby's last-open tab (JOIN|HOST|OFFLINE|P2P)
  'fps-host-mode': string;    // HOST tab's ruleset pick ('' = ANY)
  'fps-host-map': string;     // HOST tab's map pick
  'fps-host-bots': number;    // HOST tab's bot count (-1 = map default)
  'fps-host-name': string;    // HOST tab's room-name field
  'fps-p2p-code': string;     // P2P tab's code field
  'fps-p2p-pub': number;      // P2P host listed publicly on the relay
  'fps-join-spec': string;    // JSON {map?,bots?,mode?} - creation hints for the next room join
};

const DEFAULTS: Schema = {
  'fps-pixelated': 0,
  'fps-postpro': true,
  'fps-wake': true,
  'fps-ptrails': true,
  'fps-ribbons': true,
  'fps-dots': true,
  'fps-wpos': false,
  'fps-bloom': true,
  'fps-sharpen': true,
  'fps-invert-y': false,
  'fps-sens': 0.8, // menu shows 8 → ~12.5cm/360 @800dpi - casual flick default; tuners drop it
  'fps-minimap': 0,
  'fps-loadout': '0,2,6,7',
  'fps-loadout-light': '1,2,8,4',  // Disc / Chaingun / Lightning / GL
  'fps-loadout-medium': '1,2,5,15', // Disc / Chaingun / Flak / PlasmaGun
  'fps-loadout-heavy': '1,19,6,3', // Disc / Bombard / PlasmaCannon / Mortar
  // gear bundle: belt,sidearm,pack,perk,skill - nugget pack + pistol for all
  'fps-gear-light': 'hook,pistol,nugget,airtank,dash',
  'fps-gear-medium': 'hook,pistol,nugget,regenerator,medkit',
  'fps-gear-heavy': 'hook,pistol,nugget,juggernaut,shield',
  'fps-belt': 'hook',
  'fps-sidearm': 'pistol',
  'fps-pack': 'nugget',
  'fps-skill': 'dash',
  'fps-perk': 'jumpstart',
  'fps-class': 'medium',
  'fps-mode': '',
  'fps-spawns': 0,
  'fps-debug': 0,
  'fps-volume': 0.7,
  'fps-keys': '',
  'fps-server': '',
  'fps-p2p': '',
  'fps-lobby': 0,
  'fps-unlisted': 0,
  'fps-nocreatures': 1,
  'fps-creatures': 0,
  'fps-noballs': 1,
  'fps-nolips': 0,
  'fps-fav-rooms': '[]',
  'fps-shadows': true,
  'fps-tts-chat': false,
  'fps-vgs-physical': false,
  'fps-autoq': true,
  'fps-cap': 0,
  'fps-filter': 0,
  'fps-pscale': 1,
  'fps-pmode': 0,
  'fps-aa': 1,
  'fps-retro': 0,
  'fps-fov': 90,
  'fps-player-id': '',
  'fps-name': '',
  'fps-session-token': '',
  'fps-muted': '[]',
  'fps-onboarded': 0,
  'fps-last-room': '',
  'fps-solo': 0,
  'fps-solo-map': '',
  'fps-solo-bots': -1,
  'fps-lb-tab': '',
  'fps-host-mode': '',
  'fps-host-map': '',
  'fps-host-bots': -1,
  'fps-host-name': '',
  'fps-p2p-code': '',
  'fps-p2p-pub': 0,
  'fps-join-spec': '{}',
};

const parse = {
  boolean: (raw: string | null, def: boolean): boolean => (raw === null ? def : raw === 'true'),
  number: (raw: string | null, def: number): number => {
    if (raw === null) {return def;}
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : def;
  },
};

// Keys that once stored 'true'/'false' but are numeric now - 'true' reads as 1.
const LEGACY_TRUE_AS_ONE = new Set<keyof Schema>(['fps-pixelated']);

// Storage can throw - Safari private mode caps/quota errors, embeds with
// storage disabled. A raw throw from set() on a settings toggle (or get()
// at boot) would kill the app on a device that can still play fine, so
// failures fall back to a session-only shadow.
const memFallback = new Map<string, string>();
// Identity keys live in sessionStorage (per-tab), not localStorage: two
// tabs sharing one playerId+token reclaim-evict each other forever (~13s
// ping-pong, observed in soaks). sessionStorage survives F5 inside a tab,
// so reconnect/reclaim still works; a second tab mints its own identity.
const SESSION_KEYS = new Set(['fps-player-id', 'fps-session-token']);
const store = {
  backing(k: string): Storage {
    return SESSION_KEYS.has(k) ? sessionStorage : localStorage;
  },
  get(k: string): string | null {
    try { return this.backing(k).getItem(k); } catch { return memFallback.get(k) ?? null; }
  },
  set(k: string, v: string): void {
    memFallback.set(k, v);
    try { this.backing(k).setItem(k, v); } catch { /* shadow keeps it session-local */ }
  },
  has(k: string): boolean {
    try { return this.backing(k).getItem(k) !== null; } catch { return memFallback.has(k); }
  },
  remove(k: string): void {
    memFallback.delete(k);
    try { this.backing(k).removeItem(k); } catch { /* nothing persisted anyway */ }
  },
};

export const settings = {
  get<K extends keyof Schema>(key: K): Schema[K] {
    const raw = store.get(key);
    const def = DEFAULTS[key];
    if (LEGACY_TRUE_AS_ONE.has(key) && raw === 'true') {return 1 as Schema[K];}
    // `as Schema[K]` - parse.* returns the right runtime type per declared type
    if (typeof def === 'string') {return (raw ?? def) as Schema[K];}
    return (typeof def === 'boolean' ? parse.boolean(raw, def as boolean) : parse.number(raw, def as number)) as Schema[K];
  },
  set<K extends keyof Schema>(key: K, value: Schema[K]): void {
    store.set(key, String(value));
    // Live-toggle consumers (debug overlays) subscribe to this - the event
    // fires same-tab only, which is the only place a toggle can happen.
    window.dispatchEvent(new CustomEvent('fps:set', { detail: { key, value } }));
  },
  /** "User ever set this?" - get() can't distinguish unset from the
   *  default, which migrations (potato seeds, legacy pscale) need. */
  has(key: keyof Schema): boolean {
    return store.has(key);
  },
  remove(key: keyof Schema): void {
    store.remove(key);
  },
};
