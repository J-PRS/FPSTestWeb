// Loadout bar — the bottom-center chip row of the ESC menu. Custom
// dropups, not <select>: a native popup is OS chrome and breaks the
// game-menu illusion. Chip face + styled option list opening upward.
import { SKILL_ORDER, Player, type SkillId, BELT_ITEMS, type BeltItem } from '../entities/Player.js';
import { PERKS, PERK_ORDER, type PerkId } from '../../../shared/perks.js';
import { CLASS_STATS, type ArmorClass } from '../../../shared/botClasses.js';
import { MAX_HEALTH } from '../core/config.js';
import { SLOT_DEFS } from '../weapons.js';
import { codeFor, codeLabel } from '../core/keybinds.js';

export interface LoadoutDeps {
  lazyPlayer: () => Player;
  /** Online only — class picks get announced so the server banks the
   *  same tier swap for respawn. Absent offline. */
  lazyNetworkManager?: () => { sendClassUpdate(armorClass: string): void; sendPerkUpdate(perk: string): void } | null;
}

interface DropOpt { v: string; label: string; desc?: string }
interface Drop { el: HTMLElement; setValue(v: string): void; setOptions?(o: DropOpt[]): void; }

const BELT_LABELS: Record<BeltItem, string> = {
  disc: 'Disc', grenade: 'Grenade', cluster: 'Cluster Bomb',
  javelin: 'Javelin', sticky: 'Sticky Bomb', impact: 'Impact Grenade',
  remoterailgun: 'Remote Railgun', armornade: 'Armor Grenade',
};

// One-line role reads — only for effects you can't feel by firing once.
// Weapons get no line: squeeze the trigger and the gun explains itself.
// Belt/pack/perk effects (plating allies, escort behavior) stay labelled.
const BELT_ROLES: Record<BeltItem, string> = {
  disc: 'bouncing charge', grenade: 'frag', cluster: 'splits mid-air',
  javelin: 'arcing spear', sticky: 'remote chain', impact: 'instant pop',
  remoterailgun: 'capacitor slug', armornade: 'plates friendlies',
};

// Chip width is measured, not hardcoded — canvas-measure the widest
// option (uppercased, same font as .lo-opt) + padding + caret so no
// label ever overflows and no chip is wider than it needs to be.
const measureCtx = document.createElement('canvas').getContext('2d')!;
function dropWidth(options: { label: string }[]): number {
  measureCtx.font = `600 ${0.78 * 16}px ${getComputedStyle(document.body).fontFamily}`;
  let w = 0;
  for (const o of options) w = Math.max(w, measureCtx.measureText(o.label.toUpperCase()).width);
  return Math.ceil(w) + 11 * 2 + 8 + 12; // padding + gap + caret
}

let openDrop: HTMLElement | null = null;

interface BarUi {
  slotDrops: Drop[]; beltDrop: Drop | null; skillDrop: Drop | null;
  perkDrop: Drop | null; classDrop: Drop | null; sidearmDrop: Drop | null;
  packDrop: Drop | null; beltLabel: HTMLElement | null; skillLabel: HTMLElement | null;
  sidearmLabel: HTMLElement | null; packLabel: HTMLElement | null;
}

type MkDrop = (options: DropOpt[], onPick: (v: string) => void, faceOpts?: DropOpt[]) => Drop;

export function wireLoadoutBar(deps: LoadoutDeps): { refreshLoadout(): void } {
  const loadoutBar = document.getElementById('loadout-bar');

  function mkDrop(
    initialOptions: DropOpt[],
    onPick: (v: string) => void,
    faceOpts?: DropOpt[],
  ): Drop {
    const el = document.createElement('div');
    el.className = 'lo-chip lo-drop';
    const face = document.createElement('span');
    el.appendChild(face);
    const caret = document.createElement('span');
    caret.className = 'lo-caret';
    caret.textContent = '▴';
    el.appendChild(caret);
    const list = document.createElement('div');
    list.className = 'lo-list';
    el.appendChild(list);
    let options = initialOptions;
    let currentV = '';
    const rebuild = () => {
      el.style.minWidth = `${dropWidth(options)}px`;
      list.innerHTML = '';
      for (const o of options) {
        const it = document.createElement('div');
        it.className = 'lo-opt';
        it.textContent = o.label;
        if (o.desc) {
          // Perks are the only invisible pick — weapons/skills you can
          // feel in a second, a perk's effect needs a label.
          it.classList.add('has-desc');
          const d = document.createElement('span');
          d.className = 'lo-desc';
          d.textContent = o.desc;
          it.appendChild(d);
        }
        it.dataset.v = o.v;
        it.addEventListener('click', (e) => {
          e.stopPropagation();
          onPick(o.v);
          el.classList.remove('open');
          openDrop = null;
          refreshLoadout();
        });
        list.appendChild(it);
      }
    };
    rebuild();
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      const was = el.classList.contains('open');
      openDrop?.classList.remove('open');
      el.classList.toggle('open', !was);
      openDrop = was ? null : el;
    });
    return {
      el,
      setValue(v) {
        currentV = v;
        // faceOpts resolves labels the filtered list can't — an equipped
        // heavy weapon on lighter armor must name itself, not print "6".
        face.textContent = options.find((o) => o.v === v)?.label
          ?? faceOpts?.find((o) => o.v === v)?.label ?? v;
        list.querySelectorAll<HTMLElement>('.lo-opt').forEach((o) =>
          o.classList.toggle('sel', o.dataset.v === v));
      },
      setOptions(next) {
        options = next;
        rebuild();
        // The equipped value may have survived the filter — re-face it.
        this.setValue(currentV);
      },
    };
  }

  // Clicking the bar's dead space closes any open dropup
  loadoutBar?.addEventListener('click', () => {
    openDrop?.classList.remove('open');
    openDrop = null;
  });

  const ui = loadoutBar ? buildRows(loadoutBar, deps, mkDrop) : null;

  function refreshLoadout(): void {
    if (!ui) return;
    const player = deps.lazyPlayer();
    ui.slotDrops.forEach((d, i) => d.setValue(String(player.loadout[i])));
    ui.beltDrop?.setValue(player.beltItem);
    ui.skillDrop?.setValue(player.skill);
    ui.perkDrop?.setValue(player.perk);
    ui.classDrop?.setValue(player.armorClass);
    ui.sidearmDrop?.setValue(player.sidearm);
    ui.packDrop?.setValue(player.packItem);
    if (ui.beltLabel) ui.beltLabel.textContent = `BELT (${codeLabel(codeFor('belt'))})`;
    if (ui.skillLabel) ui.skillLabel.textContent = `SKILL (${codeLabel(codeFor('skill'))})`;
    if (ui.sidearmLabel) ui.sidearmLabel.textContent = `SIDEARM (${codeLabel(codeFor('sidearm'))})`;
    if (ui.packLabel) ui.packLabel.textContent = `PACK (${codeLabel(codeFor('deploy'))})`;
  }

  return { refreshLoadout };
}

function mkCellDom(parent: HTMLElement): { cell: HTMLElement; cap: HTMLSpanElement } {
  const cell = document.createElement('div');
  cell.className = 'lo-cell';
  const cap = document.createElement('span');
  cap.className = 'lo-cap';
  cell.appendChild(cap);
  parent.appendChild(cell);
  return { cell, cap };
}

// Panel construction — three labeled groups (ARMOR / WEAPONS / KIT) inside
// one bottom sheet. Class is a tile picker because its tradeoff (speed vs
// HP) reads at a glance; everything else stays a dropup chip.
function buildRows(bar: HTMLElement, deps: LoadoutDeps, mkDrop: MkDrop): BarUi {
  const ui: BarUi = {
    slotDrops: [], beltDrop: null, skillDrop: null, perkDrop: null,
    classDrop: null, sidearmDrop: null, packDrop: null,
    beltLabel: null, skillLabel: null, sidearmLabel: null, packLabel: null,
  };

  const mkGroup = (title: string, showHead = true): HTMLElement => {
    const g = document.createElement('div');
    g.className = 'lo-group';
    const h = document.createElement('div');
    if (showHead) {
      h.className = 'lo-head';
      h.textContent = title;
      g.appendChild(h);
    }
    const cells = document.createElement('div');
    cells.className = 'lo-cells';
    g.appendChild(cells);
    bar.appendChild(g);
    return cells;
  };

  // Sidearms are chosen in their own row — a primary slot offering them
  // would let a loadout double-carry the hold-out tier. Heavy-only
  // ordnance hides when a lighter tier is picked (setArmorClass also
  // unshoulders whatever was equipped).
  const heavyOnly = new Set(Player.HEAVY_ONLY.map(String));
  const weaponOptsFor = (cls: string) => SLOT_DEFS
    .map((def, wid) => ({ v: String(wid), label: def.config.displayName, sidearm: !!def.sidearm }))
    .filter((o) => !o.sidearm && (cls === 'heavy' || !heavyOnly.has(o.v)));

  // --- ARMOR: tile picker, not a dropup — the speed/HP tradeoff is the
  // headline and tiles show all three choices at once. ---
  const armorCells = mkGroup('ARMOR');
  const tiles = document.createElement('div');
  tiles.className = 'lo-tiles';
  armorCells.appendChild(tiles);
  const classTileEls: { v: string; el: HTMLElement }[] = [];
  const pickClass = (v: string) => {
    deps.lazyPlayer().setArmorClass(v as ArmorClass);
    deps.lazyNetworkManager?.()?.sendClassUpdate(v);
    // Class change re-filters the weapon drops on the spot — heavy
    // ordnance shows/hides without closing the menu.
    for (const d of ui.slotDrops) d.setOptions?.(weaponOptsFor(v));
    refreshTiles();
  };
  const refreshTiles = () => {
    const cur = deps.lazyPlayer()?.armorClass ?? 'medium';
    for (const t of classTileEls) t.el.classList.toggle('sel', t.v === cur);
  };
  for (const cls of ['light', 'medium', 'heavy'] as const) {
    const st = CLASS_STATS[cls];
    const t = document.createElement('div');
    t.className = 'lo-tile';
    const name = document.createElement('span');
    name.className = 'lo-tile-name';
    name.textContent = cls.toUpperCase();
    const sub = document.createElement('span');
    sub.className = 'lo-tile-sub';
    sub.textContent = `${MAX_HEALTH + st.maxHealth} HP · ${Math.round(st.speedScale * 100)}% SPD`;
    t.appendChild(name);
    t.appendChild(sub);
    t.addEventListener('click', (e) => { e.stopPropagation(); pickClass(cls); });
    tiles.appendChild(t);
    classTileEls.push({ v: cls, el: t });
  }
  // Drop-compatible shim: refreshLoadout drives faces via setValue.
  ui.classDrop = { el: tiles, setValue: () => refreshTiles() };

  // --- WEAPONS: one numbered cell per slot. No group head — every cell
  // is already captioned, the banner just ate vertical space. ---
  const weaponCells = mkGroup('WEAPONS', false);
  const weaponOpts = weaponOptsFor(deps.lazyPlayer()?.armorClass ?? 'medium');
  const allWeaponOpts = weaponOptsFor('heavy'); // label source for filtered-out picks
  for (let i = 0; i < Player.LOADOUT_SLOTS; i++) {
    const { cell, cap } = mkCellDom(weaponCells);
    cap.textContent = `SLOT ${i + 1}`;
    const drop = mkDrop(weaponOpts, (v) => deps.lazyPlayer().setLoadoutSlot(i, Number(v)), allWeaponOpts);
    cell.appendChild(drop.el);
    ui.slotDrops.push(drop);
  }

  // --- KIT: the five equipment picks in one strip — headless like the
  // weapon row; each cell names its own slot. ---
  const kitCells = mkGroup('KIT', false);
  const belt = mkCellDom(kitCells);
  ui.beltLabel = belt.cap;
  ui.beltDrop = mkDrop(
    BELT_ITEMS.map((b) => ({ v: b, label: BELT_LABELS[b], desc: BELT_ROLES[b] })),
    (v) => deps.lazyPlayer().setBeltItem(v as BeltItem),
  );
  belt.cell.appendChild(ui.beltDrop.el);

  const sidearm = mkCellDom(kitCells);
  ui.sidearmLabel = sidearm.cap;
  ui.sidearmDrop = mkDrop(
    [{ v: 'pistol', label: 'Pistol', desc: 'light hold-out' },
     { v: 'revolver', label: 'Revolver', desc: 'heavy hold-out' },
     { v: 'shotgun', label: 'Shotgun', desc: 'close fan' },
     { v: 'repair', label: 'Repair Tool', desc: 'weld + over-armor deployables' }],
    (v) => deps.lazyPlayer().setSidearm(v as 'pistol' | 'revolver' | 'shotgun' | 'repair'),
  );
  sidearm.cell.appendChild(ui.sidearmDrop.el);

  const pack = mkCellDom(kitCells);
  ui.packLabel = pack.cap;
  ui.packDrop = mkDrop(
    [{ v: 'turret', label: 'Sentry', desc: 'auto-gun deployable' },
     { v: 'mine', label: 'Mine', desc: 'proximity trap' },
     { v: 'station', label: 'Pad', desc: 'heal + resupply' },
     { v: 'drone', label: 'Drone', desc: 'escort drone' }],
    (v) => deps.lazyPlayer().setPackItem(v as 'turret' | 'mine' | 'station' | 'drone'),
  );
  pack.cell.appendChild(ui.packDrop.el);

  const skill = mkCellDom(kitCells);
  ui.skillLabel = skill.cap;
  ui.skillDrop = mkDrop(
    SKILL_ORDER.map((s) => ({ v: s, label: s[0].toUpperCase() + s.slice(1) })),
    (v) => deps.lazyPlayer().setSkill(v as SkillId),
  );
  skill.cell.appendChild(ui.skillDrop.el);

  const perk = mkCellDom(kitCells);
  perk.cap.textContent = 'PERK';
  ui.perkDrop = mkDrop(
    PERK_ORDER.map((p) => ({ v: p, label: PERKS[p].name, desc: PERKS[p].blurb })),
    (v) => {
      deps.lazyPlayer().setPerk(v as PerkId);
      deps.lazyNetworkManager?.()?.sendPerkUpdate(v);
    },
  );
  perk.cell.appendChild(ui.perkDrop.el);

  return ui;
}
