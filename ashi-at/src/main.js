import { searchNotesByTag } from "./misskey.js";
import { parseText } from "./parser.js";
import {
  createMap,
  addAshiato,
  loadPrefectureBoundaries,
  loadMunicipalityBoundaries,
} from "./map.js";
import { decodeGeohash } from "./geohash.js";
import { buildPrefectureIndex, findPrefecturesInView } from "./prefectureIndex.js";

// これよりズームしたら、当該都道府県の市区町村GeoJsonを読み込む
const MIN_ZOOM_FOR_MUNICIPALITIES = 9;

const $ = (s) => document.querySelector(s),
  map = createMap("map"),
  status = $("#status"),
  list = $("#results");

let layers = [];
let prefectureIndex = [];
const municipalityLayers = new Map();
let municipalitiesVisible = false;

function setStatus(t, e = false) {
  status.textContent = t;
  status.className = e ? "status error" : "status";
}

async function initBoundaries() {
  try {
    const prefectureData = await loadPrefectureBoundaries(map);
    prefectureIndex = buildPrefectureIndex(prefectureData);
    await syncMunicipalityLayers();
    map.on("moveend", syncMunicipalityLayers);
  } catch (error) {
    console.error(error);
    setStatus("地図境界の読み込みに失敗しました。", true);
  }
}

async function syncMunicipalityLayers() {
  if (map.getZoom() < MIN_ZOOM_FOR_MUNICIPALITIES) {
    if (municipalitiesVisible) {
      for (const layer of municipalityLayers.values()) {
        if (layer !== "loading") map.removeLayer(layer);
      }
      municipalitiesVisible = false;
    }
    return;
  }

  if (!municipalitiesVisible) {
    // ズームが閾値を超えた場合は、市区町村境界を読み込み表示するが、
    // 既に読み込み済みであればそちらを再利用する
    for (const layer of municipalityLayers.values()) {
      if (layer !== "loading") layer.addTo(map);
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
      const layer = await loadMunicipalityBoundaries(map, pref.code);
      municipalityLayers.set(pref.code, layer);
    } catch (error) {
      console.error(`市区町村境界の読み込みに失敗(${pref.name}):`, error);
      municipalityLayers.delete(pref.code); // 後の moveend で再試行
    }
  }
}

initBoundaries();

async function search() {
  const btn = $("#search");

  btn.disabled = true;
  setStatus("Misskeyから検索中…");

  try {
    const notes = await searchNotesByTag(
      $("#instance").value,
      $("#hashtag").value,
    );

    layers.forEach((x) => map.removeLayer(x));
    layers = [];
    list.replaceChildren();

    const found = [];
    for (const note of notes) {
      if (!note?.text) continue;
      for (const r of parseText(note.text))
        found.push({ ...r, noteId: note.id, note });
    }

    for (const r of found) {
      layers.push(addAshiato(map, r, openAshiato));

      const li = document.createElement("li"),
        b = document.createElement("button");

      b.textContent = `${r.model.geohash} — ${r.canonical}`;
      b.onclick = () => {
        const { centerLat, centerLon } = decodeGeohash(r.model.geohash);
        map.setView([centerLat, centerLon], 13);
      };

      li.append(b);
      list.append(li);
    }

    setStatus(
      `${notes.length}件のノートから、${found.length}件のAshiatoを発見。`,
    );
  } catch (e) {
    console.error(e);
    setStatus(e.message || "検索に失敗しました。", true);
  } finally {
    btn.disabled = false;
  }
}
function openAshiato(r) {
  alert(
    `Ashiatoを発見しました。\n\nGeohash: ${r.model.geohash}\n\n現地到達判定は次の実装段階で有効化します。`,
  );
}
$("#search").onclick = search;
$("#hashtag").onkeydown = (e) => {
  if (e.key === "Enter") search();
};
