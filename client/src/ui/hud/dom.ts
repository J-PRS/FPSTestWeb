// HUD DOM: the whole stylesheet + element tree + selector wiring lives
// here so hud.ts holds only behavior. Everything needed by the class is
// returned in one bag — field names match the old private members.
import { hudRegion } from './regions.js';
export interface HudDom {
  el: HTMLDivElement;
  health: HTMLSpanElement;
  energy: HTMLSpanElement;
  ammo: HTMLSpanElement;
  speed: HTMLSpanElement;
  speedH: HTMLSpanElement;
  speedV: HTMLSpanElement;
  kills: HTMLSpanElement;
  state: HTMLSpanElement;
  ping: HTMLSpanElement;
  loss: HTMLSpanElement;
  jitter: HTMLSpanElement;
  fps: HTMLSpanElement;
  crosshair: HTMLDivElement;
  bloomRing: HTMLDivElement;
  sheepReadout: HTMLDivElement;
  energyReadout: HTMLDivElement;
  groundReadout: HTMLDivElement;
  wammoReadout: HTMLDivElement;
  wammoRegenFill: HTMLDivElement;
  hitMarker: HTMLDivElement;
  dmgVignette: HTMLDivElement;
  dmgEdge: HTMLDivElement;
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
  heldCount: HTMLDivElement;
  classicScore: HTMLDivElement;
  matchStatus: HTMLDivElement; matchClock: HTMLElement; flagA: HTMLElement; flagB: HTMLElement;
  sbRows: HTMLElement;
  killFeed: HTMLDivElement;
  connBanner: HTMLDivElement;
}

export function createHudDom(): HudDom {


    const el = document.createElement('div');
    el.id = 'hud';
    el.innerHTML = `
      <div id="hud-reg-tl">
        <div id="killfeed"></div>
        <div id="player-list"></div>
      </div>
      <div id="hud-reg-tr">
        <div id="hud-tr">
          <span id="state-lbl">GROUND</span> &nbsp; Ping: <span id="ping">0</span>ms &nbsp; Loss: <span id="loss">0</span>% &nbsp; Jitter: <span id="jitter">0</span>ms
        </div>
        <div id="hud-fps"><span id="fps">0</span></div>
        <div id="hud-timer">00:00</div>
      </div>
      <div id="hud-reg-tc">
        <div id="team-score"><span class="a">ALPHA <b id="ts-a">0</b></span><span class="sep">vs</span><span class="b"><b id="ts-b">0</b> BRAVO</span></div>
        <div id="classic-score"><div id="cs-line">0 - 0</div><div id="cs-time">0.00</div></div>
        <div id="match-status"><span class="fchip a" id="flag-a">⚑</span><span class="clock" id="match-clock"></span><span class="fchip b" id="flag-b">⚑</span></div>
        <div id="conn-banner"></div>
      </div>
      <div id="hud-reg-bc">
        <div id="held-count"><b id="held-n">0</b></div>
      <div id="hud-bc">
        <div id="hud-weapons">
          <span class="wslot" data-w="0"></span>
          <span class="wslot" data-w="1"></span>
          <span class="wslot" data-w="2"></span>
          <span class="wslot" data-w="3"></span>
        </div>
        <div class="labels">
          <span class="vpair"><span class="v" id="hp">100</span><span class="v" id="armor">0</span></span>
          <div id="hud-speedo">
            <span class="spd-cell"><i>A</i><b id="spd">0</b></span>
            <span class="spd-cell"><i>H</i><b id="spd-h">0</b></span>
            <span class="spd-cell"><i>V</i><b id="spd-v">0</b></span>
          </div>
          <span class="vpair"><span class="v" id="ammo">0</span><span class="v" id="nrg">60</span></span>
          <span hidden><span class="v" id="kills">0</span></span>
        </div>
        <div class="bar-wrap hp"><div class="bar-ghost" id="health-ghost"></div><div class="bar-fill" id="health-bar"></div><div class="bar-fill armor-fill" id="armor-bar"></div></div>
        <div class="bar-wrap thin"><div class="bar-fill" id="energy-bar"></div></div>
        <div id="buffs"></div>
      </div>
      </div>
      <div id="crosshair"></div>
      <div id="bloom-arms"><div class="ba ba-n"></div><div class="ba ba-e"></div><div class="ba ba-s"></div><div class="ba ba-w"></div></div>
      <div id="hud-reg-ret">
        <div id="sheep-readout"></div>
        <div id="energy-readout"></div>
        <div id="ground-readout"></div>
        <div id="wammo-readout"></div>
        <div id="wammo-regen"><div id="wammo-regen-fill"></div></div>
      </div>
      <div id="hit-marker"></div>
      <div id="dmg-vignette"></div>
      <div id="dmg-edge"><div class="wedge"></div><div class="grit"></div></div>
      <div id="dmg-dir"><div class="arc"></div></div>
      <div id="ent-counts"></div>
      <div id="scoreboard">
        <div id="sb-title"></div>
        <div id="sb-teams"><span class="a" id="sb-ts-a">0</span><span class="sep">–</span><span class="b" id="sb-ts-b">0</span></div>
        <table><thead><tr><th>#</th><th>PLAYER</th><th>CLASS</th><th>FRAGS</th><th>DEATHS</th><th>PTS</th><th>NET</th><th>PING</th><th>SHEEP</th><th>ALIVE</th><th title="high air / air / ski / walk / still / idle — % of current life"><span class="asw-ha">HA</span>/<span class="asw-a">A</span>/<span class="asw-s">S</span>/<span class="asw-w">W</span>/<span class="asw-st">ST</span>/<span class="asw-i">I</span></th><th title="net displacement m/s at 1/2/5/10/15s windows"><span class="asw-s">L</span><span class="asw-a">O</span><span class="asw-w">C</span><span class="asw-st">O</span></th></tr></thead><tbody id="sb-rows"></tbody></table>
        <div id="sb-countdown"></div>
      </div>
    `;
    document.body.append(el);

    const health = el.querySelector('#hp')! as HTMLSpanElement;
    const energy = el.querySelector('#nrg')! as HTMLSpanElement;
    const ammo = el.querySelector('#ammo')! as HTMLSpanElement;
    const speed = el.querySelector('#spd')! as HTMLSpanElement;
    const speedH = el.querySelector('#spd-h')! as HTMLSpanElement;
    const speedV = el.querySelector('#spd-v')! as HTMLSpanElement;
    const kills = el.querySelector('#kills')! as HTMLSpanElement;
    const state = el.querySelector('#state-lbl')! as HTMLSpanElement;
    const ping = el.querySelector('#ping')! as HTMLSpanElement;
    const loss = el.querySelector('#loss')! as HTMLSpanElement;
    const jitter = el.querySelector('#jitter')! as HTMLSpanElement;
    const fps = el.querySelector('#fps')! as HTMLSpanElement;
    const crosshair = el.querySelector('#crosshair')! as HTMLDivElement;
    const bloomRing = el.querySelector('#bloom-arms')! as HTMLDivElement;
    const sheepReadout = el.querySelector('#sheep-readout')! as HTMLDivElement;
    const energyReadout = el.querySelector('#energy-readout')! as HTMLDivElement;
    const groundReadout = el.querySelector('#ground-readout')! as HTMLDivElement;
    const wammoReadout = el.querySelector('#wammo-readout')! as HTMLDivElement;
    const wammoRegenFill = el.querySelector('#wammo-regen-fill')! as HTMLDivElement;
    const dmgVignette = el.querySelector('#dmg-vignette')! as HTMLDivElement;
    const dmgEdge = el.querySelector('#dmg-edge')! as HTMLDivElement;
    const dmgDir = el.querySelector('#dmg-dir')! as HTMLDivElement;
    // Reparent edge effects to <body>: inside the HUD container a
    // transformed/letterboxed parent anchors fixed/absolute elements to
    // IT, not the viewport — that's the detached-mid-screen vignette.
    document.body.append(dmgVignette, dmgEdge, dmgDir);
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
    const heldCount = el.querySelector('#held-count')! as HTMLDivElement;
    const tsA = el.querySelector('#ts-a')! as HTMLElement;
    const tsB = el.querySelector('#ts-b')! as HTMLElement;
    const classicScore = el.querySelector('#classic-score')! as HTMLDivElement;
    const matchStatus = el.querySelector('#match-status')! as HTMLDivElement;
    const matchClock = el.querySelector('#match-clock')! as HTMLElement;
    const flagA = el.querySelector('#flag-a')! as HTMLElement;
    const flagB = el.querySelector('#flag-b')! as HTMLElement;
    const ballCountEl = el.querySelector('#ent-counts')! as HTMLDivElement;
    const timerEl = el.querySelector('#hud-timer')! as HTMLDivElement;
    const killFeed = el.querySelector('#killfeed')! as HTMLDivElement;
    const connBanner = el.querySelector('#conn-banner')! as HTMLDivElement;

    // The debug census docks in the body-level BR region alongside the
    // other debug panels, not inside the HUD box.
    hudRegion('br').append(ballCountEl);

  // Nugget counter — starts at 0, updated via setNuggets
  ammo.textContent = '0';
  ammo.style.color = '#ffd54a'; // gold, matching the pickup

  return { el, health, energy, ammo, speed, speedH, speedV, kills, state, ping, loss, jitter,
    fps, crosshair, bloomRing, sheepReadout, energyReadout, groundReadout, hitMarker, dmgVignette, dmgEdge, dmgDir, dmgDirArc, ghostBar,
    playerList, ballCountEl, timerEl, weaponSlots, healthBar, energyBar, wammoReadout, wammoRegenFill,
    armor, armorBar, buffsRow,
    scoreboard, sbRows, teamScore, tsA, tsB, heldCount, classicScore,
    matchStatus, matchClock, flagA, flagB, killFeed, connBanner };
}
