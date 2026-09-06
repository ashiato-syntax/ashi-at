import { searchNotesByTag, normalizeInstanceUrl } from "./misskey.js";
import { parseText } from "./parser.js";
import {
  createMap,
  addAshiato,
  loadPrefectureBoundaries,
  loadMunicipalityBoundaries,
} from "./map.js";
import {
  decodeGeohash,
  geohashCellSizeMeters
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
} from "./cache.js";

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
  status = $("#status"),
  list = $("#results");

let layers = [];
let prefectureIndex = [];
let prefectureLabelLayer = null;
let prefectureLabelsVisible = false;

const municipalityLayers = new Map();
let municipalitiesVisible = false;
let municipalityLabelsVisible = false;

// ページング/キャッシュ用の状態。host(インスタンスのorigin)ごとに区画が分かれる。
let currentHost = null;
let cursor = null; // { oldestSeenNoteId, newestSeenNoteId } | null
const renderedIds = new Set(); // 表示済みAshiatoの重複防止(cache.jsのレコードidを使う)

function setStatus(t, e = false) {
  status.textContent = t;
  status.className = e ? "status error" : "status";
}

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

function openAshiato(result) {
  const { widthM, heightM } = geohashCellSizeMeters(result.model.geohash);
  alert(
    `このあしあとは、現地に行くと開封できます\n\n当たり判定エリアサイズ:\n(東西 ${Math.round(widthM)}m, 南北 ${Math.round(heightM)}m)`,
  );
}

function renderRecord(record) {
  if (renderedIds.has(record.id)) return;
  renderedIds.add(record.id);

  const result = { model: { geohash: record.geohash }, canonical: record.canonical };
  layers.push(addAshiato(map, result, openAshiato));

  const li = document.createElement("li"),
    b = document.createElement("button");

  b.textContent = `${record.geohash} — ${record.canonical}`;
  b.onclick = () => {
    const { centerLat, centerLon } = decodeGeohash(record.geohash);
    map.setView([centerLat, centerLon], 13);
  };

  li.append(b);
  list.append(li);
}

function updateButtons() {
  $("#search").textContent = cursor ? "さらに探す" : "探す";
  $("#loadNewer").hidden = !cursor;
}

// インスタンス欄が変わったら、表示中のAshiatoを一旦クリアして、
// そのhost用のキャッシュ(あれば)を読み込み直す。
async function switchHost(host) {
  currentHost = host;

  layers.forEach((x) => map.removeLayer(x));
  layers = [];
  list.replaceChildren();
  renderedIds.clear();

  await pruneCache(host, TAG); // 読み込み前に期限切れ・上限超過分を掃除
  const cached = await getAshiatoRecords(host, TAG);
  // 古い順に並べておくと、ページングで足された分と混ざっても違和感がない
  cached.sort((a, b) => a.cachedAt - b.cachedAt);
  for (const record of cached) renderRecord(record);

  cursor = await getCursor(host, TAG);
  updateButtons();

  setStatus(
    cached.length > 0
      ? `キャッシュから${cached.length}件のAshiatoを復元しました`
      : "準備完了",
  );
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
      records.push(makeRecord(host, TAG, note.id, idx, r));
      idx++;
    }
  }

  await putAshiatoRecords(records);
  for (const record of records) renderRecord(record);
  return records;
}

// 過去方向(untilId): 「探す」(初回) / 「さらに過去を探す」(2回目以降、同じボタン)
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
        ? `表示中 ${renderedIds.size}件`
        : "これより古いAshiatoは見つかりませんでした",
    );
  } catch (e) {
    console.error(e);
    setStatus(e.message || "検索に失敗しました", true);
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
        ? `表示中 ${renderedIds.size}件`
        : "新しいAshiatoはありませんでした",
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

  layers.forEach((x) => map.removeLayer(x));
  layers = [];
  list.replaceChildren();
  renderedIds.clear();
  cursor = null;

  updateButtons();
  setStatus("キャッシュを消去しました。");
}

$("#search").onclick = fetchOlder;
$("#loadNewer").onclick = fetchNewer;
$("#clearCache").onclick = handleClearCache;
$("#instance").onkeydown = (e) => {
  if (e.key === "Enter") fetchOlder();
};

// 起動時: 今のインスタンス欄の値でキャッシュを復元しておく(ブラウザ再訪時の復元)
ensureHost().catch((error) => {
  console.error(error);
  setStatus("キャッシュの読み込みに失敗しました。", true);
});
