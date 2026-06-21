import { Player } from './Player.js';

export class HUD {
  private el: HTMLDivElement;
  private health: HTMLSpanElement;
  private energy: HTMLSpanElement;
  private ammo: HTMLSpanElement;
  private speed: HTMLSpanElement;
  private kills: HTMLSpanElement;
  private state: HTMLSpanElement;
  private ping: HTMLSpanElement;
  private loss: HTMLSpanElement;
  private jitter: HTMLSpanElement;
  private crosshair: HTMLDivElement;
  private hitMarker: HTMLDivElement;
  private hitTimer = 0;

  constructor() {
    const style = document.createElement('style');
    style.textContent = `
      #hud {
        position: absolute; inset: 0; pointer-events: none;
        font-family: 'Courier New', monospace; color: #fff;
        text-shadow: 0 0 4px #000, 1px 1px 0 #000;
      }
      #hud-bl {
        position: absolute; bottom: 20px; left: 20px;
        display: flex; flex-direction: column; gap: 4px;
        font-size: 0.85rem;
      }
      #hud-bl .row { display: flex; gap: 12px; align-items: center; }
      #hud-bl .label { color: #adf; font-size: 0.72rem; letter-spacing: 0.08em; }
      #hud-bl .val { font-size: 1.0rem; font-weight: bold; min-width: 48px; }
      #hud-tr {
        position: absolute; top: 14px; right: 20px;
        font-size: 0.75rem; color: #8cf; text-align: right;
        line-height: 1.7;
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
      .energy-bar-wrap {
        width: 140px; height: 6px; background: rgba(255,255,255,0.15);
        border-radius: 3px; overflow: hidden; margin-top: 2px;
      }
      #energy-bar {
        height: 100%; width: 100%;
        background: linear-gradient(90deg, #0af, #08f);
        border-radius: 3px;
        transition: width 0.05s;
      }
      #health-bar-wrap {
        width: 140px; height: 6px; background: rgba(255,255,255,0.15);
        border-radius: 3px; overflow: hidden; margin-top: 2px;
      }
      #health-bar {
        height: 100%; width: 100%;
        background: linear-gradient(90deg, #f44, #f88);
        border-radius: 3px;
        transition: width 0.1s;
      }
    `;
    document.head.appendChild(style);

    this.el = document.createElement('div');
    this.el.id = 'hud';
    this.el.innerHTML = `
      <div id="hud-tl">
        WASD=move &nbsp; SPACE=jump/ski &nbsp; RMB=jetpack &nbsp; LMB=fire &nbsp; R=reload
      </div>
      <div id="hud-tr">
        Speed: <span id="spd">0</span> &nbsp; <span id="state-lbl">GROUND</span> &nbsp; Ping: <span id="ping">0</span>ms &nbsp; Loss: <span id="loss">0</span>% &nbsp; Jitter: <span id="jitter">0</span>ms
      </div>
      <div id="hud-bl">
        <div class="row">
          <span class="label">HP</span>
          <span class="val" id="hp">100</span>
        </div>
        <div class="energy-bar-wrap" style="margin-bottom:2px">
          <div id="health-bar"></div>
        </div>
        <div class="row">
          <span class="label">ENERGY</span>
          <span class="val" id="nrg">60</span>
        </div>
        <div class="energy-bar-wrap">
          <div id="energy-bar"></div>
        </div>
        <div class="row" style="margin-top:6px">
          <span class="label">AMMO</span>
          <span class="val" id="ammo">10/10</span>
          &nbsp;
          <span class="label">KILLS</span>
          <span class="val" id="kills">0</span>
        </div>
      </div>
      <div id="crosshair"></div>
      <div id="hit-marker"></div>
    `;
    document.body.appendChild(this.el);

    this.health   = this.el.querySelector('#hp')!;
    this.energy   = this.el.querySelector('#nrg')!;
    this.ammo     = this.el.querySelector('#ammo')!;
    this.speed    = this.el.querySelector('#spd')!;
    this.kills    = this.el.querySelector('#kills')!;
    this.state    = this.el.querySelector('#state-lbl')!;
    this.ping     = this.el.querySelector('#ping')!;
    this.loss     = this.el.querySelector('#loss')!;
    this.jitter   = this.el.querySelector('#jitter')!;
    this.crosshair = this.el.querySelector('#crosshair')!;
    this.hitMarker = this.el.querySelector('#hit-marker')!;
  }

  showHitMarker(): void {
    this.hitTimer = 0.12;
    this.hitMarker.classList.add('visible');
  }

  hide(): void {
    this.el.style.display = 'none';
  }

  show(): void {
    this.el.style.display = 'block';
  }

  update(dt: number, player: Player, ping: number = 0, packetLoss: number = 0, jitter: number = 0): void {
    this.health.textContent = String(player.health);
    (this.el.querySelector('#health-bar') as HTMLDivElement).style.width =
      `${(player.health / 100) * 100}%`;

    const nrg = Math.round(player.energy);
    this.energy.textContent = String(nrg);
    (this.el.querySelector('#energy-bar') as HTMLDivElement).style.width =
      `${(nrg / 60) * 100}%`;

    this.ammo.textContent = '∞';
    (this.ammo as HTMLElement).style.color = '#4f4';

    this.speed.textContent  = String(Math.round(player.getSpeed()));
    this.kills.textContent  = String(player.kills);
    this.state.textContent  = player.onGround ? 'GROUND' : 'AIR';
    this.ping.textContent   = String(Math.round(ping));
    this.loss.textContent   = String(Math.round(packetLoss));
    this.jitter.textContent = String(Math.round(jitter));

    if (this.hitTimer > 0) {
      this.hitTimer -= dt;
      if (this.hitTimer <= 0) this.hitMarker.classList.remove('visible');
    }
  }
}
