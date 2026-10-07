// DemoVault — personal clip persistence in IndexedDB (via `idb`, the
// 1.2KB promise wrapper). Server upload is the *share* lane; the vault
// is the *yours* lane — clips survive refresh and upload failures, and
// each is downloadable to a .demo file to send to yourself.
// FIFO-evict past CAP so clip spam can't grow storage unbounded — IDB
// quota is per-origin and shared with everything else the page stores.

import { openDB, type IDBPDatabase } from 'idb';
import type { DemoFile } from './types.js';
import { ChildLogger } from '../core/Logger.js';

const logger = new ChildLogger('DemoVault');

const DB_NAME = 'fps-demos';
const STORE = 'clips';
const CAP = 100;

export interface VaultEntry {
  id: string;
  timestamp: number;
  description: string;
  projectileLifetime: number;
  weapon?: string;
  distance?: number;
  data: DemoFile;
}

export type VaultMeta = Omit<VaultEntry, 'data'>;

export class DemoVault {
  private dbp: Promise<IDBPDatabase> | null = null;

  private db(): Promise<IDBPDatabase> {
    // Lazy: opening IDB on module load would fault sessions that never
    // record a clip (and jsdom tests, where IDB may not exist).
    if (!this.dbp) {
      this.dbp = openDB(DB_NAME, 2, {
        upgrade(db, _oldVersion, _newVersion, tx) {
          if (!db.objectStoreNames.contains(STORE)) {
            db.createObjectStore(STORE, { keyPath: 'id' });
          }
          const store = tx.objectStore(STORE);
          if (!store.indexNames.contains('ts')) {store.createIndex('ts', 'timestamp');}
        },
      });
      this.dbp.catch(() => { this.dbp = null; });
    }
    return this.dbp;
  }

  async put(entry: VaultEntry): Promise<void> {
    try {
      const db = await this.db();
      await db.put(STORE, entry);
      await this.evict(db);
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
      const all = await (await this.db()).getAll(STORE) as VaultEntry[];
      all.sort((a, b) => b.timestamp - a.timestamp);
      return all.map(({ data: _data, ...meta }) => meta);
    } catch (e) {
      logger.warn('Vault list failed', e);
      return [];
    }
  }

  // FIFO: newest survive; oldest go once past CAP. The 'ts' index cursor
  // deletes by key without deserializing clip payloads — getAll would
  // pull ~35MB of DemoFiles through structured clone on every put.
  private async evict(db: IDBPDatabase): Promise<void> {
    const tx = db.transaction(STORE, 'readwrite');
    let excess = (await tx.store.count()) - CAP;
    if (excess <= 0) { return; }
    for await (const cursor of tx.store.index('ts').iterate()) {
      if (excess <= 0) { break; }
      await cursor.delete();
      excess--;
    }
    await tx.done;
  }
}
