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
  join(name: string, map?: string, bots?: number, mode?: string, unlisted?: boolean, noCreatures?: boolean, noBalls?: boolean): void;
  /** SOLO page's pickers — Lobby refills them from the same map list as
   *  HOST's so both tabs agree on what's playable. */
  bindSoloSelects(modeSel: HTMLSelectElement, mapSel: HTMLSelectElement): void;
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
  row.append(span);
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
  window.location.reload();
}

function buildP2PButtons(p2pIn: HTMLInputElement): HTMLDivElement {
  const code = (): string => p2pIn.value.trim() || 'duel';
  const wrap = document.createElement('div');
  wrap.className = 'lb-quick';
  wrap.style.cssText = 'align-items:center;';
  // Public = listed on the relay so QUICK JOINers land here; off = the
  // code is the only way in.
  let pub = false;
  // .tog styling is scoped to #overlay .btn-row — the wrapper is required
  // for the tile + ON/OFF state box to render at all.
  const pubRow = document.createElement('div');
  pubRow.className = 'btn-row';
  pubRow.style.cssText = 'flex:1;display:flex;';
  const pubBtn = document.createElement('button');
  pubBtn.className = 'tog';
  // Row-height match: .btn-row's 9px padding is sized for the settings
  // column, .lb-quick chips are shorter — slim it to the row's rhythm.
  pubBtn.style.cssText = 'flex:1;padding:4px 8px;';
  pubBtn.textContent = 'PUBLIC';
  pubBtn.title = 'listed publicly — quick-joinable';
  pubBtn.addEventListener('click', (): void => {
    pub = !pub;
    pubBtn.classList.toggle('on', pub);
  });
  pubRow.append(pubBtn);
  const specs: [string, () => void][] = [
    ['HOST', (): void => p2pGo(`host:${code()}`, pub ? 1 : 0)],
    ['JOIN', (): void => p2pGo(`join:${code()}`, 0)],
    // Quick join: the relay hands back the oldest open lobby.
    ['QUICK JOIN', (): void => p2pGo('quick', 0)],
  ];
  for (const [text, fn] of specs) {
    const b = btn(text);
    b.addEventListener('click', fn);
    wrap.append(b);
  }
  wrap.append(pubRow);
  return wrap;
}

/** Solo match setup — the offline twin of HOST's PLAY: reloads onto a
 *  URL carrying ?mode/?map/?bots and NO ?room/?p2p, which is what keeps
 *  the boot offline (see connectPhase: no room = no socket). '' mode is
 *  free roam — pick a ruleset to get bots/flags/scoring. */
function playOffline(mode: string, map: string, bots: number | undefined): void {
  settings.set('fps-mode', mode);
  settings.set('fps-p2p', '');
  settings.set('fps-lobby', 0);
  const q = new URLSearchParams(window.location.search);
  for (const k of ['room', 'p2p', 'lobby', 'map', 'bots', 'mode', 'unlisted', 'solo', 'nocreatures', 'noballs']) {q.delete(k);}
  if (mode) {q.set('mode', mode);}
  if (map) {q.set('map', map);}
  if (bots !== undefined) {q.set('bots', String(bots));}
  // Same sim gates as HOST — the local spawner reads the URL params too.
  if (settings.get('fps-nocreatures') === 1) {q.set('nocreatures', '1');}
  if (settings.get('fps-noballs') === 1) {q.set('noballs', '1');}
  // Marker param — a free-roam pick writes no mode/map/bots at all, but
  // it is still a live session; without this the boot is indistinguishable
  // from a fresh front-door load and the lobby would re-pop mid-game.
  q.set('solo', '1');
  const href = q.toString() ? `${window.location.pathname}?${q}` : window.location.pathname;
  window.location.href = href;
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
  const update = async (): Promise<void> => {
    const url = select.value && h.deps.mapThumbUrl ? h.deps.mapThumbUrl(select.value) : '';
    probe += 1;
    const gen = probe;
    if (!url) { thumb.style.display = 'none'; return; }
    const ok = await fetch(url).then((r): boolean => r.ok).catch((): boolean => false);
    if (gen !== probe) {return;} // selection moved on while probing
    thumb.style.display = ok ? 'block' : 'none';
    if (ok) {thumb.src = url;}
  };
  thumb.addEventListener('error', (): void => { thumb.style.display = 'none'; });
  select.addEventListener('change', update);
  // Refills change the selection without firing 'change' — watch the
  // option list so the preview tracks mode filtering too.
  new MutationObserver(update).observe(select, { childList: true });
  return { select, thumb };
}

/** Renders a select as a row of toggle buttons — the select stays the
 *  value store (hidden), the row is the UI. Rebuilds on option-list
 *  refills (refreshMaps lands post-open). */
function modeToggleRow(sel: HTMLSelectElement): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'lb-quick';
  row.style.cssText = 'flex-wrap:wrap;margin-bottom:2px;';
  const rebuild = (): void => {
    row.textContent = '';
    for (const o of sel.options) {
      const b = btn(o.textContent ?? o.value);
      b.dataset.v = o.value;
      b.classList.toggle('active', o.value === sel.value);
      b.addEventListener('click', (): void => {
        sel.value = o.value;
        sel.dispatchEvent(new Event('change'));
      });
      row.append(b);
    }
  };
  // Programmatic picks (map auto-adopts its default ruleset) fire
  // 'change' without touching the option list — resync actives on it.
  const sync = (): void => {
    for (const x of row.children) {
      (x as HTMLElement).classList.toggle('active', (x as HTMLElement).dataset.v === sel.value);
    }
  };
  sel.addEventListener('change', sync);
  new MutationObserver((): void => { rebuild(); }).observe(sel, { childList: true });
  rebuild();
  return row;
}

/** Map list picker — same contract as modeToggleRow: the hidden select
 *  stays the value store (fillMapSelect/bindSoloSelects keep working),
 *  this renders it as a scrollable column of rows. */
function mapListBox(sel: HTMLSelectElement): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'lb-maplist';
  box.style.cssText = 'flex:0 0 44%;min-width:0;max-height:340px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;';
  const rebuild = (): void => {
    box.textContent = '';
    for (const o of sel.options) {
      const b = btn(o.textContent ?? o.value);
      b.dataset.v = o.value;
      b.style.cssText = 'flex:none;text-align:left;font-size:0.66rem;padding:7px 9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      b.classList.toggle('active', o.value === sel.value);
      b.addEventListener('click', (): void => {
        sel.value = o.value;
        sel.dispatchEvent(new Event('change'));
      });
      box.append(b);
    }
  };
  const sync = (): void => {
    for (const x of box.children) {
      (x as HTMLElement).classList.toggle('active', (x as HTMLElement).dataset.v === sel.value);
    }
  };
  sel.addEventListener('change', sync);
  new MutationObserver(rebuild).observe(sel, { childList: true });
  rebuild();
  return box;
}

export function buildLobbyPanel(h: LobbyPanelHost): LobbyPanelEls {

    // The trigger lives in the ESC menu (#lobby-open in index.html) —
    // a floating HUD button during gameplay was HUD clutter. The panel
    // mounts inside #overlay so menu-close takes it down too.
    const openBtn = document.getElementById('lobby-open');
    if (openBtn) {openBtn.addEventListener('click', (): void => h.toggle());}

    // ESC-menu disconnect — the classic "leave server" is a one-shot
    // reload to a clean URL: solo boot IS the disconnected state, so no
    // teardown logic lives client-side. Visibility re-evaluates on each
    // menu open because in-place switchRoom hops change the room without
    // a reload.
    const leaveServerBtn = document.getElementById('leave-server');
    const syncLeaveBtn = (): void => {
      if (!leaveServerBtn) {return;}
      const online = urlParams.room != null || urlParams.p2p != null || settings.get('fps-p2p') !== '';
      leaveServerBtn.style.display = online ? 'block' : 'none';
    };
    if (leaveServerBtn) {
      syncLeaveBtn();
      leaveServerBtn.addEventListener('click', (): void => {
        settings.set('fps-p2p', '');
        settings.set('fps-lobby', 0);
        const q = new URLSearchParams(window.location.search);
        for (const k of ['room', 'p2p', 'lobby']) {q.delete(k);}
        window.location.href = q.toString() ? `${window.location.pathname}?${q}` : window.location.pathname;
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
    const showTab = (name: string): void => {
      for (const [n, el] of tabs) {el.style.display = n === name ? 'block' : 'none';}
      for (const b of tabBtns) {b.classList.toggle('active', b.dataset.tab === name);}
    };
    for (const name of ['JOIN', 'HOST', 'OFFLINE', 'P2P']) {
      const b = btn(name);
      b.dataset.tab = name;
      b.addEventListener('click', (): void => showTab(name));
      tabBtns.push(b);
      tabBar.append(b);
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
    refreshBtn.addEventListener('click', (): void => { h.refresh(); refreshLobsFn(); });
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
    leaveBtn.addEventListener('click', (): void => h.join('default'));
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
    nameInput.addEventListener('keydown', (e): void => {
      e.stopPropagation();
      if (e.key === 'Enter') {hostBtn.click();}
    });
    nameRow.append(nameInput);
    const modeRow = field('MODE');
    const modeSelect = document.createElement('select');
    modeSelect.className = 'lb-input';
    // Hidden store — the toggle row beside it is the actual UI; the
    // select keeps serving fillMapSelect/handler reads.
    modeSelect.style.display = 'none';
    modeSelect.addEventListener('change', (): void => h.fillMapSelect());
    modeRow.append(modeSelect);
    // Toggle row is a page-level block under the MODE field — inside the
    // flex field it shares the row and wraps at half width.
    const modeBtns = modeToggleRow(modeSelect);
    // Map-family toggles — T2 ports vs our own arenas. Both on = full
    // list; each can be dropped to shrink the picker. HOST and OFFLINE
    // each get a row; clicks resync every button so the tabs can't drift.
    const famBtns: { b: HTMLButtonElement; kind: 't2' | 'custom' }[] = [];
    const famToggles = (): HTMLDivElement => {
      const row = document.createElement('div');
      row.className = 'lb-quick';
      row.style.marginBottom = '2px';
      for (const [kind, text] of [['t2', 'T2'], ['custom', 'CUSTOM']] as const) {
        const b = btn(text);
        b.classList.toggle('active', h.mapFamOn(kind));
        b.addEventListener('click', (): void => {
          h.toggleMapFam(kind);
          for (const f of famBtns) {f.b.classList.toggle('active', h.mapFamOn(f.kind));}
        });
        famBtns.push({ b, kind });
        row.append(b);
      }
      return row;
    };
    const famRow = famToggles();
    // PRIVATE rides the same toggle row — an unlisted room is off /rooms
    // and quick-join; friends get in by CREATE / JOIN BY NAME only.
    const privBtn = btn('PRIVATE');
    privBtn.classList.toggle('active', settings.get('fps-unlisted') === 1);
    privBtn.title = 'unlisted — not on the public room list';
    privBtn.addEventListener('click', (): void => {
      const on = settings.get('fps-unlisted') !== 1;
      settings.set('fps-unlisted', on ? 1 : 0);
      privBtn.classList.toggle('active', on);
    });
    famRow.append(privBtn);
    // Sim gates — the host can mint a room without creatures (melee
    // species) and/or the ball sim. ON is the default; OFF rides the
    // join as noCreatures/noBalls like `unlisted`. Same toggles serve
    // OFFLINE's solo boot URL (gateToggles writes the same settings keys).
    const gateToggles = (row: HTMLDivElement): void => {
      for (const [key, label_, tip] of [
        ['fps-nocreatures', 'CREATURES', 'spawn melee species (crawlers etc.)'],
        ['fps-noballs', 'BALLS', 'spawn the ball sim'],
      ] as const) {
        const b = btn(label_);
        b.title = tip;
        b.classList.toggle('active', settings.get(key) !== 1);
        b.addEventListener('click', (): void => {
          const off = settings.get(key) !== 1;
          settings.set(key, off ? 1 : 0);
          b.classList.toggle('active', !off);
        });
        row.append(b);
      }
    };
    gateToggles(famRow);
    const { select: mapSelect, thumb: mapThumb } = mapPicker(h);
    // Hidden store — the scrollable list beside the preview is the UI.
    mapSelect.style.display = 'none';
    const botsRow = field('BOTS');
    const botsInput = document.createElement('input');
    botsInput.type = 'number';
    botsInput.min = '0'; botsInput.max = '24';
    botsInput.placeholder = 'map default';
    botsInput.className = 'lb-input';
    botsInput.style.cssText = 'width:110px;text-align:right;';
    botsInput.addEventListener('keydown', (e): void => e.stopPropagation());
    botsRow.append(botsInput);
    const hostBtn = btn('PLAY');
    hostBtn.style.cssText = 'width:100%;margin-top:6px;border-color:rgba(58,167,255,0.4);';
    hostBtn.addEventListener('click', async (): Promise<void> => {
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
        const noCreatures = settings.get('fps-nocreatures') === 1;
        const noBalls = settings.get('fps-noballs') === 1;
        // A named PRIVATE room is always self-hosted — quickJoin would
        // land in someone's public match instead of creating ours.
        const room = named || (priv ? `room-${Math.random().toString(36).slice(2, 8)}` : (await h.deps.quickJoin(mode, map || undefined, bots, noCreatures, noBalls)).room);
        h.join(room, map || undefined, bots, mode || undefined, priv || undefined, noCreatures || undefined, noBalls || undefined);
      } catch { hostBtn.disabled = false; }
    });

    const quickLbl = label('QUICK JOIN');
    const quick = document.createElement('div');
    quick.className = 'lb-quick';
    for (const mode of ['ctf', 'tdm', 'dm', 'nuggets']) {
      const b = btn(mode.toUpperCase());
      b.addEventListener('click', async (): Promise<void> => {
        b.disabled = true;
        try { h.join((await h.deps.quickJoin(mode)).room); }
        catch { b.disabled = false; }
      });
      quick.append(b);
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
    const named = (): void => {
      const v = input.value.trim();
      if (!v) {return;}
      const map = mapSelect.value || undefined;
      const mode = modeSelect.value || mapSelect.selectedOptions[0]?.dataset.mode || undefined;
      const bots = botsInput.value === '' ? undefined : Math.max(0, Math.min(24, Number(botsInput.value) || 0));
      h.join(v, map, bots, mode);
    };
    input.addEventListener('keydown', (e): void => {
      e.stopPropagation();
      if (e.key === 'Enter') {named();}
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
    srvIn.addEventListener('keydown', (e): void => e.stopPropagation());
    const srvBtn = btn('GO');
    srvBtn.addEventListener('click', (): void => { settings.set('fps-server', srvIn.value.trim()); window.location.reload(); });
    srvRow.append(srvIn, srvBtn);

    // Player name lives in the menu-side PROFILE row (#name-input) —
    // an identity field, not a connection parameter.

    const p2pRow = field('P2P DUEL');
    const p2pIn = document.createElement('input');
    p2pIn.maxLength = 24;
    p2pIn.placeholder = 'code';
    // No prefill: fps-p2p survives the session reload, but a join code is
    // one-shot — a dead code sitting in the box reads as a feature.
    p2pIn.className = 'lb-input';
    p2pIn.style.cssText = 'flex:1;min-width:0;';
    p2pIn.addEventListener('keydown', (e): void => e.stopPropagation());
    p2pRow.append(p2pIn);
    const p2pBtns = buildP2PButtons(p2pIn);

    // Open P2P lobbies — the relay lists public hosts still waiting for
    // a peer; clicking one is join:code without typing it.
    const lobLbl = label('OPEN LOBBIES');
    const lobRows = document.createElement('div');
    lobRows.className = 'lb-rows';
    const refreshLobsFn = async (): Promise<void> => {
      lobRows.textContent = '';
      if (!h.deps.listP2pLobbies) {return;}
      try {
        const lobs = await h.deps.listP2pLobbies();
        if (lobs.length === 0) { lobRows.textContent = '— none open —'; lobRows.style.color = 'rgba(58,167,255,0.5)'; return; }
        lobRows.style.color = '';
        for (const l of lobs) {
          const row = btn(`${l.room}  ·  ${Math.max(0, Math.round((Date.now() - l.since) / 60_000))}m`);
          row.classList.add('lb-room');
          row.style.textAlign = 'left';
          row.addEventListener('click', (): void => p2pGo(`join:${l.room}`, 0));
          lobRows.append(row);
        }
      } catch { /* relay unreachable — same failure class as /rooms */ }
    };
    const refreshLobs = (): void => { refreshLobsFn(); };
    refreshLobs();

    // Advanced paths shelved for now — JOIN is browser + quick-join only.
    // Kept mounted-but-hidden (not deleted): direct-server and
    // name-join are real features we may resurface.
    const joinExtra = document.createElement('div');
    joinExtra.style.display = 'none';
    joinExtra.append(connLbl, srvRow, label('CREATE / JOIN BY NAME'), newWrap);
    joinPage.append(headRow, hereRow, rows, quickLbl, quick, joinExtra);
    // Same split as SOLO: scrollable map list left, preview + knobs right.
    const hostBody = document.createElement('div');
    hostBody.style.cssText = 'display:flex;gap:8px;align-items:flex-start;';
    const hostRight = document.createElement('div');
    hostRight.style.cssText = 'flex:1;min-width:0;';
    mapThumb.style.marginTop = '0';
    hostRight.append(mapThumb, botsRow, hostBtn);
    hostBody.append(mapListBox(mapSelect), hostRight);
    tabs.get('HOST')!.append(hostLbl, nameRow, modeRow, modeBtns, famRow, hostBody);
    // ---- OFFLINE page: HOST's pickers, no server ---------------------
    // Same mode/map/bots row layout — a solo match IS a hosted match
    // minus the socket, so the page reads identically on purpose.
    const soloPage = tabs.get('OFFLINE')!;
    const soloLbl = label('OFFLINE MATCH');
    const soloModeRow = field('MODE');
    const soloModeSel = document.createElement('select');
    soloModeSel.className = 'lb-input';
    soloModeSel.style.display = 'none';
    soloModeRow.append(soloModeSel);
    const soloModeBtns = modeToggleRow(soloModeSel);
    const soloFamRow = famToggles();
    gateToggles(soloFamRow);
    const { select: soloMapSel, thumb: soloThumb } = mapPicker(h);
    // Hidden store — the scrollable list beside the preview is the UI.
    soloMapSel.style.display = 'none';
    const soloBotsRow = field('BOTS');
    const soloBotsIn = document.createElement('input');
    soloBotsIn.type = 'number';
    soloBotsIn.min = '0'; soloBotsIn.max = '24';
    soloBotsIn.placeholder = 'map default';
    soloBotsIn.className = 'lb-input';
    soloBotsIn.style.cssText = 'width:110px;text-align:right;';
    soloBotsIn.addEventListener('keydown', (e): void => e.stopPropagation());
    soloBotsRow.append(soloBotsIn);
    const soloBtn = btn('PLAY');
    soloBtn.style.cssText = 'width:100%;margin-top:6px;border-color:rgba(58,167,255,0.4);';
    soloBtn.addEventListener('click', (): void => {
      const bots = soloBotsIn.value === '' ? undefined : Math.max(0, Math.min(24, Number(soloBotsIn.value) || 0));
      playOffline(soloModeSel.value, soloMapSel.value, bots);
    });
    h.bindSoloSelects(soloModeSel, soloMapSel);
    // Two-column pick: scrollable map list left, preview + knobs right —
    // the old one-column layout let the 4:3 thumb push BOTS off-screen.
    const soloBody = document.createElement('div');
    soloBody.style.cssText = 'display:flex;gap:8px;align-items:flex-start;';
    const soloRight = document.createElement('div');
    soloRight.style.cssText = 'flex:1;min-width:0;';
    soloThumb.style.marginTop = '0';
    soloRight.append(soloThumb, soloBotsRow, soloBtn);
    soloBody.append(mapListBox(soloMapSel), soloRight);
    soloPage.append(soloLbl, soloModeRow, soloModeBtns, soloFamRow, soloBody);
    tabs.get('P2P')!.append(p2pRow, p2pBtns, lobLbl, lobRows);

    panel.append(tabBar, joinPage, tabs.get('HOST')!, tabs.get('OFFLINE')!, tabs.get('P2P')!);
    showTab('JOIN');
    (document.getElementById('overlay') ?? document.body).append(panel);
    // Menu closed while the panel was open (resume / re-lock) — display:none
    // hides it anyway, but the poll timer would keep burning for nothing.
    let menuWasOpen = false;
    let doorShown = false;
    new MutationObserver((): void => {
      const menuOpen = document.body.classList.contains('menu-open');
      if (!menuOpen && panel.style.display !== 'none') {h.toggle();}
      // No session at all → the browser IS the front door: the FIRST
      // menu open lands on the room list. Any live session (room, p2p,
      // or a solo boot — ?mode/?map/?bots/?solo) counts as "in a game":
      // a mid-match menu open wants loadout/settings, not a popup.
      const inGame = urlParams.room != null || urlParams.p2p != null
        || settings.get('fps-p2p') !== ''
        || urlParams.mode != null || urlParams.map != null
        || urlParams.bots !== undefined || urlParams.has('solo');
      if (menuOpen && !menuWasOpen) {
        syncLeaveBtn();
        if (!doorShown && !inGame && panel.style.display === 'none') {h.toggle();}
        doorShown = true;
      }
      menuWasOpen = menuOpen;
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  
  return { panel, here, rows, mapSelect, modeSelect, botsInput, leaveBtn, refreshLobs, pingEl };
}
