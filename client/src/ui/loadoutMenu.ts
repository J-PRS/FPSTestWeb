// Loadout bar — the bottom-center chip row of the ESC menu. Custom
// dropups, not <select>: a native popup is OS chrome and breaks the
// game-menu illusion. Chip face + styled option list opening upward.
import { SKILL_ORDER, Player, type SkillId, BELT_ITEMS, type BeltItem } from '../entities/Player.js';
import { PERKS, PERK_ORDER, type PerkId } from '../../../shared/perks.js';
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

// Chip width is measured, not hardcoded — canvas-measure the widest
// option (uppercased, same font as .lo-opt) + padding + caret so no
// label ever overflows and no chip is wider than it needs to be.
const measureCtx = document.createElement('canvas').getContext('2d')!;
function dropWidth(options: { label: string }[]): number {
  measureCtx.font = `600 ${0.66 * 16}px ${getComputedStyle(document.body).fontFamily}`;
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

type MkDrop = (options: DropOpt[], onPick: (v: string) => void) => Drop;

export function wireLoadoutBar(deps: LoadoutDeps): { refreshLoadout(): void } {
  const loadoutBar = document.getElementById('loadout-bar');

  function mkDrop(
    initialOptions: DropOpt[],
    onPick: (v: string) => void,
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
        face.textContent = options.find((o) => o.v === v)?.label ?? v;
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

// Row construction — each equipment line is a label span plus a chip dropup.
function buildRows(bar: HTMLElement, deps: LoadoutDeps, mkDrop: MkDrop): BarUi {
  const ui: BarUi = {
    slotDrops: [], beltDrop: null, skillDrop: null, perkDrop: null,
    classDrop: null, sidearmDrop: null, packDrop: null,
    beltLabel: null, skillLabel: null, sidearmLabel: null, packLabel: null,
  };
  const mkRow = (labelText: string, gap = false): { row: HTMLElement; label: HTMLSpanElement } => {
    const row = document.createElement('div');
    row.className = gap ? 'lo-row lo-gap' : 'lo-row';
    const label = document.createElement('span');
    label.className = 'lo-label';
    label.textContent = labelText;
    row.appendChild(label);
    bar.appendChild(row);
    return { row, label };
  };

  // Armor class leads the bar — the Tribes loadout decision is tier
  // first, then the weapons you carry in it.
  const classRow = mkRow('CLASS');
  ui.classDrop = mkDrop(
    [{ v: 'light', label: 'Light' }, { v: 'medium', label: 'Medium' }, { v: 'heavy', label: 'Heavy' }],
    (v) => {
      deps.lazyPlayer().setArmorClass(v as 'light' | 'medium' | 'heavy');
      deps.lazyNetworkManager?.()?.sendClassUpdate(v);
      // Class change re-filters the weapon drops on the spot — heavy
      // ordnance shows/hides without closing the menu.
      for (const d of ui.slotDrops) d.setOptions?.(weaponOptsFor(v));
    },
  );
  classRow.row.appendChild(ui.classDrop.el);

  // Sidearms are chosen in their own row — a primary slot offering them
  // would let a loadout double-carry the hold-out tier. Heavy-only
  // ordnance hides when a lighter tier is picked (setArmorClass also
  // unshoulders whatever was equipped).
  const heavyOnly = new Set(Player.HEAVY_ONLY.map(String));
  const weaponOptsFor = (cls: string) => SLOT_DEFS
    .map((def, wid) => ({ v: String(wid), label: def.config.displayName, sidearm: !!def.sidearm }))
    .filter((o) => !o.sidearm && (cls === 'heavy' || !heavyOnly.has(o.v)));
  // The bar can be wired before Player exists — pick the safe default and
  // let the class-change callback + refreshLoadout re-filter for real.
  const weaponOpts = weaponOptsFor(deps.lazyPlayer()?.armorClass ?? 'medium');
  for (let i = 0; i < Player.LOADOUT_SLOTS; i++) {
    const { row } = mkRow(`SLOT ${i + 1}`);
    const drop = mkDrop(weaponOpts, (v) => deps.lazyPlayer().setLoadoutSlot(i, Number(v)));
    row.appendChild(drop.el);
    ui.slotDrops.push(drop);
  }

  const belt = mkRow('', true); // gap separates weapon slots from equipment
  ui.beltLabel = belt.label;
  ui.beltDrop = mkDrop(
    BELT_ITEMS.map((b) => ({ v: b, label: BELT_LABELS[b] })),
    (v) => deps.lazyPlayer().setBeltItem(v as BeltItem),
  );
  belt.row.appendChild(ui.beltDrop.el);

  const sidearm = mkRow('');
  ui.sidearmLabel = sidearm.label;
  ui.sidearmDrop = mkDrop(
    [{ v: 'pistol', label: 'Pistol' }, { v: 'revolver', label: 'Revolver' }, { v: 'shotgun', label: 'Shotgun' }, { v: 'repair', label: 'Repair Tool' }],
    (v) => deps.lazyPlayer().setSidearm(v as 'pistol' | 'revolver' | 'shotgun' | 'repair'),
  );
  sidearm.row.appendChild(ui.sidearmDrop.el);

  const pack = mkRow('');
  ui.packLabel = pack.label;
  ui.packDrop = mkDrop(
    [{ v: 'turret', label: 'Sentry' }, { v: 'mine', label: 'Mine' }, { v: 'station', label: 'Pad' }, { v: 'drone', label: 'Drone' }],
    (v) => deps.lazyPlayer().setPackItem(v as 'turret' | 'mine' | 'station' | 'drone'),
  );
  pack.row.appendChild(ui.packDrop.el);

  const skill = mkRow('');
  ui.skillLabel = skill.label;
  ui.skillDrop = mkDrop(
    SKILL_ORDER.map((s) => ({ v: s, label: s[0].toUpperCase() + s.slice(1) })),
    (v) => deps.lazyPlayer().setSkill(v as SkillId),
  );
  skill.row.appendChild(ui.skillDrop.el);

  const perk = mkRow('PERK');
  ui.perkDrop = mkDrop(
    PERK_ORDER.map((p) => ({ v: p, label: PERKS[p].name, desc: PERKS[p].blurb })),
    (v) => {
      deps.lazyPlayer().setPerk(v as PerkId);
      deps.lazyNetworkManager?.()?.sendPerkUpdate(v);
    },
  );
  perk.row.appendChild(ui.perkDrop.el);

  return ui;
}
