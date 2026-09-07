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
  clearAllCache,
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

const $ = (s) => document.querySelector(s),
  map = createMap("map"),
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
// geohash文字列 -> { geohash, records: Map<id, record>, visualLayers, hitArea }
const ashiatoCells = new Map();

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

// セル内の全レコードの状態から、セル全体としての表示状態を決める。
// 「全部openedにならない限りグレーにしない」という方針のため、1件でも
// 未開封が残っていればunlocked(緑)のまま。1件も発見されていなければlocked。
function computeCellState(records) {
  const list = [...records.values()];
  if (list.length > 0 && list.every((r) => r.openedAt)) return "opened";
  if (list.some((r) => r.unlockedAt)) return "unlocked";
  return "locked";
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

// セルの見た目(円)を、現在のrecords件数・状態に合わせて作り直す。
// 件数が変わる(同じセルに新規ノートが増える)たびに、単丸/二重丸の切り替えが
// 必要になるため、既存レイヤーを消してから作り直す形にしている。
function rebuildCellVisual(cell) {
  if (cell.hitArea) removeAshiatoGroup(map, cell);

  const { visualLayers, hitArea } = addAshiatoGroup(
    map,
    cell.geohash,
    cell.records.size,
    () => handleCellClick(cell.geohash),
  );
  cell.visualLayers = visualLayers;
  cell.hitArea = hitArea;
  setAshiatoState(cell, computeCellState(cell.records));
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
    b.textContent = `${record.geohash} — ${recordDatesText(record)}`;
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
// レコードが1件なら直接開封フローへ、複数件ならポップアップで一覧を出し、
// 選んだものだけ開封フローへ進む。
function handleCellClick(geohash) {
  const cell = ashiatoCells.get(geohash);
  if (!cell) return;

  const records = [...cell.records.values()];

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

    if (!record.unlockedAt) {
      // 未発見(ロック中): Ashiato Syntaxの中身は見せない
      b.textContent = "あしあと(未開封)";
    } else {
      // 発見済み: Syntax文字列の代わりに投稿日/開封日を表示
      b.textContent = recordDatesText(record);
      if (!record.openedAt) b.classList.add("unlocked-unopened");
    }

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
// - 未アンロック: 判定エリアサイズを案内するだけ
// - アンロック済み(未開封/開封済みどちらも): 開封確認 → OKならノートURLを別タブで開く
//   (開封済みでも再度リンクへ飛べるように、常に確認ダイアログを出す)
// どちらの場合も判定エリアサイズを案内文に含める。
async function handleAshiatoClick(record, cell) {
  const sizeText = cellSizeText(record.geohash);

  if (!record.unlockedAt) {
    showInfo(`このあしあとは、現地に行くと開封できます\n\n${sizeText}`);
    return;
  }

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
    setAshiatoState(cell, computeCellState(cell.records));
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
    setAshiatoState(cell, computeCellState(cell.records));
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

  for (const cell of ashiatoCells.values()) removeAshiatoGroup(map, cell);
  ashiatoCells.clear();

  await pruneCache(host, TAG); // 読み込み前に期限切れ・上限超過分を掃除
  const cached = await getAshiatoRecords(host, TAG);
  // 古い順に並べておくと、ページングで足された分と混ざっても違和感がない
  cached.sort((a, b) => a.cachedAt - b.cachedAt);
  for (const record of cached) addRecordToCell(record);
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
    if (!note?.text) continue;
    let idx = 0;
    for (const r of parseText(note.text)) {
      records.push(makeRecord(host, TAG, note.id, idx, r, note.createdAt ?? null));
      idx++;
    }
  }

  await putAshiatoRecords(records);
  for (const record of records) addRecordToCell(record);
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

async function handleClearCache() {
  await clearAllCache();

  for (const cell of ashiatoCells.values()) removeAshiatoGroup(map, cell);
  ashiatoCells.clear();
  refreshUnlockedList();
  cursor = null;

  updateButtons();
  setStatus("キャッシュを消去しました。");
}

$("#search").onclick = fetchOlder;
$("#loadNewer").onclick = fetchNewer;
$("#toggleGps").onclick = () => setGpsEnabled(!gpsEnabled);
$("#clearCache").onclick = async () => {
  closeMenu();
  const wantsToClear = await showConfirm("本当にキャッシュを削除しますか？", {
    okLabel: "削除する",
  });
  if (!wantsToClear) return;
  await handleClearCache();
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
