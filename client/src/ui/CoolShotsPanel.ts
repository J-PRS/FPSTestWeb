import type { CoolShotEntry, DemoManager } from '../demo/index.js';
import { clipsDirName, deleteClip, exportClip, getClipBlob, listClips, pickClipsDir } from '../demo/clipSink.js';
import { zipSync } from 'fflate';

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
  private coolShotsLocal: HTMLElement;
  private demoManager: DemoManager;
  private overlay: HTMLElement;
  private requestLock: () => void;
  private lastCoolShots: CoolShotEntry[] = [];

  constructor(dependencies: CoolShotsPanelDependencies) {
    this.coolShotsTop = document.getElementById('cool-shots-top')!;
    this.coolShotsRecent = document.getElementById('cool-shots-recent')!;
    this.coolShotsLocal = document.getElementById('cool-shots-local')!;
    this.demoManager = dependencies.demoManager;
    this.overlay = dependencies.overlay;
    this.requestLock = dependencies.requestLock;

    this.setup();
  }

  private setup(): void {
    this.demoManager.onCoolShotsChanged = (shots): void => this.renderCoolShots(shots);
    this.demoManager.onLocalShotsChanged = (shots): void => this.renderLocalShots(shots);

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
    this.refreshVaultFoot();
    document.getElementById('cs-vault-zip')?.addEventListener('click', (): void => { void this.exportVault(); });
    // MP4 autosave folder — click re-picks (inside the gesture); the
    // label shows the armed folder name or 'not set' (vault fallback).
    document.getElementById('cs-save-dir')?.addEventListener('click', (): void => {
      void pickClipsDir().then((r): void => {
        const b = document.getElementById('cs-save-dir');
        // Flash the reason instead of a no-op — 'cancelled' usually means
        // the picker died without focus (overlay/lock), 'unsupported' is
        // a browser without showDirectoryPicker.
        if (b && r !== 'armed') {
          b.textContent = `save: ${r}`;
          setTimeout((): void => this.refreshVaultFoot(), 1500);
        }
        this.refreshVaultFoot();
      });
    });
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

  // Vault footer — count + total .demo bytes (pre-zip; zip size can't be
  // known until deflate runs, so we show the raw total honestly).
  private refreshVaultFoot(): void {
    const el = document.getElementById('cs-vault-stats');
    if (!el) {return;}
    void this.demoManager.vaultStats().then((s): void => {
      const mb = s.bytes / (1024 * 1024);
      el.textContent = s.count === 0 ? 'vault: empty'
        : `vault: ${s.count} clip${s.count === 1 ? '' : 's'} · ${mb < 1 ? `${Math.round(s.bytes / 1024)}KB` : `${mb.toFixed(1)}MB`}`;
      const zip = document.getElementById('cs-vault-zip');
      if (zip) {zip.style.display = s.count === 0 ? 'none' : '';}
      const dirBtn = document.getElementById('cs-save-dir');
      if (dirBtn) {dirBtn.textContent = `save: ${clipsDirName()}`;}
      void this.renderVaultClips();
    });
  }

  private async exportVault(): Promise<void> {
    const btn = document.getElementById('cs-vault-zip');
    if (btn) {btn.textContent = '…';}
    const files = await this.demoManager.vaultDump();
    if (files.length === 0) {
      if (btn) {btn.textContent = 'ZIP';}
      return;
    }
    const zipped = zipSync(Object.fromEntries(files.map((f): [string, Uint8Array] => [f.name, f.data])), { level: 6 });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' }));
    a.download = `coolshots_${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    setTimeout((): void => URL.revokeObjectURL(a.href), 10_000);
    if (btn) {btn.textContent = 'ZIP';}
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

  private renderShotItem(container: HTMLElement, shot: CoolShotEntry, rank: number, onPick?: (id: string) => void): void {
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
    if (onPick) {
      // Extracted clips: two-line tile — the description IS the headline
      // (weapon + air + victim), stats demote to the foot row.
      item.classList.add('local');
      const head = document.createElement('div');
      head.className = 'shot-head';
      item.append(head);
      const hspan = (cls: string, text: string): void => {
        const s = document.createElement('span');
        s.className = cls; s.textContent = text;
        head.append(s);
      };
      // Parse the extractor's killfeed-style line once:
      //   "POV shooter [Weapon] victim · 123m KILL"  (victim/KILL optional)
      // → chip + names in the head, aligned stats in the foot.
      const m = shot.description.match(/^(\w+) (.*?) · (\d+)m( KILL)?$/) ?? shot.description.match(/^(\w+) (.*?)( KILL)?$/);
      const pov = m?.[1] ?? '';
      let desc = m?.[2] ?? shot.description;
      const kill = m?.[4] === ' KILL';
      const miss = !desc.replace(/^(?:\w+ )?[^[]*\[[^\]]*\] ?/, '').trim();
      const dist = m?.[3];
      hspan('rank', String(rank));
      if (pov === 'REC' || pov === 'POV') {
        hspan(`pov pov-${pov.toLowerCase()}`, pov);
      } else { desc = `${pov} ${desc}`; }
      // Weapon leads (the tile is about the shot); the who dims and
      // right-aligns so killfeed noise doesn't crowd the headline.
      const parts = desc.match(/^(.*?) \[([^\]]+)\] ?(.*)$/);
      if (parts) {
        hspan('shot-desc', `[${parts[2]}]`);
        const who = `${parts[1]}${parts[3] ? ` → ${parts[3]}` : ''}`.trim();
        if (who) {hspan('shot-who', who);}
      } else { hspan('shot-desc', desc); }
      if (kill) {hspan('shot-kill', '☠');}
      const foot = document.createElement('div');
      foot.className = 'shot-foot';
      item.append(foot);
      const fspan = (cls: string, text: string): void => {
        const s = document.createElement('span');
        s.className = cls; s.textContent = text;
        foot.append(s);
      };
      fspan('lifetime', `${shot.projectileLifetime.toFixed(2)}s`);
      if (dist) {fspan('shot-dist', `${dist}m`);}
      if (miss) {fspan('shot-miss', 'miss');}
      fspan('time-ago', this.timeAgo(shot.timestamp));
    } else {
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
    }
    item.addEventListener('click', (): void => {
      (onPick ?? this.demoManager.playCoolShotById.bind(this.demoManager))(shot.id);
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

  /** Right-click menu plumbing — callers fill it via act(); appended to
   *  the overlay so it dies with the overlay's own display:none, and
   *  dismissed by any outside click, Escape, or the next list re-render
   *  (the panel repaints every second for time-ago labels). */
  private showMenu(x: number, y: number, fill: (act: (label: string, fn: () => void) => void) => void): void {
    this.closeMenu();
    const menu = document.createElement('div');
    menu.className = 'cool-shot-menu';
    const act = (label: string, fn: () => void): void => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', (e): void => {
        e.stopPropagation();
        this.closeMenu();
        fn();
      });
      menu.append(b);
    };
    fill(act);
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

  private openMenu(x: number, y: number, shot: CoolShotEntry): void {
    this.showMenu(x, y, (act): void => {
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
    });
  }

  /** F9/manual mp4s in the IDB clip vault — the write-only bucket F9
   *  saves fell into when no save folder was armed. Click plays in a
   *  new tab; right-click gives Download/Delete. */
  private async renderVaultClips(): Promise<void> {
    const host = document.getElementById('cool-shots-vault');
    if (!host) {return;}
    const clips = await listClips();
    host.innerHTML = '';
    if (clips.length === 0) {
      host.innerHTML = '<div class="cool-shot-item empty">No saved clips</div>';
      return;
    }
    for (const c of clips) {
      const item = document.createElement('div');
      item.className = 'cool-shot-item';
      const span = (cls: string, text: string): void => {
        const s = document.createElement('span');
        s.className = cls; s.textContent = text;
        item.append(s);
      };
      span('shot-desc', c.name.replace(/^kribes_|\.(mp4|webm)$/g, ''));
      span('shot-meta', `${(c.size / (1024 * 1024)).toFixed(1)}MB`);
      span('fmt fmt-mp4', c.name.endsWith('.mp4') ? 'MP4' : 'WEBM');
      span('time-ago', this.timeAgo(c.at));
      item.addEventListener('click', (): void => {
        getClipBlob(c.name).then((blob): void | null => {
          if (!blob) {return null;}
          const url = URL.createObjectURL(blob);
          window.open(url, '_blank');
          setTimeout((): void => URL.revokeObjectURL(url), 60_000);
          return undefined;
        }).catch((): void => undefined);
      });
      item.addEventListener('contextmenu', (e): void => {
        e.preventDefault();
        this.showMenu(e.clientX, e.clientY, (act): void => {
          act('Download', (): void => { void exportClip(c.name); });
          act('Delete', (): void => { void deleteClip(c.name).then((): Promise<void> => this.renderVaultClips()); });
        });
      });
      host.append(item);
    }
  }

  private renderCoolShots(shots: CoolShotEntry[]): void {
    // The 1s time-ago repaint must NOT close the context menu — item
    // nodes are rebuilt but the menu's actions captured the entry.
    this.lastCoolShots = shots;
    this.refreshVaultFoot();
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

  /** Extracted-clip library (demos/shots/**) — stream-recording cuts, so
   *  the tile shows the shooter's POV description, not your own stats.
   *  Sorted by airtime; rank is display-only. */
  private renderLocalShots(shots: CoolShotEntry[]): void {
    this.coolShotsLocal.innerHTML = '';
    if (shots.length === 0) {
      this.coolShotsLocal.innerHTML = '<div class="cool-shot-item empty">No extracted clips</div>';
      return;
    }
    const top = shots.toSorted((a, b): number => b.projectileLifetime - a.projectileLifetime).slice(0, 20);
    top.forEach((shot, i): void => this.renderShotItem(this.coolShotsLocal, shot, i + 1,
      (id): void => { this.demoManager.playLocalShotById(id); }));
  }
}
