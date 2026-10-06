import type { CoolShotEntry, DemoManager } from '../demo/index.js';

interface CoolShotsPanelDependencies {
  demoManager: DemoManager;
  overlay: HTMLElement;
  requestLock: () => void;
}

export class CoolShotsPanel {
  private coolShotsTop: HTMLElement;
  private coolShotsRecent: HTMLElement;
  private demoManager: DemoManager;
  private overlay: HTMLElement;
  private requestLock: () => void;
  private lastCoolShots: CoolShotEntry[] = [];

  constructor(dependencies: CoolShotsPanelDependencies) {
    this.coolShotsTop = document.getElementById('cool-shots-top')!;
    this.coolShotsRecent = document.getElementById('cool-shots-recent')!;
    this.demoManager = dependencies.demoManager;
    this.overlay = dependencies.overlay;
    this.requestLock = dependencies.requestLock;

    this.setup();
  }

  private setup(): void {
    this.demoManager.onCoolShotsChanged = (shots) => this.renderCoolShots(shots);
    
    // Refresh "time ago" labels every second — but only while the panel
    // is actually up: a closed overlay re-render is a 1Hz DOM rebuild
    // nobody sees. Same skip for a backgrounded tab.
    setInterval(() => {
      if (document.hidden || this.overlay.style.display === 'none') return;
      if (this.lastCoolShots.length > 0) {
        this.renderCoolShots(this.lastCoolShots);
      }
    }, 1000);
  }

  private timeAgo(ts: number): string {
    const secs = Math.floor((Date.now() - ts) / 1000);
    if (secs < 60) return `${secs}s ago`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  private renderShotItem(container: HTMLElement, shot: CoolShotEntry, rank: number): void {
    const item = document.createElement('div');
    const isRecent = Date.now() - shot.timestamp < 60000;
    item.className = isRecent ? 'cool-shot-item recent' : 'cool-shot-item';
    item.innerHTML = `<span class="rank">${rank}</span><span class="lifetime">${shot.projectileLifetime.toFixed(2)}s</span><span class="time-ago">${this.timeAgo(shot.timestamp)}</span>`;
    item.addEventListener('click', () => {
      this.demoManager.playCoolShotById(shot.id);
      this.overlay.style.display = 'none';
      this.requestLock();
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.openMenu(e.clientX, e.clientY, shot);
    });
    container.appendChild(item);
  }

  private menu: HTMLElement | null = null;

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  /** Right-click menu — play / download .demo / export mp4. Appended to
   *  the overlay so it dies with the overlay's own display:none, and
   *  dismissed by any outside click, Escape, or the next list re-render
   *  (the panel repaints every second for time-ago labels). */
  private openMenu(x: number, y: number, shot: CoolShotEntry): void {
    this.closeMenu();
    const menu = document.createElement('div');
    menu.className = 'cool-shot-menu';
    const act = (label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        this.closeMenu();
        fn();
      });
      menu.appendChild(b);
    };
    act('Play', () => {
      this.demoManager.playCoolShotById(shot.id);
      this.overlay.style.display = 'none';
      this.requestLock();
    });
    act('Download .demo', () => {
      void this.demoManager.downloadCoolShotById(shot.id);
    });
    act('Export MP4', () => {
      this.demoManager.exportCoolShotMp4(shot.id);
      this.overlay.style.display = 'none';
      this.requestLock();
    });
    this.overlay.appendChild(menu);
    // Clamp into the viewport — anchored top-left of the cursor, flips up/
    // left when it would overflow an edge.
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = `${Math.max(0, Math.min(x, innerWidth - mw - 4))}px`;
    menu.style.top = `${Math.max(0, Math.min(y, innerHeight - mh - 4))}px`;
    this.menu = menu;
    const dismiss = (e: Event) => {
      if (menu.contains(e.target as Node)) return;
      this.closeMenu();
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', key, true);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { this.closeMenu(); e.stopPropagation(); }
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', key, true);
    };
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', key, true);
  }

  private renderCoolShots(shots: CoolShotEntry[]): void {
    // The 1s time-ago repaint must NOT close the context menu — item
    // nodes are rebuilt but the menu's actions captured the entry.
    this.lastCoolShots = shots;
    this.coolShotsTop.innerHTML = '';
    this.coolShotsRecent.innerHTML = '';
    
    if (shots.length === 0) {
      this.coolShotsTop.innerHTML = '<div class="cool-shot-item empty">No cool shots yet</div>';
      this.coolShotsRecent.innerHTML = '<div class="cool-shot-item empty">No recent shots</div>';
      return;
    }

    // Top 10 by lifetime (already sorted descending by lifetime)
    const top10 = shots.slice(0, 10);
    top10.forEach((shot, i) => this.renderShotItem(this.coolShotsTop, shot, i + 1));

    // Recent 10 by timestamp (most recent first)
    const recent10 = shots.toSorted((a, b) => b.timestamp - a.timestamp).slice(0, 10);
    recent10.forEach((shot, i) => this.renderShotItem(this.coolShotsRecent, shot, i + 1));
  }
}
