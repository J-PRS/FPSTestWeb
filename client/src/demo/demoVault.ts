// DemoVault — personal clip persistence in IndexedDB (via `idb`, the
// 1.2KB promise wrapper). Server upload is the *share* lane; the vault
// is the *yours* lane — clips survive refresh and upload failures, and
// each is downloadable to a .demo file to send to yourself.
// FIFO-evict past CAP so clip spam can't grow storage unbounded — IDB
// quota is per-origin and shared with everything else the page stores.

import { openDB, type IDBPDatabase, type IDBPTransaction } from 'idb';
import type { DemoFile } from './types.js';
import { ChildLogger } from '../core/Logger.js';

const logger = new ChildLogger('DemoVault');

const DB_NAME = 'fps-demos';
const STORE = 'clips';
// Meta-only store — list() would otherwise structured-clone ~35MB of
// DemoFile payloads through getAll just to render the tile shelf.
const META_STORE = 'meta';
const CAP = 100;

export interface VaultEntry {
  id: string;
  timestamp: number;
  description: string;
  projectileLifetime: number;
  weapon?: string;
  distance?: number;
  mp4Name?: string;
  data: DemoFile;
}

export type VaultMeta = Omit<VaultEntry, 'data'>;

export class DemoVault {
  private dbp: Promise<IDBPDatabase> | null = null;

  private db(): Promise<IDBPDatabase> {
    // Lazy: opening IDB on module load would fault sessions that never
    // record a clip (and jsdom tests, where IDB may not exist).
    if (!this.dbp) {
      this.dbp = openDB(DB_NAME, 3, {
        upgrade(db, _oldVersion, _newVersion, tx) {
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'id' });
          }
          const store = tx.objectStore(STORE);
          if (!store.indexNames.contains('ts')) {store.createIndex('ts', 'timestamp');}
          if (!db.objectStoreNames.contains(META_STORE)) {
            // Upgrade stays synchronous — async backfill inside an
            // upgrade transaction races its auto-commit. v2 rows get a
            // meta row lazily on the next list() (see drift check there).
            const meta = db.createObjectStore(META_STORE, { keyPath: 'id' });
            meta.createIndex('ts', 'timestamp');
          }
        },
      });
      this.dbp.catch(() => { this.dbp = null; });
    }
    return this.dbp;
  }

  async put(entry: VaultEntry): Promise<void> {
    try {
      const db = await this.db();
      const tx = db.transaction([STORE, META_STORE], 'readwrite');
      const { data: _d, ...meta } = entry;
      await tx.objectStore(STORE).put(entry);
      await tx.objectStore(META_STORE).put(meta);
      await this.evict(tx);
      await tx.done;
    } catch (e) {
      // Vault failing must never eat a clip — memory copy is primary.
      logger.warn('Vault put failed', e);
    }
  }

  async get(id: string): Promise<DemoFile | undefined> {
    try {
      const rec = await (await this.db()).get(STORE, id) as VaultEntry | undefined;
      return rec?.data;
    } catch (e) {
      logger.warn('Vault get failed', e);
      return undefined;
    }
  }

  async list(): Promise<VaultMeta[]> {
    try {
      const db = await this.db();
      // Meta-store drift check: v2 rows predate it (and a failed put could
      // leave clip-without-meta) — backfill once rather than 413-ing the
      // shelf permanently.
      const [clipCount, metaCount] = await Promise.all([
        db.count(STORE), db.count(META_STORE),
      ]);
      if (metaCount !== clipCount) {await this.backfillMeta(db);}
      const all = await db.getAll(META_STORE) as VaultMeta[];
      all.sort((a, b) => b.timestamp - a.timestamp);
      return all;
    } catch (e) {
      logger.warn('Vault list failed', e);
      return [];
    }
  }

  // Rebuild the meta store from the clip rows — only runs when the two
  // counts disagree, i.e. on first list() after the v2→v3 upgrade.
  private async backfillMeta(db: IDBPDatabase): Promise<void> {
    try {
      const tx = db.transaction([STORE, META_STORE], 'readwrite');
      for await (const cursor of tx.objectStore(STORE).iterate()) {
        const { data: _d, ...m } = cursor.value as VaultEntry;
        await tx.objectStore(META_STORE).put(m);
      }
      await tx.done;
    } catch (e) {
      logger.warn('Vault meta backfill failed', e);
    }
  }

  // FIFO: newest survive; oldest go once past CAP. The 'ts' index cursor
  // deletes by key without deserializing clip payloads — getAll would
  // pull ~35MB of DemoFiles through structured clone on every put.
  // Both stores evict in the same tx so meta can never orphan.
  private async evict(tx: IDBPTransaction<unknown, string[], 'readwrite'>): Promise<void> {
    const clips = tx.objectStore(STORE);
    let excess = (await clips.count()) - CAP;
    if (excess <= 0) { return; }
    const meta = tx.objectStore(META_STORE);
    for await (const cursor of clips.index('ts').iterate()) {
      if (excess <= 0) { break; }
      await cursor.delete();
      await meta.delete(cursor.primaryKey as string);
      excess--;
    }
  }
}
