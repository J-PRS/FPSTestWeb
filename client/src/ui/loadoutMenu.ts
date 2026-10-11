// Loadout bar — the bottom-center chip row of the ESC menu. Custom
// dropups, not <select>: a native popup is OS chrome and breaks the
// game-menu illusion. Chip face + styled option list opening upward.
import { SKILL_ORDER, Player, type SkillId, BELT_ITEMS, type BeltItem } from '../entities/Player.js';
import { PERKS, PERK_ORDER, type PerkId } from '../../../shared/perks.js';
import type { ArmorClass } from '../../../shared/botClasses.js';
import { SLOT_DEFS } from '../weapons.js';
import { codeFor, codeLabel } from '../core/keybinds.js';
import type { DeployKind } from '../../../shared/deployables.js';
import { DEPLOY_KINDS } from '../../../shared/deployables.js';
import { DEPLOY_ITEMS } from '../../../shared/deployItems.js';

export interface LoadoutDeps {
  lazyPlayer: () => Player;
  /** Online only — class picks get announced so the server banks the
   *  same tier swap for respawn. Absent offline. */
  lazyNetworkManager?: () => { sendClassUpdate(armorClass: string): void; sendPerkUpdate(perk: string): void } | null;
}

interface DropOpt { v: string; label: string; desc?: string; disabled?: boolean }
interface Drop { el: HTMLElement; setValue(v: string): void; setOptions?(o: DropOpt[]): void; markUsed?(used: ReadonlySet<string>): void; }

const BELT_LABELS: Record<BeltItem, string> = {
  disc: 'Disc', grenade: 'Grenade', cluster: 'Cluster Bomb',
  javelin: 'Javelin', sticky: 'Sticky Bomb', impact: 'Impact Grenade',
  conc: 'Concussion Grenade',
  remoterailgun: 'Remote Railgun', armornade: 'Armor Grenade',
  proxy: 'Proxy Grenade', satchel: 'Satchel Charge (2)', heal: 'Heal Grenade',
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

type MkDrop = (options: DropOpt[], onPick: (v: string) => void, faceOpts?: DropOpt[], cols2?: boolean) => Drop;

export function wireLoadoutBar(deps: LoadoutDeps): { refreshLoadout(): void; closeDrops(): void } {
  const loadoutBar = document.getElementById('loadout-bar');

  function mkDrop(
    initialOptions: DropOpt[],
    onPick: (v: string) => void,
    faceOpts?: DropOpt[],
    cols2 = false,
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
    list.className = cols2 ? 'lo-list cols2' : 'lo-list';
    el.appendChild(list);
    let options = initialOptions;
    let currentV = '';
    const rebuild = () => {
      el.style.minWidth = `${dropWidth(options)}px`;
      list.innerHTML = '';
      for (const o of options) {
        const it = document.createElement('div');
        it.className = 'lo-opt';
        if (o.disabled) it.classList.add('locked');
        // 'none' isn't a perk — banner it across both columns.
        if (cols2 && o.v === 'none') it.classList.add('full');
        const name = document.createElement('span');
        name.className = 'lo-name';
        name.textContent = o.label;
        it.appendChild(name);
        if (o.desc) {
          // Perks are the only invisible pick — everything else
          // self-explains in a second of firing it.
          it.classList.add('has-desc');
          const d = document.createElement('span');
          d.className = 'lo-desc';
          d.textContent = o.desc;
          it.appendChild(d);
        }
        it.dataset.v = o.v;
        it.addEventListener('click', (e) => {
          e.stopPropagation();
          if (o.disabled) return; // tier-locked — visible but unshoulderable
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
      // 'used' = equipped in a sibling slot — a faint tint reads "already
      // in the kit" without competing with this slot's bright .sel.
      markUsed(used) {
        list.querySelectorAll<HTMLElement>('.lo-opt').forEach((o) => {
          const v = o.dataset.v ?? '';
          o.classList.toggle('used', v !== currentV && used.has(v));
        });
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
    // Options gate on armorClass — the tier whose kit is being edited
    // (a banked heavy pick CAN hold a mortar; it shoulders at respawn).
    // Faces come from menuKit: the pending kit while a swap is banked.
    const opts = weaponOptsFor(player.armorClass);
    ui.slotDrops.forEach((d, i) => { d.setOptions?.(opts); d.setValue(String(player.menuKit[i])); });
    markSlotUse(player, ui.slotDrops);
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

  // Menu close must not strand an open dropup — resume, then next ESC
  // shows a list floating over a face that isn't asking for it.
  function closeDrops(): void {
    openDrop?.classList.remove('open');
    openDrop = null;
  }

  return { refreshLoadout, closeDrops };
}

/** Faint-mark weapons already sitting in a sibling slot — one open
 *  list then shows the whole kit at a glance. */
function markSlotUse(player: Player, slotDrops: Drop[]): void {
  const kit = player.menuKit.map(String);
  slotDrops.forEach((d, i) => {
    const used = new Set(kit);
    used.delete(kit[i]); // this slot's pick keeps the bright .sel, not 'used'
    d.markUsed?.(used);
  });
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

// Sidearms are chosen in their own row — a primary slot offering them
// would let a loadout double-carry the hold-out tier. Tier-locked
// ordnance stays listed but tagged [H]/[M]/[L] and grayed out —
// lockedForClass flags it in the list AND gates it in setLoadoutSlot.
const TIER_TAG = new Map<string, string>([
  ...Player.HEAVY_ONLY.map((w) => [String(w), '[H]'] as const),
  ...Player.MEDIUM_ONLY.map((w) => [String(w), '[M]'] as const),
  ...Player.LIGHT_ONLY.map((w) => [String(w), '[L]'] as const),
]);

// Locked gear stays listed but grays out against the tier in effect —
// knowing a mortar exists matters even when you can't shoulder it.
function weaponOptsFor(cls: ArmorClass): DropOpt[] {
  return SLOT_DEFS
    .map((def, wid) => {
      const tag = TIER_TAG.get(String(wid));
      return {
        v: String(wid),
        label: (tag ? `${tag} ` : '') + def.config.displayName,
        sidearm: !!def.sidearm,
        disabled: Player.lockedForClass(cls, wid),
      };
    })
    .filter((o) => !o.sidearm)
    // SLOT_DEFS order is wire identity (wid = index) — the MENU sorts by
    // name instead; v stays the wid so picks never reshuffle. Tier-locked
    // entries group at the bottom so restricted gear reads as one block.
    .toSorted((a, b) => {
      const ar = a.label.startsWith('[') ? 1 : 0, br = b.label.startsWith('[') ? 1 : 0;
      return ar - br || a.label.localeCompare(b.label);
    });
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

  // --- ARMOR: tile picker, not a dropup — headless like the other
  // groups; three labeled tiles need no banner to read as armor class.
  const armorCells = mkGroup('ARMOR', false);
  const tiles = document.createElement('div');
  tiles.className = 'lo-tiles';
  armorCells.appendChild(tiles);
  const classTileEls: { v: string; el: HTMLElement }[] = [];
  const pickClass = (v: string) => {
    const player = deps.lazyPlayer();
    player.setArmorClass(v as ArmorClass);
    deps.lazyNetworkManager?.()?.sendClassUpdate(v);
    // Re-flag locks + re-face chips for the tier just picked — the menu
    // now edits that tier's pending kit (live gun untouched until
    // respawn), so faces show the recalled kit and gates follow it.
    const opts = weaponOptsFor(player.armorClass);
    ui.slotDrops.forEach((d, i) => { d.setOptions?.(opts); d.setValue(String(player.menuKit[i])); });
    markSlotUse(player, ui.slotDrops);
    refreshTiles();
  };
  const refreshTiles = () => {
    const cur = deps.lazyPlayer()?.armorClass ?? 'medium';
    for (const t of classTileEls) t.el.classList.toggle('sel', t.v === cur);
  };
  for (const cls of ['light', 'medium', 'heavy'] as const) {
    const t = document.createElement('div');
    t.className = 'lo-tile';
    const name = document.createElement('span');
    name.className = 'lo-tile-name';
    name.textContent = cls.toUpperCase();
    t.appendChild(name);
    t.addEventListener('click', (e) => { e.stopPropagation(); pickClass(cls); });
    tiles.appendChild(t);
    classTileEls.push({ v: cls, el: t });
  }
  // Drop-compatible shim: refreshLoadout drives faces via setValue.
  ui.classDrop = { el: tiles, setValue: () => refreshTiles() };

  // --- WEAPONS: one numbered cell per slot. No group head — every cell
  // is already captioned, the banner just ate vertical space. ---
  const weaponCells = mkGroup('WEAPONS', false);
  // Filter by armorClass — the tier the menu edits (a banked class swap
  // edits that tier's kit, so its legal picks must show). lazyPlayer can
  // be unborn at wire-up — default the flag pass to medium.
  const weaponOpts = weaponOptsFor(deps.lazyPlayer()?.armorClass ?? 'medium');
  const allWeaponOpts = weaponOpts; // label source for filtered-out picks
  for (let i = 0; i < Player.LOADOUT_SLOTS; i++) {
    const { cell, cap } = mkCellDom(weaponCells);
    cap.textContent = `SLOT ${i + 1}`;
    const drop = mkDrop(weaponOpts, (v) => deps.lazyPlayer().setLoadoutSlot(i, Number(v)), allWeaponOpts);
    cell.appendChild(drop.el);
    ui.slotDrops.push(drop);
  }

  // --- KIT: two rows — SIDEARM+BELT up top, PACK+SKILL+PERK under;
  // five cells in one nowrap strip overflowed the bar's width. ---
  const kitRowA = mkGroup('KIT', false);
  kitRowA.classList.add('lo-grid2');
  const kitRowB = mkGroup('KIT', false);
  kitRowB.classList.add('lo-grid3');
  const sidearm = mkCellDom(kitRowA);
  ui.sidearmLabel = sidearm.cap;
  ui.sidearmDrop = mkDrop(
    [{ v: 'pistol', label: 'Pistol' },
     { v: 'revolver', label: 'Revolver' },
     { v: 'shotgun', label: 'Shotgun' },
     { v: 'repair', label: 'Repair Tool' }],
    (v) => deps.lazyPlayer().setSidearm(v as 'pistol' | 'revolver' | 'shotgun' | 'repair'),
  );
  sidearm.cell.appendChild(ui.sidearmDrop.el);

  const belt = mkCellDom(kitRowA);
  ui.beltLabel = belt.cap;
  ui.beltDrop = mkDrop(
    // No descs — every belt item is one throw away from explaining itself.
    BELT_ITEMS.map((b) => ({ v: b, label: BELT_LABELS[b] })),
    (v) => deps.lazyPlayer().setBeltItem(v as BeltItem),
  );
  belt.cell.appendChild(ui.beltDrop.el);

  const pack = mkCellDom(kitRowB);
  ui.packLabel = pack.cap;
  ui.packDrop = mkDrop(
    DEPLOY_KINDS.map((kind) => ({ v: kind, label: DEPLOY_ITEMS[kind].label })),
    (v) => deps.lazyPlayer().setPackItem(v as DeployKind),
  );
  pack.cell.appendChild(ui.packDrop.el);

  const skill = mkCellDom(kitRowB);
  ui.skillLabel = skill.cap;
  ui.skillDrop = mkDrop(
    SKILL_ORDER.map((s) => ({ v: s, label: s[0].toUpperCase() + s.slice(1) })),
    (v) => deps.lazyPlayer().setSkill(v as SkillId),
  );
  skill.cell.appendChild(ui.skillDrop.el);

  const perk = mkCellDom(kitRowB);
  perk.cap.textContent = 'PERK';
  ui.perkDrop = mkDrop(
    PERK_ORDER.map((p) => ({ v: p, label: PERKS[p].name, desc: PERKS[p].blurb })),
    (v) => {
      deps.lazyPlayer().setPerk(v as PerkId);
      deps.lazyNetworkManager?.()?.sendPerkUpdate(v);
    },
    undefined, true, // 2 cols — 10 perks stack taller than the menu otherwise
  );
  perk.cell.appendChild(ui.perkDrop.el);

  return ui;
}
