// gunstats — the whole shared weapon table as a sortable page. Pure
// shared/ imports: WEAPONS (stat rows), WEAPON_FIRE_INTERVAL_S (cadence),
// class-lock sets, and the WeaponType names — the same numbers the
// server sims with, so the page can never drift from gameplay truth.
import { WEAPONS } from '../../shared/weaponRows.js';
import { GRAVITY } from '../../shared/movement.js';
import { WeaponType, WEAPON_FIRE_INTERVAL_S, BELT_THROW_WEAPONS, HEALBEAM_PER_TICK } from '../../shared/weapons.js';
import { SLOT_DEFS } from './weapons.js';
import { LIGHT_ONLY_WEAPONS, MEDIUM_ONLY_WEAPONS, HEAVY_ONLY_WEAPONS } from '../../shared/botClasses.js';
import { DEPLOY_ITEMS } from '../../shared/deployItems.js';
import type { WeaponStats } from '../../shared/weaponTable.js';
import pkg from '../package.json';
const RATE = WEAPON_FIRE_INTERVAL_S as Record<number, number | undefined>;

interface Col {
  key: string;
  label: string;
  cls?: string;
  /** true = higher is better (default); false = lower wins (cadence). */
  betterHigh?: boolean;
  hidden?: boolean; // data stays in the table, column doesn't render
  get: (wt: number, s: WeaponStats) => string | number;
  /** Numeric value for sort/heat when get() renders a compound string
   *  (burst weapons show "dmg×count" but rank on the product). */
  val?: (wt: number, s: WeaponStats) => number;
}

const classOf = (wt: number): string =>
  LIGHT_ONLY_WEAPONS.has(wt) ? 'L' : MEDIUM_ONLY_WEAPONS.has(wt) ? 'M' : HEAVY_ONLY_WEAPONS.has(wt) ? 'H' : '';
const clsTag = (wt: number): string => {
  const c = classOf(wt);
  return c ? `<span class="cls${c}">${c}</span>` : '';
};
const flag = (v: unknown): string => (v ? '<span class="yes">y</span>' : '<span class="no">-</span>');
const num = (v: number | undefined): number => v ?? 0;

// Table-only display names for enum keys that read ambiguous short.
const NAME_OVERRIDES = new Map<number, string>([
  [WeaponType.Disc, 'Disc Launcher'],
  [WeaponType.FastDiscLauncher, 'Fast Disc'],
  [WeaponType.Sticky, 'Sticky Gun'],
]);

const COLS: Col[] = [
  { key: 'name', label: 'weapon', cls: 'l', get: (wt): string => {
    // Enum key → readable: PlasmaCannon → "Plasma Cannon",
    // MRVLauncher → "MRV Launcher" (acronym boundary handled too).
    const n = (NAME_OVERRIDES.get(wt) ?? WeaponType[wt] ?? String(wt))
      .replaceAll(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .replaceAll(/([a-z])([A-Z])/g, '$1 $2');
    return `${n} ${clsTag(wt)}`;
  } },
  { key: 'dd', label: 'dmg', get: (wt, s): string | number => {
    // Cluster weapons (MRV): the carrier pop is delivery, the bomblet
    // rain is the weapon; show bomblet dmg × count, same "per pellet"
    // convention as burst weapons.
    if (wt === WeaponType.HealBeam) {
      return `<span title="Healing">${HEALBEAM_PER_TICK}*</span>`;
    }
    if (wt === WeaponType.Repair) {
      // dmg shows the anti-creature sting; * flags the real job is healing
      return `<span title="Repairs">${s.directDamage}*</span>`;
    }
    if (s.cluster) {
      const b = WEAPONS[WeaponType.MRVBomblet]; // only MRV clusters today
      return b ? `${b.directDamage}×${s.cluster.count}` : s.directDamage;
    }
    if (s.burst) {return `${s.directDamage}×${s.burst}`;}
    // Cone-sweep weapons carry their damage on the aoe field — melee's
    // 55 and slam's 35 would otherwise read as zero-damage entries.
    return s.directDamage || s.aoeDamage;
  },
  val: (_w, s): number => {
    if (s.cluster) {
      const b = WEAPONS[WeaponType.MRVBomblet];
      return b ? b.directDamage * s.cluster.count : s.directDamage;
    }
    return (s.directDamage || s.aoeDamage) * (s.burst ?? 1);
  } },
  { key: 'rate', label: 'tbs s', betterHigh: false, get: (wt): string | number => {
    const r = DEP_META.get(wt)?.int ?? RATE[wt] ?? 0;
    // * = energy-fed: the jet tank is the magazine, cadence isn't the limit
    if (wt === WeaponType.Blaster) {return `<span title="energy-fed">${r}*</span>`;}
    return r;
  }, val: (wt): number => DEP_META.get(wt)?.int ?? RATE[wt] ?? 0 },
  { key: 'spd', label: 'm/s', get: (_w, s): number => s.speed },
  { key: 'ar', label: 'aoe m', get: (_w, s): number => s.aoeRadius },
  { key: 'wt', label: 'id', get: (wt): number => wt, hidden: true },
  { key: 'ad', label: 'aoe dmg', get: (_w, s): number => s.aoeDamage },
  { key: 'kb', label: 'knock', get: (_w, s): number => s.knockbackForce },
  { key: 'br', label: 'hbox m', get: (_w, s): string | number => {
    // * = the hitbox is a WAKE: it grows in flight from hitMin toward
    // hitMax at hitGrow m/s (spinfusor-style shells), not a fixed sphere.
    if (s.hitMax && s.hitMax > s.bodyRadius) {
      const t = s.hitGrow ? ((s.hitMax - (s.hitMin ?? s.bodyRadius)) / s.hitGrow).toFixed(1) : '?';
      // No '->' in the title — a literal '>' inside an attribute escapes
      // the HTML-strip regex in the 'c' clipboard copy and leaks markup.
      return `<span title="${s.hitMin ?? s.bodyRadius}m to ${s.hitMax}m in ${t}s">${s.bodyRadius}*</span>`;
    }
    return s.bodyRadius;
  }, val: (_w, s): number => Math.max(s.bodyRadius, s.hitMax ?? 0) },
  { key: 'life', label: 'ttl s', get: (_w, s): string | number => s.maxLifetime ? num(s.maxLifetime) : '<span class="no">-</span>' },
  // Range in m. Flat shots: speed × ttl. Gravity shells: the 45° ballistic
  // max v²/g, but if the shell would still be aloft at ttl the lifetime
  // binds first; pick the arc that lands exactly at ttl instead.
  { key: 'rng', label: 'range', get: (wt, s): number => {
    // Deployables: the acquire envelope, not a ballistic reach.
    const dep = DEP_META.get(wt);
    if (dep) {return dep.range ?? 0;}
    const v = s.speed, ttl = num(s.maxLifetime);
    if (!v || !ttl) {return 0;}
    if (!s.gravity) {return Math.round(v * ttl);}
    const g = Math.abs(GRAVITY);
    const t45 = v * Math.SQRT2 / g;
    if (ttl >= t45) {return Math.round(v * v / g);}
    const sin = Math.min(1, g * ttl / (2 * v));
    return Math.round(v * Math.cos(Math.asin(sin)) * ttl);
  } },
  { key: 'grav', label: 'grav', get: (_w, s): string => flag(s.gravity) },
  { key: 'bnc', label: 'bounce', get: (_w, s): string => flag(s.terrainBounce) },
  { key: 'dps', label: 'dps', get: (wt, s): number => {
    const r = DEP_META.get(wt)?.int ?? RATE[wt];
    if (!r) {return 0;}
    // Same payload convention as dmg: cluster = bomblets, burst = pellets.
    const payload = s.cluster
      ? (WEAPONS[WeaponType.MRVBomblet]?.directDamage ?? s.directDamage) * s.cluster.count
      : (s.directDamage || s.aoeDamage) * (s.burst ?? 1);
    return Math.round(payload / r);
  } },
];

// Derived, not hardcoded: slot weapons come straight from SLOT_DEFS (the
// same table the menus read), belt items from shared BELT_THROW_WEAPONS —
// a stale copied list once put Sprinkler & co in "other".
const SLOT_WTS = new Set(SLOT_DEFS.map((d): number => d.weaponType));

// Deployables aren't WeaponType rows — they live in DEPLOY_ITEMS — but
// their numbers fit the grid where a column has a real meaning: dmg is
// per-shot/blast, 'tbs s' is their fireInterval, 'range' is the acquire
// envelope, 'ttl' the plant's server lifetime. Columns with no honest
// read (muzzle speed for a planted mine, grav/bounce) stay blank.
// Fake ids live past the WeaponType space so class/belt/slot filters
// never claim them.
const DEP_META = new Map<number, { int?: number; range?: number }>();
const DEPLOY_ROWS: [number, WeaponStats][] = Object.values(DEPLOY_ITEMS).map((d, i): [number, WeaponStats] => {
  const wt = 9000 + i;
  NAME_OVERRIDES.set(wt, d.label);
  DEP_META.set(wt, { int: d.fireInterval, range: d.range });
  return [wt, {
    directDamage: d.damage ?? d.blastDamage ?? 0,
    aoeDamage: d.blastDamage ?? 0,
    aoeRadius: d.blastRadius ?? d.shieldRadius ?? d.waterRadius ?? d.tetherRadius ?? d.triggerDist ?? 0,
    knockbackForce: d.knockback ?? 0,
    speed: d.projSpeed ?? 0,
    bodyRadius: d.bodyR,
    maxLifetime: d.ttlS || undefined,
  } as WeaponStats];
});

const ALL_ROWS: [number, WeaponStats][] = [
  ...Object.entries(WEAPONS)
    .map(([k, s]): [number, WeaponStats] => [Number(k), s])
    .filter(([wt]): boolean => WeaponType[wt] !== undefined),
  ...DEPLOY_ROWS,
];

type Filter = 'all' | 'weapon' | 'primary' | 'sidearm' | 'belt' | 'other';
const saved = localStorage.getItem('gunstats.filter') as Filter | null;
let filter: Filter = saved ?? 'all';
const rowsFor = (f: Filter): [number, WeaponStats][] => {
  if (f === 'weapon') {return ALL_ROWS.filter(([wt]): boolean => SLOT_WTS.has(wt));}
  if (f === 'primary') {return ALL_ROWS.filter(([wt, s]): boolean => SLOT_WTS.has(wt) && s.sidearm !== true);}
  if (f === 'sidearm') {return ALL_ROWS.filter(([, s]): boolean => s.sidearm === true);}
  if (f === 'belt') {return ALL_ROWS.filter(([wt]): boolean => BELT_THROW_WEAPONS.has(wt));}
  if (f === 'other') {return ALL_ROWS.filter(([wt, s]): boolean => !SLOT_WTS.has(wt) && !BELT_THROW_WEAPONS.has(wt) && s.sidearm !== true);}
  return ALL_ROWS;
};

// Percentile heat: each numeric column ranks its VISIBLE rows into
// sixths: red worst → purple best. betterHigh:false flips the ladder
// (a 0.09s cadence is purple, not red).
const TIER_COLORS = ['#ff6b6b', '#ffa94d', '#ffe066', '#8fd08f', '#6db3f2', '#b197fc'];
const heatFor = (col: Col, rows: [number, WeaponStats][]): Map<number, string> => {
  const vals = rows.map(([wt, s]): [number, number] => [wt, col.val ? col.val(wt, s) : Number(col.get(wt, s))]);
  const sorted = vals.map(([, v]): number => v).sort((a, b): number => a - b);
  const map = new Map<number, string>();
  for (const [wt, v] of vals) {
    // rank = share of values strictly below; ties share the best tier.
    const below = sorted.findIndex((x): boolean => x >= v);
    const pct = sorted.length > 1 ? below / (sorted.length - 1) : 0.5;
    const t = Math.min(5, Math.floor((col.betterHigh === false ? 1 - pct : pct) * 6));
    map.set(wt, TIER_COLORS[t]!);
  }
  return map;
};

let sortKey = localStorage.getItem('gunstats.sort') ?? 'name';
let sortDir = Number(localStorage.getItem('gunstats.sortDir')) || 1;

function render(): void {
  const cols = COLS.filter((c): boolean => !c.hidden);
  const cmp = (a: [number, WeaponStats], b: [number, WeaponStats]): number => {
    const col = cols.find((c): boolean => c.key === sortKey)!;
    const va = col.val ? col.val(a[0], a[1]) : col.get(a[0], a[1]);
    const vb = col.val ? col.val(b[0], b[1]) : col.get(b[0], b[1]);
    if (typeof va === 'number' && typeof vb === 'number') {return (va - vb) * sortDir;}
    return String(va).localeCompare(String(vb)) * sortDir;
  };
  const visible = rowsFor(filter);
  const heat = new Map<string, Map<number, string>>();
  for (const c of cols) {
    if (c.key === 'name' || c.key === 'wt' || c.key === 'grav' || c.key === 'bnc') {continue;}
    heat.set(c.key, heatFor(c, visible));
  }
  const out = document.querySelector('#out')!;
  const head = cols.map((c): string =>
    `<th class="${c.cls ?? ''}${c.key === sortKey ? ' sorted' : ''}" data-k="${c.key}">${c.label}${c.key === sortKey ? (sortDir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('');
  const body = [...visible].sort(cmp).map(([wt, s]): string =>
    `<tr${s.sidearm ? ' class="side"' : ''}>${cols.map((c): string => {
      const v = c.get(wt, s);
      const color = heat.get(c.key)?.get(wt);
      const style = color ? ` style="color:${color}"` : '';
      return `<td class="${c.cls ?? ''}"${style}>${v}</td>`;
    }).join('')}</tr>`).join('');
  const filt = (['all', 'weapon', 'primary', 'sidearm', 'belt', 'other'] as const).map((f): string =>
    `<button data-f="${f}"${f === filter ? ' class="on"' : ''}>${f}</button>`).join(' ');
  out.innerHTML = `<div id="fbar">${filt}</div><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  out.querySelectorAll('#fbar button').forEach((b): void => {
    b.addEventListener('click', (): void => {
      filter = (b as HTMLElement).dataset.f as Filter;
      localStorage.setItem('gunstats.filter', filter);
      render();
    });
  });
  out.querySelectorAll('th').forEach((th): void => {
    th.addEventListener('click', (): void => {
      const k = (th as HTMLElement).dataset.k!;
      if (k === sortKey) {sortDir = -sortDir;}
      else {
        sortKey = k;
        // First click sorts BEST first: descending for better-high stats,
        // ascending for better-low (tbs) and the name column.
        const c = cols.find((x): boolean => x.key === k);
        sortDir = c && c.betterHigh !== false && c.key !== 'name' ? -1 : 1;
      }
      localStorage.setItem('gunstats.sort', sortKey);
      localStorage.setItem('gunstats.sortDir', String(sortDir));
      render();
    });
  });
}

render();

// 'c' copies the CURRENT view (filter + sort order) as an
// aligned monospace table. Plain text: pastes clean into chat/docs.
document.addEventListener('keydown', (e): void => {
  if (e.key !== 'c' || e.ctrlKey || e.metaKey || e.altKey) {return;}
  const cols = COLS.filter((c): boolean => !c.hidden);
  const text = (wt: number, s: WeaponStats, c: Col): string => {
    // Strip HTML (heat spans, wake/heal markup) for the clipboard copy.
    const v = c.get(wt, s);
    return typeof v === 'string' ? v.replaceAll(/<[^>]*>/g, '') : String(v);
  };
  const visible = rowsFor(filter);
  const cmp = (a: [number, WeaponStats], b: [number, WeaponStats]): number => {
    const col = cols.find((c): boolean => c.key === sortKey)!;
    const va = col.val ? col.val(a[0], a[1]) : col.get(a[0], a[1]);
    const vb = col.val ? col.val(b[0], b[1]) : col.get(b[0], b[1]);
    if (typeof va === 'number' && typeof vb === 'number') {return (va - vb) * sortDir;}
    return String(va).localeCompare(String(vb)) * sortDir;
  };
  const rows = [...visible].sort(cmp);
  const widths = cols.map((c): number => Math.max(c.label.length, ...rows.map(([wt, s]): number => text(wt, s, c).length)));
  const line = (cells: string[]): string => cells.map((t, i): string => cols[i]!.cls === 'l' ? t.padEnd(widths[i]!) : t.padStart(widths[i]!)).join('  ').trimEnd();
  const out = [
    `gunstats [${filter}] sorted by ${sortKey} ${sortDir > 0 ? 'asc' : 'desc'}`,
    line(cols.map((c): string => c.label)),
    ...rows.map(([wt, s]): string => line(cols.map((c): string => text(wt, s, c)))),
  ].join('\n');
  void navigator.clipboard.writeText(out);
  toast(`copied ${rows.length} rows`);
});

let toastT = 0;
const toastEl = (() => { const d = document.createElement('div'); d.id = 'toast'; document.body.append(d); return d; })();
function toast(msg: string): void {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastT);
  toastT = window.setTimeout((): void => toastEl.classList.remove('show'), 1400);
}

// Version footer: same build.txt the game HUD reads (content hash +
// stamp per build); dev serves show just the package version.
const foot = document.createElement('div');
foot.className = 'sub';
foot.style.marginTop = '10px';
foot.id = 'ver';
document.body.append(foot);
fetch('/build.txt', { cache: 'no-cache' })
  .then((r): Promise<string> => (r.ok ? r.text() : Promise.resolve('')))
  .then((v): void => {
    // Dev server answers index.html for /build.txt; only trust it when
    // it looks like the real "hash stamp" line, not HTML.
    const [hash, stamp] = v.trim().split(/\s+/);
    const real = hash && !hash.includes('<');
    foot.textContent = `v${pkg.version} · ${real ? hash + (stamp ? ` · ${stamp}` : '') : 'dev'}`;
  })
  .catch((): void => { foot.textContent = `v${pkg.version} · dev`; });
