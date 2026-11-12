/**
 * Local-only photo storage (BingoSnap). Photos live in this browser's IndexedDB and nowhere
 * else: this module has no network code, and nothing it stores is ever sent anywhere.
 *
 * Layout (database "bingosnap", version 1), both stores keyed by [gameId, playerId, cellId]:
 *   photos: { schema, gameId, playerId, cellId, thumb, width, height, takenAt, savedAt, source }
 *   images: { gameId, playerId, cellId, image }   (the full photo; read only when it is opened)
 * A photo and its thumbnail are written in ONE transaction, so a save either lands completely or
 * not at all (an interrupted write leaves the previous photo in place). Every read and write is
 * scoped to one game AND one participant, so photos never mix between games or players.
 *
 * When IndexedDB is unavailable (some private modes, blocked storage) a memory store with the
 * same interface is used, and the UI says photos will not survive a reload.
 */
import type { CapturedPhoto, PhotoSource } from "./process";

export const PHOTO_DB_NAME = "bingosnap";
export const PHOTO_DB_VERSION = 1;
/** Version of the record shape (bump with a migration in onupgradeneeded). */
export const PHOTO_SCHEMA = 1;
const META = "photos";
const IMAGES = "images";
const OWNER_INDEX = "owner";
/** Photos of OTHER games older than this are removed on the next visit. The current game's never are. */
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const OPEN_TIMEOUT_MS = 5000;

export type PhotoOwner = { gameId: string; playerId: string };
export type PhotoSummary = {
  cellId: string;
  thumb: Blob;
  width: number;
  height: number;
  takenAt: number;
  savedAt: number;
  source: PhotoSource;
};

export type PhotoStoreErrorKind = "unavailable" | "quota" | "interrupted" | "invalid" | "unknown";

export class PhotoStoreError extends Error {
  readonly kind: PhotoStoreErrorKind;
  constructor(kind: PhotoStoreErrorKind, cause?: unknown) {
    super(kind, cause === undefined ? undefined : { cause });
    this.kind = kind;
    this.name = "PhotoStoreError";
  }
}

export const storeHelp: Record<PhotoStoreErrorKind, string> = {
  quota: "This phone is out of space for photos. Free up some storage, then tap Save again.",
  interrupted: "Saving was interrupted. Your photo is still here: tap Save again.",
  unavailable: "This browser won't let us save photos. Try again, or switch off private browsing.",
  invalid: "We couldn't match this photo to your card. Close the camera and try again.",
  unknown: "We couldn't save that photo. Tap Save again.",
};

export function classifyStorageError(e: unknown): PhotoStoreErrorKind {
  if (e instanceof PhotoStoreError) return e.kind;
  const err = e as { name?: string; code?: number; message?: string } | null;
  const name = err?.name ?? "";
  if (name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || err?.code === 22) return "quota";
  if (/quota/i.test(err?.message ?? "")) return "quota";
  if (name === "AbortError" || name === "TransactionInactiveError") return "interrupted";
  if (name === "SecurityError" || name === "InvalidStateError" || name === "NotSupportedError" || name === "VersionError") return "unavailable";
  return "unknown";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The composite key; refuses anything that isn't a game/player/cell uuid. */
export function photoKey(owner: PhotoOwner, cellId: string): [string, string, string] {
  if (![owner.gameId, owner.playerId, cellId].every((v) => typeof v === "string" && UUID.test(v))) {
    throw new PhotoStoreError("invalid");
  }
  return [owner.gameId.toLowerCase(), owner.playerId.toLowerCase(), cellId.toLowerCase()];
}

/** Whether a stored record may be pruned: another game's, and older than the cut-off. */
export const isStale = (r: { gameId: string; savedAt: number }, keepGameId: string, now: number) =>
  r.gameId !== keepGameId.toLowerCase() && !(now - r.savedAt < STALE_AFTER_MS);

export interface PhotoStore {
  /** false for the memory fallback: photos are lost on reload. */
  readonly persistent: boolean;
  list(owner: PhotoOwner): Promise<PhotoSummary[]>;
  getImage(owner: PhotoOwner, cellId: string): Promise<Blob | null>;
  /** Saves or replaces a cell's photo atomically. */
  put(owner: PhotoOwner, cellId: string, photo: CapturedPhoto): Promise<PhotoSummary>;
  remove(owner: PhotoOwner, cellId: string): Promise<void>;
  clear(owner: PhotoOwner): Promise<void>;
  /** Removes other games' photos older than STALE_AFTER_MS; returns how many. */
  prune(keepGameId: string, now?: number): Promise<number>;
}

// ------------------------------------------------------------------ memory ----

export class MemoryPhotoStore implements PhotoStore {
  readonly persistent = false;
  private rows = new Map<string, { gameId: string; playerId: string; summary: PhotoSummary; image: Blob }>();
  private k = (owner: PhotoOwner, cellId: string) => photoKey(owner, cellId).join("|");

  async list(owner: PhotoOwner) {
    const [g, p] = photoKey(owner, owner.gameId /* any uuid; only g/p are used */);
    return [...this.rows.values()].filter((r) => r.gameId === g && r.playerId === p).map((r) => r.summary);
  }
  async getImage(owner: PhotoOwner, cellId: string) {
    return this.rows.get(this.k(owner, cellId))?.image ?? null;
  }
  async put(owner: PhotoOwner, cellId: string, photo: CapturedPhoto) {
    const [gameId, playerId, cell] = photoKey(owner, cellId);
    const summary = summaryOf(cell, photo, Date.now());
    this.rows.set(this.k(owner, cellId), { gameId, playerId, summary, image: photo.image });
    return summary;
  }
  async remove(owner: PhotoOwner, cellId: string) {
    this.rows.delete(this.k(owner, cellId));
  }
  async clear(owner: PhotoOwner) {
    for (const s of await this.list(owner)) this.rows.delete(this.k(owner, s.cellId));
  }
  async prune(keepGameId: string, now = Date.now()) {
    let n = 0;
    for (const [key, r] of this.rows) {
      if (isStale({ gameId: r.gameId, savedAt: r.summary.savedAt }, keepGameId, now)) { this.rows.delete(key); n++; }
    }
    return n;
  }
}

function summaryOf(cellId: string, p: CapturedPhoto, savedAt: number): PhotoSummary {
  return { cellId, thumb: p.thumb, width: p.width, height: p.height, takenAt: p.takenAt, savedAt, source: p.source };
}

// --------------------------------------------------------------- IndexedDB ----

/** Some WebKit builds can't store Blobs in IndexedDB; those get bytes + type instead. */
type Stored = Blob | { bytes: ArrayBuffer; type: string };
const toBlob = (s: Stored | undefined): Blob | null =>
  s instanceof Blob ? s : s && s.bytes instanceof ArrayBuffer ? new Blob([s.bytes], { type: s.type || "image/jpeg" }) : null;
const toBytes = async (b: Blob): Promise<Stored> => ({ bytes: await b.arrayBuffer(), type: b.type });

type MetaRow = {
  schema: number; gameId: string; playerId: string; cellId: string; thumb: Stored;
  width: number; height: number; takenAt: number; savedAt: number; source: PhotoSource;
};

const req = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

/** Resolves only when the transaction COMMITS (so the photo is really on disk). */
const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    // A failed request is NOT prevented, so the whole transaction aborts: never half a photo.
    tx.onabort = () => reject(new PhotoStoreError(classifyStorageError(tx.error ?? { name: "AbortError" }), tx.error));
  });

class IdbPhotoStore implements PhotoStore {
  readonly persistent = true;
  private db: IDBDatabase;
  constructor(db: IDBDatabase) {
    this.db = db;
    // Another tab upgraded the schema: let it, and fail later calls cleanly.
    db.onversionchange = () => db.close();
  }

  private tx(stores: string[], mode: IDBTransactionMode) {
    try {
      return this.db.transaction(stores, mode);
    } catch (e) {
      throw new PhotoStoreError(classifyStorageError(e) === "unknown" ? "unavailable" : classifyStorageError(e), e);
    }
  }

  async list(owner: PhotoOwner) {
    const [g, p] = photoKey(owner, owner.gameId);
    const tx = this.tx([META], "readonly");
    const rows = (await req(tx.objectStore(META).index(OWNER_INDEX).getAll(IDBKeyRange.only([g, p])))) as MetaRow[];
    return rows
      .filter((r) => r.schema === PHOTO_SCHEMA)
      .flatMap((r) => {
        const thumb = toBlob(r.thumb);
        return thumb ? [{ cellId: r.cellId, thumb, width: r.width, height: r.height, takenAt: r.takenAt, savedAt: r.savedAt, source: r.source }] : [];
      });
  }

  async getImage(owner: PhotoOwner, cellId: string) {
    const tx = this.tx([IMAGES], "readonly");
    const row = (await req(tx.objectStore(IMAGES).get(photoKey(owner, cellId)))) as { image?: Stored } | undefined;
    return toBlob(row?.image);
  }

  async put(owner: PhotoOwner, cellId: string, photo: CapturedPhoto) {
    const [gameId, playerId, cell] = photoKey(owner, cellId);
    const savedAt = Date.now();
    const write = async (asBytes: boolean) => {
      const image: Stored = asBytes ? await toBytes(photo.image) : photo.image;
      const thumb: Stored = asBytes ? await toBytes(photo.thumb) : photo.thumb;
      const tx = this.tx([META, IMAGES], "readwrite");
      const committed = done(tx);
      try {
        tx.objectStore(IMAGES).put({ gameId, playerId, cellId: cell, image });
        tx.objectStore(META).put({
          schema: PHOTO_SCHEMA, gameId, playerId, cellId: cell, thumb,
          width: photo.width, height: photo.height, takenAt: photo.takenAt, savedAt, source: photo.source,
        } satisfies MetaRow);
      } catch (e) {
        try { tx.abort(); } catch { /* already finished */ }
        committed.catch(() => undefined);
        throw e;
      }
      await committed;
    };
    try {
      await write(false);
    } catch (e) {
      const name = (e as { name?: string }).name;
      // "DataCloneError" / WebKit "UnknownError": this browser can't store Blobs. Retry as bytes.
      if (name !== "DataCloneError" && !(e instanceof PhotoStoreError && e.kind === "unknown")) throw wrap(e);
      await write(true).catch((e2) => { throw wrap(e2); });
    }
    return summaryOf(cell, photo, savedAt);
  }

  async remove(owner: PhotoOwner, cellId: string) {
    const key = photoKey(owner, cellId);
    const tx = this.tx([META, IMAGES], "readwrite");
    const committed = done(tx);
    tx.objectStore(META).delete(key);
    tx.objectStore(IMAGES).delete(key);
    await committed;
  }

  async clear(owner: PhotoOwner) {
    const [g, p] = photoKey(owner, owner.gameId);
    const range = IDBKeyRange.bound([g, p, ""], [g, p, "￿"]);
    const tx = this.tx([META, IMAGES], "readwrite");
    const committed = done(tx);
    tx.objectStore(META).delete(range);
    tx.objectStore(IMAGES).delete(range);
    await committed;
  }

  async prune(keepGameId: string, now = Date.now()) {
    const tx = this.tx([META, IMAGES], "readwrite");
    const committed = done(tx);
    const images = tx.objectStore(IMAGES);
    let n = 0;
    await new Promise<void>((resolve, reject) => {
      const cursor = tx.objectStore(META).openCursor();
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return resolve();
        const r = c.value as MetaRow;
        if (isStale(r, keepGameId, now)) { c.delete(); images.delete(c.primaryKey); n++; }
        c.continue();
      };
    });
    await committed;
    return n;
  }
}

const wrap = (e: unknown) => (e instanceof PhotoStoreError ? e : new PhotoStoreError(classifyStorageError(e), e));

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PhotoStoreError("unavailable")), OPEN_TIMEOUT_MS);
    let r: IDBOpenDBRequest;
    try {
      r = factory.open(PHOTO_DB_NAME, PHOTO_DB_VERSION);
    } catch (e) {
      clearTimeout(timer);
      return reject(new PhotoStoreError("unavailable", e));
    }
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(META)) {
        const meta = db.createObjectStore(META, { keyPath: ["gameId", "playerId", "cellId"] });
        meta.createIndex(OWNER_INDEX, ["gameId", "playerId"]);
      }
      if (!db.objectStoreNames.contains(IMAGES)) db.createObjectStore(IMAGES, { keyPath: ["gameId", "playerId", "cellId"] });
    };
    r.onsuccess = () => { clearTimeout(timer); resolve(r.result); };
    r.onerror = () => { clearTimeout(timer); reject(new PhotoStoreError("unavailable", r.error)); };
    // Another tab holds an older version open: it closes on versionchange; until then we wait (bounded by the timer).
    r.onblocked = () => undefined;
  });
}

let shared: Promise<PhotoStore> | null = null;

/** The browser's photo store (one per page). Falls back to memory when IndexedDB can't be used. */
export function openPhotoStore(): Promise<PhotoStore> {
  shared ??= (async () => {
    try {
      const factory = globalThis.indexedDB;
      if (!factory) throw new PhotoStoreError("unavailable");
      return new IdbPhotoStore(await openDb(factory));
    } catch {
      return new MemoryPhotoStore();
    }
  })();
  return shared;
}

let persistAsked = false;
/** Ask the browser not to evict our data (once per page; best effort, some browsers prompt). */
export function requestPersistence(): void {
  if (persistAsked) return;
  persistAsked = true;
  const s = globalThis.navigator?.storage;
  void s?.persisted?.().then((already) => (already ? true : s.persist?.())).catch(() => undefined);
}
