// HUD DOM: the whole stylesheet + element tree + selector wiring lives
// here so hud.ts holds only behavior. Everything needed by the class is
// returned in one bag — field names match the old private members.
export interface HudDom {
  el: HTMLDivElement;
  health: HTMLSpanElement;
  energy: HTMLSpanElement;
  ammo: HTMLSpanElement;
  speed: HTMLSpanElement;
  kills: HTMLSpanElement;
  state: HTMLSpanElement;
  ping: HTMLSpanElement;
  loss: HTMLSpanElement;
  jitter: HTMLSpanElement;
  fps: HTMLSpanElement;
  crosshair: HTMLDivElement;
  hitMarker: HTMLDivElement;
  dmgVignette: HTMLDivElement;
  dmgDir: HTMLDivElement;
  dmgDirArc: HTMLDivElement;
  ghostBar: HTMLDivElement;
  playerList: HTMLDivElement;
  ballCountEl: HTMLDivElement;
  timerEl: HTMLDivElement;
  weaponSlots: HTMLSpanElement[];
  healthBar: HTMLDivElement;
  energyBar: HTMLDivElement;
  scoreboard: HTMLDivElement;
  teamScore: HTMLDivElement; tsA: HTMLElement; tsB: HTMLElement;
  matchStatus: HTMLDivElement; matchClock: HTMLElement; flagA: HTMLElement; flagB: HTMLElement;
  sbRows: HTMLElement;
}

export function createHudDom(): HudDom {
    const style = document.createElement('style');
    style.textContent = `
      #hud {
        position: absolute; inset: 0; pointer-events: none;
        user-select: none; -webkit-user-select: none;
        font-family: 'Courier New', monospace; color: #fff;
        text-shadow: 0 0 4px #000, 1px 1px 0 #000;
      }
      #hud-bc {
        position: absolute; bottom: 24px; left: 50%;
        transform: translateX(-50%);
        display: flex; flex-direction: column; gap: 5px;
        width: 300px;
        font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
        text-shadow: 0 1px 2px rgba(0,0,0,0.8);
      }
      #hud-bc .labels {
        display: flex; justify-content: space-between;
        font-size: 0.7rem; letter-spacing: 0.15em;
        color: rgba(200,220,240,0.75); font-weight: 600;
      }
      #hud-bc .labels .v {
        color: #fff; font-weight: 700; font-size: 1.0rem;
        margin-left: 5px; font-variant-numeric: tabular-nums;
      }
      #hud-bc .bar-wrap {
        width: 100%; height: 8px;
        background: rgba(10,14,20,0.55);
        transform: skewX(-20deg);
        overflow: hidden;
        border: 1px solid rgba(255,255,255,0.12);
      }
      #hud-bc .bar-wrap.thin { height: 5px; }
      #hud-weapons {
        display: flex; justify-content: center; gap: 14px;
        font-size: 0.65rem; letter-spacing: 0.12em; font-weight: 600;
        color: rgba(160,180,200,0.45);
      }
      #hud-weapons .wslot { padding: 0 2px; }
      #hud-weapons .wslot.active {
        color: #fff;
        text-shadow: 0 0 6px rgba(140,220,255,0.9);
      }
      #hud-bc .bar-fill {
        height: 100%; width: 100%;
        transition: width 0.08s;
      }
      #health-bar { background: linear-gradient(90deg, #e33, #f77); box-shadow: 0 0 6px rgba(255,80,80,0.5); }
      #energy-bar { background: linear-gradient(90deg, #0af, #7df); box-shadow: 0 0 6px rgba(80,180,255,0.5); }
      #hud-tr {
        position: absolute; top: 14px; right: 20px;
        font-size: 0.75rem; color: #8cf; text-align: right;
        line-height: 1.7;
      }
      #hud-fps {
        position: absolute; top: 44px; right: 20px;
        font-size: 2.2rem; font-weight: bold; color: #8cf;
        text-align: right; line-height: 1;
      }
      #ball-count {
        position: fixed; bottom: 24px; left: 24px;
        font-size: 1.4rem; font-weight: bold; color: #fc8;
        font-variant-numeric: tabular-nums;
      }
      #ent-counts {
        position: fixed; bottom: 24px; left: 24px;
        font-size: 0.78rem; color: #ccc; line-height: 1.55;
        font-variant-numeric: tabular-nums; white-space: pre;
        text-shadow: 1px 1px 2px #000; pointer-events: none;
      }
      #ent-counts .dim { color: #777; }
      #ent-counts .hot { color: #fc8; font-weight: bold; }
      #hud-timer {
        position: absolute; top: 14px; left: 50%;
        transform: translateX(-50%);
        font-size: 1.5rem; font-weight: bold; color: #ffd9a0;
        font-variant-numeric: tabular-nums;
        text-shadow: 0 0 6px rgba(0,0,0,0.8), 1px 1px 0 #000;
      }
      #hud-tl {
        position: absolute; top: 14px; left: 20px;
        font-size: 0.75rem; color: #ccc; line-height: 1.7;
      }
      #crosshair {
        position: absolute; top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        width: 5px; height: 5px;
        background: rgba(255,255,255,0.9);
        border-radius: 50%;
        box-shadow: 0 0 3px rgba(0,0,0,0.8);
      }
      #hit-marker {
        position: absolute; top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        width: 0; height: 0; opacity: 0;
        transition: opacity 0.05s;
      }
      #hit-marker::before, #hit-marker::after {
        content: ''; position: absolute;
        background: #fff; width: 3px; height: 22px;
        top: -11px; left: -1px;
        border-radius: 1px;
      }
      #hit-marker::before { transform: rotate(45deg); }
      #hit-marker::after  { transform: rotate(-45deg); }
      #hit-marker.visible { opacity: 1; }

      /* Damage feedback — thin edge vignette, never a blood overlay */
      #dmg-vignette {
        position: absolute; inset: 0; opacity: 0;
        background: radial-gradient(ellipse at center,
          transparent 52%, transparent 68%,
          rgba(220,40,30,0.55) 100%);
      }
      /* Directional arc — a thick arc segment rotated to the source bearing */
      #dmg-dir {
        position: absolute; top: 50%; left: 50%;
        width: 110px; height: 110px;
        transform: translate(-50%, -50%);
        opacity: 0;
      }
      #dmg-dir .arc {
        position: absolute; inset: 0; border-radius: 50%;
        border: 5px solid transparent;
        border-top-color: rgba(255,60,40,0.9);
        filter: drop-shadow(0 0 6px rgba(255,40,20,0.7));
      }
      /* Ghost bar — the lost HP drains as a pale segment behind the fill */
      #hud-bc .bar-ghost {
        position: absolute; height: 100%;
        background: rgba(255,120,100,0.65);
        transition: none;
      }
      #hud-bc .bar-wrap { position: relative; }

      .player-indicator {
        position: absolute;
        width: 12px;
        height: 12px;
        background: #f44;
        border: 2px solid #fff;
        border-radius: 50%;
        pointer-events: none;
        transform: translate(-50%, -50%);
        box-shadow: 0 0 8px rgba(255, 68, 68, 0.8);
        transition: opacity 0.1s;
      }
      .player-indicator-offscreen {
        width: 12px !important;
        height: 12px !important;
      }
      .player-indicator.offscreen {
        background: transparent;
        border-color: #f00;
      }
      .player-indicator.hidden {
        opacity: 0;
      }
      #player-list {
        position: absolute; top: 14px; left: 20px;
        font-size: 0.75rem; color: #ccc; line-height: 1.7;
        text-align: left;
      }
      #player-list .player-id {
        display: block;
        margin-bottom: 2px;
      }
      #player-list .player-id.local {
        color: #0f0;
        font-weight: bold;
      }
      #player-list .player-id.remote {
        color: #ccc;
      }
      #scoreboard {
        position: absolute; top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        min-width: 340px;
        background: rgba(8,12,18,0.85);
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 8px;
        padding: 14px 18px;
        font-family: 'Segoe UI', 'Helvetica Neue', Arial, sans-serif;
        display: none;
      }
      #scoreboard .sb-title {
        font-size: 0.65rem; letter-spacing: 0.25em;
        color: rgba(200,220,240,0.5); font-weight: 600;
        text-align: center; margin-bottom: 10px;
      }
      #scoreboard table {
        width: 100%; border-collapse: collapse;
        font-size: 0.85rem; color: #dde;
        font-variant-numeric: tabular-nums;
      }
      #scoreboard th {
        font-size: 0.6rem; letter-spacing: 0.15em; font-weight: 600;
        color: rgba(200,220,240,0.5); text-align: left;
        padding: 0 14px 6px 0;
      }
      #scoreboard th:last-child, #scoreboard td:last-child { text-align: right; padding-right: 0; }
      #scoreboard td { padding: 3px 14px 3px 0; }
      #scoreboard td:last-child { text-align: right; }
      #scoreboard tr.self td { color: #8fd8ff; font-weight: 600; }
      #scoreboard tr.dead td { opacity: 0.45; }
      #scoreboard tr.sb-team td {
        font-size: 0.62rem; letter-spacing: 0.2em; font-weight: 700;
        padding-top: 8px; border-top: 1px solid rgba(255,255,255,0.1);
      }
      #scoreboard tr.sb-team.alpha td { color: #55aaff; }
      #scoreboard tr.sb-team.bravo td { color: #ff8855; }
      #team-score {
        position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
        display: none; font: 700 18px/1 monospace; letter-spacing: 0.08em;
        text-shadow: 0 0 8px #000; pointer-events: none; white-space: nowrap;
      }
      #team-score .a { color: #55aaff; } #team-score .b { color: #ff8855; }
      #team-score .sep { color: #8899aa; margin: 0 10px; font-weight: 400; font-size: 13px; }
      /* Match meta strip under the score — clock + flag chips. Only shows
         in matches that declare them (same gate as the score strip). */
      #match-status {
        position: fixed; top: 58px; left: 50%; transform: translateX(-50%);
        display: none; align-items: center; gap: 12px;
        font-size: 12px; letter-spacing: 0.12em; color: #cdd9e5;
        font-variant-numeric: tabular-nums;
      }
      #match-status .clock { font-weight: 700; color: #fff; }
      #match-status .clock.late { color: #ff6b6b; animation: resumePulse 1s ease-in-out infinite; }
      #match-status .fchip { padding: 2px 8px; border-radius: 4px; font-size: 0.62rem; font-weight: 700; }
      #match-status .fchip.a { color: #55aaff; border: 1px solid rgba(85,170,255,0.4); }
      #match-status .fchip.b { color: #ff8855; border: 1px solid rgba(255,136,85,0.4); }
      #match-status .fchip.taken { animation: resumePulse 1s ease-in-out infinite; }
    `;
    document.head.appendChild(style);

    const el = document.createElement('div');
    el.id = 'hud';
    el.innerHTML = `
      <div id="player-list"></div>
      <div id="hud-tr">
        Speed: <span id="spd">0</span> &nbsp; <span id="state-lbl">GROUND</span> &nbsp; Ping: <span id="ping">0</span>ms &nbsp; Loss: <span id="loss">0</span>% &nbsp; Jitter: <span id="jitter">0</span>ms
      </div>
      <div id="hud-fps"><span id="fps">0</span></div>
      <div id="hud-bc">
        <div id="hud-weapons">
          <span class="wslot" data-w="0"></span>
          <span class="wslot" data-w="1"></span>
          <span class="wslot" data-w="2"></span>
          <span class="wslot" data-w="3"></span>
        </div>
        <div class="labels">
          <span>HEALTH<span class="v" id="hp">100</span></span>
          <span>NUGGETS<span class="v" id="ammo">0</span></span>
        </div>
        <div class="labels">
          <span>ENERGY<span class="v" id="nrg">60</span></span>
          <span>KILLS<span class="v" id="kills">0</span></span>
        </div>
        <div class="bar-wrap"><div class="bar-ghost" id="health-ghost"></div><div class="bar-fill" id="health-bar"></div></div>
        <div class="bar-wrap thin"><div class="bar-fill" id="energy-bar"></div></div>
      </div>
      <div id="crosshair"></div>
      <div id="hit-marker"></div>
      <div id="dmg-vignette"></div>
      <div id="dmg-dir"><div class="arc"></div></div>
      <div id="ent-counts"></div>
      <div id="hud-timer">00:00</div>
      <div id="team-score"><span class="a">ALPHA <b id="ts-a">0</b></span><span class="sep">vs</span><span class="b"><b id="ts-b">0</b> BRAVO</span></div>
      <div id="match-status"><span class="fchip a" id="flag-a">⚑</span><span class="clock" id="match-clock"></span><span class="fchip b" id="flag-b">⚑</span></div>
      <div id="scoreboard">
        <div class="sb-title">SCOREBOARD</div>
        <table><thead><tr><th>PLAYER</th><th>FRAGS</th><th>PTS</th><th>PING</th></tr></thead><tbody id="sb-rows"></tbody></table>
      </div>
    `;
    document.body.appendChild(el);

    const health = el.querySelector('#hp')! as HTMLSpanElement;
    const energy = el.querySelector('#nrg')! as HTMLSpanElement;
    const ammo = el.querySelector('#ammo')! as HTMLSpanElement;
    const speed = el.querySelector('#spd')! as HTMLSpanElement;
    const kills = el.querySelector('#kills')! as HTMLSpanElement;
    const state = el.querySelector('#state-lbl')! as HTMLSpanElement;
    const ping = el.querySelector('#ping')! as HTMLSpanElement;
    const loss = el.querySelector('#loss')! as HTMLSpanElement;
    const jitter = el.querySelector('#jitter')! as HTMLSpanElement;
    const fps = el.querySelector('#fps')! as HTMLSpanElement;
    const crosshair = el.querySelector('#crosshair')! as HTMLDivElement;
    const dmgVignette = el.querySelector('#dmg-vignette')! as HTMLDivElement;
    const dmgDir = el.querySelector('#dmg-dir')! as HTMLDivElement;
    const dmgDirArc = dmgDir.querySelector('.arc')! as HTMLDivElement;
    const ghostBar = el.querySelector('#health-ghost')! as HTMLDivElement;
    const playerList = el.querySelector('#player-list')! as HTMLDivElement;
    const hitMarker = el.querySelector('#hit-marker')! as HTMLDivElement;
    const weaponSlots = Array.from(el.querySelectorAll<HTMLSpanElement>('.wslot'));
    const healthBar = el.querySelector('#health-bar') as HTMLDivElement;
    const energyBar = el.querySelector('#energy-bar') as HTMLDivElement;
    const scoreboard = el.querySelector('#scoreboard')! as HTMLDivElement;
    const sbRows = el.querySelector('#sb-rows')! as HTMLElement;
    const teamScore = el.querySelector('#team-score')! as HTMLDivElement;
    const tsA = el.querySelector('#ts-a')! as HTMLElement;
    const tsB = el.querySelector('#ts-b')! as HTMLElement;
    const matchStatus = el.querySelector('#match-status')! as HTMLDivElement;
    const matchClock = el.querySelector('#match-clock')! as HTMLElement;
    const flagA = el.querySelector('#flag-a')! as HTMLElement;
    const flagB = el.querySelector('#flag-b')! as HTMLElement;
    const ballCountEl = el.querySelector('#ent-counts')! as HTMLDivElement;
    const timerEl = el.querySelector('#hud-timer')! as HTMLDivElement;

  // Nugget counter — starts at 0, updated via setNuggets
  ammo.textContent = '0';
  ammo.style.color = '#ffd54a'; // gold, matching the pickup

  return { el, health, energy, ammo, speed, kills, state, ping, loss, jitter,
    fps, crosshair, hitMarker, dmgVignette, dmgDir, dmgDirArc, ghostBar,
    playerList, ballCountEl, timerEl, weaponSlots, healthBar, energyBar,
    scoreboard, sbRows, teamScore, tsA, tsB,
    matchStatus, matchClock, flagA, flagB };
}
