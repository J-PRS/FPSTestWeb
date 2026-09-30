/**
 * VGS — the Tribes Voice Game System. V opens the chord menu, two more
 * letters pick a line (VGS = "Shazbot!"), Esc/timeout/invalid cancels.
 * Lines ride the normal chat wire: Global-category emotes go to everyone,
 * tactical categories are team-scoped — same scoping a real Tribes VGS
 * callout has. The menu is its own DOM module like Chat.
 */

import { audio } from '../core/audio.ts';

type VgsNode = { label: string } & ({ line: string; team?: boolean } | { children: Record<string, VgsNode> });

const cat = (label: string, children: Record<string, VgsNode>): VgsNode => ({ label, children });
const line = (label: string, text?: string, team = true): VgsNode => ({ label, line: text ?? `${label}!`, team });
const say = (label: string, text?: string): VgsNode => line(label, text, false);

const TREE: Record<string, VgsNode> = {
  G: cat('Global', {
    C: cat('Compliment', {
      A: line('Awesome'),
      G: line('Good game'),
      N: line('Nice move'),
      S: line('Great shot'),
      Y: line('You rock'),
    }),
    R: cat('Respond', {
      A: line('Any time'),
      D: line("Don't know", "I don't know."),
      T: line('Thanks'),
      W: line('Wait'),
    }),
    T: cat('Taunt', {
      A: line('Awww', "Awww, that's too bad!"),
      B: line('Best you can do?', 'Is that the best you can do?'),
      G: line('I am the greatest!'),
      T: line('THAT was graceful!'),
      W: line('When will you learn?'),
    }),
    Y: say('Yes'),
    N: say('No'),
    H: say('Hi'),
    B: say('Bye'),
    O: say('Ooops'),
    Q: say('Quiet'),
    S: say('Shazbot', 'SHAZBOT!'),
    W: say('Woohoo'),
  }),
  A: cat('Attack', {
    A: line('Attack'),
    B: line('Base', 'Attack the enemy base!'),
    C: line('Chase', 'Chase the enemy flag carrier!'),
    D: line('Disrupt', 'Disrupt the enemy defense!'),
    F: line('Flag', 'Get the enemy flag!'),
    G: line('Generator', 'Destroy the enemy generator!'),
    R: line('Reinforce', 'Reinforce the offense!'),
    S: line('Sensors', 'Destroy the enemy sensors!'),
    T: line('Turrets', 'Destroy enemy turrets!'),
    V: line('Vehicle', 'Destroy the enemy vehicle!'),
    W: line('Wait', 'Wait for my signal before attacking.'),
  }),
  D: cat('Defend', {
    B: line('Base', 'Defend our base!'),
    C: line('Flag carrier', 'Defend the flag carrier!'),
    E: line('Entrances', 'Defend the entrances!'),
    F: line('Flag', 'Defend our flag!'),
    G: line('Generator', 'Defend our generator!'),
    M: line('Me', 'Cover me!'),
    R: line('Reinforce', 'Reinforce our defense!'),
    S: line('Sensors', 'Defend our sensors!'),
    T: line('Turrets', 'Defend our turrets!'),
    V: line('Vehicle', 'Defend our vehicle!'),
  }),
  F: cat('Flag', {
    D: line('Defend', 'Defend our flag!'),
    F: line('I have the flag', 'I have the flag!'),
    G: line('Give me', 'Give me the flag!'),
    R: line('Retrieve', 'Retrieve our flag!'),
    S: line('Secure', 'Our flag is secure!'),
    T: line('Take', 'Take the flag from me!'),
  }),
  N: cat('Need', {
    C: line('Covering fire', 'Need covering fire.'),
    D: line('Driver', 'I need a driver.'),
    E: line('Escort', 'I need an escort.'),
    N: line('Nuggets', 'I need nuggets!'),
    R: line('Ride', 'I need a ride!'),
    S: line('Support', 'I need support!'),
    W: line('Where to?'),
  }),
  B: cat('Base', {
    C: line('Clear', 'Our base is clear.'),
    E: line('Enemy in base', 'The enemy is in our base!'),
    R: line('Retake', 'Retake our base!'),
    S: line('Secure', 'Secure our base!'),
  }),
  E: cat('Enemy', {
    D: line('Disarray', 'The enemy is in disarray!'),
    G: line('Generator destroyed', 'The enemy generator is destroyed!'),
    S: line('Sensors destroyed', 'The enemy sensors are destroyed!'),
    T: line('Turrets destroyed', 'The enemy turrets are destroyed!'),
    V: line('Vehicle destroyed', 'The enemy vehicle is destroyed!'),
  }),
  R: cat('Repair', {
    G: line('Generator', 'Repair our generator!'),
    S: line('Sensors', 'Repair our sensors!'),
    T: line('Turrets', 'Repair our turrets!'),
    V: line('Vehicle', 'Repair the vehicle!'),
  }),
  C: cat('Command', {
    A: line('Acknowledged'),
    C: line('Completed'),
    D: line('Declined'),
    W: line('Assignment?', "What's my assignment?"),
  }),
  S: cat('Self', {
    A: cat('Attack', {
      A: line('Attack', 'I will attack.'),
      B: line('Base', 'I will attack the enemy base.'),
      F: line('Flag', 'I will get the enemy flag.'),
      G: line('Generator', 'I will destroy the enemy generator.'),
      T: line('Turrets', 'I will destroy the enemy turrets.'),
    }),
    D: cat('Defend', {
      B: line('Base', 'I will defend our base.'),
      F: line('Flag', 'I will defend our flag.'),
      G: line('Generator', 'I will defend our generator.'),
      T: line('Turrets', 'I will defend our turrets.'),
    }),
    R: cat('Repair', {
      G: line('Generator', 'I will repair our generator.'),
      S: line('Sensors', 'I will repair our sensors.'),
      T: line('Turrets', 'I will repair our turrets.'),
    }),
    C: line('Cover me', 'Cover me!'),
    E: line('Enemy spotted', 'Enemy spotted!'),
    O: line('On my way', 'On my way.'),
    T: line('Target spotted', 'Target spotted!'),
  }),
};

const TIMEOUT_MS = 3000;

export interface VgsDeps {
  /** Wire chat — team flag scopes the line. */
  send(text: string, team: boolean): void;
  isConnected(): boolean;
  /** Offline/local echo into the feed. */
  echo(text: string, team: boolean): void;
}

export class Vgs {
  private menu: HTMLDivElement;
  private path: VgsNode[] = [];
  private active = false;
  private timer = 0;

  constructor(private deps: VgsDeps) {
    this.menu = document.createElement('div');
    this.menu.style.cssText =
      'position:fixed;left:12px;bottom:140px;z-index:60;display:none;' +
      'font:13px/1.5 monospace;color:#fff;background:rgba(0,0,0,.65);' +
      'border:1px solid #555;padding:6px 10px;min-width:220px;pointer-events:none;';
    document.body.appendChild(this.menu);
    window.addEventListener('keydown', (e) => this.onKey(e), true);
  }

  private get node(): Record<string, VgsNode> {
    const top = this.path[this.path.length - 1];
    return top && 'children' in top ? top.children : TREE;
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.active) {
      if (e.code === 'KeyV' && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        this.open();
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') { this.close(); return; }
    const letter = e.code.startsWith('Key') ? e.code.slice(3) : '';
    const next = letter && this.node[letter];
    if (!next) { this.close(); return; }
    if ('line' in next) {
      const team = next.team !== false;
      this.deps.send(next.line, team);
      if (!this.deps.isConnected()) this.deps.echo(next.line, team);
      this.blip();
      this.close();
      return;
    }
    this.path.push(next);
    this.render();
    this.rearm();
  }

  private open(): void {
    this.active = true;
    this.path = [];
    this.menu.style.display = 'block';
    this.render();
    this.rearm();
  }

  private close(): void {
    this.active = false;
    this.menu.style.display = 'none';
    clearTimeout(this.timer);
  }

  private rearm(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.close(), TIMEOUT_MS);
  }

  private render(): void {
    this.menu.textContent = '';
    const crumb = document.createElement('div');
    crumb.style.color = '#9cf';
    crumb.textContent = 'VGS' + (this.path.length ? ' ▸ ' + this.path.map((n) => n.label).join(' ▸ ') : '');
    this.menu.appendChild(crumb);
    for (const [k, n] of Object.entries(this.node)) {
      const row = document.createElement('div');
      const key = document.createElement('span');
      key.style.color = '#fd8';
      key.textContent = `[${k}] `;
      row.append(key, document.createTextNode(n.label));
      this.menu.appendChild(row);
    }
  }

  /** Voice-pack stand-in: two-tone ack blip, pitched like a radio click. */
  private blip(): void {
    const bus = audio.uiBus;
    const c = bus?.context;
    if (!bus || !c) return;
    const t = c.currentTime;
    for (const [f, dt] of [[880, 0], [660, 0.07]] as const) {
      const o = c.createOscillator();
      const g = c.createGain();
      o.type = 'square';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.06, t + dt);
      g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.06);
      o.connect(g); g.connect(bus);
      o.start(t + dt); o.stop(t + dt + 0.07);
    }
  }
}
