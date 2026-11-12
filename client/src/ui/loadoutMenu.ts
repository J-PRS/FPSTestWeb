// Loadout bar - the bottom-center chip row of the ESC menu. Custom
// dropups, not <select>: a native popup is OS chrome and breaks the
// game-menu illusion. Chip face + styled option list opening upward.
import { SKILL_ORDER, Player, type SkillId, BELT_ITEMS, type BeltItem } from '../entities/Player.js';
import { PERKS, PERK_ORDER, type PerkId } from '../../../shared/perks.js';
import type { ArmorClass } from '../../../shared/botClasses.js';
import { SLOT_DEFS, widOf } from '../weapons.js';
import { WeaponType } from '../../../shared/weapons.js';
import { PlayerLoadout, type SidearmId } from '../entities/playerLoadout.js';
import { codeFor, codeLabel } from '../core/keybinds.js';
import { PACK_KINDS, type DeployKind } from '../../../shared/deployables.js';
import { DEPLOY_ITEMS } from '../../../shared/deployItems.js';

export interface LoadoutDeps {
  lazyPlayer: () => Player;
  /** Online only - class picks get announced so the server banks the
   *  same tier swap for respawn. Absent offline. */
  lazyNetworkManager?: () => { sendClassUpdate(armorClass: string): void; sendPerkUpdate(perk: string): void } | null;
}

interface DropOpt { v: string; label: string; desc?: string; disabled?: boolean }
interface Drop { el: HTMLElement; setValue(v: string): void; setOptions?(o: DropOpt[]): void; markUsed?(used: ReadonlySet<string>): void; }

const BELT_LABELS: Record<BeltItem, string> = {
  disc: 'Implodisc', pushdisc: 'Disc', grenade: 'Grenade', cluster: 'Cluster Bomb',
  javelin: 'Javelin', sticky: 'Sticky Bomb', impact: 'Impact Grenade',
  conc: 'Concussion Grenade',
  remoterailgun: 'Remote Railgun', armornade: 'Armor Grenade',
  proxy: 'Proxy Grenade', satchel: 'Satchel Charge', heal: 'Heal Grenade',
  hook: 'Hook', emp: 'EMP Grenade',
};

// Chip width is measured, not hardcoded - canvas-measure the widest
// option (uppercased, same font as .lo-opt) + padding + caret so no
// label ever overflows and no chip is wider than it needs to be.
const measureCtx = document.createElement('canvas').getContext('2d')!;
function dropWidth(options: { label: string }[]): number {
  measureCtx.font = `600 ${0.78 * 16}px ${getComputedStyle(document.body).fontFamily}`;
  let w = 0;
  for (const o of options) {w = Math.max(w, measureCtx.measureText(o.label.toUpperCase()).width);}
  return Math.ceil(w) + 11 * 2 + 8 + 12; // padding + gap + caret
}

let openDrop: HTMLElement | null = null;
let kitLocked = false;

/** Locked kits hide most cells - the surviving drops go label-width so
 *  the bar shrink-wraps them; unlocked keeps the option-list floor. */
function compactDrops(ui: BarUi): void {
  for (const d of [ui.beltDrop, ui.skillDrop, ui.perkDrop, ui.classDrop, ui.sidearmDrop, ui.packDrop]) {
    if (d) {d.el.style.minWidth = kitLocked ? '0px' : `${Number(d.el.dataset.loW ?? 0)}px`;}
  }
}

interface BarUi {
  slotDrops: Drop[]; beltDrop: Drop | null; skillDrop: Drop | null;
  perkDrop: Drop | null; classDrop: Drop | null; sidearmDrop: Drop | null;
  packDrop: Drop | null; beltLabel: HTMLElement | null; skillLabel: HTMLElement | null;
  sidearmLabel: HTMLElement | null; packLabel: HTMLElement | null;
  sidearmCell: HTMLElement | null; packCell: HTMLElement | null;
  armorTiles: { v: string; el: HTMLElement }[];
  /** Whole-group boxes - instagib hides ARMOR/WEAPONS/KIT-row-A outright
   *  (kit is forced); only SKILL + PERK stay live. */
  armorBox: HTMLElement | null; weaponBox: HTMLElement | null; kitBoxA: HTMLElement | null;
}

type MkDrop = (options: DropOpt[], onPick: (v: string) => void, faceOpts?: DropOpt[], cols2?: boolean) => Drop;

// Panel construction - three labeled groups (ARMOR / WEAPONS / KIT) inside
// one bottom sheet. Class is a tile picker because its tradeoff (speed vs
// HP) reads at a glance; everything else stays a dropup chip.
function buildRows(bar: HTMLElement, deps: LoadoutDeps, mkDrop: MkDrop): BarUi {
  const ui: BarUi = {
    slotDrops: [], beltDrop: null, skillDrop: null, perkDrop: null,
    classDrop: null, sidearmDrop: null, packDrop: null,
    beltLabel: null, skillLabel: null, sidearmLabel: null, packLabel: null,
    sidearmCell: null, packCell: null, armorTiles: [],
    armorBox: null, weaponBox: null, kitBoxA: null,
  };

  const mkGroup = (title: string, showHead = true): HTMLElement => {
    const g = document.createElement('div');
    g.className = 'lo-group';
    const h = document.createElement('div');
    if (showHead) {
      h.className = 'lo-head';
      h.textContent = title;
      g.append(h);
    }
    const cells = document.createElement('div');
    cells.className = 'lo-cells';
    g.append(cells);
    bar.append(g);
    return cells;
  };

  // --- ARMOR: tile picker, not a dropup - headless like the other
  // groups; three labeled tiles need no banner to read as armor class.
  const armorCells = mkGroup('ARMOR', false);
  ui.armorBox = armorCells;
  const tiles = document.createElement('div');
  tiles.className = 'lo-tiles';
  armorCells.append(tiles);
  const classTileEls: { v: string; el: HTMLElement }[] = [];
  const pickClass = (v: string): void => {
    const player = deps.lazyPlayer();
    if (player.armory.igun) {return;}
    if (player.armory.instagib && v !== 'light') {return;}
    player.setArmorClass(v as ArmorClass);
    deps.lazyNetworkManager?.()?.sendClassUpdate(v);
    // Re-flag locks + re-face chips for the tier just picked - the menu
    // now edits that tier's pending kit (live gun untouched until
    // respawn), so faces show the recalled kit and gates follow it.
    const opts = weaponOptsFor(player.armorClass);
    ui.slotDrops.forEach((d, i): void => { d.setOptions?.(opts); d.setValue(String(player.menuKit[i])); });
    markSlotUse(player, ui.slotDrops);
    refreshTiles();
  };
  const refreshTiles = (): void => {
    const cur = deps.lazyPlayer()?.armorClass ?? 'medium';
    for (const t of classTileEls) {t.el.classList.toggle('sel', t.v === cur);}
  };
  for (const cls of ['light', 'medium', 'heavy'] as const) {
    const t = document.createElement('div');
    t.className = 'lo-tile';
    const name = document.createElement('span');
    name.className = 'lo-tile-name';
    name.textContent = cls.toUpperCase();
    t.append(name);
    t.addEventListener('click', (e): void => { e.stopPropagation(); pickClass(cls); });
    tiles.append(t);
    classTileEls.push({ v: cls, el: t });
  }
  ui.armorTiles = classTileEls;
  // Drop-compatible shim: refreshLoadout drives faces via setValue.
  ui.classDrop = { el: tiles, setValue: (): void => refreshTiles() };

  // --- WEAPONS: one numbered cell per slot. No group head - every cell
  // is already captioned, the banner just ate vertical space. ---
  const weaponCells = mkGroup('WEAPONS', false);
  ui.weaponBox = weaponCells;
  // Filter by armorClass - the tier the menu edits (a banked class swap
  // edits that tier's kit, so its legal picks must show). lazyPlayer can
  // be unborn at wire-up - default the flag pass to medium.
  const weaponOpts = weaponOptsFor(deps.lazyPlayer()?.armorClass ?? 'medium');
  const allWeaponOpts = weaponOpts; // label source for filtered-out picks
  for (let i = 0; i < Player.LOADOUT_SLOTS; i += 1) {
    const { cell, cap } = mkCellDom(weaponCells);
    cap.textContent = `SLOT ${i + 1}`;
    const drop = mkDrop(weaponOpts, (v): void => deps.lazyPlayer().setLoadoutSlot(i, Number(v)), allWeaponOpts);
    cell.append(drop.el);
    ui.slotDrops.push(drop);
  }

  // --- KIT: two rows - SIDEARM+BELT up top, PACK+SKILL+PERK under;
  // five cells in one nowrap strip overflowed the bar's width. ---
  const kitRowA = mkGroup('KIT', false);
  kitRowA.classList.add('lo-grid2');
  ui.kitBoxA = kitRowA;
  const kitRowB = mkGroup('KIT', false);
  kitRowB.classList.add('lo-grid3');
  const sidearm = mkCellDom(kitRowA);
  ui.sidearmCell = sidearm.cell;
  ui.sidearmLabel = sidearm.cap;
  ui.sidearmDrop = mkDrop(
    // The SIDEARM table owns id→wid+label - the menu derives, so a new
    // sidearm is one table entry, not a menu edit.
    Object.entries(PlayerLoadout.SIDEARM)
      .map(([v, s]): { v: string; label: string } => ({ v, label: s.label }))
      .toSorted(byLabel),
    (v): void => deps.lazyPlayer().setSidearm(v as SidearmId),
  );
  sidearm.cell.append(ui.sidearmDrop.el);

  const belt = mkCellDom(kitRowA);
  ui.beltLabel = belt.cap;
  ui.beltDrop = mkDrop(
    BELT_OPTS,
    (v): void => deps.lazyPlayer().setBeltItem(v as BeltItem),
  );
  belt.cell.append(ui.beltDrop.el);

  const pack = mkCellDom(kitRowB);
  ui.packCell = pack.cell;
  ui.packLabel = pack.cap;
  ui.packDrop = mkDrop(
    PACK_KINDS.map((kind): { v: DeployKind; label: string; } => ({ v: kind, label: DEPLOY_ITEMS[kind].label })).toSorted(byLabel),
    (v): void => deps.lazyPlayer().setPackItem(v as DeployKind),
  );
  pack.cell.append(ui.packDrop.el);

  const skill = mkCellDom(kitRowB);
  ui.skillLabel = skill.cap;
  ui.skillDrop = mkDrop(
    SKILL_ORDER.map((s): { v: SkillId; label: string; } => ({ v: s, label: s[0].toUpperCase() + s.slice(1) })).toSorted(byLabel),
    (v): void => deps.lazyPlayer().setSkill(v as SkillId),
  );
  skill.cell.append(ui.skillDrop.el);

  const perk = mkCellDom(kitRowB);
  perk.cap.textContent = 'PERK';
  ui.perkDrop = mkDrop(
    // 'none' stays on top — it banners full-width as the absence pick.
    PERK_ORDER.map((p): { v: PerkId; label: string; desc: string; } => ({ v: p, label: PERKS[p].name, desc: PERKS[p].blurb }))
      .toSorted((a, b): number => (a.v === 'none' ? -1 : b.v === 'none' ? 1 : byLabel(a, b))),
    (v): void => {
      deps.lazyPlayer().setPerk(v as PerkId);
      deps.lazyNetworkManager?.()?.sendPerkUpdate(v);
    },
    undefined, true, // 2 cols - 10 perks stack taller than the menu otherwise
  );
  perk.cell.append(ui.perkDrop.el);

  return ui;
}



const byLabel = (a: { label: string }, b: { label: string }): number => a.label.localeCompare(b.label);

const BELT_OPTS: DropOpt[] = BELT_ITEMS.map((b) => ({ v: b, label: BELT_LABELS[b] })).toSorted(byLabel);
const BELT_HOOK_ONLY: DropOpt[] = [{ v: 'hook', label: BELT_LABELS.hook }];
const RAIL_WID = widOf(WeaponType.Railgun);

// Only equippable weapons list - the class gate hides other tiers'
// ordnance outright; grayed-out dead options were pure noise.
function weaponOptsFor(cls: ArmorClass): DropOpt[] {
  return SLOT_DEFS
    .map((def, wid): { v: string; label: string; name: string; tier: number; sidearm: boolean; disabled: boolean; } => {
      const tag = TIER_TAG.get(String(wid));
      return {
        v: String(wid),
        label: (tag ? `${tag} ` : '') + def.config.displayName,
        name: def.config.displayName,
        tier: tag ? 1 : 0,
        sidearm: Boolean(def.sidearm),
        disabled: Player.lockedForClass(cls, wid),
      };
    })
    .filter((o): boolean => !o.sidearm && !o.disabled)
    // SLOT_DEFS order is wire identity (wid = index) - the MENU sorts by
    // name instead; v stays the wid so picks never reshuffle. Tier-locked
    // ordnance trails the standard list - [H]/[M]/[L] sort before letters.
    .toSorted((a, b): number => a.tier - b.tier || a.name.localeCompare(b.name));
}



/** Faint-mark weapons already sitting in a sibling slot - one open
 *  list then shows the whole kit at a glance. */
function markSlotUse(player: Player, slotDrops: Drop[]): void {
  const kit = player.menuKit.map(String);
  slotDrops.forEach((d, i): void => {
    const used = new Set(kit);
    used.delete(kit[i]); // this slot's pick keeps the bright .sel, not 'used'
    d.markUsed?.(used);
  });
}



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
    el.append(face);
    const caret = document.createElement('span');
    caret.className = 'lo-caret';
    caret.textContent = '▴';
    el.append(caret);
    const list = document.createElement('div');
    list.className = cols2 ? 'lo-list cols2' : 'lo-list';
    el.append(list);
    let options = initialOptions;
    let currentV = '';
    const rebuild = (): void => {
      const w = dropWidth(options);
      // Width lives on the LIST (it's absolutely positioned, can overflow
      // the face) - under a kit lock the face shrinks to its label.
      el.dataset.loW = String(w);
      el.style.minWidth = kitLocked ? '0px' : `${w}px`;
      list.style.minWidth = `${w}px`;
      list.innerHTML = '';
      for (const o of options) {
        const it = document.createElement('div');
        it.className = 'lo-opt';
        if (o.disabled) {it.classList.add('locked');}
        // 'none' isn't a perk - banner it across both columns.
        if (cols2 && o.v === 'none') {it.classList.add('full');}
        const name = document.createElement('span');
        name.className = 'lo-name';
        name.textContent = o.label;
        it.append(name);
        if (o.desc) {
          // Perks are the only invisible pick - everything else
          // self-explains in a second of firing it.
          it.classList.add('has-desc');
          const d = document.createElement('span');
          d.className = 'lo-desc';
          d.textContent = o.desc;
          it.append(d);
        }
        it.dataset.v = o.v;
        it.addEventListener('click', (e): void => {
          e.stopPropagation();
          // oxlint-disable-next-line vitest/no-conditional-in-test -- rule misfires on the it() item-builder above
          // oxlint-disable-next-line vitest/no-conditional-in-test -- rule misfires on the it() item-builder above
          if (o.disabled) {return;} // tier-locked - visible but unshoulderable
          onPick(o.v);
          el.classList.remove('open');
          openDrop = null;
          refreshLoadout();
        });
        list.append(it);
      }
    };
    rebuild();
    el.addEventListener('click', (e): void => {
      e.stopPropagation();
      const was = el.classList.contains('open');
      openDrop?.classList.remove('open');
      el.classList.toggle('open', !was);
      openDrop = was ? null : el;
    });
    return {
      el,
      setValue(v): void {
        currentV = v;
        // faceOpts resolves labels the filtered list can't - an equipped
        // heavy weapon on lighter armor must name itself, not print "6".
        face.textContent = options.find((o): boolean => o.v === v)?.label
          ?? faceOpts?.find((o): boolean => o.v === v)?.label ?? v;
        list.querySelectorAll<HTMLElement>('.lo-opt').forEach((o): boolean =>
          o.classList.toggle('sel', o.dataset.v === v));
      },
      setOptions(next): void {
        options = next;
        rebuild();
        // The equipped value may have survived the filter - re-face it.
        this.setValue(currentV);
      },
      // 'used' = equipped in a sibling slot - a faint tint reads "already
      // in the kit" without competing with this slot's bright .sel.
      markUsed(used): void {
        list.querySelectorAll<HTMLElement>('.lo-opt').forEach((o): void => {
          const v = o.dataset.v ?? '';
          o.classList.toggle('used', v !== currentV && used.has(v));
        });
      },
    };
  }

  // Clicking the bar's dead space closes any open dropup
  loadoutBar?.addEventListener('click', (): void => {
    openDrop?.classList.remove('open');
    openDrop = null;
  });

  const ui = loadoutBar ? buildRows(loadoutBar, deps, mkDrop) : null;

  function refreshLoadout(): void {
    if (!ui) {return;}
    const player = deps.lazyPlayer();
    // Room modifiers own parts of the kit: instagib forces chassis+gun+
    // belt outright (only skill/perk live); gun game keeps class/skill/
    // perk but the ladder owns the weapon band and the belt is hook-only.
    const insta = player.armory.instagib;
    const gg = player.armory.gunGame;
    const {igun} = player.armory;
    kitLocked = insta || gg;
    // The class is the durable lock signal - inline min-width set before
    // or after races rebuilds, the CSS rule can't be outrun.
    document.getElementById('loadout-bar')?.classList.toggle('lo-lock', kitLocked);
    compactDrops(ui);
    if (ui.armorBox) {ui.armorBox.style.display = (insta || igun) ? 'none' : '';}
    if (ui.weaponBox) {ui.weaponBox.style.display = (insta || gg) ? 'none' : '';}
    if (ui.kitBoxA) {ui.kitBoxA.style.display = (insta || gg) ? 'none' : '';}
    const opts = insta
      ? weaponOptsFor('light').filter((o): boolean => o.v === String(RAIL_WID))
      : weaponOptsFor(player.armorClass);
    ui.slotDrops.forEach((d, i): void => { d.setOptions?.(opts); d.setValue(String(player.menuKit[i])); });
    markSlotUse(player, ui.slotDrops);
    ui.beltDrop?.setOptions?.(insta || gg ? BELT_HOOK_ONLY : BELT_OPTS);
    ui.beltDrop?.setValue(player.menuGear.beltItem);
    ui.skillDrop?.setValue(player.menuGear.skill);
    ui.perkDrop?.setValue(player.menuGear.perk);
    ui.classDrop?.setValue(player.armorClass);
    ui.sidearmDrop?.setValue(player.menuGear.sidearm);
    ui.packDrop?.setValue(player.menuGear.packItem);
    if (ui.sidearmCell) {ui.sidearmCell.style.display = (insta || gg) ? 'none' : '';}
    if (ui.packCell) {ui.packCell.style.display = (insta || gg) ? 'none' : '';}
    if (ui.beltLabel) {ui.beltLabel.textContent = `BELT (${codeLabel(codeFor('belt'))})`;}
    if (ui.skillLabel) {ui.skillLabel.textContent = `SKILL (${codeLabel(codeFor('skill'))})`;}
    if (ui.sidearmLabel) {ui.sidearmLabel.textContent = `SIDEARM (${codeLabel(codeFor('sidearm'))})`;}
    if (ui.packLabel) {ui.packLabel.textContent = `PACK (${codeLabel(codeFor('deploy'))})`;}
  }

  // Menu close must not strand an open dropup - resume, then next ESC
  // shows a list floating over a face that isn't asking for it.
  function closeDrops(): void {
    openDrop?.classList.remove('open');
    openDrop = null;
  }

  return { refreshLoadout, closeDrops };
}

function mkCellDom(parent: HTMLElement): { cell: HTMLElement; cap: HTMLSpanElement } {
  const cell = document.createElement('div');
  cell.className = 'lo-cell';
  const cap = document.createElement('span');
  cap.className = 'lo-cap';
  cell.append(cap);
  parent.append(cell);
  return { cell, cap };
}

// Sidearms are chosen in their own row - a primary slot offering them
// would let a loadout double-carry the hold-out tier. Tier-locked
// ordnance stays listed but tagged [H]/[M]/[L] and grayed out -
// lockedForClass flags it in the list AND gates it in setLoadoutSlot.
const TIER_TAG = new Map<string, string>([
  ...Player.HEAVY_ONLY.map((w): readonly [string, "[H]"] => [String(w), '[H]'] as const),
  ...Player.MEDIUM_ONLY.map((w): readonly [string, "[M]"] => [String(w), '[M]'] as const),
  ...Player.LIGHT_ONLY.map((w): readonly [string, "[L]"] => [String(w), '[L]'] as const),
]);
