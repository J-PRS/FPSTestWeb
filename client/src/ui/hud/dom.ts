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
  armor: HTMLSpanElement;
  armorBar: HTMLDivElement;
  buffsRow: HTMLDivElement;
  scoreboard: HTMLDivElement;
  teamScore: HTMLDivElement; tsA: HTMLElement; tsB: HTMLElement;
  matchStatus: HTMLDivElement; matchClock: HTMLElement; flagA: HTMLElement; flagB: HTMLElement;
  sbRows: HTMLElement;
  killFeed: HTMLDivElement;
}

export function createHudDom(): HudDom {


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
          <span>ARMOR<span class="v" id="armor">0</span></span>
          <span>NUGGETS<span class="v" id="ammo">0</span></span>
        </div>
        <div class="labels">
          <span>ENERGY<span class="v" id="nrg">60</span></span>
          <span>KILLS<span class="v" id="kills">0</span></span>
        </div>
        <div class="bar-wrap"><div class="bar-ghost" id="health-ghost"></div><div class="bar-fill" id="health-bar"></div></div>
        <div class="bar-wrap thin armor"><div class="bar-fill" id="armor-bar"></div></div>
        <div class="bar-wrap thin"><div class="bar-fill" id="energy-bar"></div></div>
        <div id="buffs"></div>
      </div>
      <div id="crosshair"></div>
      <div id="hit-marker"></div>
      <div id="dmg-vignette"></div>
      <div id="dmg-dir"><div class="arc"></div></div>
      <div id="ent-counts"></div>
      <div id="hud-timer">00:00</div>
      <div id="team-score"><span class="a">ALPHA <b id="ts-a">0</b></span><span class="sep">vs</span><span class="b"><b id="ts-b">0</b> BRAVO</span></div>
      <div id="match-status"><span class="fchip a" id="flag-a">⚑</span><span class="clock" id="match-clock"></span><span class="fchip b" id="flag-b">⚑</span></div>
      <div id="killfeed"></div>
      <div id="scoreboard">
        <div class="sb-title">SCOREBOARD</div>
        <table><thead><tr><th>PLAYER</th><th>FRAGS</th><th>PTS</th><th>NET</th><th>PING</th></tr></thead><tbody id="sb-rows"></tbody></table>
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
    const armor = el.querySelector('#armor')! as HTMLSpanElement;
    const armorBar = el.querySelector('#armor-bar') as HTMLDivElement;
    const buffsRow = el.querySelector('#buffs')! as HTMLDivElement;
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
    const killFeed = el.querySelector('#killfeed')! as HTMLDivElement;

  // Nugget counter — starts at 0, updated via setNuggets
  ammo.textContent = '0';
  ammo.style.color = '#ffd54a'; // gold, matching the pickup

  return { el, health, energy, ammo, speed, kills, state, ping, loss, jitter,
    fps, crosshair, hitMarker, dmgVignette, dmgDir, dmgDirArc, ghostBar,
    playerList, ballCountEl, timerEl, weaponSlots, healthBar, energyBar,
    armor, armorBar, buffsRow,
    scoreboard, sbRows, teamScore, tsA, tsB,
    matchStatus, matchClock, flagA, flagB, killFeed };
}
