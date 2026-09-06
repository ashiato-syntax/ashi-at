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
  }).setView([34.69, 135.50], 9);
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
// ラベル位置は「一番面積が大きいポリゴンパーツの重心」。離島持ちのfeature
// (例: 本土+飛び地をまとめた都道府県)で、全パーツをまとめて重心を取ると
// 本土と離島の間の海上に落ちることがあるため、最大パーツだけを使う。
function buildLabelLayer(geojson, nameOf, className) {
  const group = L.layerGroup();

  for (const feature of geojson.features) {
    const name = nameOf(feature.properties);
    if (!name) continue;

    const center = labelPositionOf(feature.geometry);
    if (!center) continue;

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

function labelPositionOf(geometry) {
  const polygons =
    geometry.type === "Polygon" ? [geometry.coordinates] :
    geometry.type === "MultiPolygon" ? geometry.coordinates :
    [];

  let best = null;
  for (const polygon of polygons) {
    const c = ringCentroid(polygon[0]); // 外接だけ。穴は無視。
    if (!best || c.area > best.area) best = c;
  }
  return best ? [best.lat, best.lon] : null;
}

// 経緯度単位での、標準的な符号付き面積に基づく多角形重心（靴ひも公式）
// 正確な測地線上の重心ではないが、テキストラベルを配置するには十分な精度
function ringCentroid(ring) {
  let area = 0, cx = 0, cy = 0;

  for (let i = 0; i < ring.length - 1; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[i + 1];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  area /= 2;

  if (area === 0) {
    const n = ring.length - 1;
    const [sx, sy] = ring.slice(0, n).reduce(([ax, ay], [x, y]) => [ax + x, ay + y], [0, 0]);
    return { lon: sx / n, lat: sy / n, area: 0 };
  }

  return { lon: cx / (6 * area), lat: cy / (6 * area), area: Math.abs(area) };
}

export function addAshiato(map, result, onOpen) {
  const b = decodeGeohash(result.model.geohash);

  const centerLat = (b.minLat + b.maxLat) / 2;
  const centerLon = (b.minLon + b.maxLon) / 2;

  const r = L.circleMarker([centerLat, centerLon], {
    color: "#9bc403",
    radius: 3,
    interactive: true,
  });

  r.on("click", () => onOpen(result));
  r.addTo(map);

  return r;
}
