import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { decodeGeohash } from "./geohash.js";
import { addGraticule } from "./graticule.js";

// NOTE: ここでは意図的に L.tileLayer(...) を追加していない
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
  }).setView([35, 135], 5);
  addGraticule(map);

  // 都道府県の境界線が常に市区町村の境界線より前面に描画されるように、専用のペインを割り当て
  map.createPane("municipalityPane");
  map.getPane("municipalityPane").style.zIndex = 410;
  map.createPane("prefecturePane");
  map.getPane("prefecturePane").style.zIndex = 420;

  return map;
}

// 都道府県境界(常に表示) GeoJSONそのものも返すので、呼び出し側で
// prefectureIndex.js の buildPrefectureIndex に渡してバウンディングボックスを作れる。
// ラベルは境界線と別レイヤー(labelLayer)にして、呼び出し側で
// 境界線とは違うズーム閾値で表示/非表示を切り替えられるようにする。
export async function loadPrefectureBoundaries(map) {
  const res = await fetch("/data/maps/s0010/prefectures.json");
  if (!res.ok) throw new Error("都道府県境界GeoJSONの読み込みに失敗しました。");
  const data = await res.json();

  L.geoJSON(data, {
    pane: "prefecturePane",
    style: { color: "#666", weight: 1.5, fill: false, interactive: false },
  }).addTo(map);

  const labelLayer = buildLabelLayer(data, (p) => p.N03_001, "pref-label");

  return { data, labelLayer };
}

// 市区町村境界は都道府県別ファイル(N03-21_{code}_210101.json)を必要になった
// ときだけ読み込む。全国版(10MB)は使わない。boundaryLayerとlabelLayerを別に
// 返すので、呼び出し側でそれぞれ別のズーム閾値で表示/非表示を切り替えられる。
export async function loadMunicipalityBoundaries(map, prefCode) {
  const res = await fetch(`/data/maps/s0010/N03-21_${prefCode}_210101.json`);
  if (!res.ok) throw new Error(`市区町村境界GeoJSONの読み込みに失敗しました(都道府県コード ${prefCode})。`);
  const data = await res.json();

  const boundaryLayer = L.geoJSON(data, {
    pane: "municipalityPane",
    style: { color: "#ccc", weight: 0.8, fill: false, interactive: false },
  }).addTo(map);

  const labelLayer = buildLabelLayer(
    data,
    //(p) => `${p.N03_003 ?? ""}${p.N03_004 ?? ""}` || null, // 郡まで表示する版
    (p) => `${p.N03_004 ?? ""}` || null, // 市区町村名だけ版
    "municipality-label",
  );

  return { boundaryLayer, labelLayer };
}

// GeoJSONの各featureについて、名前ラベルを1つ作ってLayerGroupにまとめる。
// ラベル位置はポリゴンのバウンディングボックス中心(重心ではない)。
// 離島持ちのfeature(例: 多くの飛び地を1つにまとめた市)は、本土から離れた
// 海上にラベルが出ることがある（一旦許容）
function buildLabelLayer(geojson, nameOf, className) {
  const group = L.layerGroup();

  for (const feature of geojson.features) {
    const name = nameOf(feature.properties);
    if (!name) continue;

    const center = L.geoJSON(feature).getBounds().getCenter();
    L.marker(center, {
      icon: L.divIcon({
        className: "",
        html: `<span class="${className}">${name}</span>`,
        iconSize: [0, 0],
      }),
      interactive: false,
    }).addTo(group);
  }

  return group;
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
