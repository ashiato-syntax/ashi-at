import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { decodeGeohash } from "./geohash.js";
import { addGraticule } from "./graticule.js";

// 注: ここでは意図的に L.tileLayer(...) を追加していない
// サードパーティ製のタイルプロバイダは使用しない
// 無料で運用できるように、都道府県市区町村境界だけ、
// https://github.com/smartnews-smri/japan-topography　の1%GeoJsonを使って描画してる
const JAPAN_BOUNDS = L.latLngBounds([17, 122], [46, 154]);

export function createMap(el) {
  const map = L.map(el, {
    attributionControl: false,
    minZoom: 4, // ズームアウトの制限。大体日本が全部収まるくらい
    maxBounds: JAPAN_BOUNDS,
    maxBoundsViscosity: 0.8, // 表示領域をはみ出たらふわっと戻す
  }).setView([35.69, 135.5], 5);
  addGraticule(map);

  // 都道府県の境界線が常に市区町村の境界線より前面に描画されるように、専用のペインを割り当て
  map.createPane("municipalityPane");
  map.getPane("municipalityPane").style.zIndex = 410;
  map.createPane("prefecturePane");
  map.getPane("prefecturePane").style.zIndex = 420;

  return map;
}

// 都道府県境界(常に表示) GeoJSONそのものも返すので、呼び出し側で
// prefectureIndex.js の buildPrefectureIndex に渡してバウンディングボックスを作る
export async function loadPrefectureBoundaries(map) {
  const res = await fetch("/data/maps/s0010/prefectures.json");
  if (!res.ok) throw new Error("都道府県境界GeoJSONの読み込みに失敗しました。");
  const data = await res.json();

  L.geoJSON(data, {
    pane: "prefecturePane",
    style: { color: "#666", weight: 1.5, fill: false, interactive: false },
  }).addTo(map);

  return data;
}

// 市区町村境界は都道府県別ファイル(N03-21_{code}_210101.json)を必要になったときだけ読み込む
// 全国版(10MB)は使わない
export async function loadMunicipalityBoundaries(map, prefCode) {
  const res = await fetch(`/data/maps/s0010/N03-21_${prefCode}_210101.json`);
  if (!res.ok) throw new Error(`市区町村境界GeoJSONの読み込みに失敗しました(都道府県コード ${prefCode})。`);
  const data = await res.json();

  return L.geoJSON(data, {
    pane: "municipalityPane",
    style: { color: "#ccc", weight: 0.8, fill: false, interactive: false },
  }).addTo(map);
}

export function addAshiato(map, result, onOpen) {
  const b = decodeGeohash(result.model.geohash);
  const r = L.rectangle(
    [
      [b.minLat, b.minLon],
      [b.maxLat, b.maxLon],
    ],
    { interactive: true },
  );
  r.on("click", () => onOpen(result));
  r.addTo(map);
  return r;
}
