import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { decodeGeohash, encodeGeohash } from "./geohash.js";
import { addGraticule } from "./graticule.js";

// NOTE: ここでは意図的に L.tileLayer(...) を追加していない
// サードパーティ製のタイルプロバイダは使用しない
// 無料で運用できるように、都道府県市区町村境界だけ、
// https://github.com/smartnews-smri/japan-topography　の1%GeoJsonを使って描画してる
const JAPAN_BOUNDS = L.latLngBounds([17, 122], [46, 154]);

// Geohashの桁数(精度)ごとの色。精度が細かい(=判定エリアが狭い)ほど暖色にして目立たせる。
// 5桁=緑, 6桁=黄色, 7桁=赤。Ashi@が扱うのはこの3種類の桁数のみ。
const ASHIATO_COLORS_BY_LENGTH = {
  5: "#4caf50",
  6: "#fbc02d",
  7: "#e53935",
};
// セル内の全レコードが開封済みになったときだけ、桁数に関わらずグレーにする
// (main.js の computeCellState を参照)。
const OPENED_COLOR = "#888";

function colorFor(state, geohashLength) {
  if (state === "opened") return OPENED_COLOR;
  return ASHIATO_COLORS_BY_LENGTH[geohashLength] ?? ASHIATO_COLORS_BY_LENGTH[7];
}

// main.js側(エリアオーバーレイ用にcell.colorを覚えておく処理など)からも
// 同じ色計算を使えるようにエクスポートしたもの。
export function ashiatoColor(state, geohashLength) {
  return colorFor(state, geohashLength);
}

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

  // 「エリア」トグルで表示するGeohashセルの範囲。境界線より前面、あしあと本体より背面。
  map.createPane("areaOverlayPane");
  map.getPane("areaOverlayPane").style.zIndex = 650;

  // 投稿UI表示中、選択中の精度でのGeohashセル範囲をプレビュー表示するペイン。
  // areaOverlayPaneより前面、あしあと本体より背面。
  map.createPane("precisionPreviewPane");
  map.getPane("precisionPreviewPane").style.zIndex = 660;

  // あしあとは、Geohashの桁数が細かい(=判定エリアが狭い)ほど前面に描画する。
  // 前面から順に 7桁 > 6桁 > 5桁。
  map.createPane("ashiatoPane5");
  map.getPane("ashiatoPane5").style.zIndex = 680;
  map.createPane("ashiatoPane6");
  map.getPane("ashiatoPane6").style.zIndex = 690;
  map.createPane("ashiatoPane7");
  map.getPane("ashiatoPane7").style.zIndex = 700;

  // タップ判定も、見た目の重なり順(7→6→5)と一致させるため桁数ごとに分ける。
  // (どの桁数のペインよりも前面)
  map.createPane("ashiatoHitPane5");
  map.getPane("ashiatoHitPane5").style.zIndex = 710;
  map.createPane("ashiatoHitPane6");
  map.getPane("ashiatoHitPane6").style.zIndex = 720;
  map.createPane("ashiatoHitPane7");
  map.getPane("ashiatoHitPane7").style.zIndex = 730;

  // 現在地はAshiatoよりさらに手前
  map.createPane("currentLocationPane");
  map.getPane("currentLocationPane").style.zIndex = 750;

  // ポップアップ(同じセルに複数Ashiatoがある場合の一覧)は常に最前面。
  // Leafletが標準で用意しているpopupPaneのzIndexを、Ashiato/現在地より
  // 上に上書きするだけで良い(専用paneを新設する必要はない)。
  map.getPane("popupPane").style.zIndex = 900;

  // Leafletはコンテナのサイズを初期化時に一度だけ測ってキャッシュし、
  // 以後はwindowのresizeイベントくらいでしか再計測しない。
  // 今回のようにコンテナの高さがCSSのflexレイアウトで決まる場合や、
  // モバイルでアドレスバーの表示/非表示によって実質的な高さが変わる場合、
  // windowのresizeだけでは追従しきれないことがある(横方向は問題なく
  // 追従するのに縦方向だけずれる、という形で症状が出る)。
  // コンテナ要素自体をResizeObserverで監視し、サイズ変化のたびに
  // invalidateSize()でLeaflet側のキャッシュを強制的に更新する。
  if ("ResizeObserver" in window) {
    const resizeObserver = new ResizeObserver(() => map.invalidateSize());
    resizeObserver.observe(map.getContainer());
  }

  return map;
}

// 都道府県境界(常に表示) GeoJSONそのものも返すので、呼び出し側で
// prefectureIndex.js の buildPrefectureIndex に渡してバウンディングボックスを作れる。
// ラベルは境界線と別レイヤー(labelLayer)にして、呼び出し側で
// 境界線とは違うズーム閾値で表示/非表示を切り替えられるようにする。
export async function loadPrefectureBoundaries(map) {
  const res = await fetch("./data/maps/s0010/prefectures.json");
  if (!res.ok) throw new Error("都道府県境界GeoJSONの読み込みに失敗しました。");
  const data = await res.json();

  L.geoJSON(data, {
    pane: "prefecturePane",
    style: { color: "#666", weight: 1.5, fill: false, interactive: false },
  }).addTo(map);

  const labelLayer = buildLabelLayer(data, (p) => p.N03_001, "pref-label");

  return { data, labelLayer };
}

// 都道府県別の市区町村GeoJson(N03-21_{code}_210101.json)を取得する。
// 同じ都道府県コードへの呼び出しはPromiseをキャッシュして使い回すので、
// 地図描画用(loadMunicipalityBoundaries)と、下書きの場所逆引き用
// (municipalityLookup.js)の両方から呼んでも二重取得にならない。
const municipalityGeoJsonCache = new Map(); // prefCode -> Promise<GeoJSON>

export function fetchMunicipalityGeoJson(prefCode) {
  if (!municipalityGeoJsonCache.has(prefCode)) {
    municipalityGeoJsonCache.set(
      prefCode,
      fetch(`/data/maps/s0010/N03-21_${prefCode}_210101.json`).then((res) => {
        if (!res.ok)
          throw new Error(`市区町村境界GeoJSONの読み込みに失敗しました(都道府県コード ${prefCode})。`);
        return res.json();
      }),
    );
  }
  return municipalityGeoJsonCache.get(prefCode);
}

// 市区町村境界は必要になったときだけ読み込む。全国版(10MB)は使わない。
// boundaryLayerとlabelLayerを別に返すので、呼び出し側でそれぞれ別のズーム閾値で
// 表示/非表示を切り替えられる。
export async function loadMunicipalityBoundaries(map, prefCode) {
  const data = await fetchMunicipalityGeoJson(prefCode);

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

// 1つのgeohashセルにつき1グループ(円1〜2個)を描画する。
// count(そのセルに紐づく「表示対象」Ashiatoレコード数)が2件以上のときは、外側の輪+内側の点
// による二重丸にして、「同じ場所に複数のAshiatoがある」ことを視覚的に示す。
// クリック判定(hitArea)は常に1つ(グループ全体で1つのタップ対象)。
// 色・ペインはgeohashの桁数(5/6/7)に応じて決まる(呼び出し側でこの桁数のみに絞り込み済み)。
export function addAshiatoGroup(map, geohash, count, onOpen) {
  const b = decodeGeohash(geohash);
  const centerLat = (b.minLat + b.maxLat) / 2;
  const centerLon = (b.minLon + b.maxLon) / 2;
  const latlng = [centerLat, centerLon];
  const geohashLength = geohash.length;
  const pane = `ashiatoPane${geohashLength}`;
  const hitPane = `ashiatoHitPane${geohashLength}`;
  // 初期色。addAshiatoGroup直後に呼び出し側がsetAshiatoStateで確定させる想定。
  const color = colorFor("unlocked", geohashLength);

  const outer = L.circleMarker(latlng, {
    color,
    radius: count > 1 ? 6 : 4,
    weight: count > 1 ? 2 : 3,
    fill: count === 1, // 複数件のときは外側は輪だけ(内側の点と区別するため塗りつぶさない)
    interactive: false,
    pane,
  });

  const visualLayers = [outer];

  if (count > 1) {
    const inner = L.circleMarker(latlng, {
      color,
      radius: 2,
      interactive: false,
      pane,
    });
    visualLayers.push(inner);
  }

  // タップ判定用(見た目の円の数に関わらず1つ)
  const hitArea = L.circleMarker(latlng, {
    color,
    radius: 8,
    stroke: false,
    fill: true,
    fillOpacity: 0.5,
    interactive: true,
    pane: hitPane,
  });

  hitArea.on("click", () => onOpen());

  for (const v of visualLayers) v.addTo(map);
  hitArea.addTo(map);

  return { visualLayers, hitArea, geohashLength };
}

export function removeAshiatoGroup(map, { visualLayers, hitArea }) {
  for (const v of visualLayers) map.removeLayer(v);
  map.removeLayer(hitArea);
}

// state: "unlocked" | "opened"
// (ロック中=未発見のセルは地図に一切表示しない方針のため、"locked"状態は存在しない)
export function setAshiatoState({ visualLayers, hitArea, geohashLength }, state) {
  const color = colorFor(state, geohashLength);
  for (const v of visualLayers) v.setStyle({ color });
  hitArea.setStyle({ color, fillOpacity: 0.5 });
}

// 「エリア」トグル用: あしあとのGeohashセルの範囲そのものを、あしあと本体と同じ色で描画する。
// setEnabled/refreshどちらからでも再描画され、無効時は常に空(クリア)。
export function createAreaOverlay(map) {
  const group = L.layerGroup().addTo(map);
  let enabled = false;
  let currentCells = [];

  function render() {
    group.clearLayers();
    if (!enabled) return;

    for (const cell of currentCells) {
      // 地図に円が出ていない(=発見済みが1件も無い)セルは対象外
      if (!cell.visualLayers || !cell.color) continue;

      const b = decodeGeohash(cell.geohash);
      L.rectangle(
        [
          [b.minLat, b.minLon],
          [b.maxLat, b.maxLon],
        ],
        {
          pane: "areaOverlayPane",
          color: cell.color,
          weight: 1.5,
          fillColor: cell.color,
          fillOpacity: 0.15,
          interactive: false,
        },
      ).addTo(group);
    }
  }

  return {
    setEnabled(value) {
      enabled = value;
      render();
    },
    // cellsは呼び出し側(main.js)のashiatoCellsの現在値のスナップショットを渡す想定。
    // 各要素は { geohash, visualLayers, color } を持つこと。
    refresh(cells) {
      currentCells = cells;
      render();
    },
  };
}

// 投稿UI表示中、選択中の精度でのGeohashセル範囲をプレビュー表示する。
// areaOverlay(既存の「エリア」トグル)とは独立(投稿UI固有)。
// あしあと本体の色(5桁=緑, 6桁=黄, 7桁=赤)と紛らわしくならないよう、
// あしあとでは使っていない紫系で統一して表示する。
// show()はプレビュー用に計算したgeohash文字列を返す(呼び出し側で投稿本文の
// 組み立てに使い回せるように)。
const PRECISION_PREVIEW_COLOR = "#8e24aa";

export function createPrecisionPreviewLayer(map) {
  const rect = L.rectangle(
    [
      [0, 0],
      [0, 0],
    ],
    {
      pane: "precisionPreviewPane",
      color: PRECISION_PREVIEW_COLOR,
      weight: 2,
      fillColor: PRECISION_PREVIEW_COLOR,
      fillOpacity: 0.15,
      interactive: false,
    },
  );

  return {
    show(lat, lon, geohashLength) {
      const hash = encodeGeohash(lat, lon, geohashLength);
      const b = decodeGeohash(hash);
      rect.setBounds([
        [b.minLat, b.minLon],
        [b.maxLat, b.maxLon],
      ]);
      if (!map.hasLayer(rect)) rect.addTo(map);
      return hash;
    },
    hide() {
      if (map.hasLayer(rect)) map.removeLayer(rect);
    },
  };
}

// 現在地マーカー+精度円。専用paneに乗せ、Ashiatoより手前に表示する
export function createCurrentLocationLayer(map) {
  const accuracyCircle = L.circle([0, 0], {
    radius: 0,
    pane: "currentLocationPane",
    color: "#4285f4",
    weight: 1,
    fillColor: "#4285f4",
    fillOpacity: 0.15,
    interactive: false,
  });

  const dot = L.circleMarker([0, 0], {
    radius: 6,
    pane: "currentLocationPane",
    color: "#fff",
    weight: 2,
    fillColor: "#4285f4",
    fillOpacity: 1,
    interactive: false,
  });

  return {
    show(lat, lon, accuracyM) {
      const latlng = [lat, lon];
      dot.setLatLng(latlng);
      accuracyCircle.setLatLng(latlng).setRadius(accuracyM);
      if (!map.hasLayer(dot)) dot.addTo(map);
      if (!map.hasLayer(accuracyCircle)) accuracyCircle.addTo(map);
    },
    hide() {
      if (map.hasLayer(dot)) map.removeLayer(dot);
      if (map.hasLayer(accuracyCircle)) map.removeLayer(accuracyCircle);
    },
  };
}
