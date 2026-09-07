import { searchNotesByTag, normalizeInstanceUrl } from "./misskey.js";
import { parseText } from "./parser.js";
import {
  createMap,
  addAshiatoGroup,
  removeAshiatoGroup,
  setAshiatoState,
  loadPrefectureBoundaries,
  loadMunicipalityBoundaries,
  createCurrentLocationLayer,
  createAreaOverlay,
  ashiatoColor,
} from "./map.js";
import {
  decodeGeohash,
  geohashCellSizeMeters,
  isInsideGeohashCell,
} from "./geohash.js";
import {
  buildPrefectureIndex,
  findPrefecturesInView,
} from "./prefectureIndex.js";
import {
  makeRecord,
  getCursor,
  putCursor,
  getAshiatoRecords,
  putAshiatoRecords,
  pruneCache,
  clearSearchCache,
  clearCollectedAshiato,
  markAshiatoUnlocked,
  markAshiatoOpened,
  getSetting,
  putSetting,
} from "./cache.js";
import L from "leaflet";

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
const MIN_NOTE_AGE_MS = 60 * 60 * 1000; // 1時間
const PENDING_PROMOTION_INTERVAL_MS = 60 * 1000; // 1分ごとに再チェック

function isSupportedGeohashLength(geohash) {
  return (
    geohash.length >= MIN_GEOHASH_LENGTH &&
    geohash.length <= MAX_GEOHASH_LENGTH
  );
}

// noteCreatedAtが無い/不正な場合は、安全側に倒して「まだ扱わない」扱いにする
function isOldEnough(noteCreatedAt) {
  if (!noteCreatedAt) return false;
  const postedAt = new Date(noteCreatedAt).getTime();
  if (Number.isNaN(postedAt)) return false;
  return Date.now() - postedAt >= MIN_NOTE_AGE_MS;
}

const $ = (s) => document.querySelector(s),
  map = createMap("map"),
  areaOverlay = createAreaOverlay(map),
  statusToast = $("#statusToast"),
  statusText = $("#statusText"),
  statusCloseBtn = $("#statusClose"),
  unlockedList = $("#unlockedList");

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

let prefectureIndex = [];
let prefectureLabelLayer = null;
let prefectureLabelsVisible = false;

const municipalityLayers = new Map();
let municipalitiesVisible = false;
let municipalityLabelsVisible = false;

// ページング/キャッシュ用の状態。host(インスタンスのorigin)ごとに区画が分かれる。
let currentHost = null;
let cursor = null; // { oldestSeenNoteId, newestSeenNoteId } | null

// 同じgeohash(=同じ発見判定エリア)を持つAshiatoは、地図上では1グループとして
// まとめて表示する(桁数の短いgeohashだと複数レコードが同じセルに乗ることがあり、
// レコードごとに描画するとマーカーが完全に重なってタップ不能になるため)。
// geohash文字列 -> { geohash, records: Map<id, record>, visualLayers, hitArea, geohashLength, color }
// ロック中(未発見)のレコードもrecordsには保持する(GPS判定に必要)が、
// 発見済みが1件も無い間はvisualLayers/hitArea/colorはnullのまま(=地図に描画しない)。
const ashiatoCells = new Map();

// geohashの桁数条件は満たすが、投稿からまだMIN_NOTE_AGE_MS経っていないレコード。
// promoteAgedRecords()が定期的にチェックし、条件を満たしたらashiatoCellsへ昇格させる。
const pendingRecords = new Map();

const currentLocationLayer = createCurrentLocationLayer(map);
let watchId = null;
let gpsEnabled = false;

const STATUS_AUTO_HIDE_MS = 3500;
let statusHideTimer = null;

// 通常メッセージは一定時間で自動的に消える(地図の面積を占有し続けないように)。
// エラーは見落とし防止のため自動で消さず、×ボタンで明示的に閉じる。
function setStatus(t, e = false) {
  clearTimeout(statusHideTimer);
  statusText.textContent = t;
  statusToast.classList.toggle("error", e);
  statusToast.hidden = false;
  statusCloseBtn.hidden = !e;

  if (!e) {
    statusHideTimer = setTimeout(() => {
      statusToast.hidden = true;
    }, STATUS_AUTO_HIDE_MS);
  }
}

statusCloseBtn.onclick = () => {
  clearTimeout(statusHideTimer);
  statusToast.hidden = true;
};

// --- alert/confirmの代替ダイアログ -----------------------------------------
// ネイティブのalert()/confirm()は他のUIと見た目が揃わないため、既存のdialog群と
// 同じ見た目のダイアログで代替する。showConfirmはPromise<boolean>を返し、
// OKボタンなら true、キャンセル/ESC/外側クリックならすべて false になる。

const infoDialog = $("#infoDialog");
const infoMessage = $("#infoMessage");
const infoOkBtn = $("#infoOk");

function showInfo(message) {
  infoMessage.textContent = message;
  infoDialog.showModal();
}

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

const confirmDialog = $("#confirmDialog");
const confirmMessage = $("#confirmMessage");
const confirmOkBtn = $("#confirmOk");
const confirmCancelBtn = $("#confirmCancel");

function showConfirm(message, { okLabel = "OK", cancelLabel = "キャンセル" } = {}) {
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

async function initBoundaries() {
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

function syncLabelVisibility() {
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

async function syncMunicipalityLayers() {
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
function computeCellState(visibleRecords) {
  return visibleRecords.length > 0 && visibleRecords.every((r) => r.openedAt)
    ? "opened"
    : "unlocked";
}

// geohash1件分の判定エリアサイズを、案内文の断片として作る
function cellSizeText(geohash) {
  const { widthM, heightM } = geohashCellSizeMeters(geohash);
  return `当たり判定エリアサイズ:\n(東西 ${Math.round(widthM)}m, 南北 ${Math.round(heightM)}m)`;
}

// ISO文字列 / epoch(ms) どちらも受け取れる日付フォーマッタ。値が無い/不正なら null。
function formatDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

// Ashiato Syntax(canonical)の代わりに一覧・ポップアップに表示するテキスト。
// 投稿日は常に、開封日はopenedAtがある場合だけ付け加える。
function recordDatesText(record) {
  const posted = formatDate(record.noteCreatedAt) ?? "不明";
  const opened = formatDate(record.openedAt);
  return opened ? `投稿日: ${posted} / 開封日: ${opened}` : `投稿日: ${posted}`;
}

// 「あつめたあしあと」一覧の見出しテキスト。開封済みのものは、Geohashの代わりに
// 投稿者のusername(notes/search-by-tagのuser.username)を表示する。
function unlockedListLabel(record) {
  const label = record.openedAt ? (record.username ?? "(不明なユーザー)") : record.geohash;
  return `${label} — ${recordDatesText(record)}`;
}

// セルの見た目(円)を、現在のrecords件数・状態に合わせて作り直す。
// ロック中(未発見)のレコードは地図上に一切表示しない方針のため、
// 表示対象は「発見済み(unlockedAtあり)」のレコードだけに絞る。
// 発見済みレコードが1件も無いセルは、円そのものを描画しない
// (GPS判定用の内部データとしてはcell.recordsに保持し続ける)。
function rebuildCellVisual(cell) {
  if (cell.hitArea) removeAshiatoGroup(map, cell);
  cell.visualLayers = null;
  cell.hitArea = null;
  cell.geohashLength = null;
  cell.color = null;

  const visibleRecords = [...cell.records.values()].filter((r) => r.unlockedAt);

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
    setAshiatoState(cell, state);
    cell.color = ashiatoColor(state, geohashLength);
  }

  areaOverlay.refresh([...ashiatoCells.values()]);
}

// レコードを対応するセルに追加する。セルが無ければ新設する。
// 同じidのレコードが既にあれば何もしない(重複読み込み対策)。
function addRecordToCell(record) {
  let cell = ashiatoCells.get(record.geohash);
  if (!cell) {
    cell = { geohash: record.geohash, records: new Map() };
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
function registerRecord(record) {
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
function promoteAgedRecords() {
  for (const [id, record] of pendingRecords) {
    if (isOldEnough(record.noteCreatedAt)) {
      pendingRecords.delete(id);
      addRecordToCell(record);
    }
  }
}

setInterval(promoteAgedRecords, PENDING_PROMOTION_INTERVAL_MS);

// 「開封可能なAshiato」ダイアログの右上バッジ。未開封(unlockedAt はあるが
// openedAt が無い)のものが1件でもあれば表示する。
// ハンバーガーメニュー内に移動したので、メニューボタン自体にも同じ赤丸を出す。
function updateUnlockedBadge(unlockedRecords) {
  const hasUnopened = unlockedRecords.some((r) => !r.openedAt);
  $("#unlockedBadge").hidden = !hasUnopened;
  $("#menuBadge").hidden = !hasUnopened;
}

// 「あつめたあしあと」ダイアログの表示フィルター。true なら未開封のみ表示する。
let showOnlyUnopened = false;

// 「開封可能なAshiato」ダイアログの中身を、アンロック済みのものだけ・
// アンロックした順で再構築する。ロック中(未発見)のものはここには載せない。
// 開封済みかどうかはボタン文言とグレーアウトで示す。
// showOnlyUnopenedがtrueのときは、さらに未開封のものだけに絞り込んで表示する
// (バッジ・件数判定は絞り込み前の全件ベースのまま変えない)。
function refreshUnlockedList() {
  const unlocked = [...ashiatoCells.values()]
    .flatMap((cell) => [...cell.records.values()])
    .filter((r) => r.unlockedAt)
    .sort((a, b) => a.unlockedAt - b.unlockedAt);

  updateUnlockedBadge(unlocked);

  const visible = showOnlyUnopened
    ? unlocked.filter((r) => !r.openedAt)
    : unlocked;

  unlockedList.replaceChildren();

  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "unlocked-list-empty";
    empty.textContent =
      unlocked.length === 0
        ? "まだ発見したAshiatoはありません。"
        : "未開封のAshiatoはありません。";
    unlockedList.append(empty);
    return;
  }

  for (const record of visible) {
    const li = document.createElement("li"),
      b = document.createElement("button");

    b.type = "button";
    b.textContent = unlockedListLabel(record);
    b.onclick = () => {
      unlockedListDialog.close();
      const cell = ashiatoCells.get(record.geohash);
      handleAshiatoClick(record, cell);
    };

    if (!record.openedAt) b.classList.add("unlocked-unopened");
    if (record.openedAt) li.classList.add("opened");
    li.append(b);
    unlockedList.append(li);
  }
}

// セルをクリックしたときの入口。
// ポップアップ等に出すのは発見済み(unlockedAt)のレコードのみ
// (ロック中のものは地図に表示していないため、そもそもクリックしようがない)。
// レコードが1件なら直接開封フローへ、複数件ならポップアップで一覧を出し、
// 選んだものだけ開封フローへ進む。
function handleCellClick(geohash) {
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
    const b = document.createElement("button");
    b.type = "button";
    // 開封済みのものはGeohashの代わりに投稿者のusernameを表示する
    b.textContent = record.openedAt
      ? `${record.username ?? "(不明なユーザー)"} — ${recordDatesText(record)}`
      : recordDatesText(record);
    if (!record.openedAt) b.classList.add("unlocked-unopened");

    b.onclick = () => {
      map.closePopup();
      handleAshiatoClick(record, cell);
    };
    container.append(b);
  }

  // maxHeightを指定すると、件数が多い場合にLeafletがポップアップ内を
  // 自動でスクロール可能にしてくれる(popupPaneのzIndexは createMap 側で
  // Ashiato/現在地より前面に設定済み)。
  L.popup({ maxHeight: 260 })
    .setLatLng([centerLat, centerLon])
    .setContent(container)
    .openOn(map);
}

// 個別のAshiato1件に対する開封フロー。
// 地図/ポップアップ/一覧のいずれから呼ばれる場合も、対象は常に発見済み
// (unlockedAtがある)レコードのみ。開封済みでも再度リンクへ飛べるように、
// 常に確認ダイアログを出す。判定エリアサイズは案内文に含める。
async function handleAshiatoClick(record, cell) {
  const sizeText = cellSizeText(record.geohash);
  const openedLabel = record.openedAt ? "(開封済み)" : "";

  const wantsToOpen = await showConfirm(
    `このあしあとを開封しますか？${openedLabel}\n\n投稿日: ${formatDate(record.noteCreatedAt) ?? "不明"}\n\n${sizeText}`,
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
    setAshiatoState(cell, state);
    cell.color = ashiatoColor(state, cell.geohashLength);
    areaOverlay.refresh([...ashiatoCells.values()]);

    refreshUnlockedList();
  }
}

function updateButtons() {
  $("#search").textContent = cursor ? "さらに探す" : "探す";
  $("#loadNewer").hidden = !cursor;
}

// --- 現在地(GPS)によるAshiatoのアンロック判定 -----------------------------

const gpsToggleBtn = $("#toggleGps");

// 起動時、そもそもGeolocation APIが無い端末なら見た目で分かるようにしておく
if (!("geolocation" in navigator)) {
  gpsToggleBtn.classList.add("unavailable");
  gpsToggleBtn.title = "この端末では位置情報が使えません";
}

function setGpsEnabled(enabled) {
  if (enabled && !("geolocation" in navigator)) {
    setStatus("この端末では位置情報が使えません。", true);
    return;
  }

  gpsEnabled = enabled;
  gpsToggleBtn.setAttribute("aria-pressed", String(enabled));

  if (!enabled) {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    currentLocationLayer.hide();
    return;
  }

  watchId = navigator.geolocation.watchPosition(
    handlePositionUpdate,
    handlePositionError,
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  );
}

function handlePositionError(error) {
  console.error(error);
  const messages = {
    1: "位置情報の利用が許可されていません。",
    2: "現在地を取得できませんでした。",
    3: "現在地の取得がタイムアウトしました。",
  };
  setStatus(messages[error.code] ?? "位置情報の取得に失敗しました。", true);
  if (error.code === 1) setGpsEnabled(false); // 権限拒否ならトグルもOFFに戻す
}

// 現在地が更新されるたびに呼ばれる。セルごとに1回だけ判定すればよい
// (同じセル内のレコードはgeohashが同一なので判定結果も必ず同じ)。
// 一度アンロックされたレコードは、現在地に関わらずそのまま(判定対象から外す)。
// ashiatoCellsに載っているレコードは、そもそも投稿から1時間経過済み(または
// 既に発見済み)のものだけなので、ここで改めて経過時間を見る必要はない
// (1時間未満のものはpendingRecordsに留まり、ここには出てこない)。
async function handlePositionUpdate(position) {
  const { latitude, longitude, accuracy } = position.coords;
  currentLocationLayer.show(latitude, longitude, accuracy);

  for (const cell of ashiatoCells.values()) {
    const locked = [...cell.records.values()].filter((r) => !r.unlockedAt);
    if (locked.length === 0) continue;
    if (!isInsideGeohashCell(latitude, longitude, cell.geohash)) continue;

    const unlockedAt = Date.now();
    for (const record of locked) {
      await markAshiatoUnlocked(record.id, unlockedAt);
      record.unlockedAt = unlockedAt;
    }
    rebuildCellVisual(cell); // 初めて発見された/丸の数が増えたケースに対応
    refreshUnlockedList();
  }
}

// --- 開封可能なAshiatoリスト(ダイアログ) ----------------------------------

const unlockedListDialog = $("#unlockedListDialog");

$("#unlockedListToggle").onclick = () => {
  closeMenu();
  unlockedListDialog.showModal();
};
$("#unlockedListClose").onclick = () => unlockedListDialog.close();

$("#unopenedOnlyFilter").onchange = (e) => {
  showOnlyUnopened = e.target.checked;
  refreshUnlockedList();
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

const toggleAreaBtn = $("#toggleArea");
let areaEnabled = false;

toggleAreaBtn.onclick = () => {
  areaEnabled = !areaEnabled;
  toggleAreaBtn.setAttribute("aria-pressed", String(areaEnabled));
  areaOverlay.setEnabled(areaEnabled);
};

// --- ハンバーガーメニュー -------------------------------------------------

const menuToggle = $("#menuToggle");
const menuDropdown = $("#menuDropdown");
const aboutDialog = $("#aboutDialog");

function closeMenu() {
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
  if (!menuDropdown.hidden && !e.target.closest(".menu")) closeMenu();
});

$("#aboutButton").onclick = () => {
  closeMenu();
  aboutDialog.showModal();
};
$("#aboutClose").onclick = () => aboutDialog.close();

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

const instanceDialog = $("#instanceDialog");
const currentHostLabel = $("#currentHostLabel");

$("#changeInstance").onclick = () => {
  closeMenu();
  instanceDialog.showModal();
};
$("#instanceCancel").onclick = () => instanceDialog.close();

instanceDialog.addEventListener("click", (e) => {
  const rect = instanceDialog.getBoundingClientRect();
  const inside =
    rect.top <= e.clientY &&
    e.clientY <= rect.top + rect.height &&
    rect.left <= e.clientX &&
    e.clientX <= rect.left + rect.width;
  if (!inside) instanceDialog.close();
});

$("#instanceApply").onclick = () => {
  instanceDialog.close();
  fetchOlder();
};

// インスタンス欄が変わったら、表示中のAshiatoを一旦クリアして、
// そのhost用のキャッシュ(あれば)を読み込み直す。
async function switchHost(host) {
  currentHost = host;
  currentHostLabel.textContent = `現在: ${host.replace(/^https?:\/\//, "")}`;
  putSetting("instanceUrl", host); // TTL無し。次回起動時のデフォルト接続先にする

  for (const cell of ashiatoCells.values()) {
    if (cell.hitArea) removeAshiatoGroup(map, cell);
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
  updateButtons();

  setStatus(
    cached.length > 0
      ? `キャッシュから${cached.length}件のAshiatoを復元しました。`
      : "準備完了。",
  );

  return cached.length;
}

async function ensureHost() {
  const host = normalizeInstanceUrl($("#instance").value);
  if (host !== currentHost) await switchHost(host);
  return host;
}

async function ingestNotes(host, notes) {
  const records = [];

  for (const note of notes) {
    // 削除済みノート、本文が無いノートは対象外
    if (!note?.text || note.deletedAt) continue;

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
          ),
        );
      }
      idx++; // 対象外の桁数で弾いた分もidxは進める(ノート内位置とidの対応を崩さないため)
    }
  }

  await putAshiatoRecords(records);
  for (const record of records) registerRecord(record);
  return records;
}

// 過去方向(untilId): 「探す」(初回) / 「さらに探す」(2回目以降、同じボタン)
async function fetchOlder() {
  const btn = $("#search");
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
      cursor = { oldestSeenNoteId: oldestId, newestSeenNoteId: newestId };
      await putCursor(host, TAG, cursor);
    }

    updateButtons();
    setStatus(
      notes.length > 0
        ? `${notes.length}件のノートを確認。表示中 ${ashiatoCells.size}箇所。`
        : "これより古いAshiatoは見つかりませんでした。",
    );
  } catch (e) {
    console.error(e);
    setStatus(e.message || "検索に失敗しました。", true);
  } finally {
    btn.disabled = false;
  }
}

// 最新方向(sinceId): 前回訪問後に増えた新着だけを取得
async function fetchNewer() {
  const btn = $("#loadNewer");
  btn.disabled = true;
  setStatus("Misskeyから検索中…(最新)");

  try {
    const host = await ensureHost();
    if (!cursor) {
      // カーソルが無い(＝まだ一度も検索していない)状態でここが呼ばれることは
      // 通常ない(ボタンが隠れているはず)が、念のためのフォールバック。
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
      // これにより「さらに探す」の起点が必ずこのバッチの範囲を通過するようになり、
      // fetchNewer の limit 上限で取りこぼした区間が永久に未取得のまま残ることを防ぐ。
      // (直前に fetchOlder で取得済みの範囲を再要求することになる場合があるが、
      //  host::noteId::index で重複排除されるので実害はない)
      cursor = { newestSeenNoteId: newestId, oldestSeenNoteId: oldestId };
      await putCursor(host, TAG, cursor);
    }

    setStatus(
      notes.length > 0
        ? `新着${notes.length}件を確認。表示中 ${ashiatoCells.size}箇所。`
        : "新しいAshiatoはありませんでした。",
    );
  } catch (e) {
    console.error(e);
    setStatus(e.message || "検索に失敗しました。", true);
  } finally {
    btn.disabled = false;
  }
}

// 「検索キャッシュを消す」。まだ発見していない(unlockedAtが無い)レコードと
// 保留中(pendingRecords)のレコード、カーソルだけを消す。
// 「あつめたあしあと」(発見済み)は地図上にもそのまま残す。
async function handleClearSearchCache() {
  await clearSearchCache();
  pendingRecords.clear();

  for (const [geohash, cell] of [...ashiatoCells]) {
    for (const [id, record] of [...cell.records]) {
      if (!record.unlockedAt) cell.records.delete(id);
    }
    if (cell.records.size === 0) {
      if (cell.hitArea) removeAshiatoGroup(map, cell);
      ashiatoCells.delete(geohash);
    } else {
      rebuildCellVisual(cell); // 残るのは発見済みだけなので、見た目は基本変わらない
    }
  }
  areaOverlay.refresh([...ashiatoCells.values()]);

  cursor = null;
  updateButtons();
  setStatus("検索キャッシュを消去しました。");
}

// 「あつめたあしあとを消す」。発見済み(unlockedAtがある)レコードだけを消す。
// 検索キャッシュ・カーソルはそのまま(次の「探す」の続きはそのまま使える)。
async function handleClearCollected() {
  await clearCollectedAshiato();

  for (const [geohash, cell] of [...ashiatoCells]) {
    for (const [id, record] of [...cell.records]) {
      if (record.unlockedAt) cell.records.delete(id);
    }
    if (cell.records.size === 0) {
      if (cell.hitArea) removeAshiatoGroup(map, cell);
      ashiatoCells.delete(geohash);
    } else {
      rebuildCellVisual(cell); // 残るのはロック中のみなので、円は消える
    }
  }
  areaOverlay.refresh([...ashiatoCells.values()]);

  refreshUnlockedList();
  setStatus("あつめたあしあとを消去しました。");
}

$("#search").onclick = fetchOlder;
$("#loadNewer").onclick = fetchNewer;
$("#toggleGps").onclick = () => setGpsEnabled(!gpsEnabled);
$("#clearSearchCache").onclick = async () => {
  closeMenu();
  const wantsToClear = await showConfirm(
    "検索キャッシュを削除しますか？(あつめたあしあとは残ります)",
    { okLabel: "削除する" },
  );
  if (!wantsToClear) return;
  await handleClearSearchCache();
};
$("#clearCollected").onclick = async () => {
  closeMenu();
  const wantsToClear = await showConfirm(
    "あつめたあしあとをすべて削除しますか？この操作は取り消せません。",
    { okLabel: "削除する" },
  );
  if (!wantsToClear) return;
  await handleClearCollected();
};
$("#instance").onkeydown = (e) => {
  if (e.key === "Enter") {
    instanceDialog.close();
    fetchOlder();
  }
};

// --- スプラッシュ画面 -------------------------------------------------
// ヘッダーから「Ashi@」「どこにいた？」を外した代わりに、起動直後だけ
// 全画面でこれらを表示する。タップ、または一定時間経過で消える。
// 表示中は#appにinertを付けてあり(index.html側)、背後のボタンにキーボード
// フォーカスが移ったり、スクリーンリーダーから読み上げられたりしないように
// している。スプラッシュを閉じるタイミングでinertを解除する。
const splash = $("#splash");
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
//    復元できたものが0件だった場合だけ、自動で「探す」を1回実行する。
(async () => {
  try {
    const savedInstance = await getSetting("instanceUrl");
    if (savedInstance) $("#instance").value = savedInstance;

    const savedMapView = await getSetting("mapView");
    if (savedMapView) {
      map.setView([savedMapView.lat, savedMapView.lon], savedMapView.zoom, {
        animate: false,
      });
    }

    const restoredCount = await switchHost(
      normalizeInstanceUrl($("#instance").value),
    );
    if (restoredCount === 0) fetchOlder();
  } catch (error) {
    console.error(error);
    setStatus("キャッシュの読み込みに失敗しました。", true);
  }
})();
