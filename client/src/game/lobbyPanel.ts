import { settings } from '../core/settings.js';
import type { LobbyDeps } from './lobby.js';

// Lobby panel DOM — styling lives in ui/chrome.css (.lb-*); this builds
// structure and wires behavior. Host is the Lobby facade: its event
// handlers (toggle/join/fillMapSelect) get bound here.

export interface LobbyPanelHost {
  deps: LobbyDeps;
  toggle(): void;
  fillMapSelect(): void;
  join(name: string, map?: string, bots?: number, mode?: string): void;
  currentRoom(): string;
}

export interface LobbyPanelEls {
  panel: HTMLDivElement;
  here: HTMLDivElement;
  rows: HTMLDivElement;
  mapSelect: HTMLSelectElement;
  modeSelect: HTMLSelectElement;
  botsInput: HTMLInputElement;
  leaveBtn: HTMLButtonElement;
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
    ['HOST', () => p2pGo(`host:${code()}`, 0)],
    ['JOIN', () => p2pGo(`join:${code()}`, 0)],
    // Open lobby: host publicly — anyone pressing QUICK lands here.
    ['HOST OPEN', () => p2pGo(`host:${code()}`, 1)],
    // Quick join: the relay hands back the oldest open lobby.
    ['QUICK', () => p2pGo('quick', 0)],
    ['OFF', () => p2pGo('', 0)],
  ];
  for (const [text, fn] of specs) {
    const b = btn(text);
    b.addEventListener('click', fn);
    wrap.appendChild(b);
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

    const panel = document.createElement('div');
    panel.className = 'lb-panel';
    panel.style.display = 'none';

    const head = label('MATCHES');
    head.style.marginTop = '0';
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
    const hostLbl = label('HOST MATCH');
    const modeRow = field('MODE');
    const modeSelect = document.createElement('select');
    modeSelect.className = 'lb-input';
    modeSelect.style.cssText = 'cursor:pointer;flex:1;min-width:0;';
    modeSelect.addEventListener('change', () => h.fillMapSelect());
    modeRow.appendChild(modeSelect);
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
        h.join((await h.deps.quickJoin(mode, map || undefined, bots)).room, map || undefined, bots);
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

    panel.append(head, hereRow, rows, hostLbl, modeRow, mapRow, mapThumb, botsRow, hostBtn, quickLbl, quick, newWrap, connLbl, srvRow, p2pRow, p2pBtns);
    (document.getElementById('overlay') ?? document.body).appendChild(panel);
    // Menu closed while the panel was open (resume / re-lock) — display:none
    // hides it anyway, but the poll timer would keep burning for nothing.
    new MutationObserver(() => {
      if (!document.body.classList.contains('menu-open') && panel.style.display !== 'none') h.toggle();
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  
  return { panel, here, rows, mapSelect, modeSelect, botsInput, leaveBtn };
}
