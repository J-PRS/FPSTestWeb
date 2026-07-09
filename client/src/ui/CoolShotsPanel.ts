import type { DemoManager } from '../demo/index.js';

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
  private lastCoolShots: any[] = [];

  constructor(dependencies: CoolShotsPanelDependencies) {
    this.coolShotsTop = document.getElementById('cool-shots-top')!;
    this.coolShotsRecent = document.getElementById('cool-shots-recent')!;
    this.demoManager = dependencies.demoManager;
    this.overlay = dependencies.overlay;
    this.requestLock = dependencies.requestLock;

    this.setup();
  }

  private setup(): void {
    this.demoManager.onCoolShotsChanged = (shots: any[]) => this.renderCoolShots(shots);
    
    // Refresh "time ago" labels every second
    setInterval(() => {
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

  private renderShotItem(container: HTMLElement, shot: any, rank: number): void {
    const item = document.createElement('div');
    const isRecent = Date.now() - shot.timestamp < 60000;
    item.className = isRecent ? 'cool-shot-item recent' : 'cool-shot-item';
    item.innerHTML = `<span class="rank">${rank}</span><span class="lifetime">${shot.projectileLifetime.toFixed(2)}s</span><span class="time-ago">${this.timeAgo(shot.timestamp)}</span>`;
    item.onclick = () => {
      this.demoManager.playCoolShotById(shot.id);
      this.overlay.style.display = 'none';
      this.requestLock();
    };
    container.appendChild(item);
  }

  private renderCoolShots(shots: any[]): void {
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
    const recent10 = [...shots].sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);
    recent10.forEach((shot, i) => this.renderShotItem(this.coolShotsRecent, shot, i + 1));
  }
}
