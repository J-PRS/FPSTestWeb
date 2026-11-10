import type { CoolShotEntry, DemoManager } from '../demo/index.js';
import { exportClip, getClipBlob } from '../demo/clipSink.js';

interface CoolShotsPanelDependencies {
  demoManager: DemoManager;
  overlay: HTMLElement;
  requestLock: () => void;
}

const bind = (id: string, get: () => boolean, set: (on: boolean) => void): void => {
  const btn = document.getElementById(id);
  if (!btn) {return;}
  const sync = (): boolean => btn.classList.toggle('on', get());
  btn.addEventListener('click', (): void => { set(!get()); sync(); });
  sync();
};

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
    this.demoManager.onCoolShotsChanged = (shots): void => this.renderCoolShots(shots);

    // Autorecord toggles — state lives in DemoManager (localStorage),
    // the buttons only mirror it.
    bind('cs-toggle-demo', (): boolean => this.demoManager.coolShotDemo, (v): void => { this.demoManager.coolShotDemo = v; });
    bind('cs-toggle-mp4', (): boolean => this.demoManager.coolShotMp4, (v): void => { this.demoManager.coolShotMp4 = v; });
    // Dev tool: manual .demo capture - REC flips to STOP, stopping
    // downloads demo_<ts>.demo for offline inspection.
    const recBtn = document.getElementById('cs-demo-rec');
    recBtn?.addEventListener('click', (): void => {
      if (this.demoManager.isRecording) {
        this.demoManager.stopRecording();
        this.demoManager.saveDemo();
      } else {
        this.demoManager.startRecording();
      }
      recBtn.textContent = this.demoManager.isRecording ? 'STOP' : 'REC';
      recBtn.classList.toggle('on', this.demoManager.isRecording);
    });
    // autoDemo means recording is usually ALREADY live when the panel
    // opens - mirror the real state, don't default to REC.
    const syncRec = (): void => {
      if (!recBtn) {return;}
      recBtn.textContent = this.demoManager.isRecording ? 'STOP' : 'REC';
      recBtn.classList.toggle('on', this.demoManager.isRecording);
    };
    syncRec();
    setInterval(syncRec, 1000);
    
    // Refresh "time ago" labels every second — but only while the panel
    // is actually up: a closed overlay re-render is a 1Hz DOM rebuild
    // nobody sees. Same skip for a backgrounded tab.
    setInterval((): void => {
      if (document.hidden || this.overlay.style.display === 'none') {return;}
      if (this.lastCoolShots.length > 0) {
        this.renderCoolShots(this.lastCoolShots);
      }
    }, 1000);
  }

  private timeAgo(ts: number): string {
    const secs = Math.floor((Date.now() - ts) / 1000);
    if (secs < 60) {return `${secs}s ago`;}
    const mins = Math.floor(secs / 60);
    if (mins < 60) {return `${mins}m ago`;}
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) {return `${hrs}h ago`;}
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  private renderShotItem(container: HTMLElement, shot: CoolShotEntry, rank: number): void {
    const item = document.createElement('div');
    const isRecent = Date.now() - shot.timestamp < 60_000;
    item.className = isRecent ? 'cool-shot-item recent' : 'cool-shot-item';
    // Tile: weapon + shot→hit distance + air time — the brag stats.
    // meta is optional (server/vault-restored entries may lack it).
    const dist = shot.distance == null ? '' : `${shot.distance.toFixed(0)}m`;
    // The column ellipsizes past ~18 chars; a long weapon name would eat the
    // distance, so multi-word names initial only when the pair overflows.
    let weapon = shot.weapon ?? '';
    if (weapon && dist && (weapon.length + dist.length) > 15 && weapon.includes(' ')) {
      weapon = weapon.split(/\s+/).map((w): string => w[0]).join('');
    }
    const meta = [weapon, dist].filter(Boolean).join(' · ');
    // Server-merged entries carry uploader-supplied strings (weapon) —
    // textContent keeps a crafted name inert.
    const span = (cls: string, text: string): void => {
      const s = document.createElement('span');
      s.className = cls;
      s.textContent = text;
      item.append(s);
    };
    span('rank', String(rank));
    // The shot score is the ranking stat - airtime alone undervalues
    // snappy close-range direct hits.
    if (shot.score != null) {span('shot-score', String(shot.score));}
    span('lifetime', `${shot.projectileLifetime.toFixed(2)}s`);
    if (meta) {span('shot-meta', meta);}
    // Every entry is a demo clip; the MP4 badge only shows when a
    // rolling-capture cut actually landed for this shot.
    span('fmt fmt-demo', 'DEMO');
    if (shot.mp4Name) {span('fmt fmt-mp4', 'MP4');}
    span('time-ago', this.timeAgo(shot.timestamp));
    item.addEventListener('click', (): void => {
      this.demoManager.playCoolShotById(shot.id);
      this.overlay.style.display = 'none';
      this.requestLock();
    });
    item.addEventListener('contextmenu', (e): void => {
      e.preventDefault();
      this.openMenu(e.clientX, e.clientY, shot);
    });
    container.append(item);
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
    const act = (label: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', (e): void => {
        e.stopPropagation();
        this.closeMenu();
        fn();
      });
      menu.append(b);
      return b;
    };
    act('Play', (): void => {
      this.demoManager.playCoolShotById(shot.id);
      this.overlay.style.display = 'none';
      this.requestLock();
    });
    act('Download .demo', (): void => {
      this.demoManager.downloadCoolShotById(shot.id);
    });
    // Server-hosted clips get a /clips/<file> deep link — the feed route
    // lands on this exact clip (and unfurls via the server's OG shell).
    // Local-only entries (no filename) can't be linked — nothing on the
    // server points at them.
    if (shot.filename) {
      act('Copy share link', (): void => {
        const url = `${location.origin}/clips/${shot.filename}`;
        const toast = (text: string): void => {
          const t = document.createElement('div');
          t.textContent = text;
          t.style.cssText = 'position:fixed;left:50%;bottom:12%;transform:translateX(-50%);'
            + 'background:rgba(0,0,0,.75);color:#8f8;padding:.4em 1em;border-radius:4px;z-index:99;font-size:14px';
          document.body.append(t);
          setTimeout((): void => t.remove(), 1800);
        };
        navigator.clipboard.writeText(url).then((): void => { toast('Share link copied'); },
          (): void => { prompt('Share link:', url); });
      });
    }
    if (shot.mp4Name) {
      act('Watch MP4', (): void => {
        // Blob URL in a new tab - the stock video player, nothing saved.
        getClipBlob(shot.mp4Name!).then((blob): void | null => {
          if (!blob) {return null;}
          const url = URL.createObjectURL(blob);
          window.open(url, '_blank');
          // Long revoke delay: the player loads lazily; revoking early
          // blanks the tab in some builds.
          setTimeout((): void => URL.revokeObjectURL(url), 60_000);
          return undefined;
        }).catch((): void => undefined);
      });
      act('Download MP4', (): void => {
        exportClip(shot.mp4Name!);
      });
    }
    act('Export MP4', (): void => {
      this.demoManager.exportCoolShotMp4(shot.id);
      this.overlay.style.display = 'none';
      this.requestLock();
    });
    act('Render MP4 (fast)', (): void => {
      this.demoManager.exportCoolShotMp4Rendered(shot.id).catch((): void => undefined);
      this.overlay.style.display = 'none';
      this.requestLock();
    });
    this.overlay.append(menu);
    // Clamp into the viewport — anchored top-left of the cursor, flips up/
    // left when it would overflow an edge.
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = `${Math.max(0, Math.min(x, innerWidth - mw - 4))}px`;
    menu.style.top = `${Math.max(0, Math.min(y, innerHeight - mh - 4))}px`;
    this.menu = menu;
    const dismiss = (e: Event): void => {
      if (menu.contains(e.target as Node)) {return;}
      this.closeMenu();
      document.removeEventListener('pointerdown', dismiss, true);
      document.removeEventListener('keydown', key, true);
    };
    const key = (e: KeyboardEvent): void => {
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
      this.coolShotsTop.innerHTML = '<div class="cool-shot-item empty">No best shots yet</div>';
      this.coolShotsRecent.innerHTML = '<div class="cool-shot-item empty">No recent shots</div>';
      return;
    }

    // Top 10 by shot score (falls back to airtime for entries recorded
    // before scores existed), last 24h only - shots arrive in insertion
    // order, not sorted, so the sort must happen here.
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const top10 = shots
      .filter((s): boolean => s.timestamp >= dayAgo)
      .toSorted((a, b): number => (b.score ?? b.projectileLifetime) - (a.score ?? a.projectileLifetime))
      .slice(0, 10);
    if (top10.length === 0) {
      this.coolShotsTop.innerHTML = '<div class="cool-shot-item empty">No best shots in 24h</div>';
    }
    top10.forEach((shot, i): void => this.renderShotItem(this.coolShotsTop, shot, i + 1));

    // Recent 10 by timestamp (most recent first)
    const recent10 = shots.toSorted((a, b): number => b.timestamp - a.timestamp).slice(0, 10);
    recent10.forEach((shot, i): void => this.renderShotItem(this.coolShotsRecent, shot, i + 1));
  }
}
