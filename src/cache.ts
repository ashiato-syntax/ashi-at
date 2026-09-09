import type { AshiatoModel } from "./parser.js";
import type { AshiatoRecord, Cursor, Draft, GeohashLength } from "./types.js";

// ローカルキャッシュ(IndexedDB)。
const DB_NAME = "ashi-at";
const DB_VERSION = 4; // 4: emojiImagesストア追加(カスタム絵文字画像のキャッシュ用)

export const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14日(通常のキャッシュ)
export const UNLOCKED_TTL_MS = 180 * 24 * 60 * 60 * 1000; // 180日(発見済みAshiato)
const MAX_RECORDS_PER_HOST_TAG = 1000;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
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

      // TTL無しで永続化したい設定値(インスタンスURL、地図の表示位置など)用。
      // host/tagには紐付かないアプリ全体の設定なので、単純な key-value。
      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }

      // 投稿機能の下書き。まだ投稿していないAshiatoの位置・精度をここに置く。
      // ashiatoCache(受信したAshiatoのキャッシュ)とは別物であり、TTLでは
      // 消えない(ユーザーが明示的に削除するまで残る)。
      if (!db.objectStoreNames.contains("drafts")) {
        db.createObjectStore("drafts", { keyPath: "id" });
      }

      // カスタム絵文字画像(Blob)のキャッシュ。URLをキーにする。
      // 本文プレビュー(MFM)中のカスタム絵文字を表示するたびに毎回ネットワーク
      // 取得しないようにするためのもの。TTLは設けない
      // (画像そのものは個人情報ではなく、インスタンス側で差し替えられる頻度も
      // 低いため、素朴にURLキーでキャッシュし続ける方針)。
      if (!db.objectStoreNames.contains("emojiImages")) {
        db.createObjectStore("emojiImages", { keyPath: "url" });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  return dbPromise;
}

function hostTagKey(host: string, tag: string): string {
  return `${host}::${tag}`;
}

/**
 * @param host misskey.jsのnormalizeInstanceUrl()が返すorigin
 * @param tag ハッシュタグ(先頭の#なし)
 * @param indexInNote 同じノート内に複数のAshiatoがあった場合の連番
 * @param parseResult parser.jsのparseCandidate()がok:trueで返すオブジェクトそのもの
 * @param noteCreatedAt Misskeyのnote.createdAt(ISO8601文字列)
 * @param username 投稿者のacct名(note.user.username)。
 *   「あつめたあしあと」で開封済みのものを表示する際に使う(本文・投稿者の他の情報は保存しない)。
 * @param textPreview ノート本文からAshiato Syntax部分を除き、MFMを
 *   プレーンテキスト化したプレビュー文字列。表示側(main.js)ではCSSでの高さクリップ
 *   +「続きを表示」で見た目上だけ省略する方針のため、ここでは意図的な文字数での
 *   切り詰めは行わない(極端に長い本文に対する安全弁としての上限のみ設ける)。
 *   未開封の「あつめたあしあと」一覧でも、開封前に内容を確認できるようにするために保持する
 *   (ノート本文そのものを無条件に保存しないという方針は、Ashiato Syntax部分の除去や
 *   note.deletedAt等のノート単位フィルタでは維持しつつ、本文プレビュー自体は
 *   この用途のために例外的に保持する)。
 * @param emojiHost textPreview中の「:name:」表記(カスタム絵文字)を解決する際に
 *   問い合わせるインスタンスのorigin(例: "https://misskey.io")。ノートの投稿元インスタンス
 *   (note.user.hostがあればそちら、ローカルユーザーのノートならhostと同じ)を渡す想定。
 *   note.emojisは最近のMisskeyでは空のことが多く当てにできないため、代わりにこちらを保持し、
 *   表示側(main.js)でmisskey.jsのfetchEmojiMapを使って都度解決する
 *   (絵文字画像そのものは保存しない方針は維持。ここで保持するのは問い合わせ先ホストだけ)。
 *   投稿者のacct表示(@username@host)を組み立てる際のhostとしても表示側で流用する。
 * @param displayName 投稿者の表示名(note.user.name)。設定していないユーザーも
 *   いるためnullになりうる。表示側では「{displayName} @{username}@{host}」の形式で使う。
 * @returns Ashiatoキャッシュ1レコード(ノート本文全体は含まない)
 */
export function makeRecord(
  host: string,
  tag: string,
  noteId: string,
  indexInNote: number,
  parseResult: { model: Pick<AshiatoModel, "geohash" | "contextId">; canonical: string },
  noteCreatedAt: string | null = null,
  username: string | null = null,
  textPreview: string | null = null,
  emojiHost: string | null = null,
  displayName: string | null = null,
): AshiatoRecord {
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
    noteCreatedAt, // ノートの投稿日時(本文は含まない、日時だけ)
    username, // 投稿者のacct名(表示用)
    displayName, // 投稿者の表示名(表示用、無いユーザーもいる)
    textPreview, // 本文プレビュー(MFMをプレーンテキスト化、Ashiato Syntax除去済み)
    emojiHost, // textPreview中のカスタム絵文字解決 / acct表示用のホスト
    cachedAt: Date.now(),
    unlockedAt: null, // 現在地がこのAshiatoのセル内に入った時刻(初回のみ記録)
    openedAt: null, // 「開封する」でノートURLへ遷移した時刻(初回のみ記録)
  };
}

export async function getCursor(host: string, tag: string): Promise<Cursor | null> {
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

export async function putCursor(
  host: string,
  tag: string,
  patch: Partial<Cursor>,
): Promise<void> {
  try {
    const db = await openDb();
    const key = hostTagKey(host, tag);
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("cursors", "readwrite");
      const store = t.objectStore("cursors");
      const getReq = store.get(key);
      getReq.onsuccess = () => {
        const existing: Cursor = getReq.result ?? { hostTag: key, host, tag };
        store.put({ ...existing, ...patch, hostTag: key, host, tag, updatedAt: Date.now() });
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch (error) {
    console.warn("cache: putCursor failed — このセッションでは検索位置が保存されません:", error);
  }
}

export async function putAshiatoRecords(records: AshiatoRecord[]): Promise<void> {
  if (records.length === 0) return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
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

export interface GetAshiatoRecordsOptions {
  ttlMs?: number;
  unlockedTtlMs?: number;
}

/**
 * @returns 期限内のレコードだけを返す。unlockedAtがあるレコードはunlockedTtlMs、
 * 無いレコードはttlMsで判定する(cachedAt起点は共通)。期限切れ分はここでは
 * 削除しない(削除はpruneCacheの役目) — 読み込みは読み込み、掃除は掃除。
 */
export async function getAshiatoRecords(
  host: string,
  tag: string,
  { ttlMs = CACHE_TTL_MS, unlockedTtlMs = UNLOCKED_TTL_MS }: GetAshiatoRecordsOptions = {},
): Promise<AshiatoRecord[]> {
  try {
    const db = await openDb();
    const key = hostTagKey(host, tag);

    const all: AshiatoRecord[] = await new Promise((resolve, reject) => {
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

export interface PruneCacheOptions extends GetAshiatoRecordsOptions {
  maxRecords?: number;
}

/**
 * 期限切れレコード、および件数上限を超えた古いレコードを削除する。
 * 定期実行のバックグラウンド処理としてではなく、host切り替え時など
 * 「読み込みが発生するタイミング」でだけ呼ぶ。
 * unlockedAtがあるレコード(発見済みAshiato)は、件数上限による間引きの対象からも外す
 * — 容量超過を理由に「達成の記録」が真っ先に消えるのは本末転倒なため。
 */
export async function pruneCache(
  host: string,
  tag: string,
  {
    ttlMs = CACHE_TTL_MS,
    unlockedTtlMs = UNLOCKED_TTL_MS,
    maxRecords = MAX_RECORDS_PER_HOST_TAG,
  }: PruneCacheOptions = {},
): Promise<void> {
  try {
    const db = await openDb();
    const key = hostTagKey(host, tag);
    const now = Date.now();

    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("ashiatoCache", "readwrite");
      const idx = t.objectStore("ashiatoCache").index("hostTag");
      const req = idx.getAll(IDBKeyRange.only(key));

      req.onsuccess = () => {
        const all: AshiatoRecord[] = req.result ?? [];
        const isFresh = (r: AshiatoRecord) =>
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
async function updateAshiatoRecord(id: string, patch: Partial<AshiatoRecord>): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("ashiatoCache", "readwrite");
      const store = t.objectStore("ashiatoCache");
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing: AshiatoRecord | undefined = getReq.result;
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
export function markAshiatoUnlocked(id: string, unlockedAt: number = Date.now()): Promise<void> {
  return updateAshiatoRecord(id, { unlockedAt });
}

/** 「開封する」でノートURLへ遷移したことを記録する。 */
export function markAshiatoOpened(id: string, openedAt: number = Date.now()): Promise<void> {
  return updateAshiatoRecord(id, { openedAt });
}

/**
 * 「検索キャッシュを消す」で呼ぶ。まだ発見していない(unlockedAtが無い)レコードと
 * カーソル(検索位置)だけを消す。「あつめたあしあと」(unlockedAtがあるレコード)は
 * ここでは一切消さない。全host・全tag対象。
 */
export async function clearSearchCache(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction(["ashiatoCache", "cursors"], "readwrite");
      const store = t.objectStore("ashiatoCache");
      const req = store.getAll();
      req.onsuccess = () => {
        for (const r of (req.result ?? []) as AshiatoRecord[]) {
          if (!r.unlockedAt) store.delete(r.id);
        }
      };
      t.objectStore("cursors").clear();
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch (error) {
    console.warn("cache: clearSearchCache failed:", error);
  }
}

/**
 * 「あつめたあしあと」一覧でチェックして選んだレコードだけを、
 * 「まだ発見していない(ロック中)」状態に戻す(unlockedAt/openedAtをnullに戻す)。
 * レコード自体は削除しない — 削除すると、そのノートのIDが既にカーソル
 * (oldestSeenNoteId/newestSeenNoteId)の走査済み範囲に埋もれてしまい、
 * 「過去を探す」「最新を確認」のいずれでも二度と再取得できなくなる
 * (=現地に行っても二度と再発見できなくなる)ため。
 * unlockedAtが無い(まだ発見していない)idが混ざっていても無視する。
 * カーソル(検索位置)はそのまま変更しない。全host・全tag対象。
 *
 * @param ids 「あつめたあしあと」一覧でチェックされたレコードidの配列
 */
export async function clearCollectedAshiatoByIds(ids: string[]): Promise<void> {
  if (!ids || ids.length === 0) return;
  const idSet = new Set(ids);

  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("ashiatoCache", "readwrite");
      const store = t.objectStore("ashiatoCache");

      for (const id of idSet) {
        const getReq = store.get(id);
        getReq.onsuccess = () => {
          const existing: AshiatoRecord | undefined = getReq.result;
          if (existing && existing.unlockedAt) {
            store.put({ ...existing, unlockedAt: null, openedAt: null });
          }
        };
      }

      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch (error) {
    console.warn("cache: clearCollectedAshiatoByIds failed:", error);
  }
}

// --- 投稿機能の下書き ---------------------------------------------------
// 「認証不要・共有フォーム経由で投稿」という方針のため、下書きはあくまで
// 「あとで共有フォームを開くための材料(緯度経度・精度)」を保持するだけで、
// 投稿が実際に成功したかどうかはAshi@側では検知できない
// (削除はユーザーが手動で行う想定)。

/**
 * @param geohashLength 精度(あとから変更可能)
 * @param municipalityLabel 下書き作成時に1回だけ確定させる場所ラベル
 *   (municipalityLookup.jsで取得。見つからなければnull=呼び出し側で
 *   「@緯度, 経度」表示にフォールバックする)
 */
export function makeDraft(
  lat: number,
  lon: number,
  geohashLength: GeohashLength,
  municipalityLabel: string | null,
): Draft {
  return {
    id: `draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(), // 精度をあとから変更しても更新しない(30分ルールの起点)
    lat,
    lon,
    geohashLength,
    municipalityLabel,
  };
}

export async function putDraft(draft: Draft): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("drafts", "readwrite");
      t.objectStore("drafts").put(draft);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch (error) {
    console.warn("cache: putDraft failed:", error);
  }
}

/** 新しい順(作成が新しいものが先)で下書き一覧を返す。 */
export async function getDrafts(): Promise<Draft[]> {
  try {
    const db = await openDb();
    const all: Draft[] = await new Promise((resolve, reject) => {
      const t = db.transaction("drafts", "readonly");
      const req = t.objectStore("drafts").getAll();
      req.onsuccess = () => resolve(req.result ?? []);
      req.onerror = () => reject(req.error);
    });
    return all.sort((a, b) => b.createdAt - a.createdAt);
  } catch (error) {
    console.warn("cache: getDrafts failed:", error);
    return [];
  }
}

export async function deleteDraft(id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("drafts", "readwrite");
      t.objectStore("drafts").delete(id);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch (error) {
    console.warn(`cache: deleteDraft(${id}) failed:`, error);
  }
}

/**
 * 下書きの精度だけを後から変更する(get→マージ→put)。
 * createdAtは変更しない(30分ルールの起点を精度変更で動かさないため)。
 */
export async function updateDraftPrecision(id: string, geohashLength: GeohashLength): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("drafts", "readwrite");
      const store = t.objectStore("drafts");
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const existing: Draft | undefined = getReq.result;
        if (!existing) return; // 削除済み等。黙って無視する
        store.put({ ...existing, geohashLength });
      };
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch (error) {
    console.warn(`cache: updateDraftPrecision(${id}) failed:`, error);
  }
}

// --- カスタム絵文字画像のキャッシュ -------------------------------------
// あつめたあしあと一覧・ポップアップの本文プレビューでカスタム絵文字を表示する際、
// 同じ絵文字画像を毎回ネットワークから取り直さないようにするためのBlobキャッシュ。
// URLをキーにするだけの単純なストアで、TTLは設けていない。

export async function getEmojiImageBlob(url: string): Promise<Blob | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const t = db.transaction("emojiImages", "readonly");
      const req = t.objectStore("emojiImages").get(url);
      req.onsuccess = () => resolve(req.result?.blob ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.warn(`cache: getEmojiImageBlob(${url}) failed:`, error);
    return null;
  }
}

export async function putEmojiImageBlob(url: string, blob: Blob): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("emojiImages", "readwrite");
      t.objectStore("emojiImages").put({ url, blob, cachedAt: Date.now() });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch (error) {
    console.warn(`cache: putEmojiImageBlob(${url}) failed:`, error);
  }
}

// --- 設定値(インスタンスURL、地図の表示位置など) ---------------------------
// ashiatoCache/cursorsと違い、TTLで期限切れにはしない。プライバシー上保持
// したくない投稿由来の情報ではなく、単なるアプリの利用状況・好みの記録なため。
// 検索キャッシュ・あつめたあしあとのどちらの削除の対象にも含めていない
// (削除したいだけのユーザーが、意図せずインスタンス設定や地図の表示位置まで
// 失ってしまうのを避けるため)。

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const t = db.transaction("settings", "readonly");
      const req = t.objectStore("settings").get(key);
      req.onsuccess = () => resolve(req.result?.value ?? null);
      req.onerror = () => reject(req.error);
    });
  } catch (error) {
    console.warn(`cache: getSetting(${key}) failed:`, error);
    return null;
  }
}

export async function putSetting(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const t = db.transaction("settings", "readwrite");
      t.objectStore("settings").put({ key, value });
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  } catch (error) {
    console.warn(`cache: putSetting(${key}) failed:`, error);
  }
}
