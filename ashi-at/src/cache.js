// ローカルキャッシュ(IndexedDB)。
//
// 重要な設計方針(README_JP.md §7,8,9、およびレビューで確定した合意事項):
// - Misskeyのノート本文・投稿者・添付ファイル等は一切保存しない。保存するのは
//   パース済みのAshiato情報(geohash / canonical文字列など)だけ。
// - これは「Ashi@というサービスが持つ恒久的なAshiatoインデックス」ではなく、
//   「そのユーザーのブラウザに残る、そのユーザー自身の検索結果」という位置付け。
//   なので定期実行のバックグラウンド処理(Service Worker等)は一切持たない。
//   失効判定は「読み込まれたときにその場でフィルタする」形にとどめる。
// - Misskey側での投稿削除・編集を能動的に追跡することはしない。時間経過による
//   自動失効(CACHE_TTL_MS)だけで「古くなったキャッシュ」を扱う。

const DB_NAME = "ashi-at";
const DB_VERSION = 1;

export const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14日
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
 * @returns Ashiatoキャッシュ1レコード(ノート本文・投稿者などは含まない)
 */
export function makeRecord(host, tag, noteId, indexInNote, parseResult) {
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
    cachedAt: Date.now(),
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
 * @returns 期限内(cachedAt >= now - ttlMs)のレコードだけを返す。期限切れ分は
 * ここでは削除しない(削除はpruneCacheの役目) — 読み込みは読み込み、掃除は掃除。
 */
export async function getAshiatoRecords(host, tag, { ttlMs = CACHE_TTL_MS } = {}) {
  try {
    const db = await openDb();
    const key = hostTagKey(host, tag);
    const cutoff = Date.now() - ttlMs;

    const all = await new Promise((resolve, reject) => {
      const t = db.transaction("ashiatoCache", "readonly");
      const idx = t.objectStore("ashiatoCache").index("hostTag");
      const req = idx.getAll(IDBKeyRange.only(key));
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });

    return all.filter((r) => r.cachedAt >= cutoff);
  } catch (error) {
    console.warn("cache: getAshiatoRecords failed — キャッシュなしとして続行します:", error);
    return [];
  }
}

/**
 * 期限切れレコード、および件数上限を超えた古いレコードを削除する。
 * 定期実行のバックグラウンド処理としてではなく、host切り替え時など
 * 「読み込みが発生するタイミング」でだけ呼ぶ。
 */
export async function pruneCache(host, tag, { ttlMs = CACHE_TTL_MS, maxRecords = MAX_RECORDS_PER_HOST_TAG } = {}) {
  try {
    const db = await openDb();
    const key = hostTagKey(host, tag);
    const cutoff = Date.now() - ttlMs;

    await new Promise((resolve, reject) => {
      const t = db.transaction("ashiatoCache", "readwrite");
      const idx = t.objectStore("ashiatoCache").index("hostTag");
      const req = idx.getAll(IDBKeyRange.only(key));

      req.onsuccess = () => {
        const all = req.result ?? [];
        const expired = all.filter((r) => r.cachedAt < cutoff);

        const fresh = all
          .filter((r) => r.cachedAt >= cutoff)
          .sort((a, b) => b.cachedAt - a.cachedAt);
        const overflow = fresh.slice(maxRecords);

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
