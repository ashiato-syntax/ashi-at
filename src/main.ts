import {
  searchNotesByTag,
  normalizeInstanceUrl,
  buildShareUrl,
  fetchEmojiMap,
  type MisskeyNote,
} from "./misskey.js";
import { parseText, extractCandidates, buildMinimalCandidate } from "./parser.js";
import { parse as parseMfm, type MfmNode } from "mfm-js";
import {
  createMap,
  addAshiatoGroup,
  removeAshiatoGroup,
  setAshiatoState,
  loadPrefectureBoundaries,
  loadMunicipalityBoundaries,
  createCurrentLocationLayer,
  createAreaOverlay,
  createPrecisionPreviewLayer,
  ashiatoColor,
  type MunicipalityBoundaryResult,
} from "./map.js";
import {
  decodeGeohash,
  encodeGeohash,
  geohashCellSizeMeters,
  isInsideGeohashCell,
} from "./geohash.js";
import {
  buildPrefectureIndex,
  findPrefecturesInView,
  type PrefectureIndexEntry,
} from "./prefectureIndex.js";
import { lookupMunicipality } from "./municipalityLookup.js";
import {
  makeRecord,
  getCursor,
  putCursor,
  getAshiatoRecords,
  putAshiatoRecords,
  pruneCache,
  clearSearchCache,
  clearCollectedAshiatoByIds,
  markAshiatoUnlocked,
  markAshiatoOpened,
  getSetting,
  putSetting,
  makeDraft,
  putDraft,
  getDrafts,
  deleteDraft,
  updateDraftPrecision,
  getEmojiImageBlob,
  putEmojiImageBlob,
} from "./cache.js";
import L from "leaflet";
import type { AshiatoRecord, AshiatoCell, Draft, Cursor, GeohashLength } from "./types.js";

// これよりズームしたら、都道府県名ラベルを表示
const MIN_ZOOM_FOR_PREFECTURE_LABELS = 7;
// これよりズームしたら、当該都道府県の市区町村GeoJsonを読み込む
const MIN_ZOOM_FOR_MUNICIPALITIES = 9;
// これよりズームしたら、市区町村名ラベルを表示
const MIN_ZOOM_FOR_MUNICIPALITY_LABELS = 11;

// 固定タグ。将来複数タグに対応するなら cache.js のhostTagキーはそのまま使い回せる。
const TAG = "Ashiato";
const PAGE_SIZE = 30;

// Ashi@で扱うgeohashの桁数(精度)。これ以外の精度の「あしあと」は対象外として無視する
// (地図表示にも「あつめたあしあと」にも一切出さない)。
const MIN_GEOHASH_LENGTH = 5;
const MAX_GEOHASH_LENGTH = 7;

// 投稿からこの時間が経過するまでは、その「あしあと」を発見判定の対象にしない
// (セルにすら登録しないので、現在地判定も一切かからない)。
// PENDING_PROMOTION_INTERVAL_MSごとに保留分を再チェックし、経過後は
// 手動で「探す」し直さなくても自動的に対象へ昇格する。
// NOTE: デバッグ用に一時的に0にしている(本来は30分)。本番前に戻すこと。
const MIN_NOTE_AGE_MS = 60 * 30 * 1000; // 30分
const PENDING_PROMOTION_INTERVAL_MS = 60 * 1000; // 1分ごとに再チェック

// 投稿機能: 精度「約150m」(Geohash7桁)の下書きは、プライバシー配慮のため
// 作成からこの時間が経過するまで投稿できないようにする。
const DRAFT_HIGH_PRECISION_DELAY_MS = 30 * 60 * 1000; // 30分

const PRECISION_LABELS: Record<GeohashLength, string> = { 5: "約4km", 6: "約1km", 7: "約150m" };

// 「あつめたあしあと」一覧・ポップアップに表示する本文プレビューの
// 安全弁としての最大文字数。表示上の省略はCSS(.mfm-preview)での高さクリップ
// +「続きを表示」ヒントで行うため、通常はここで切り詰められることはない
// (Misskeyの標準的な投稿文字数上限を大きく超えるような極端なケースにのみ働く、
// 文字数で機械的に切ると:name:のようなMFM記法の途中で千切れる恐れがあるため)。
const TEXT_PREVIEW_SAFETY_CAP_LENGTH = 3000;

// デバッグ用: trueにすると、未発見(ロック中)のAshiatoも地図に表示する。
// GPSによる発見判定や「集めたあしあと」一覧の仕様は変えない。本番ではfalse。
const SHOW_LOCKED_ASHIATO_FOR_DEBUG = false;

function isSupportedGeohashLength(geohash: string): boolean {
  return (
    geohash.length >= MIN_GEOHASH_LENGTH &&
    geohash.length <= MAX_GEOHASH_LENGTH
  );
}

// noteCreatedAtが無い/不正な場合は、安全側に倒して「まだ扱わない」扱いにする
function isOldEnough(noteCreatedAt: string | null): boolean {
  if (!noteCreatedAt) return false;
  const postedAt = new Date(noteCreatedAt).getTime();
  if (Number.isNaN(postedAt)) return false;
  return Date.now() - postedAt >= MIN_NOTE_AGE_MS;
}

const $ = <T extends Element = HTMLElement>(s: string): T => document.querySelector<T>(s)!,
  map = createMap("map"),
  areaOverlay = createAreaOverlay(map),
  precisionPreview = createPrecisionPreviewLayer(map),
  statusToast = $("#statusToast"),
  statusText = $("#statusText"),
  statusCloseBtn = $<HTMLButtonElement>("#statusClose"),
  precisionWarning = $("#precisionWarning"),
  unlockedList = $("#unlockedList"),
  unlockedSortModeSelect = $<HTMLSelectElement>("#unlockedSortMode");

// 地図の表示位置(中心緯度経度・ズーム)をTTL無しで保存しておき、次回起動時に
// 復元する(復元自体は起動処理の中でsetView()する形で行う。createMap()の
// デフォルト位置で一瞬描画されてから復元位置へ飛ぶが、体感できるほどの
// 遅延ではないため許容している)。
// moveendは操作の区切り(ドラッグ終了・ズーム完了)でまとめて発火するので、
// 追加のデバウンスなしでもIndexedDBへの書き込み頻度は十分少ない。
map.on("moveend", () => {
  const center = map.getCenter();
  putSetting("mapView", { lat: center.lat, lon: center.lng, zoom: map.getZoom() });
});

let prefectureIndex: PrefectureIndexEntry[] = [];
let prefectureLabelLayer: L.LayerGroup | null = null;
let prefectureLabelsVisible = false;

const municipalityLayers = new Map<string, "loading" | MunicipalityBoundaryResult>();
let municipalitiesVisible = false;
let municipalityLabelsVisible = false;

// ページング/キャッシュ用の状態。host(インスタンスのorigin)ごとに区画が分かれる。
let currentHost: string | null = null;
let cursor: Cursor | null = null;

// 同じgeohash(=同じ発見判定エリア)を持つAshiatoは、地図上では1グループとして
// まとめて表示する(桁数の短いgeohashだと複数レコードが同じセルに乗ることがあり、
// レコードごとに描画するとマーカーが完全に重なってタップ不能になるため)。
// geohash文字列 -> { geohash, records: Map<id, record>, visualLayers, hitArea, geohashLength, color }
// ロック中(未発見)のレコードもrecordsには保持する(GPS判定に必要)が、
// 発見済みが1件も無い間はvisualLayers/hitArea/colorはnullのまま(=地図に描画しない)。
const ashiatoCells = new Map<string, AshiatoCell>();

// geohashの桁数条件は満たすが、投稿からまだMIN_NOTE_AGE_MS経っていないレコード。
// promoteAgedRecords()が定期的にチェックし、条件を満たしたらashiatoCellsへ昇格させる。
const pendingRecords = new Map<string, AshiatoRecord>();

const currentLocationLayer = createCurrentLocationLayer(map);
let watchId: number | null = null;
let gpsEnabled = false;

const STATUS_AUTO_HIDE_MS = 3500;
const ERROR_AUTO_HIDE_MS = 6000; // エラーも時間経過で自動的に消す(内容確認の猶予として少し長め)
let statusHideTimer: ReturnType<typeof setTimeout> | undefined;

// 通常メッセージ・エラーメッセージいずれも、一定時間で自動的に消える
// (地図の面積を占有し続けないように)。エラーは見落とし防止のため
// ×ボタンでも明示的に閉じられるが、自動消去自体は行う。
function setStatus(t: string, e = false): void {
  clearTimeout(statusHideTimer);
  statusText.textContent = t;
  statusToast.classList.toggle("error", e);
  statusToast.hidden = false;
  statusCloseBtn.hidden = !e;

  statusHideTimer = setTimeout(
    () => {
      statusToast.hidden = true;
    },
    e ? ERROR_AUTO_HIDE_MS : STATUS_AUTO_HIDE_MS,
  );
}

statusCloseBtn.onclick = () => {
  clearTimeout(statusHideTimer);
  statusToast.hidden = true;
};

// --- alert/confirmの代替ダイアログ -----------------------------------------
// ネイティブのalert()/confirm()は他のUIと見た目が揃わないため、既存のdialog群と
// 同じ見た目のダイアログで代替する。showConfirmはPromise<boolean>を返し、
// OKボタンなら true、キャンセル/ESC/外側クリックならすべて false になる。

const infoDialog = $<HTMLDialogElement>("#infoDialog");
const infoMessage = $("#infoMessage");
const infoOkBtn = $<HTMLButtonElement>("#infoOk");

function showInfo(message: string): void {
  infoMessage.textContent = message;
  infoDialog.showModal();
}
void showInfo; // 現状未使用だが、alert()代替の共通部品として残しておく

infoOkBtn.onclick = () => infoDialog.close();

infoDialog.addEventListener("click", (e) => {
  const rect = infoDialog.getBoundingClientRect();
  const inside =
    rect.top <= e.clientY &&
    e.clientY <= rect.top + rect.height &&
    rect.left <= e.clientX &&
    e.clientX <= rect.left + rect.width;
  if (!inside) infoDialog.close();
});

const confirmDialog = $<HTMLDialogElement>("#confirmDialog");
const confirmMessage = $("#confirmMessage");
const confirmOkBtn = $<HTMLButtonElement>("#confirmOk");
const confirmCancelBtn = $<HTMLButtonElement>("#confirmCancel");

function showConfirm(
  message: string,
  { okLabel = "OK", cancelLabel = "キャンセル" }: { okLabel?: string; cancelLabel?: string } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    confirmMessage.textContent = message;
    confirmOkBtn.textContent = okLabel;
    confirmCancelBtn.textContent = cancelLabel;

    // resultは「OKが押されたか」を保持するだけの変数。close()の実行順に
    // 依存しないよう、close()を呼ぶ前に必ずresultを確定させてから閉じる。
    let result = false;

    const handleOk = () => {
      result = true;
      confirmDialog.close();
    };
    const handleCancel = () => {
      result = false;
      confirmDialog.close();
    };
    // ESCキー/外側クリックによるネイティブcloseも含め、閉じたタイミングで
    // 一度だけresultを読み取ってPromiseを解決する。
    const handleClose = () => {
      confirmOkBtn.removeEventListener("click", handleOk);
      confirmCancelBtn.removeEventListener("click", handleCancel);
      confirmDialog.removeEventListener("close", handleClose);
      resolve(result);
    };

    confirmOkBtn.addEventListener("click", handleOk);
    confirmCancelBtn.addEventListener("click", handleCancel);
    confirmDialog.addEventListener("close", handleClose);

    confirmDialog.showModal();
  });
}

confirmDialog.addEventListener("click", (e) => {
  const rect = confirmDialog.getBoundingClientRect();
  const inside =
    rect.top <= e.clientY &&
    e.clientY <= rect.top + rect.height &&
    rect.left <= e.clientX &&
    e.clientX <= rect.left + rect.width;
  if (!inside) confirmDialog.close(); // キャンセル扱い(resultはfalseのまま)
});

async function initBoundaries(): Promise<void> {
  try {
    const { data: prefectureData, labelLayer } =
      await loadPrefectureBoundaries(map);
    prefectureIndex = buildPrefectureIndex(prefectureData);
    prefectureLabelLayer = labelLayer;
    syncLabelVisibility();
    await syncMunicipalityLayers();
    map.on("moveend", () => {
      syncLabelVisibility();
      syncMunicipalityLayers();
    });
  } catch (error) {
    console.error(error);
    setStatus("地図境界の読み込みに失敗しました。", true);
  }
}

function syncLabelVisibility(): void {
  const zoom = map.getZoom();

  const wantPrefLabels = zoom >= MIN_ZOOM_FOR_PREFECTURE_LABELS;
  if (wantPrefLabels !== prefectureLabelsVisible && prefectureLabelLayer) {
    if (wantPrefLabels) prefectureLabelLayer.addTo(map);
    else map.removeLayer(prefectureLabelLayer);
    prefectureLabelsVisible = wantPrefLabels;
  }

  const wantMunicipalityLabels = zoom >= MIN_ZOOM_FOR_MUNICIPALITY_LABELS;
  if (wantMunicipalityLabels !== municipalityLabelsVisible) {
    for (const entry of municipalityLayers.values()) {
      if (entry === "loading") continue;
      if (wantMunicipalityLabels) entry.labelLayer.addTo(map);
      else map.removeLayer(entry.labelLayer);
    }
    municipalityLabelsVisible = wantMunicipalityLabels;
  }
}

async function syncMunicipalityLayers(): Promise<void> {
  if (map.getZoom() < MIN_ZOOM_FOR_MUNICIPALITIES) {
    if (municipalitiesVisible) {
      for (const entry of municipalityLayers.values()) {
        if (entry === "loading") continue;
        map.removeLayer(entry.boundaryLayer);
        map.removeLayer(entry.labelLayer);
      }
      municipalitiesVisible = false;
    }
    return;
  }

  if (!municipalitiesVisible) {
    // ズームが閾値を超えた場合は、市区町村境界を読み込み表示するが、
    // 既に読み込み済みであればそちらを再利用する
    for (const entry of municipalityLayers.values()) {
      if (entry === "loading") continue;
      entry.boundaryLayer.addTo(map);
      if (municipalityLabelsVisible) entry.labelLayer.addTo(map);
    }
    municipalitiesVisible = true;
  }

  const b = map.getBounds();
  const viewRect = {
    minLat: b.getSouth(),
    maxLat: b.getNorth(),
    minLon: b.getWest(),
    maxLon: b.getEast(),
  };
  const needed = findPrefecturesInView(prefectureIndex, viewRect);

  for (const pref of needed) {
    if (municipalityLayers.has(pref.code)) continue; // 読み込み済み or 読み込み中

    municipalityLayers.set(pref.code, "loading");
    try {
      const entry = await loadMunicipalityBoundaries(map, pref.code);
      if (municipalityLabelsVisible) entry.labelLayer.addTo(map);
      municipalityLayers.set(pref.code, entry);
    } catch (error) {
      console.error(`市区町村境界の読み込みに失敗(${pref.name}):`, error);
      municipalityLayers.delete(pref.code); // 後の moveend で再試行
    }
  }
}

initBoundaries();

// --- Ashiatoのページング + ローカルキャッシュ ---------------------------

// セル内の「表示対象(発見済み)」レコードから、セル全体としての表示状態を決める。
// 「全部openedにならない限りグレーにしない」という方針のため、1件でも
// 未開封が残っていればunlocked(緑/黄/赤)のまま。呼び出し側は発見済みレコードの
// 配列だけを渡すこと(ロック中のレコードはそもそも表示対象ではないため考慮不要)。
function computeCellState(visibleRecords: AshiatoRecord[]): "opened" | "unlocked" {
  return visibleRecords.length > 0 && visibleRecords.every((r) => r.openedAt)
    ? "opened"
    : "unlocked";
}

// geohash1件分の判定エリアサイズを、案内文の断片として作る
function cellSizeText(geohash: string): string {
  const { widthM, heightM } = geohashCellSizeMeters(geohash);
  return `当たり判定エリアサイズ:\n(東西 ${Math.round(widthM)}m, 南北 ${Math.round(heightM)}m)`;
}

// ISO文字列 / epoch(ms) どちらも受け取れる日付フォーマッタ。値が無い/不正なら null。
function formatDate(value: string | number | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

// 日付+時刻(分単位)まで含むフォーマッタ。「過去を探す」の到達地点表示や
// 下書きの作成日時表示に使う。値が無い/不正なら null。
function formatDateTime(value: string | number | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Ashiato Syntax(canonical)の代わりに一覧・ポップアップに表示するテキスト。
// 投稿日・発見日(当たり判定になった日 = unlockedAt)を表示する。
// ここに載るレコードは一覧・ポップアップいずれも発見済み(unlockedAtあり)のみが対象。
function recordDatesText(record: AshiatoRecord): string {
  const posted = formatDate(record.noteCreatedAt) ?? "不明";
  const discovered = formatDate(record.unlockedAt) ?? "不明";
  return `投稿 ${posted}, 発見 ${discovered}`;
}

// 投稿者のラベルを「{表示名} @{アカウント名}@{投稿元インスタンス}」の形式で組み立てる。
// 表示名(note.user.name)を設定していないユーザーもいるため、その場合は
// 「@アカウント名@インスタンス」のみになる。usernameそのものが無い
// (通常は起こらないはずだが念のため)場合は不明ユーザー扱いにする。
// ホストはemojiHost(投稿元インスタンスのorigin。無ければ検索に使ったhost)から導出する。
function formatUserLabel(record: AshiatoRecord): string {
  if (!record.username) return "(不明なユーザー)";
  const host = (record.emojiHost ?? record.host).replace(/^https?:\/\//, "");
  const handle = `@${record.username}@${host}`;
  return record.displayName ? `${record.displayName} ${handle}` : handle;
}

// --- 本文プレビュー中のカスタム絵文字描画 ---------------------------------
// textPreview(MFMをプレーンテキスト化したもの)には、カスタム絵文字が
// 「:name:」という記法のまま残っている(mfmNodeToPlainText参照)。
// ポップアップ・あつめたあしあと一覧の2箇所だけ、record.emojiHost(投稿元インスタンス)
// のmisskey.js:fetchEmojiMapを使ってshortcode→画像URLを解決し、実際の画像に置き換えて
// 表示する(note.emojisは最近のMisskeyでは空のことが多く当てにできないため使わない)。
// 下書き一覧はユーザーが本文を入力する欄自体が無いため対象外。

const EMOJI_SHORTCODE_RE = /:([0-9a-zA-Z_+-]+):/g;

// 画像取得結果(Object URL)のセッション内メモリキャッシュ。キーは`${emojiHost}::${name}`
// (同じshortcodeでもインスタンスが違えば別の絵文字になりうるため、hostも含めて区別する)。
// IndexedDB(cache.js)側は「ネットワーク再取得を避ける」ための永続キャッシュ、
// こちらは「同じセッション中に何度もcreateObjectURLし直さない」ための即席キャッシュ。
const emojiObjectUrlCache = new Map<string, string | null>(); // "host::name" -> objectURL | null(取得失敗)

// shortcode(name)を、そのカスタム絵文字の投稿元インスタンス(emojiHost)に問い合わせて
// 画像URLへ解決し、Blobをcache.js経由でキャッシュした上でObject URLを返す。
// emojiHostのインスタンスにその名前の絵文字が無い(=ローカルの通常絵文字や、
// 既に削除された絵文字など)場合はnullを返し、呼び出し側でテキストへフォールバックする。
async function resolveEmojiImageUrl(emojiHost: string, name: string): Promise<string | null> {
  const cacheKey = `${emojiHost}::${name}`;
  if (emojiObjectUrlCache.has(cacheKey)) return emojiObjectUrlCache.get(cacheKey)!;

  try {
    const emojiMap = await fetchEmojiMap(emojiHost);
    const url = emojiMap.get(name);
    if (!url) throw new Error(`絵文字が見つかりません: ${name}@${emojiHost}`);

    let blob = await getEmojiImageBlob(url);
    if (!blob) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`絵文字画像の取得に失敗: HTTP ${res.status}`);
      blob = await res.blob();
      await putEmojiImageBlob(url, blob); // 次回以降はネットワーク取得しない
    }
    const objectUrl = URL.createObjectURL(blob);
    emojiObjectUrlCache.set(cacheKey, objectUrl);
    return objectUrl;
  } catch (error) {
    console.warn(`main: カスタム絵文字画像の取得に失敗(${cacheKey}):`, error);
    emojiObjectUrlCache.set(cacheKey, null); // 失敗も覚えておき、同じセッション内で無駄な再取得をしない
    return null;
  }
}

// text中の「:name:」を、emojiHost(投稿元インスタンス)から解決した画像があれば<img>に、
// 無ければそのままのテキストとしてcontainerへ追加していく。画像の解決は非同期のため、
// 一旦プレースホルダーのimgを差し込んでおき、後から src を差し替える
// (取得に失敗した場合はテキストへフォールバックする)。
// onEmojiSettledは、各絵文字の解決(成功/失敗いずれか)が完了するたびに呼ばれる。
// 画像挿入によってcontainerの高さが変わりうるため、呼び出し側は「続きを表示」ヒントの
// 表示要否(applyPreviewOverflowChecks)を再計算するのに使う。
function appendTextWithEmojis(
  container: HTMLElement,
  text: string,
  emojiHost: string,
  onEmojiSettled?: () => void,
): void {
  let lastIndex = 0;
  EMOJI_SHORTCODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = EMOJI_SHORTCODE_RE.exec(text))) {
    if (m.index > lastIndex) {
      container.append(document.createTextNode(text.slice(lastIndex, m.index)));
    }

    const name = m[1];
    const img = document.createElement("img");
    img.className = "mfm-emoji-inline";
    img.alt = `:${name}:`;
    img.decoding = "async";
    container.append(img);

    resolveEmojiImageUrl(emojiHost, name).then((objectUrl) => {
      if (objectUrl) {
        img.src = objectUrl;
      } else if (img.isConnected) {
        img.replaceWith(document.createTextNode(`:${name}:`));
      }
      onEmojiSettled?.();
    });

    lastIndex = EMOJI_SHORTCODE_RE.lastIndex;
  }

  if (lastIndex < text.length) {
    container.append(document.createTextNode(text.slice(lastIndex)));
  }
}

// mfm-preview(本文プレビュー)が実際に高さでクリップされているかどうかを判定し、
// 直後のmfm-preview-hint(「続きを表示」)の表示/非表示を切り替える。
// 要素がまだ画面に表示されていない(閉じたdialog内・ポップアップ生成直後でDOM未接続 等)
// タイミングで呼んでも高さが正しく測れないため、実際に画面へ表示されたタイミング
// (dialogを開いた直後、ポップアップをopenOn()した直後)、および絵文字画像の非同期
// 読み込みで高さが変わりうるタイミング(appendTextWithEmojisのonEmojiSettled経由)で呼ぶ。
function applyPreviewOverflowChecks(root: ParentNode): void {
  for (const preview of root.querySelectorAll<HTMLElement>(".mfm-preview")) {
    const hint = preview.nextElementSibling as HTMLElement | null;
    if (!hint?.classList.contains("mfm-preview-hint")) continue;
    hint.hidden = preview.scrollHeight <= preview.clientHeight + 1;
  }
}

// あしあと1件分の「内容表示」部分(ユーザーラベル→本文プレビュー→日付)を組み立てる。
// あつめたあしあと一覧・マップ同一位置ポップアップで共通利用する。
// overflowRootは「続きを表示」ヒントの再計算対象(applyPreviewOverflowChecks)に渡すルート要素。
function renderAshiatoContent(
  container: HTMLElement,
  record: AshiatoRecord,
  overflowRoot: ParentNode,
): void {
  container.replaceChildren();
  container.append(document.createTextNode(formatUserLabel(record)));

  if (record.textPreview) {
    container.append(document.createTextNode("\n"));
    const preview = document.createElement("span");
    preview.className = "mfm-preview";
    const hint = document.createElement("span");
    hint.className = "mfm-preview-hint";
    hint.textContent = "続きを表示";
    hint.hidden = true;
    appendTextWithEmojis(
      preview,
      record.textPreview,
      record.emojiHost ?? record.host,
      () => applyPreviewOverflowChecks(overflowRoot),
    );
    container.append(preview, hint);
  }

  container.append(document.createTextNode(`\n${recordDatesText(record)}`));
}

// あしあと1件分の行を組み立てる(あつめたあしあと一覧・マップ同一位置ポップアップ共通)。
// 内容表示(非ボタン)+「開封」ボタン(+showInfoButton時は「詳細」ボタン)+未開封バッジで構成する。
// 行タップ自体では何も起きず、各ボタンだけがそれぞれのアクションを起動する。
function renderAshiatoRow(
  record: AshiatoRecord,
  overflowRoot: ParentNode,
  {
    showInfoButton,
    onOpen,
    onInfo,
  }: { showInfoButton: boolean; onOpen: () => void; onInfo?: () => void },
): HTMLElement {
  const row = document.createElement("div");
  row.className = "ashiato-row";

  const content = document.createElement("div");
  content.className = "ashiato-row-content";
  renderAshiatoContent(content, record, overflowRoot);

  const actions = document.createElement("div");
  actions.className = "ashiato-row-actions";

  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "ashiato-open-btn";
  openBtn.textContent = "開封";
  openBtn.onclick = onOpen;
  actions.append(openBtn);

  if (showInfoButton) {
    const infoBtn = document.createElement("button");
    infoBtn.type = "button";
    infoBtn.className = "ashiato-info-btn secondary";
    infoBtn.setAttribute("aria-label", "詳細情報");
    infoBtn.textContent = "ℹ";
    infoBtn.onclick = onInfo!;
    actions.append(infoBtn);
  }

  const badge = document.createElement("span");
  badge.className = "ashiato-unopened-badge";
  badge.textContent = "未開封";
  badge.hidden = !!record.openedAt;

  row.append(content, actions, badge);
  return row;
}

// セルの見た目(円)を、現在のrecords件数・状態に合わせて作り直す。
// ロック中(未発見)のレコードは地図上に一切表示しない方針のため、
// 表示対象は「発見済み(unlockedAtあり)」のレコードだけに絞る。
// 発見済みレコードが1件も無いセルは、円そのものを描画しない
// (GPS判定用の内部データとしてはcell.recordsに保持し続ける)。
function rebuildCellVisual(cell: AshiatoCell): void {
  if (cell.hitArea) removeAshiatoGroup(map, { visualLayers: cell.visualLayers!, hitArea: cell.hitArea });
  cell.visualLayers = null;
  cell.hitArea = null;
  cell.geohashLength = null;
  cell.color = null;

  const visibleRecords = [...cell.records.values()].filter(
    (r) => SHOW_LOCKED_ASHIATO_FOR_DEBUG || r.unlockedAt,
  );


  if (visibleRecords.length > 0) {
    const { visualLayers, hitArea, geohashLength } = addAshiatoGroup(
      map,
      cell.geohash,
      visibleRecords.length,
      () => handleCellClick(cell.geohash),
    );
    cell.visualLayers = visualLayers;
    cell.hitArea = hitArea;
    cell.geohashLength = geohashLength;

    const state = computeCellState(visibleRecords);
    setAshiatoState({ visualLayers, hitArea, geohashLength }, state);
    cell.color = ashiatoColor(state, geohashLength);
  }

  areaOverlay.refresh([...ashiatoCells.values()]);
}

// レコードを対応するセルに追加する。セルが無ければ新設する。
// 同じidのレコードが既にあれば何もしない(重複読み込み対策)。
function addRecordToCell(record: AshiatoRecord): void {
  let cell = ashiatoCells.get(record.geohash);
  if (!cell) {
    cell = { geohash: record.geohash, records: new Map(), visualLayers: null, hitArea: null, geohashLength: null, color: null };
    ashiatoCells.set(record.geohash, cell);
  }
  if (cell.records.has(record.id)) return;

  cell.records.set(record.id, record);
  rebuildCellVisual(cell);
}

// geohashの桁数条件は満たしているレコードを、状態に応じて登録する。
// - 既に発見済み(unlockedAt)、または投稿から1時間経過済み: 即座にセルへ登録する
//   (これ以降、現在地判定(GPS)の対象になる)
// - まだ1時間経っていない: pendingRecordsで保留する(セルには一切登録しない=
//   現在地判定も一切かからない)。promoteAgedRecords()が定期的に昇格させる。
function registerRecord(record: AshiatoRecord): void {
  if (record.unlockedAt || isOldEnough(record.noteCreatedAt)) {
    pendingRecords.delete(record.id);
    addRecordToCell(record);
  } else {
    pendingRecords.set(record.id, record);
  }
}

// 保留中のレコードを定期的に再チェックし、投稿から1時間経過したものを
// 自動的にセルへ昇格させる(ページを開きっぱなしでも、手動で「探す」し直す
// 必要が無いように)。
function promoteAgedRecords(): void {
  let promoted = false;
  for (const [id, record] of pendingRecords) {
    if (isOldEnough(record.noteCreatedAt)) {
      pendingRecords.delete(id);
      addRecordToCell(record);
      promoted = true;
    }
  }
  if (promoted && gpsEnabled) checkCurrentPositionAgainstCells();
}

setInterval(promoteAgedRecords, PENDING_PROMOTION_INTERVAL_MS);

// 「開封可能なAshiato」ダイアログの右上バッジ。未開封(unlockedAt はあるが
// openedAt が無い)のものが1件でもあれば表示する。
// ハンバーガーメニュー内に移動したので、メニューボタン自体にも同じ赤丸を出す。
function updateUnlockedBadge(unlockedRecords: AshiatoRecord[]): void {
  const hasUnopened = unlockedRecords.some((r) => !r.openedAt);
  $("#unlockedBadge").hidden = !hasUnopened;
  $("#menuBadge").hidden = !hasUnopened;
}

// 「あつめたあしあと」ダイアログの表示フィルター。true なら未開封のみ表示する。
let showOnlyUnopened = false;

// 「あつめたあしあと」一覧の並び順。"unlocked"=発見日順、"posted"=投稿日順。
// いずれも新しい方が上(降順固定)。起動時にsettingsから復元する(initSortMode参照)。
type UnlockedSortMode = "unlocked" | "posted";
let unlockedSortMode: UnlockedSortMode = "unlocked";

function sortKeyFor(record: AshiatoRecord, mode: UnlockedSortMode): number {
  if (mode === "posted") {
    const posted = record.noteCreatedAt ? new Date(record.noteCreatedAt).getTime() : NaN;
    return Number.isNaN(posted) ? 0 : posted;
  }
  return record.unlockedAt ?? 0;
}

// 「あつめたあしあと」一覧でチェックボックスにより選択されているレコードid。
// 一覧を再構築するたびに、表示から消えたid(フィルタで隠れた/削除済み等)は
// 自動的に選択解除する。
const selectedUnlockedIds = new Set<string>();

function updateDeleteButtonState(): void {
  $<HTMLButtonElement>("#deleteSelectedUnlocked").disabled = selectedUnlockedIds.size === 0;
}

// 「開封可能なAshiato」ダイアログの中身を、アンロック済みのものだけ・
// アンロックした順で再構築する。ロック中(未発見)のものはここには載せない。
// 開封済みかどうかはボタン文言とグレーアウトで示す。
// showOnlyUnopenedがtrueのときは、さらに未開封のものだけに絞り込んで表示する
// (バッジ・件数判定は絞り込み前の全件ベースのまま変えない)。
// 各行には削除対象選択用のチェックボックスも並べる(選択状態はselectedUnlockedIdsで管理)。
function refreshUnlockedList(): void {
  const unlocked = [...ashiatoCells.values()]
    .flatMap((cell) => [...cell.records.values()])
    .filter((r) => r.unlockedAt)
    .sort((a, b) => sortKeyFor(b, unlockedSortMode) - sortKeyFor(a, unlockedSortMode));

  updateUnlockedBadge(unlocked);

  const visible = showOnlyUnopened
    ? unlocked.filter((r) => !r.openedAt)
    : unlocked;

  // 表示から消えたレコードの選択は残さない
  const visibleIds = new Set(visible.map((r) => r.id));
  for (const id of [...selectedUnlockedIds]) {
    if (!visibleIds.has(id)) selectedUnlockedIds.delete(id);
  }
  updateDeleteButtonState();

  unlockedList.replaceChildren();

  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "unlocked-list-empty";
    empty.textContent =
      unlocked.length === 0
        ? "まだ発見したあしあとありません。"
        : "未開封のあしあとはありません。";
    unlockedList.append(empty);
    return;
  }

  for (const record of visible) {
    const li = document.createElement("li"),
      checkbox = document.createElement("input");

    checkbox.type = "checkbox";
    checkbox.className = "unlocked-list-checkbox";
    checkbox.setAttribute("aria-label", "削除対象として選択");
    checkbox.checked = selectedUnlockedIds.has(record.id);
    checkbox.onchange = () => {
      if (checkbox.checked) selectedUnlockedIds.add(record.id);
      else selectedUnlockedIds.delete(record.id);
      updateDeleteButtonState();
    };

    const row = renderAshiatoRow(record, unlockedList, {
      showInfoButton: true,
      onOpen: () => {
        unlockedListDialog.close();
        const cell = ashiatoCells.get(record.geohash);
        if (cell) handleAshiatoClick(record, cell);
      },
      onInfo: () => showAshiatoInfoPopup(record),
    });

    li.append(checkbox, row);
    unlockedList.append(li);
  }

  // このタイミングでdialogが開いていれば正しく測れる(閉じていれば後で
  // showModal()後に再度呼ばれて補正される。unlockedListToggleのonclick参照)。
  applyPreviewOverflowChecks(unlockedList);
}

// セルをクリックしたときの入口。
// ポップアップ等に出すのは発見済み(unlockedAt)のレコードのみ
// (ロック中のものは地図に表示していないため、そもそもクリックしようがない)。
// レコードが1件なら直接開封フローへ、複数件ならポップアップで一覧を出し、
// 選んだものだけ開封フローへ進む。
function handleCellClick(geohash: string): void {
  const cell = ashiatoCells.get(geohash);
  if (!cell) return;

  const records = [...cell.records.values()].filter((r) => r.unlockedAt);
  if (records.length === 0) return; // 通常は来ないはずだが念のため

  if (records.length === 1) {
    handleAshiatoClick(records[0], cell);
    return;
  }

  const { centerLat, centerLon } = decodeGeohash(geohash);
  const container = document.createElement("div");
  container.className = "ashiato-popup-list";

  for (const record of records) {
    const row = renderAshiatoRow(record, container, {
      showInfoButton: false,
      onOpen: () => {
        map.closePopup();
        handleAshiatoClick(record, cell);
      },
    });
    container.append(row);
  }

  // maxHeightを指定すると、件数が多い場合にLeafletがポップアップ内を
  // 自動でスクロール可能にしてくれる(popupPaneのzIndexは createMap 側で
  // Ashiato/現在地より前面に設定済み)。
  // ashiato-popup-list内のbuttonはwidth:100%指定のため、Leafletが
  // コンテンツの自然な幅(scrollWidth)を測ろうとしても常に小さい値に
  // つぶれてしまい、maxWidthだけでは広がらない(実際に描画される幅は
  // minWidthとの兼ね合いで決まる)。minWidthで下限を明示して確実に
  // 横幅を確保する。
  L.popup({ minWidth: 280, maxWidth: 320, maxHeight: 260 })
    .setLatLng([centerLat, centerLon])
    .setContent(container)
    .openOn(map);

  // openOn()でDOMに接続・表示された直後なので、ここで初めて高さが正しく測れる。
  applyPreviewOverflowChecks(container);
}

// 個別のAshiato1件に対する開封フロー。
// 地図/ポップアップ/一覧のいずれから呼ばれる場合も、対象は常に発見済み
// (unlockedAtがある)レコードのみ。開封済みでも再度リンクへ飛べるように、
// 常に確認ダイアログを出す。判定エリアサイズは案内文に含める。
async function handleAshiatoClick(record: AshiatoRecord, cell: AshiatoCell): Promise<void> {
  const sizeText = cellSizeText(record.geohash);
  const openedLabel = record.openedAt ? "(開封済み)" : "";

  const wantsToOpen = await showConfirm(
    `このあしあとを開封しますか？（投稿先のSNSを開きます）${openedLabel}\n\n投稿: ${formatDate(record.noteCreatedAt) ?? "不明"}\n\n${sizeText}`,
    { okLabel: "開封する" },
  );
  if (!wantsToOpen) return;

  window.open(`${record.host}/notes/${record.noteId}`, "_blank", "noopener");

  if (!record.openedAt) {
    const openedAt = Date.now();
    await markAshiatoOpened(record.id, openedAt);
    record.openedAt = openedAt;

    const visibleRecords = [...cell.records.values()].filter((r) => r.unlockedAt);
    const state = computeCellState(visibleRecords);
    setAshiatoState(
      { visualLayers: cell.visualLayers!, hitArea: cell.hitArea!, geohashLength: cell.geohashLength! },
      state,
    );
    cell.color = ashiatoColor(state, cell.geohashLength!);
    areaOverlay.refresh([...ashiatoCells.values()]);

    refreshUnlockedList();
  }
}

// 「あつめたあしあと」一覧の「詳細」ボタンから呼ばれる。一覧ダイアログを閉じて
// 該当セルの位置へ地図を移動し、投稿者・投稿日・発見日・当たり判定サイズを
// 吹き出し(ポップアップ)で表示する。本文プレビューはここには出さない
// (一覧側で既に確認できるため)。
function showAshiatoInfoPopup(record: AshiatoRecord): void {
  unlockedListDialog.close();

  const { minLat, maxLat, minLon, maxLon, centerLat, centerLon } = decodeGeohash(record.geohash);
  map.fitBounds(
    [
      [minLat, minLon],
      [maxLat, maxLon],
    ],
    { maxZoom: 18, padding: [40, 40] },
  );

  const content = document.createElement("div");
  content.className = "dialog-message";
  content.textContent = [
    `投稿者: ${formatUserLabel(record)}`,
    `投稿日: ${formatDate(record.noteCreatedAt) ?? "不明"}`,
    `発見日: ${formatDate(record.unlockedAt) ?? "不明"}`,
    cellSizeText(record.geohash),
  ].join("\n");

  L.popup({ maxWidth: 260 }).setLatLng([centerLat, centerLon]).setContent(content).openOn(map);
}

// --- 現在地(GPS)によるAshiatoのアンロック判定 -----------------------------

const gpsToggleBtn = $<HTMLButtonElement>("#toggleGps");
const composeAshiatoMenuItem = $<HTMLButtonElement>("#composeAshiatoMenuItem");

// GPSトグルON中、直近で取得できた現在地。投稿UIを開くとき、既にこれが
// あれば新たな位置情報取得を待たずに即座に投稿UIを表示できる。
// GPSトグルOFFのときは常にnull(古い位置情報を使い回さないため)。
let lastKnownPosition: { lat: number; lon: number } | null = null;
// 直近の位置精度(半径, メートル)。GPSトグルOFF中は常にnull。
let lastKnownAccuracy: number | null = null;

// 位置精度がこの半径(メートル)を超えたら「精度が悪い」とみなす(直径200mより悪い = 半径100m超)。
// この状態では、あしあとの発見(当たり判定)・新規投稿・新規下書きを行わない
// (下書き済みのあしあとの投稿はisDraftPostableのルールのみに従い、ここでは制限しない)。
const BAD_ACCURACY_RADIUS_M = 100;

function isPrecisionBad(): boolean {
  return gpsEnabled && lastKnownAccuracy !== null && lastKnownAccuracy > BAD_ACCURACY_RADIUS_M;
}

function updatePrecisionWarning(): void {
  precisionWarning.hidden = !isPrecisionBad();
}

// GPSトグルON/OFF・位置精度いずれの変化でも、投稿メニュー項目(新規投稿・新規下書きの入口)の
// 有効/無効を再計算する。
function updateComposeAvailability(): void {
  composeAshiatoMenuItem.disabled = !gpsEnabled || isPrecisionBad();
}

// 起動時、そもそもGeolocation APIが無い端末なら見た目で分かるようにしておく
if (!("geolocation" in navigator)) {
  gpsToggleBtn.classList.add("unavailable");
  gpsToggleBtn.title = "この端末では位置情報が使えません";
}
// GPSトグルは初期状態でOFFなので、投稿メニュー項目も初期状態は無効。
composeAshiatoMenuItem.disabled = true;

function setGpsEnabled(enabled: boolean): void {
  if (enabled && !("geolocation" in navigator)) {
    setStatus("この端末では位置情報が使えません。", true);
    return;
  }

  gpsEnabled = enabled;
  gpsToggleBtn.setAttribute("aria-pressed", String(enabled));
  // 投稿UIは現在地が前提の機能のため、GPSトグルOFF中は投稿メニュー項目も無効化する。
  updateComposeAvailability();

  if (!enabled) {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    currentLocationLayer.hide();
    lastKnownPosition = null; // OFFにしたら古い位置情報は使い回さない
    lastKnownAccuracy = null;
    updatePrecisionWarning();
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    handlePositionUpdate,
    handlePositionError,
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  );
}

function handlePositionError(error: GeolocationPositionError): void {
  console.error(error);
  const messages: Record<number, string> = {
    1: "位置情報の利用が許可されていません。",
    2: "現在地を取得できませんでした。",
    3: "現在地の取得がタイムアウトしました。",
  };
  setStatus(messages[error.code] ?? "位置情報の取得に失敗しました。", true);
  // 権限拒否(1)、または取得不能(2: 端末側の位置情報サービスがOFFの場合もこのコードで
  // 返ってくることが多い)なら、トグルもOFFに戻す。Web Geolocation APIには
  // OS側の位置情報サービスON/OFFを直接判定する手段が無いため、これを代理シグナルとして使う。
  if (error.code === 1 || error.code === 2) setGpsEnabled(false);
}

// 現在地(lastKnownPosition)と全セルを突き合わせて、未発見のものを判定する。
// watchPositionのコールバック(位置そのものが変わった時)だけでなく、
// GPS ON中に新しいAshiatoを読み込んだ(=セル自体が増減した)時にも呼ぶ必要がある
// (「過去を探す」「最新を確認」、保留レコードの昇格など)。
// 位置精度が悪いとき(isPrecisionBad)は、誤発見を避けるため判定自体を行わない。
async function checkCurrentPositionAgainstCells(): Promise<void> {
  if (!lastKnownPosition || isPrecisionBad()) return;
  const { lat, lon } = lastKnownPosition;

  for (const cell of ashiatoCells.values()) {
    const locked = [...cell.records.values()].filter((r) => !r.unlockedAt);
    if (locked.length === 0) continue;
    if (!isInsideGeohashCell(lat, lon, cell.geohash)) continue;

    const unlockedAt = Date.now();
    for (const record of locked) {
      await markAshiatoUnlocked(record.id, unlockedAt);
      record.unlockedAt = unlockedAt;
    }
    rebuildCellVisual(cell); // 初めて発見された/丸の数が増えたケースに対応
    refreshUnlockedList();
  }
}

// 現在地が更新されるたびに呼ばれる。実際の判定はcheckCurrentPositionAgainstCellsに委譲する
// (「過去を探す」等でセル自体が増減したタイミングでも同じ判定を再利用できるようにするため)。
async function handlePositionUpdate(position: GeolocationPosition): Promise<void> {
  const { latitude, longitude, accuracy } = position.coords;
  lastKnownPosition = { lat: latitude, lon: longitude };
  lastKnownAccuracy = accuracy;
  currentLocationLayer.show(latitude, longitude, accuracy);
  updatePrecisionWarning();
  updateComposeAvailability();
  if (composeDialog.open) updateComposeButtons(); // 開いたまま精度が変化した場合に備える
  await checkCurrentPositionAgainstCells();
}

// --- 開封可能なAshiatoリスト(ダイアログ) ----------------------------------

const unlockedListDialog = $<HTMLDialogElement>("#unlockedListDialog");

$<HTMLButtonElement>("#unlockedListToggle").onclick = () => {
  closeMenu();
  unlockedListDialog.showModal();
  // refreshUnlockedList()が閉じた状態で呼ばれていた場合、高さが正しく
  // 測れず「続きを表示」ヒントの表示要否判定が不正確なことがあるため、
  // 実際に表示された直後に測り直す。
  applyPreviewOverflowChecks(unlockedListDialog);
};
$<HTMLButtonElement>("#unlockedListCloseX").onclick = () => unlockedListDialog.close();

$<HTMLInputElement>("#unopenedOnlyFilter").onchange = (e) => {
  showOnlyUnopened = (e.target as HTMLInputElement).checked;
  refreshUnlockedList();
};

unlockedSortModeSelect.onchange = () => {
  unlockedSortMode = unlockedSortModeSelect.value as UnlockedSortMode;
  putSetting("unlockedSortMode", unlockedSortMode);
  refreshUnlockedList();
};

// 「あつめたあしあと」一覧でチェックした分だけを選んで削除する
// (削除 = ロック中の状態に戻す。現地に行けば再度発見できる)。
// 廃止した「あつめたあしあとを消す」(全件対象)の代わりに、こちらは
// チェックボックスで選んだレコードだけを対象にする。
$<HTMLButtonElement>("#deleteSelectedUnlocked").onclick = async () => {
  if (selectedUnlockedIds.size === 0) return;

  const ids = [...selectedUnlockedIds];
  const wantsToDelete = await showConfirm(
    `選択した${ids.length}件のあしあとを削除しますか？(現地に行けば再度発見できます)`,
    { okLabel: "削除する" },
  );
  if (!wantsToDelete) return;

  await clearCollectedAshiatoByIds(ids);

  const idSet = new Set(ids);
  for (const cell of ashiatoCells.values()) {
    let changed = false;
    for (const record of cell.records.values()) {
      if (idSet.has(record.id) && record.unlockedAt) {
        record.unlockedAt = null;
        record.openedAt = null;
        changed = true;
      }
    }
    if (changed) rebuildCellVisual(cell); // ロック中に戻るので円は消える(セルは保持)
  }
  areaOverlay.refresh([...ashiatoCells.values()]);

  selectedUnlockedIds.clear();
  refreshUnlockedList();
  setStatus("選択したあしあとを削除しました。(現地に行けば再度発見できます)");
};

unlockedListDialog.addEventListener("click", (e) => {
  const rect = unlockedListDialog.getBoundingClientRect();
  const inside =
    rect.top <= e.clientY &&
    e.clientY <= rect.top + rect.height &&
    rect.left <= e.clientX &&
    e.clientX <= rect.left + rect.width;
  if (!inside) unlockedListDialog.close();
});

// --- 「エリア」トグル(Geohashセルの範囲描画) ------------------------------

const toggleAreaBtn = $<HTMLButtonElement>("#toggleArea");
let areaEnabled = false;

toggleAreaBtn.onclick = () => {
  areaEnabled = !areaEnabled;
  toggleAreaBtn.setAttribute("aria-pressed", String(areaEnabled));
  areaOverlay.setEnabled(areaEnabled);
};

// --- ハンバーガーメニュー(投稿ボタンを統合、画面下部・footprint型) -------

const menuToggle = $<HTMLButtonElement>("#menuToggle");
const menuDropdown = $("#menuDropdown");
const aboutDialog = $<HTMLDialogElement>("#aboutDialog");

function closeMenu(): void {
  menuDropdown.hidden = true;
  menuToggle.setAttribute("aria-expanded", "false");
}

menuToggle.onclick = (e) => {
  e.stopPropagation();
  const willOpen = menuDropdown.hidden;
  menuDropdown.hidden = !willOpen;
  menuToggle.setAttribute("aria-expanded", String(willOpen));
};

document.addEventListener("click", (e) => {
  if (!menuDropdown.hidden && !(e.target as Element).closest(".menu")) closeMenu();
});

$<HTMLButtonElement>("#aboutButton").onclick = () => {
  closeMenu();
  aboutDialog.showModal();
};
$<HTMLButtonElement>("#aboutClose").onclick = () => aboutDialog.close();

// ダイアログ外側(::backdrop)クリックでも閉じられるようにする
aboutDialog.addEventListener("click", (e) => {
  const rect = aboutDialog.getBoundingClientRect();
  const inside =
    rect.top <= e.clientY &&
    e.clientY <= rect.top + rect.height &&
    rect.left <= e.clientX &&
    e.clientX <= rect.left + rect.width;
  if (!inside) aboutDialog.close();
});

// --- インスタンス変更ダイアログ --------------------------------------------

const instanceDialog = $<HTMLDialogElement>("#instanceDialog");
const currentHostLabel = $("#currentHostLabel");

$<HTMLButtonElement>("#changeInstance").onclick = () => {
  closeMenu();
  instanceDialog.showModal();
};
$<HTMLButtonElement>("#instanceCancel").onclick = () => instanceDialog.close();

instanceDialog.addEventListener("click", (e) => {
  const rect = instanceDialog.getBoundingClientRect();
  const inside =
    rect.top <= e.clientY &&
    e.clientY <= rect.top + rect.height &&
    rect.left <= e.clientX &&
    e.clientX <= rect.left + rect.width;
  if (!inside) instanceDialog.close();
});

$<HTMLButtonElement>("#instanceApply").onclick = () => {
  instanceDialog.close();
  fetchOlder();
};

// インスタンス欄が変わったら、表示中のAshiatoを一旦クリアして、
// そのhost用のキャッシュ(あれば)を読み込み直す。
async function switchHost(host: string): Promise<number> {
  currentHost = host;
  currentHostLabel.textContent = `現在: ${host.replace(/^https?:\/\//, "")}`;
  putSetting("instanceUrl", host); // TTL無し。次回起動時のデフォルト接続先にする

  for (const cell of ashiatoCells.values()) {
    if (cell.hitArea) removeAshiatoGroup(map, { visualLayers: cell.visualLayers!, hitArea: cell.hitArea });
  }
  ashiatoCells.clear();
  pendingRecords.clear();
  areaOverlay.refresh([]);

  await pruneCache(host, TAG); // 読み込み前に期限切れ・上限超過分を掃除
  const cached = await getAshiatoRecords(host, TAG);
  // 古い順に並べておくと、ページングで足された分と混ざっても違和感がない
  cached.sort((a, b) => a.cachedAt - b.cachedAt);
  for (const record of cached) {
    if (!isSupportedGeohashLength(record.geohash)) continue; // 対象外の桁数は無視
    registerRecord(record);
  }
  refreshUnlockedList();

  cursor = await getCursor(host, TAG);

  setStatus(
    cached.length > 0
      ? `キャッシュから${cached.length}件のAshiatoを復元しました。`
      : "準備完了。",
  );

  return cached.length;
}

async function ensureHost(): Promise<string> {
  const host = normalizeInstanceUrl($<HTMLInputElement>("#instance").value);
  if (host !== currentHost) await switchHost(host);
  return host;
}

// --- 本文プレビュー(MFM) ------------------------------------------------
// 「あつめたあしあと」を開封する前でも、内容を少しだけ確認できるように、
// ノート本文の冒頭をプレビュー表示する。ノート本文そのもの(全文)は
// これまで通りキャッシュに保存しない方針を維持し、ここで作った短い
// プレビュー文字列だけを例外的にレコードへ持たせる。
// MFM(Misskey Flavored Markdown)の構文記号がそのまま見えると読みにくいため、
// misskey-dev/mfm.js でパースした上でプレーンテキスト化する
// (https://github.com/misskey-dev/mfm.js)。
// 表示上の省略(3行程度でクリップし「続きを表示」を出す)はCSS側(.mfm-preview)で
// 行うため、ここでは文字数による切り詰めはしない(TEXT_PREVIEW_SAFETY_CAP_LENGTH参照)。

// mfm.jsのASTノードを再帰的にたどり、装飾を取り除いた素のテキストへ変換する。
// 未知のノード種別は子ノードだけを連結するフォールバックにしておく
// (mfm.jsのバージョン差異で多少ノード種別が増減しても壊れにくいように)。
function mfmNodeToPlainText(node: MfmNode): string {
  switch (node.type) {
    case "text":
      return node.props.text;
    case "unicodeEmoji":
      return node.props.emoji;
    case "emojiCode":
      return `:${node.props.name}:`;
    case "mention":
      return node.props.acct ? `@${node.props.acct}` : "";
    case "hashtag":
      return `#${node.props.hashtag}`;
    case "url":
      return node.props.url;
    case "inlineCode":
      return node.props.code;
    case "mathInline":
      return node.props.formula;
    case "search":
      return node.props.query ?? "";
    default:
      // bold/italic/strike/small/center/quote/link/fn等、子ノードを持つものは
      // 子ノードのテキストだけを連結する(装飾記号自体は落とす)。
      return Array.isArray(node.children)
        ? mfmNodesToPlainText(node.children)
        : "";
  }
}

function mfmNodesToPlainText(nodes: MfmNode[]): string {
  return nodes.map(mfmNodeToPlainText).join("");
}

// ノート本文からAshiato Syntax候補(⟦...⟧)を取り除いた上でMFMをプレーン
// テキスト化する。表示上の省略はCSSでの高さクリップで行うため、ここでは
// TEXT_PREVIEW_SAFETY_CAP_LENGTHを超える極端なケースの安全弁としてのみ切り詰める
// (文字数で機械的に切ると:name:のようなMFM記法の途中で千切れる恐れがあるため)。
// 残りが空文字列になった場合はnull(プレビュー無し)を返す。
function extractPreviewText(noteText: string): string | null {
  let stripped = noteText;
  for (const candidate of extractCandidates(noteText)) {
    stripped = stripped.split(candidate).join("");
  }
  stripped = stripped.trim();
  if (!stripped) return null;

  let plain: string;
  try {
    plain = mfmNodesToPlainText(parseMfm(stripped));
  } catch (error) {
    console.warn("main: MFM解析に失敗。プレーンテキストのまま使用します:", error);
    plain = stripped;
  }

  plain = plain.replace(/\s+/g, " ").trim();
  if (!plain) return null;

  const chars = [...plain];
  return chars.length > TEXT_PREVIEW_SAFETY_CAP_LENGTH
    ? chars.slice(0, TEXT_PREVIEW_SAFETY_CAP_LENGTH).join("") + "…"
    : plain;
}

async function ingestNotes(host: string, notes: MisskeyNote[]): Promise<AshiatoRecord[]> {
  const records: AshiatoRecord[] = [];

  for (const note of notes) {
    // 削除済みノート、本文が無いノートは対象外
    if (!note?.text || note.deletedAt) continue;

    const preview = extractPreviewText(note.text);
    // カスタム絵文字・acct表示のホストはノートの投稿元インスタンスに属する
    // (フェデレーション対応)。note.user.hostがあればリモートユーザー
    // (=そのホストが投稿元インスタンス)、無ければローカルユーザー
    // (=host、つまり今検索しているインスタンス自身が投稿元)。
    const emojiHost = note.user?.host ? `https://${note.user.host}` : host;

    let idx = 0;
    for (const r of parseText(note.text)) {
      if (isSupportedGeohashLength(r.model.geohash)) {
        records.push(
          makeRecord(
            host,
            TAG,
            note.id,
            idx,
            r,
            note.createdAt ?? null,
            note.user?.username ?? null,
            preview,
            emojiHost,
            note.user?.name ?? null,
          ),
        );
      }
      idx++; // 対象外の桁数で弾いた分もidxは進める(ノート内位置とidの対応を崩さないため)
    }
  }

  await putAshiatoRecords(records);
  for (const record of records) registerRecord(record);

  // 「過去を探す」「最新を確認」でセルが新しく増えた場合、GPSが既にONで
  // その場から動いていない(=watchPositionが発火しない)状況でも、現在地がその
  // 新セル内に入っていれば即座に発見扱いにする。
  if (gpsEnabled) await checkCurrentPositionAgainstCells();

  return records;
}

// 過去方向(untilId): 「過去を探す」(初回・2回目以降とも同じボタン)
async function fetchOlder(): Promise<void> {
  const btn = $<HTMLButtonElement>("#search");
  btn.disabled = true;
  setStatus("Misskeyから検索中…");

  try {
    const host = await ensureHost();

    const notes = await searchNotesByTag(host, TAG, {
      limit: PAGE_SIZE,
      untilId: cursor?.oldestSeenNoteId,
    });

    await ingestNotes(host, notes);

    if (notes.length > 0) {
      const oldestId = notes[notes.length - 1].id;
      const newestId = cursor?.newestSeenNoteId ?? notes[0].id;
      cursor = { hostTag: `${host}::${TAG}`, host, tag: TAG, oldestSeenNoteId: oldestId, newestSeenNoteId: newestId };
      await putCursor(host, TAG, cursor);
    }

    if (notes.length > 0) {
      // 今回のレスポンスの中で一番古い投稿日時を、「どこまで過去を探索したか」の
      // 目安として表示する(ボタンの挙動を利用者に理解してもらうため)。
      const oldestCreatedAt = notes.reduce<string | null>((oldest, n) => {
        if (!n.createdAt) return oldest;
        return !oldest || new Date(n.createdAt) < new Date(oldest)
          ? n.createdAt
          : oldest;
      }, null);
      const oldestLabel = formatDateTime(oldestCreatedAt);

      setStatus(
        `${notes.length}件のノートを確認。表示中 ${ashiatoCells.size}箇所。` +
          (oldestLabel ? `${oldestLabel}まで探しました。` : ""),
      );
    } else {
      setStatus("これより古いAshiatoは見つかりませんでした。");
    }
  } catch (e) {
    console.error(e);
    setStatus((e as Error).message || "検索に失敗しました。", true);
  } finally {
    btn.disabled = false;
  }
}

// 最新方向(sinceId): 前回訪問後に増えた新着だけを取得。
// カーソルが無い(＝まだ一度も検索していない)状態でも呼べるようにし、
// その場合はfetchOlderにフォールバックする(「探す」ボタン廃止に伴う対応)。
async function fetchNewer(): Promise<void> {
  const btn = $<HTMLButtonElement>("#loadNewer");
  btn.disabled = true;
  setStatus("Misskeyから検索中…(最新)");

  try {
    const host = await ensureHost();
    if (!cursor) {
      await fetchOlder();
      return;
    }

    const notes = await searchNotesByTag(host, TAG, {
      limit: PAGE_SIZE,
      sinceId: cursor.newestSeenNoteId,
    });

    await ingestNotes(host, notes);

    if (notes.length > 0) {
      const newestId = notes[0].id;
      const oldestId = notes[notes.length - 1].id;
      // 中抜け対策: 今回取得したバッチの最古ノートで oldestSeenNoteId も進めておく。
      // これにより「過去を探す」の起点が必ずこのバッチの範囲を通過するようになり、
      // fetchNewer の limit 上限で取りこぼした区間が永久に未取得のまま残ることを防ぐ。
      // (直前に fetchOlder で取得済みの範囲を再要求することになる場合があるが、
      //  host::noteId::index で重複排除されるので実害はない)
      cursor = { hostTag: `${host}::${TAG}`, host, tag: TAG, newestSeenNoteId: newestId, oldestSeenNoteId: oldestId };
      await putCursor(host, TAG, cursor);
    }

    setStatus(
      notes.length > 0
        ? `新着${notes.length}件を確認。表示中 ${ashiatoCells.size}箇所。`
        : "新しいAshiatoはありませんでした。",
    );
  } catch (e) {
    console.error(e);
    setStatus((e as Error).message || "検索に失敗しました。", true);
  } finally {
    btn.disabled = false;
  }
}

// 「検索キャッシュを消す」。まだ発見していない(unlockedAtが無い)レコードと
// 保留中(pendingRecords)のレコード、カーソルだけを消す。
// 「あつめたあしあと」(発見済み)は地図上にもそのまま残す。
async function handleClearSearchCache(): Promise<void> {
  await clearSearchCache();
  pendingRecords.clear();

  for (const [geohash, cell] of [...ashiatoCells]) {
    for (const [id, record] of [...cell.records]) {
      if (!record.unlockedAt) cell.records.delete(id);
    }
    if (cell.records.size === 0) {
      if (cell.hitArea) removeAshiatoGroup(map, { visualLayers: cell.visualLayers!, hitArea: cell.hitArea });
      ashiatoCells.delete(geohash);
    } else {
      rebuildCellVisual(cell); // 残るのは発見済みだけなので、見た目は基本変わらない
    }
  }
  areaOverlay.refresh([...ashiatoCells.values()]);

  cursor = null;
  setStatus("検索キャッシュを消去しました。");
}

$<HTMLButtonElement>("#search").onclick = fetchOlder;
$<HTMLButtonElement>("#loadNewer").onclick = fetchNewer;
$<HTMLButtonElement>("#toggleGps").onclick = () => setGpsEnabled(!gpsEnabled);
$<HTMLButtonElement>("#clearSearchCache").onclick = async () => {
  closeMenu();
  const wantsToClear = await showConfirm(
    "検索キャッシュを削除しますか？(あつめたあしあとは残ります)",
    { okLabel: "削除する" },
  );
  if (!wantsToClear) return;
  await handleClearSearchCache();
};
$<HTMLInputElement>("#instance").onkeydown = (e) => {
  if (e.key === "Enter") {
    instanceDialog.close();
    fetchOlder();
  }
};

// --- 投稿機能(共有フォーム経由) ---------------------------------------
// Ashi@自身は投稿APIを一切呼ばない(認証不要・静的Webページというコンセプト
// のため)。Misskey Hubの共有フォーム中継(/share)を新規タブで開き、実際の
// 投稿操作はユーザーが普段使っているMisskeyインスタンス側で行ってもらう。
// そのためAshi@側では「投稿が実際に成功したか」を厳密には検知できないが、
// 下書きについては「投稿する」ボタン押下(=確認ダイアログでOKして共有
// フォームまで開いた)時点でその下書きを削除する(役目を終えたとみなす)。

const composeDialog = $<HTMLDialogElement>("#composeDialog");
const composePrecisionNote = $("#composePrecisionNote");
const draftListDialog = $<HTMLDialogElement>("#draftListDialog");
const draftList = $("#draftList");

let composePosition: { lat: number; lon: number } | null = null; // 投稿UI表示中のみ有効

function selectedPrecision(): GeohashLength {
  return Number(
    document.querySelector<HTMLInputElement>('input[name="precision"]:checked')!.value,
  ) as GeohashLength;
}

// 精度「約150m」(7桁)は、作成から30分経つまで投稿不可
// (下書きの精度をあとから変更しても、常にこの条件で都度再評価する)。
function isDraftPostable(draft: Draft): boolean {
  if (draft.geohashLength !== 7) return true;
  return Date.now() - draft.createdAt >= DRAFT_HIGH_PRECISION_DELAY_MS;
}

function updateComposeButtons(): void {
  const isHighPrecision = selectedPrecision() === 7;
  const precisionBad = isPrecisionBad();

  $<HTMLButtonElement>("#composePost").disabled = isHighPrecision || precisionBad;
  $<HTMLButtonElement>("#composeSaveDraft").disabled = precisionBad;

  composePrecisionNote.hidden = !isHighPrecision && !precisionBad;
  if (precisionBad) {
    composePrecisionNote.textContent =
      "現在地の精度が低いため、新規投稿・下書きの保存はできません。精度が改善してからお試しください。";
  } else if (isHighPrecision) {
    composePrecisionNote.textContent =
      "この精度はプライバシー保護のため直接投稿できません。いったん下書きに保存し、30分経過後に投稿してください。";
  }
}

function updateComposePreview(): void {
  if (!composePosition) return;
  const hash = precisionPreview.show(
    composePosition.lat,
    composePosition.lon,
    selectedPrecision(),
  );
  fitMapToComposeCell(hash);
}

// 投稿UI(下部シート)に隠れないよう、シートの高さぶんを下側の余白として
// 確保した上で、選択中の精度のセル全体が見えるように地図をフィットさせる。
// composeDialogがまだ開いていない(高さが取れない)場合は何もしない。
function fitMapToComposeCell(hash: string): void {
  const sheetHeight = composeDialog.getBoundingClientRect().height;
  if (sheetHeight === 0) return; // dialogがまだ表示されていない

  const b = decodeGeohash(hash);
  map.fitBounds(
    [
      [b.minLat, b.minLon],
      [b.maxLat, b.maxLon],
    ],
    {
      paddingTopLeft: [20, 20],
      paddingBottomRight: [20, sheetHeight + 20],
      maxZoom: 18,
    },
  );
}

document.querySelectorAll<HTMLInputElement>('input[name="precision"]').forEach((el) => {
  el.onchange = () => {
    updateComposePreview();
    updateComposeButtons();
  };
});

$<HTMLButtonElement>("#composeAshiatoMenuItem").onclick = () => {
  closeMenu();
  if (!gpsEnabled || isPrecisionBad()) return; // ボタン自体を無効化済みだが念のため

  // GPSトグルが既にONで現在地が分かっていれば、新たに取得し直さず即座に開く。
  if (lastKnownPosition) {
    composePosition = { ...lastKnownPosition };
    updateComposeButtons();
    composeDialog.show(); // 非モーダル: マップ操作(ドラッグ/ズーム/エリアトグル等)を妨げない
    updateComposePreview();
    return;
  }

  // ONにした直後などでまだ現在地が届いていない場合だけ、改めて取得する。
  setStatus("現在地を取得中…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      composePosition = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      updateComposeButtons();
      // dialogを開いてから高さを測ってfitBoundsする必要があるため、
      // show()を先に呼ぶ(まだ非表示の時点でupdateComposePreviewを
      // 呼ぶとcomposeDialogの高さが0になりfitMapToComposeCellが動かない)。
      composeDialog.show(); // 非モーダル
      updateComposePreview();
    },
    handlePositionError,
    { enableHighAccuracy: true, timeout: 15000 },
  );
};

$<HTMLButtonElement>("#composeCloseX").onclick = () => composeDialog.close();

// 非モーダル(show())にしたことで、showModal()標準の「Escapeで閉じる」挙動が
// 自動では効かなくなるため、他のダイアログとの一貫性のために手動で対応する。
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && composeDialog.open) composeDialog.close();
});

// 閉じ方(ボタン/Escapeいずれでも)に関わらず、プレビュー矩形は消す。
composeDialog.addEventListener("close", () => precisionPreview.hide());

// 投稿本文(Ashiato Syntax + #Ashiatoタグ)を組み立てる。
// 自由記述コメントはAshi@側では持たない(共有フォーム側で書けるため)。
function shareTextFor(lat: number, lon: number, geohashLength: GeohashLength): string {
  const geohash = encodeGeohash(lat, lon, geohashLength);
  return `${buildMinimalCandidate(geohash)} #Ashiato`;
}

$<HTMLButtonElement>("#composePost").onclick = async () => {
  if (!composePosition) return;

  const wantsToPost = await showConfirm(
    "現在地の情報を含んだ投稿フォームを開きます。内容は共有フォーム上で確認・編集できます。",
    { okLabel: "共有フォームを開く" },
  );
  if (!wantsToPost) return;

  const text = shareTextFor(composePosition.lat, composePosition.lon, selectedPrecision());
  window.open(buildShareUrl(text), "_blank", "noopener");
  composeDialog.close();
};

$<HTMLButtonElement>("#composeSaveDraft").onclick = async () => {
  if (!composePosition) return;

  const { lat, lon } = composePosition;
  const geohashLength = selectedPrecision();
  // Nominatim等の外部APIは使わず、既存の市区町村境界GeoJsonから逆引きする。
  // 見つからなければnull(下書きリスト側で「@緯度, 経度」表示にフォールバック)。
  const municipalityLabel = await lookupMunicipality(prefectureIndex, lat, lon).catch(
    () => null,
  );

  await putDraft(makeDraft(lat, lon, geohashLength, municipalityLabel));
  composeDialog.close();
  setStatus("下書きに保存しました。");
};

// --- 下書きリスト(ダイアログ) ------------------------------------------

async function refreshDraftList(): Promise<void> {
  const drafts = await getDrafts();
  draftList.replaceChildren();

  if (drafts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "unlocked-list-empty";
    empty.textContent = "下書きはありません。";
    draftList.append(empty);
    return;
  }

  for (const draft of drafts) {
    const li = document.createElement("li");

    const meta = document.createElement("p");
    meta.className = "draft-meta";
    const place =
      draft.municipalityLabel ?? `@${draft.lat.toFixed(4)}, ${draft.lon.toFixed(4)}`;
    meta.textContent = `${formatDateTime(draft.createdAt)} — ${place}`;

    // 精度はあとから変更できる(位置・作成時刻はそのまま)。
    const precisionSelect = document.createElement("select");
    for (const [value, label] of Object.entries(PRECISION_LABELS)) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      opt.selected = String(draft.geohashLength) === value;
      precisionSelect.append(opt);
    }

    const actions = document.createElement("div");
    actions.className = "draft-actions";

    const postBtn = document.createElement("button");
    postBtn.type = "button";
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "secondary";
    deleteBtn.textContent = "削除";

    // 残り時間は「下書きリストを開いた(=このリストを描画した)タイミング」で
    // 計算する。ダイアログを開いたままの秒単位カウントダウンはしない
    // (open中は既存のsetIntervalで1分ごとに再描画されるので、その都度更新される)。
    function renderPostButton() {
      const postable = isDraftPostable(draft);
      postBtn.disabled = !postable;
      if (postable) {
        postBtn.textContent = "投稿する";
      } else {
        const remainingMs =
          DRAFT_HIGH_PRECISION_DELAY_MS - (Date.now() - draft.createdAt);
        const remainingMin = Math.max(1, Math.ceil(remainingMs / 60000));
        postBtn.textContent = `投稿できません(あと${remainingMin}分)`;
      }
    }
    renderPostButton();

    precisionSelect.onchange = async () => {
      draft.geohashLength = Number(precisionSelect.value) as GeohashLength;
      await updateDraftPrecision(draft.id, draft.geohashLength);
      renderPostButton();
    };

    // 投稿本体と同じ確認ダイアログを経由する。OKで共有フォームを開いたら、
    // この下書きは役目を終えたものとして削除する(投稿ボタンを押した=
    // 少なくとも共有フォームまでは進んだ、という前提。投稿が実際に成功
    // したかどうかまではAshi@側では検知できない)。
    postBtn.onclick = async () => {
      const wantsToPost = await showConfirm(
        "現在地の情報を含んだ投稿フォームを開きます。内容は共有フォーム上で確認・編集できます。",
        { okLabel: "共有フォームを開く" },
      );
      if (!wantsToPost) return;

      const text = shareTextFor(draft.lat, draft.lon, draft.geohashLength);
      window.open(buildShareUrl(text), "_blank", "noopener");

      await deleteDraft(draft.id);
      refreshDraftList();
    };

    deleteBtn.onclick = async () => {
      const wantsToDelete = await showConfirm("この下書きを削除しますか？", {
        okLabel: "削除する",
      });
      if (!wantsToDelete) return;
      await deleteDraft(draft.id);
      refreshDraftList();
    };

    actions.append(postBtn, deleteBtn);
    li.append(meta, precisionSelect, actions);
    draftList.append(li);
  }
}

// 30分経過による投稿可否の変化を、リストを開いたまま待っていても反映されるように
setInterval(() => {
  if (draftListDialog.open) refreshDraftList();
}, 60 * 1000);

$<HTMLButtonElement>("#draftListToggle").onclick = () => {
  closeMenu();
  refreshDraftList();
  draftListDialog.showModal();
};
$<HTMLButtonElement>("#draftListCloseX").onclick = () => draftListDialog.close();

draftListDialog.addEventListener("click", (e) => {
  const rect = draftListDialog.getBoundingClientRect();
  const inside =
    rect.top <= e.clientY &&
    e.clientY <= rect.top + rect.height &&
    rect.left <= e.clientX &&
    e.clientX <= rect.left + rect.width;
  if (!inside) draftListDialog.close();
});

// --- スプラッシュ画面 -------------------------------------------------
// ヘッダーから「Ashi@」「どこにいた？」を外した代わりに、起動直後だけ
// 全画面でこれらを表示する。タップ、または一定時間経過で消える。
// 表示中は#appにinertを付けてあり(index.html側)、背後のボタンにキーボード
// フォーカスが移ったり、スクリーンリーダーから読み上げられたりしないように
// している。スプラッシュを閉じるタイミングでinertを解除する。
const splash = document.querySelector<HTMLElement>("#splash");
const appRoot = $("#app");
if (splash) {
  let splashHidden = false;
  const hideSplash = () => {
    if (splashHidden) return;
    splashHidden = true;
    splash.classList.add("hide");
    appRoot.removeAttribute("inert");
  };
  splash.addEventListener("click", hideSplash);
  setTimeout(hideSplash, 1600);
}

// 起動時:
// 1. TTL無しで保存してあるインスタンスURL・地図の表示位置があれば復元する
//    (どちらも無ければ、input要素のデフォルト値/createMap()のデフォルト位置のまま)
// 2. その上で、今のインスタンス欄の値でAshiatoキャッシュを復元し(ブラウザ再訪時の復元)、
//    復元できたものが0件だった場合だけ、自動で「過去を探す」を1回実行する。
(async () => {
  try {
    const savedInstance = await getSetting<string>("instanceUrl");
    if (savedInstance) $<HTMLInputElement>("#instance").value = savedInstance;

    const savedSortMode = await getSetting<UnlockedSortMode>("unlockedSortMode");
    if (savedSortMode === "unlocked" || savedSortMode === "posted") {
      unlockedSortMode = savedSortMode;
      unlockedSortModeSelect.value = savedSortMode;
    }

    const savedMapView = await getSetting<{ lat: number; lon: number; zoom: number }>("mapView");
    if (savedMapView) {
      map.setView([savedMapView.lat, savedMapView.lon], savedMapView.zoom, {
        animate: false,
      });
    }

    const restoredCount = await switchHost(
      normalizeInstanceUrl($<HTMLInputElement>("#instance").value),
    );
    if (restoredCount === 0) fetchOlder();
  } catch (error) {
    console.error(error);
    setStatus("キャッシュの読み込みに失敗しました。", true);
  }
})();
