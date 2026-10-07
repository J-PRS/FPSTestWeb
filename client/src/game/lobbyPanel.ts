import { settings } from '../core/settings.js';
import { urlParams } from '../core/params.js';
import type { LobbyDeps } from './lobby.js';

// Lobby panel DOM — styling lives in ui/chrome.css (.lb-*); this builds
// structure and wires behavior. Host is the Lobby facade: its event
// handlers (toggle/join/fillMapSelect) get bound here.

export interface LobbyPanelHost {
  deps: LobbyDeps;
  toggle(): void;
  fillMapSelect(): void;
  mapFamOn(kind: 't2' | 'custom'): boolean;
  toggleMapFam(kind: 't2' | 'custom'): void;
  join(name: string, map?: string, bots?: number, mode?: string, unlisted?: boolean): void;
  currentRoom(): string;
  /** Favorites persist across sessions — classic browser column. */
  isFav(name: string): boolean;
  toggleFav(name: string): void;
  /** Repolls the room list on demand (the ↻ button). */
  refresh(): void;
}

export interface LobbyPanelEls {
  panel: HTMLDivElement;
  here: HTMLDivElement;
  rows: HTMLDivElement;
  mapSelect: HTMLSelectElement;
  modeSelect: HTMLSelectElement;
  botsInput: HTMLInputElement;
  leaveBtn: HTMLButtonElement;
  /** Repoll the open-lobby list — Lobby calls it on open + poll tick. */
  refreshLobs(): void;
  /** Server RTT readout in the JOIN header — Lobby writes it per poll. */
  pingEl: HTMLSpanElement;
}

function btn(text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.className = 'lb-btn';
  return b;
}

function field(text: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'lb-field';
  const span = document.createElement('span');
  span.textContent = text;
  row.appendChild(span);
  return row;
}

function label(text: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = 'lb-label lb-spaced';
  d.textContent = text;
  return d;
}

/** Buttons persist to settings then reload so the URL params stay the
 *  single source of truth (?p2p=/?lobby). */
function p2pGo(p2p: string, lobby: number): void {
  settings.set('fps-p2p', p2p);
  settings.set('fps-lobby', lobby);
  location.reload();
}

function buildP2PButtons(p2pIn: HTMLInputElement): HTMLDivElement {
  const code = () => p2pIn.value.trim() || 'duel';
  const wrap = document.createElement('div');
  wrap.className = 'lb-quick';
  const specs: [string, () => void][] = [
    ['HOST PRIVATE', () => p2pGo(`host:${code()}`, 0)],
    ['JOIN BY CODE', () => p2pGo(`join:${code()}`, 0)],
    // Open lobby: listed publicly — anyone pressing QUICK DUEL lands here.
    ['HOST PUBLIC', () => p2pGo(`host:${code()}`, 1)],
    // Quick join: the relay hands back the oldest open lobby.
    ['QUICK DUEL', () => p2pGo('quick', 0)],
  ];
  for (const [text, fn] of specs) {
    const b = btn(text);
    b.addEventListener('click', fn);
    wrap.appendChild(b);
  }
  return wrap;
}

/** Offline solo/bot modes — the same modes the ESC-menu MODE select
 *  exposes, as one-click entries (classic browser "create local game"). */
const OFFLINE_MODES: [string, string][] = [
  ['', 'SOLO — no bots'],
  ['nuggets', 'NUGGET WARS 5v5'],
  ['ctf', 'CTF 5v5'],
  ['dm', 'DEATHMATCH ×10'],
  ['flagrun', 'FLAG RUN (solo)'],
  ['classic', 'CLASSIC'],
];

function playOffline(mode: string): void {
  settings.set('fps-mode', mode);
  settings.set('fps-p2p', '');
  settings.set('fps-lobby', 0);
  const q = new URLSearchParams(location.search);
  for (const k of ['room', 'p2p', 'lobby', 'map', 'bots', 'mode']) q.delete(k);
  const href = q.toString() ? `${location.pathname}?${q}` : location.pathname;
  location.href = href;
}

function buildOfflineList(): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'lb-rows';
  for (const [mode, text] of OFFLINE_MODES) {
    const row = btn(text);
    row.classList.add('lb-room');
    row.style.textAlign = 'left';
    row.addEventListener('click', () => playOffline(mode));
    wrap.appendChild(row);
  }
  return wrap;
}


/** MAP picker + pre-rendered thumbnail preview — the image swaps on
 *  selection/refill and hides itself when a map has no rendered thumb. */
function mapPicker(h: LobbyPanelHost): { select: HTMLSelectElement; thumb: HTMLImageElement } {
  const select = document.createElement('select');
  select.className = 'lb-input';
  select.style.cssText = 'cursor:pointer;flex:1;min-width:0;';
  const thumb = document.createElement('img');
  thumb.className = 'lb-mapthumb';
  // Block element BELOW the field row, not a flex item inside it — a
  // flex child sizes to the image's natural pixels and overflows.
  thumb.style.cssText = 'display:block;width:100%;height:auto;aspect-ratio:4/3;object-fit:cover;border-radius:4px;margin-top:4px;';
  thumb.alt = 'map preview';
  // Thumbs are optional — mapthumbs.ts only renders them on demand. An
  // <img> 404 spams the console, so probe with fetch first: a missing
  // thumb quietly hides, a present one loads from cache.
  let probe = 0;
  const update = async () => {
    const url = select.value && h.deps.mapThumbUrl ? h.deps.mapThumbUrl(select.value) : '';
    const gen = ++probe;
    if (!url) { thumb.style.display = 'none'; return; }
    const ok = await fetch(url).then((r) => r.ok).catch(() => false);
    if (gen !== probe) return; // selection moved on while probing
    thumb.style.display = ok ? 'block' : 'none';
    if (ok) thumb.src = url;
  };
  thumb.addEventListener('error', () => { thumb.style.display = 'none'; });
  select.addEventListener('change', update);
  // Refills change the selection without firing 'change' — watch the
  // option list so the preview tracks mode filtering too.
  new MutationObserver(update).observe(select, { childList: true });
  return { select, thumb };
}

export function buildLobbyPanel(h: LobbyPanelHost): LobbyPanelEls {

    // The trigger lives in the ESC menu (#lobby-open in index.html) —
    // a floating HUD button during gameplay was HUD clutter. The panel
    // mounts inside #overlay so menu-close takes it down too.
    const openBtn = document.getElementById('lobby-open');
    if (openBtn) openBtn.addEventListener('click', () => h.toggle());

    // ESC-menu disconnect — the classic "leave server" is a one-shot
    // reload to a clean URL: solo boot IS the disconnected state, so no
    // teardown logic lives client-side. Visibility re-evaluates on each
    // menu open because in-place switchRoom hops change the room without
    // a reload.
    const leaveServerBtn = document.getElementById('leave-server');
    const syncLeaveBtn = () => {
      if (!leaveServerBtn) {return;}
      const online = urlParams.room != null || urlParams.p2p != null || settings.get('fps-p2p') !== '';
      leaveServerBtn.style.display = online ? 'block' : 'none';
    };
    if (leaveServerBtn) {
      syncLeaveBtn();
      leaveServerBtn.addEventListener('click', () => {
        settings.set('fps-p2p', '');
        settings.set('fps-lobby', 0);
        const q = new URLSearchParams(location.search);
        for (const k of ['room', 'p2p', 'lobby']) q.delete(k);
        location.href = q.toString() ? `${location.pathname}?${q}` : location.pathname;
      });
    }

    const panel = document.createElement('div');
    panel.className = 'lb-panel';
    panel.style.display = 'none';

    // Tabbed hub — the classic server-browser layout: JOIN is the room
    // list, HOST is match setup, SOLO/DUEL are one-purpose pages.
    const tabBar = document.createElement('div');
    tabBar.className = 'lb-tabs';
    const tabs = new Map<string, HTMLDivElement>();
    const tabBtns: HTMLButtonElement[] = [];
    const showTab = (name: string) => {
      for (const [n, el] of tabs) el.style.display = n === name ? 'block' : 'none';
      for (const b of tabBtns) b.classList.toggle('active', b.dataset.tab === name);
    };
    for (const name of ['JOIN', 'HOST', 'SOLO', 'P2P']) {
      const b = btn(name);
      b.dataset.tab = name;
      b.addEventListener('click', () => showTab(name));
      tabBtns.push(b);
      tabBar.appendChild(b);
      const page = document.createElement('div');
      page.style.display = 'none';
      tabs.set(name, page);
    }

    // ---- JOIN page: server browser ------------------------------------
    const joinPage = tabs.get('JOIN')!;
    const headRow = document.createElement('div');
    headRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const head = label('MATCHES');
    head.style.cssText = 'margin-top:0;flex:1;';
    const refreshBtn = btn('↻');
    refreshBtn.title = 'refresh list';
    refreshBtn.style.cssText = 'font-size:0.7rem;padding:2px 8px;';
    refreshBtn.addEventListener('click', () => { h.refresh(); refreshLobsFn(); });
    // Server-level RTT — one ping covers every room row (they all live
    // on the same host), so it lives in the header, not a column.
    const pingEl = document.createElement('span');
    pingEl.style.cssText = 'font-size:0.62rem;letter-spacing:0.06em;';
    headRow.append(head, pingEl, refreshBtn);
    const hereRow = document.createElement('div');
    hereRow.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const here = document.createElement('div');
    here.className = 'lb-here';
    here.style.flex = '1';
    here.textContent = `IN: ${h.currentRoom().toUpperCase()}`;
    // LEAVE = hop back to the immortal default lobby room (in-place
    // switchRoom when the socket is live, reload otherwise) — only
    // meaningful while you're in a named match.
    const leaveBtn = btn('LEAVE');
    leaveBtn.style.cssText = 'font-size:0.6rem;padding:2px 8px;';
    leaveBtn.addEventListener('click', () => h.join('default'));
    hereRow.append(here, leaveBtn);
    const rows = document.createElement('div');
    rows.className = 'lb-rows';

    // Match setup — mode (ruleset) and map (geometry) are separate picks:
    // MODE filters which maps are offered, MAP picks the arena. Bot count
    // can override the spec default.
    const hostLbl = label('NEW MATCH');
    const nameRow = field('NAME');
    const nameInput = document.createElement('input');
    nameInput.maxLength = 32;
    nameInput.placeholder = 'auto';
    nameInput.className = 'lb-input';
    nameInput.style.cssText = 'flex:1;min-width:0;';
    nameInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') hostBtn.click();
    });
    nameRow.appendChild(nameInput);
    const modeRow = field('MODE');
    const modeSelect = document.createElement('select');
    modeSelect.className = 'lb-input';
    modeSelect.style.cssText = 'cursor:pointer;flex:1;min-width:0;';
    modeSelect.addEventListener('change', () => h.fillMapSelect());
    modeRow.appendChild(modeSelect);
    // Map-family toggles — T2 ports vs our own arenas. Both on = full
    // list; each can be dropped to shrink the picker. Refills through
    // the host so MODE and family compose.
    const famRow = document.createElement('div');
    famRow.className = 'lb-quick';
    famRow.style.marginBottom = '2px';
    for (const [kind, text] of [['t2', 'T2'], ['custom', 'CUSTOM']] as const) {
      const b = btn(text);
      b.classList.toggle('active', h.mapFamOn(kind));
      b.addEventListener('click', () => {
        h.toggleMapFam(kind);
        b.classList.toggle('active', h.mapFamOn(kind));
      });
      famRow.appendChild(b);
    }
    // PRIVATE rides the same toggle row — an unlisted room is off /rooms
    // and quick-join; friends get in by CREATE / JOIN BY NAME only.
    const privBtn = btn('PRIVATE');
    privBtn.classList.toggle('active', settings.get('fps-unlisted') === 1);
    privBtn.title = 'unlisted — not on the public room list';
    privBtn.addEventListener('click', () => {
      const on = settings.get('fps-unlisted') !== 1;
      settings.set('fps-unlisted', on ? 1 : 0);
      privBtn.classList.toggle('active', on);
    });
    famRow.appendChild(privBtn);
    const mapRow = field('MAP');
    const { select: mapSelect, thumb: mapThumb } = mapPicker(h);
    mapRow.appendChild(mapSelect);
    const botsRow = field('BOTS');
    const botsInput = document.createElement('input');
    botsInput.type = 'number';
    botsInput.min = '0'; botsInput.max = '24';
    botsInput.placeholder = 'map default';
    botsInput.className = 'lb-input';
    botsInput.style.cssText = 'width:110px;text-align:right;';
    botsInput.addEventListener('keydown', (e) => e.stopPropagation());
    botsRow.appendChild(botsInput);
    const hostBtn = btn('PLAY');
    hostBtn.style.cssText = 'width:100%;margin-top:6px;border-color:rgba(58,167,255,0.4);';
    hostBtn.addEventListener('click', async () => {
      hostBtn.disabled = true;
      try {
        const map = mapSelect.value;
        // ANY = let the map's own spec decide the ruleset.
        const mode = modeSelect.value || mapSelect.selectedOptions[0]?.dataset.mode || '';
        const bots = botsInput.value === '' ? undefined : Math.max(0, Math.min(24, Number(botsInput.value) || 0));
        // A typed name skips quickJoin — host names their own room. The
        // MODE pick still applies or a named host silently drops it.
        const named = nameInput.value.trim();
        const priv = settings.get('fps-unlisted') === 1;
        // A named PRIVATE room is always self-hosted — quickJoin would
        // land in someone's public match instead of creating ours.
        const room = named || (priv ? `room-${Math.random().toString(36).slice(2, 8)}` : (await h.deps.quickJoin(mode, map || undefined, bots)).room);
        h.join(room, map || undefined, bots, mode || undefined, priv || undefined);
      } catch { hostBtn.disabled = false; }
    });

    const quickLbl = label('QUICK JOIN');
    const quick = document.createElement('div');
    quick.className = 'lb-quick';
    for (const mode of ['nuggets', 'ctf', 'dm', 'tdm']) {
      const b = btn(mode.toUpperCase());
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { h.join((await h.deps.quickJoin(mode)).room); }
        catch { b.disabled = false; }
      });
      quick.appendChild(b);
    }

    const newWrap = document.createElement('div');
    newWrap.className = 'lb-newrow';
    const input = document.createElement('input');
    input.maxLength = 32;
    input.placeholder = 'new room name';
    input.className = 'lb-input';
    input.style.flex = '1';
    // Named-room joins honor the HOST MATCH pickers — a fresh room spins up
    // from the selected spec + bot count instead of always landing bare.
    const named = () => {
      const v = input.value.trim();
      if (!v) return;
      const map = mapSelect.value || undefined;
      const mode = modeSelect.value || mapSelect.selectedOptions[0]?.dataset.mode || undefined;
      const bots = botsInput.value === '' ? undefined : Math.max(0, Math.min(24, Number(botsInput.value) || 0));
      h.join(v, map, bots, mode);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') named();
    });
    const create = btn('JOIN');
    create.addEventListener('click', named);
    newWrap.append(input, create);

    // Server + P2P — the URL params ?server=/?p2p= still work for links,
    // but these fields make them reachable without editing the URL.
    const connLbl = label('CONNECTION');
    const srvRow = field('SERVER');
    const srvIn = document.createElement('input');
    srvIn.placeholder = 'host (blank = local)';
    srvIn.value = settings.get('fps-server');
    srvIn.className = 'lb-input';
    srvIn.style.cssText = 'flex:1;min-width:0;';
    srvIn.addEventListener('keydown', (e) => e.stopPropagation());
    const srvBtn = btn('GO');
    srvBtn.addEventListener('click', () => { settings.set('fps-server', srvIn.value.trim()); location.reload(); });
    srvRow.append(srvIn, srvBtn);

    const plyRow = field('PLAYER');
    const plyIn = document.createElement('input');
    plyIn.maxLength = 24;
    plyIn.placeholder = 'display name';
    plyIn.value = settings.get('fps-name');
    plyIn.className = 'lb-input';
    plyIn.style.cssText = 'flex:1;min-width:0;';
    plyIn.addEventListener('keydown', (e) => e.stopPropagation());
    // Names ship on the next join handshake — no need to reload mid-edit.
    plyIn.addEventListener('input', () => settings.set('fps-name', plyIn.value.trim()));
    plyRow.appendChild(plyIn);

    const p2pRow = field('P2P DUEL');
    const p2pIn = document.createElement('input');
    p2pIn.maxLength = 24;
    p2pIn.placeholder = 'code';
    // Strip the role prefix for display; the saved value is 'role:code'.
    const savedP2p = settings.get('fps-p2p');
    p2pIn.value = savedP2p.includes(':') ? savedP2p.slice(savedP2p.indexOf(':') + 1) : '';
    p2pIn.className = 'lb-input';
    p2pIn.style.cssText = 'flex:1;min-width:0;';
    p2pIn.addEventListener('keydown', (e) => e.stopPropagation());
    p2pRow.appendChild(p2pIn);
    const p2pBtns = buildP2PButtons(p2pIn);

    // Open P2P lobbies — the relay lists public hosts still waiting for
    // a peer; clicking one is join:code without typing it.
    const lobLbl = label('OPEN LOBBIES');
    const lobRows = document.createElement('div');
    lobRows.className = 'lb-rows';
    const refreshLobsFn = async () => {
      lobRows.textContent = '';
      if (!h.deps.listP2pLobbies) return;
      try {
        const lobs = await h.deps.listP2pLobbies();
        if (lobs.length === 0) { lobRows.textContent = '— none open —'; lobRows.style.color = 'rgba(58,167,255,0.5)'; return; }
        lobRows.style.color = '';
        for (const l of lobs) {
          const row = btn(`${l.room}  ·  ${Math.max(0, Math.round((Date.now() - l.since) / 60000))}m`);
          row.classList.add('lb-room');
          row.style.textAlign = 'left';
          row.addEventListener('click', () => p2pGo(`join:${l.room}`, 0));
          lobRows.appendChild(row);
        }
      } catch { /* relay unreachable — same failure class as /rooms */ }
    };
    const refreshLobs = () => { void refreshLobsFn(); };
    refreshLobs();

    joinPage.append(headRow, hereRow, rows, quickLbl, quick, connLbl, plyRow, srvRow, label('CREATE / JOIN BY NAME'), newWrap);
    tabs.get('HOST')!.append(hostLbl, nameRow, modeRow, famRow, mapRow, mapThumb, botsRow, hostBtn);
    tabs.get('SOLO')!.append(buildOfflineList());
    tabs.get('P2P')!.append(p2pRow, p2pBtns, lobLbl, lobRows);

    panel.append(tabBar, joinPage, tabs.get('HOST')!, tabs.get('SOLO')!, tabs.get('P2P')!);
    showTab('JOIN');
    (document.getElementById('overlay') ?? document.body).appendChild(panel);
    // Menu closed while the panel was open (resume / re-lock) — display:none
    // hides it anyway, but the poll timer would keep burning for nothing.
    let menuWasOpen = false;
    new MutationObserver(() => {
      const menuOpen = document.body.classList.contains('menu-open');
      if (!menuOpen && panel.style.display !== 'none') h.toggle();
      // Not in a game → the browser IS the front door: the menu OPEN
      // transition lands on the room list. Edge-triggered only — a user
      // who closed the panel while the menu stays open keeps it closed.
      const offline = urlParams.room == null && urlParams.p2p == null && settings.get('fps-p2p') === '';
      if (menuOpen && !menuWasOpen) {
        syncLeaveBtn();
        if (offline && panel.style.display === 'none') h.toggle();
      }
      menuWasOpen = menuOpen;
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  
  return { panel, here, rows, mapSelect, modeSelect, botsInput, leaveBtn, refreshLobs, pingEl };
}
