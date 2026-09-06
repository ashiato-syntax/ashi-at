// ローカルキャッシュ(IndexedDB)。
const DB_NAME = "ashi-at";
const DB_VERSION = 1;

export const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14日(通常のキャッシュ)
export const UNLOCKED_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180日(発見済みAshiato)
const MAX_RECORDS_PER_HOST_TAG = 1000;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains("ashiatoCache")) {
        const store = db.createObjectStore("ashiatoCache", { keyPath: "id" });
        store.createIndex("hostTag", "hostTag", { unique: false });
      }

      if (!db.objectStoreNames.contains("cursors")) {
        db.createObjectStore("cursors", { keyPath: "hostTag" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

function hostTagKey(host, tag) {
  return `${host}::${tag}`;
}

/**
 * @param {string} host misskey.jsのnormalizeInstanceUrl()が返すorigin
 * @param {string} tag ハッシュタグ(先頭の#なし)
 * @param {string} noteId
 * @param {number} indexInNote 同じノート内に複数のAshiatoがあった場合の連番
 * @param {{ model: { geohash:string, contextId:string|null }, canonical:string }} parseResult
 *   parser.jsのparseCandidate()がok:trueで返すオブジェクトそのもの
 * @param {string|null} noteCreatedAt Misskeyのnote.createdAt(ISO8601文字列)
 * @returns Ashiatoキャッシュ1レコード(ノート本文・投稿者などは含まない)
 */
export function makeRecord(host, tag, noteId, indexInNote, parseResult, noteCreatedAt = null) {
  return {
    id: `${host}::${noteId}::${indexInNote}`,
    hostTag: hostTagKey(host, tag),
    host,
    tag,
    noteId,
    indexInNote,
    geohash: parseResult.model.geohash,
    contextId: parseResult.model.contextId,
    canonical: parseResult.canonical,
    noteCreatedAt, // ノートの投稿日時(本文・投稿者は含まない、日時だけ)
    cachedAt: Date.now(),
    unlockedAt: null, // 現在地がこのAshiatoのセル内に入った時刻(初回のみ記録)
    openedAt: null, // 「開封する」でノートURLへ遷移した時刻(初回のみ記録)
  };
}

export async function getCursor(host, tag) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const t = db.transaction("cursors", "readonly");
      const req = t.objectStore("cursors").get(hostTagKey(host, tag));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.warn("cache: getCursor failed — キャッシュなしで続行します:", error);
    return null;
  }
}

export async function putCursor(host, tag, patch) {
  try {
    const db = await openDb();
    const key = hostTagKey(host, tag);
    await new Promise((resolve, reject) => {
      const t = db.transaction("cursors", "readwrite");
      const store = t.objectStore("cursors");
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const existing = getReq.result ?? { hostTag: key, host, tag };
        store.put({ ...existing, ...patch, hostTag: key, host, tag, updatedAt: Date.now() });
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch (error) {
    console.warn("cache: putCursor failed — このセッションでは検索位置が保存されません:", error);
  }
}

export async function putAshiatoRecords(records) {
  if (records.length === 0) return;
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const t = db.transaction("ashiatoCache", "readwrite");
      const store = t.objectStore("ashiatoCache");
      for (const r of records) store.put(r);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch (error) {
    console.warn("cache: putAshiatoRecords failed — このセッションではキャッシュされません:", error);
  }
}

/**
 * @returns 期限内のレコードだけを返す。unlockedAtがあるレコードはunlockedTtlMs、
 * 無いレコードはttlMsで判定する(cachedAt起点は共通)。期限切れ分はここでは
 * 削除しない(削除はpruneCacheの役目) — 読み込みは読み込み、掃除は掃除。
 */
export async function getAshiatoRecords(
  host,
  tag,
  { ttlMs = CACHE_TTL_MS, unlockedTtlMs = UNLOCKED_TTL_MS } = {},
) {
  try {
    const db = await openDb();
    const key = hostTagKey(host, tag);

    const all = await new Promise((resolve, reject) => {
      const t = db.transaction("ashiatoCache", "readonly");
      const idx = t.objectStore("ashiatoCache").index("hostTag");
      const req = idx.getAll(IDBKeyRange.only(key));
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });

    const now = Date.now();
    return all.filter(
      (r) => now - r.cachedAt < (r.unlockedAt ? unlockedTtlMs : ttlMs),
    );
  } catch (error) {
    console.warn("cache: getAshiatoRecords failed — キャッシュなしとして続行します:", error);
    return [];
  }
}

/**
 * 期限切れレコード、および件数上限を超えた古いレコードを削除する。
 * 定期実行のバックグラウンド処理としてではなく、host切り替え時など
 * 「読み込みが発生するタイミング」でだけ呼ぶ。
 * unlockedAtがあるレコード(発見済みAshiato)は、件数上限による間引きの対象からも外す
 * — 容量超過を理由に「達成の記録」が真っ先に消えるのは本末転倒なため。
 */
export async function pruneCache(
  host,
  tag,
  { ttlMs = CACHE_TTL_MS, unlockedTtlMs = UNLOCKED_TTL_MS, maxRecords = MAX_RECORDS_PER_HOST_TAG } = {},
) {
  try {
    const db = await openDb();
    const key = hostTagKey(host, tag);
    const now = Date.now();

    await new Promise((resolve, reject) => {
      const t = db.transaction("ashiatoCache", "readwrite");
      const idx = t.objectStore("ashiatoCache").index("hostTag");
      const req = idx.getAll(IDBKeyRange.only(key));

      req.onsuccess = () => {
        const all = req.result ?? [];
        const isFresh = (r) =>
          now - r.cachedAt < (r.unlockedAt ? unlockedTtlMs : ttlMs);

        const expired = all.filter((r) => !isFresh(r));
        const notExpired = all.filter(isFresh);

        const otherRecords = notExpired
          .filter((r) => !r.unlockedAt)
          .sort((a, b) => b.cachedAt - a.cachedAt);
        const overflow = otherRecords.slice(maxRecords);

        const store = t.objectStore("ashiatoCache");
        for (const r of [...expired, ...overflow]) store.delete(r.id);
      };

      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch (error) {
    console.warn("cache: pruneCache failed:", error);
  }
}

/**
 * 既存レコードの一部フィールドだけを更新する(get→マージ→put)。
 * 該当idのレコードが既に無い場合(キャッシュ消去後にGPSコールバックが
 * 遅れて届いた、等)は何もしない。
 */
async function updateAshiatoRecord(id, patch) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const t = db.transaction("ashiatoCache", "readwrite");
      const store = t.objectStore("ashiatoCache");
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) return; // 消去済み等。黙って無視する
        store.put({ ...existing, ...patch });
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch (error) {
    console.warn(`cache: updateAshiatoRecord(${id}) failed:`, error);
  }
}

/** 現在地がこのAshiatoのセル内に入った(発見された)ことを記録する。 */
export function markAshiatoUnlocked(id, unlockedAt = Date.now()) {
  return updateAshiatoRecord(id, { unlockedAt });
}

/** 「開封する」でノートURLへ遷移したことを記録する。 */
export function markAshiatoOpened(id, openedAt = Date.now()) {
  return updateAshiatoRecord(id, { openedAt });
}

/** ユーザーが明示的に「キャッシュを消す」を押したときだけ呼ぶ。全host・全tag対象。 */
export async function clearAllCache() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const t = db.transaction(["ashiatoCache", "cursors"], "readwrite");
      t.objectStore("ashiatoCache").clear();
      t.objectStore("cursors").clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch (error) {
    console.warn("cache: clearAllCache failed:", error);
  }
}
