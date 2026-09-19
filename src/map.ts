import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { decodeGeohash, encodeGeohash } from "./geohash.js";
import type { AshiatoGroupHandle } from "./types.js";
import type { FeatureCollection, Geometry, Position } from "geojson";
import { createIcon } from "./icons.js";
import {
  LAND_FILL_COLOR_LIGHT,
  LAND_FILL_COLOR_DARK,
  PREFECTURE_DASH_ARRAY,
  PREFECTURE_BOUNDARY_COLOR_LIGHT,
  PREFECTURE_BOUNDARY_COLOR_DARK,
  PREFECTURE_BOUNDARY_WEIGHT,
  MUNICIPALITY_BOUNDARY_COLOR_LIGHT,
  MUNICIPALITY_BOUNDARY_COLOR_DARK,
  MUNICIPALITY_BOUNDARY_WEIGHT,
  WARD_DASH_ARRAY,
  WARD_BOUNDARY_COLOR_LIGHT,
  WARD_BOUNDARY_COLOR_DARK,
  ASHIATO_COLORS_BY_LENGTH_LIGHT,
  ASHIATO_COLORS_BY_LENGTH_DARK,
  ASHIATO_RARE_GRADIENT_STOPS,
  INSET_FRACTION,
  PRECISION_PREVIEW_COLOR,
  CURRENT_LOCATION_COLOR,
  RAILWAY_COLOR_LIGHT,
  RAILWAY_COLOR_DARK,
  RAILWAY_WEIGHT,
  STATION_RADIUS,
} from "./config.js";

// NOTE: ここでは意図的に L.tileLayer(...) を追加していない
// サードパーティ製のタイルプロバイダは使用しない
// 無料で運用できるように、都道府県市区町村境界だけ、
// https://github.com/smartnews-smri/japan-topography　の1%GeoJsonを使って描画してる
const JAPAN_BOUNDS = L.latLngBounds([17, 122], [46, 154]);

// 陸地・境界線の色はLeafletがSVGのfill/stroke属性としてJSから直接書き込むため、
// CSSのdata-theme切り替えだけでは追従しない(config.ts参照)。都度、現在の
// テーマ(main.ts: applyThemeが<html>に付けるdata-theme属性)を見て選ぶ。
function isDarkTheme(): boolean {
  return document.documentElement.dataset.theme === "dark";
}
function landFillColor(): string {
  return isDarkTheme() ? LAND_FILL_COLOR_DARK : LAND_FILL_COLOR_LIGHT;
}
function prefectureBoundaryColor(): string {
  return isDarkTheme() ? PREFECTURE_BOUNDARY_COLOR_DARK : PREFECTURE_BOUNDARY_COLOR_LIGHT;
}
function municipalityBoundaryColor(): string {
  return isDarkTheme() ? MUNICIPALITY_BOUNDARY_COLOR_DARK : MUNICIPALITY_BOUNDARY_COLOR_LIGHT;
}
function wardBoundaryColor(): string {
  return isDarkTheme() ? WARD_BOUNDARY_COLOR_DARK : WARD_BOUNDARY_COLOR_LIGHT;
}
function railwayColor(): string {
  return isDarkTheme() ? RAILWAY_COLOR_DARK : RAILWAY_COLOR_LIGHT;
}

function ringsOf(geometry: Geometry): Position[][] {
  if (geometry.type === "Polygon") return geometry.coordinates;
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat();
  return [];
}

// 浮動小数点の微妙な誤差で「同じ頂点なのに一致しない」ことがないよう、
// 座標を丸めた上でキー化する。
function coordKey(c: Position): string {
  return `${c[0].toFixed(7)},${c[1].toFixed(7)}`;
}

interface BoundaryEdge {
  count: number;
  a: Position;
  b: Position;
  keyA: string;
  keyB: string;
}

interface BoundaryNeighbor {
  to: string;
  edgeKey: string;
  coord: Position;
}

// 辺の集合(内陸の境界・海岸線等、絞り込み済みのもの)を、1本ずつの連続した線
// (チェーン)として再構成する共通処理。extractPrefectureBoundaryChains/
// extractMunicipalityBoundaryChainsの両方から使う。
//
// 1. 対象の辺だけで頂点の隣接グラフを作り、分岐点・端点(隣接する辺が
//    ちょうど2本ではない頂点)を起点に、辺を1本ずつ辿って繋ぎ合わせる。
//    バラバラの2頂点の線分としてではなく1本の連続した線にすることで、
//    dashArrayによる破線・点線のリズムが繋ぎ目でリセットされず
//    綺麗に続くようにする。
// 2. どの分岐点・端点にも繋がらない閉ループ(飛び地を囲む境界線など、
//    次数2の頂点だけで構成される辺の輪)は最後にまとめて処理する。
function chainEdges(internalEdges: BoundaryEdge[]): [number, number][][] {
  const adjacency = new Map<string, BoundaryNeighbor[]>();
  const vertexCoord = new Map<string, Position>();

  const addNeighbor = (from: string, to: string, edgeKey: string, toCoord: Position) => {
    let list = adjacency.get(from);
    if (!list) {
      list = [];
      adjacency.set(from, list);
    }
    list.push({ to, edgeKey, coord: toCoord });
  };

  for (const { a, b, keyA, keyB } of internalEdges) {
    const edgeKey = keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;
    vertexCoord.set(keyA, a);
    vertexCoord.set(keyB, b);
    addNeighbor(keyA, keyB, edgeKey, b);
    addNeighbor(keyB, keyA, edgeKey, a);
  }

  const usedEdges = new Set<string>();

  // startKeyからfirstの方向へ辺を辿り、次数がちょうど2の頂点を通過点として
  // 繋ぎながら、分岐点・端点(または閉ループの一周)に着くまで進む。
  function walk(startKey: string, first: BoundaryNeighbor): Position[] {
    const chain: Position[] = [vertexCoord.get(startKey)!, first.coord];
    usedEdges.add(first.edgeKey);
    let currentKey = first.to;

    for (;;) {
      const neighbors = adjacency.get(currentKey)!;
      if (neighbors.length !== 2) break; // 分岐点・端点に到着

      const next = neighbors.find((n) => !usedEdges.has(n.edgeKey));
      if (!next) break; // 閉ループを一周し終えた

      usedEdges.add(next.edgeKey);
      chain.push(next.coord);
      currentKey = next.to;
    }

    return chain;
  }

  const chains: Position[][] = [];

  // 1. 分岐点・端点から辿る
  for (const [vertexKey, neighbors] of adjacency) {
    if (neighbors.length === 2) continue;
    for (const n of neighbors) {
      if (usedEdges.has(n.edgeKey)) continue;
      chains.push(walk(vertexKey, n));
    }
  }

  // 2. 残り(次数2の頂点だけで構成される閉ループ)を処理する
  for (const [vertexKey, neighbors] of adjacency) {
    for (const n of neighbors) {
      if (usedEdges.has(n.edgeKey)) continue;
      chains.push(walk(vertexKey, n));
    }
  }

  // GeoJSONの座標は[lon, lat]、Leafletは[lat, lon]の順序なので入れ替える。
  return chains.map((chain) => chain.map((c): [number, number] => [c[1], c[0]]));
}

interface PrefectureBoundaryChains {
  // 内陸の県境(隣の都道府県ポリゴンと共有している辺)
  internalChains: [number, number][][];
  // 海岸線(どの都道府県とも共有していない、1回しか出てこない辺)
  coastlineChains: [number, number][][];
}

// 都道府県境界(prefectures.json)から、「内陸の県境」と「海岸線」をそれぞれ
// 1本ずつの連続した線として再構成する。全ポリゴンの辺(隣接する2頂点の組)を
// 数え上げ、2回出てくる辺(隣の都道府県のポリゴンにも同じ辺があり、境界を
// 共有している=内陸の県境)と、1回しか出てこない辺(どの都道府県とも
// 共有していない=海岸線)とに分ける。
// ライトモードでは陸地の塗りと海の背景色の境目だけで海岸線が読み取れるため
// coastlineChainsは使わないが、ダークモードでは陸地と海の明度差が付けにくく
// 境目が分かりづらいため、市区町村境界線と同じ見た目で描画する
// (loadPrefectureBoundaries参照)。
//
// 都道府県データは47件・頂点数は合計6万程度で、この処理は起動時に1回だけ
// (loadPrefectureBoundaries内で)行うだけなので重くはならない。
function extractPrefectureBoundaryChains(
  geojson: FeatureCollection<Geometry>,
): PrefectureBoundaryChains {
  const edges = new Map<string, BoundaryEdge>();

  for (const feature of geojson.features) {
    for (const ring of ringsOf(feature.geometry)) {
      for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i];
        const b = ring[i + 1];
        const keyA = coordKey(a);
        const keyB = coordKey(b);
        const key = keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;

        const existing = edges.get(key);
        if (existing) existing.count++;
        else edges.set(key, { count: 1, a, b, keyA, keyB });
      }
    }
  }

  const allEdges = [...edges.values()];
  return {
    internalChains: chainEdges(allEdges.filter((e) => e.count === 2)),
    coastlineChains: chainEdges(allEdges.filter((e) => e.count === 1)),
  };
}

// フィーチャが政令指定都市の区(N03_003が「〜市」で終わる)なら親市名を返す。
// それ以外(区が無い市町村)はnull。boundary用のグループ分け・ラベル用の
// グループ分けの両方が、この判定を土台にしている。
function designatedCityNameOf(props: MunicipalityProperties): string | null {
  return props.N03_003?.endsWith("市") ? props.N03_003 : null;
}

// 政令指定都市の区は同じ親市名でまとめ、それ以外(区が無い市町村)は
// 自分自身の市区町村名を1件だけのグループとする。
function municipalityGroupKey(props: MunicipalityProperties): string {
  return designatedCityNameOf(props) ?? props.N03_004 ?? "";
}

interface MunicipalityBoundaryChains {
  // 通常の市区町村境界(政令市の場合はその市全体の外縁を含む)
  cityBoundaryChains: [number, number][][];
  // 政令指定都市内部の区どうしの境界だけ(外縁より薄い色で描画する対象)
  wardInternalChains: [number, number][][];
}

// 市区町村境界(1都道府県分のN03-21_{code}_...json)から、海岸線・都道府県境を
// 除いた内陸の境界を再構成する。extractPrefectureBoundaryChainsとほぼ同じだが、
// 2回出てくる辺(内陸の境界)をさらに2種類に分類する:
// - 政令指定都市の区どうしが共有する辺(同じ親市の区+区) → wardInternalChains
// - それ以外(政令市の外縁、区が無い市町村どうしの境界など) → cityBoundaryChains
// 1つの都道府県データだけを見た場合、どちらのケースでも「1回しか出てこない辺」は
// 海岸線か都道府県境のどちらかであり、区別する必要なくまとめて除外できる。
function extractMunicipalityBoundaryChains(
  geojson: FeatureCollection<Geometry, MunicipalityProperties>,
): MunicipalityBoundaryChains {
  const edges = new Map<string, BoundaryEdge & { groups: string[] }>();

  for (const feature of geojson.features) {
    const group = municipalityGroupKey(feature.properties ?? {});
    for (const ring of ringsOf(feature.geometry)) {
      for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i];
        const b = ring[i + 1];
        const keyA = coordKey(a);
        const keyB = coordKey(b);
        const key = keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`;

        const existing = edges.get(key);
        if (existing) {
          existing.count++;
          existing.groups.push(group);
        } else {
          edges.set(key, { count: 1, a, b, keyA, keyB, groups: [group] });
        }
      }
    }
  }

  const wardInternalEdges: BoundaryEdge[] = [];
  const cityBoundaryEdges: BoundaryEdge[] = [];

  for (const e of edges.values()) {
    if (e.count !== 2) continue; // 1回だけ=海岸線・都道府県境はここで除外される
    (e.groups[0] === e.groups[1] ? wardInternalEdges : cityBoundaryEdges).push(e);
  }

  return {
    cityBoundaryChains: chainEdges(cityBoundaryEdges),
    wardInternalChains: chainEdges(wardInternalEdges),
  };
}

// Geohashの桁数(精度)ごとの色(ASHIATO_COLORS_BY_LENGTH_LIGHT/_DARK)は
// config.ts参照。ライト/ダークで別の色を使うため、他の地図の色(landFillColor
// 等)と同じくここでテーマを見て選ぶ。main.js側(エリアオーバーレイの色計算・
// 表示レイヤーのchip色・凡例の色見本等)からも使えるようにエクスポートする。
export function ashiatoColor(geohashLength: number): string {
  const table = isDarkTheme() ? ASHIATO_COLORS_BY_LENGTH_DARK : ASHIATO_COLORS_BY_LENGTH_LIGHT;
  return table[geohashLength] ?? table[7];
}

export function createMap(el: string | HTMLElement): L.Map {
  const map = L.map(el, {
    attributionControl: false,
    zoomControl: false, // 標準のズームコントロールは自前で追加する(下記参照)
    minZoom: 4, // ズームアウトの制限。大体日本が全部収まるくらい
    maxBounds: JAPAN_BOUNDS,
    maxBoundsViscosity: 0.8, // 表示領域をはみ出たらふわっと戻す
  }).setView([34.69, 135.50], 9);

  // ズームボタン。標準のズームコントロールは英語のtitle・"+"/"−"の文字表示・
  // 角ばった見た目のままなので、日本語のtitleに変えた上でlucideアイコンに
  // 差し替える(見た目自体の丸み・影はstyle.cssの.leaflet-control-zoom側で付ける)。
  const zoomControl = L.control.zoom({ zoomInTitle: "拡大", zoomOutTitle: "縮小" }).addTo(map);
  const zoomContainer = zoomControl.getContainer();
  zoomContainer?.querySelector(".leaflet-control-zoom-in")?.replaceChildren(createIcon("plus"));
  zoomContainer?.querySelector(".leaflet-control-zoom-out")?.replaceChildren(createIcon("minus"));

  // 陸地(都道府県ポリゴンの塗りつぶし)専用のペイン。
  // グリッド(デフォルトのoverlayPane, z-index 400)より前面、
  // 市区町村・都道府県の境界線より背面に置くことで、
  // 「塗りつぶしの上に境界線が乗る」見た目にする(逆順だと境界線が塗りに隠れる)。
  map.createPane("landPane");
  map.getPane("landPane")!.style.zIndex = "405";

  // 都道府県の境界線が常に市区町村の境界線より前面に描画されるように、専用のペインを割り当て
  map.createPane("municipalityPane");
  map.getPane("municipalityPane")!.style.zIndex = "410";
  // 鉄道路線は市区町村境界より前面、都道府県境界より背面に描画する。
  map.createPane("railwayPane");
  map.getPane("railwayPane")!.style.zIndex = "415";
  // 駅は路線の線より前面に描画する(線の上に点が乗る見た目にする)。
  map.createPane("stationPane");
  map.getPane("stationPane")!.style.zIndex = "416";
  // 路線・駅は東京のような密集地域だと点数(セグメント数・駅数)がかなり多く、
  // 既定のSVGレンダラー(要素1つ1つが個別のDOM要素になる)だと重くなるため、
  // 1枚のcanvasにまとめて描くCanvasレンダラーを使う。都道府県をまたいで
  // 全て同じレンダラーを使い回す(loadRailways参照)。
  railwayRenderer = L.canvas({ pane: "railwayPane" });
  stationRenderer = L.canvas({ pane: "stationPane" });
  map.createPane("prefecturePane");
  map.getPane("prefecturePane")!.style.zIndex = "420";

  // 投稿UI表示中、選択中の精度でのGeohashセル範囲をプレビュー表示するペイン。
  // 境界線より前面、あしあと本体より背面。
  map.createPane("precisionPreviewPane");
  map.getPane("precisionPreviewPane")!.style.zIndex = "660";

  // あしあとは、Geohashの桁数が細かい(=判定エリアが狭い)ほど前面に描画する。
  // 前面から順に 7桁 > 6桁 > 5桁 > 4桁 > 3桁。
  map.createPane("ashiatoPane3");
  map.getPane("ashiatoPane3")!.style.zIndex = "665";
  map.createPane("ashiatoPane4");
  map.getPane("ashiatoPane4")!.style.zIndex = "670";
  map.createPane("ashiatoPane5");
  map.getPane("ashiatoPane5")!.style.zIndex = "680";
  map.createPane("ashiatoPane6");
  map.getPane("ashiatoPane6")!.style.zIndex = "690";
  map.createPane("ashiatoPane7");
  map.getPane("ashiatoPane7")!.style.zIndex = "700";

  // タップ判定も、見た目の重なり順(7→6→5→4→3)と一致させるため桁数ごとに分ける。
  // (どの桁数のペインよりも前面)
  map.createPane("ashiatoHitPane3");
  map.getPane("ashiatoHitPane3")!.style.zIndex = "702";
  map.createPane("ashiatoHitPane4");
  map.getPane("ashiatoHitPane4")!.style.zIndex = "705";
  map.createPane("ashiatoHitPane5");
  map.getPane("ashiatoHitPane5")!.style.zIndex = "710";
  map.createPane("ashiatoHitPane6");
  map.getPane("ashiatoHitPane6")!.style.zIndex = "720";
  map.createPane("ashiatoHitPane7");
  map.getPane("ashiatoHitPane7")!.style.zIndex = "730";

  // 現在地はAshiatoよりさらに手前
  map.createPane("currentLocationPane");
  map.getPane("currentLocationPane")!.style.zIndex = "750";

  // ポップアップ(同じセルに複数Ashiatoがある場合の一覧)は常に最前面。
  // Leafletが標準で用意しているpopupPaneのzIndexを、Ashiato/現在地より
  // 上に上書きするだけで良い(専用paneを新設する必要はない)。
  map.getPane("popupPane")!.style.zIndex = "900";

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

interface PrefectureProperties {
  N03_001?: string;
}

interface BoundaryResult {
  data: FeatureCollection<Geometry, PrefectureProperties>;
  labelLayer: L.LayerGroup;
}

// 都道府県境界(常に表示) GeoJSONそのものも返すので、呼び出し側で
// prefectureIndex.js の buildPrefectureIndex に渡してバウンディングボックスを作れる。
// ラベルは境界線と別レイヤー(labelLayer)にして、呼び出し側で
// 境界線とは違うズーム閾値で表示/非表示を切り替えられるようにする。
// 境界線(線のみ)とは別に、同じGeoJsonをlandPaneへ塗りつぶし表示することで
// 「陸地の色」を表現する(海は#mapのCSS背景色)。
// テーマ切り替え時、既に描画済みの陸地塗りつぶし・都道府県境界線を再着色するために
// モジュールスコープで保持しておく(main.ts: applyThemeからrestyleMapForTheme経由で呼ばれる)。
let landLayer: L.GeoJSON | null = null;
let prefectureBoundaryLayer: L.Polyline | null = null;
// 海岸線(ダークモードのみ表示。restyleMapForTheme側でmap本体への
// add/removeを切り替えるため、地図本体への参照も一緒に覚えておく)。
let coastlineLayer: L.Polyline | null = null;
let mapRef: L.Map | null = null;
// 鉄道路線・駅の描画に使う共有Canvasレンダラー(createMap内で生成、loadRailways参照)。
let railwayRenderer: L.Canvas | null = null;
let stationRenderer: L.Canvas | null = null;
// 市区町村境界も同様(main.ts側のmunicipalityLayersキャッシュに対応する分だけ、
// prefCodeごとに市区町村境界+区境界のポリラインを覚えておく)。
const municipalityBoundaryLayersByPrefCode = new Map<
  string,
  { cityBoundaryLine: L.Polyline; wardBoundaryLine: L.Polyline }
>();
// 鉄道路線・駅も同様(main.ts側のrailwayLayersキャッシュに対応する分だけ、
// prefCodeごとに描画済みのL.GeoJSONレイヤーを覚えておく)。
const railwayLineLayersByPrefCode = new Map<string, L.GeoJSON>();
const stationLayersByPrefCode = new Map<string, L.GeoJSON>();

export async function loadPrefectureBoundaries(map: L.Map): Promise<BoundaryResult> {
  const res = await fetch("./data/maps/prefectures.json");
  if (!res.ok) throw new Error("都道府県境界GeoJSONの読み込みに失敗しました。");
  const data: FeatureCollection<Geometry, PrefectureProperties> = await res.json();

  landLayer = L.geoJSON(data, {
    pane: "landPane",
    style: {
      stroke: false,
      fill: true,
      fillColor: landFillColor(),
      fillOpacity: 1,
      interactive: false,
    },
  }).addTo(map);

  mapRef = map;

  const { internalChains, coastlineChains } = extractPrefectureBoundaryChains(data);

  // 内陸の県境だけを一点鎖線で描画する。海岸線はライトモードでは引かない
  // (上のlandPaneの塗りつぶし(陸地)とmap.wrapのCSS背景色(海)の境目だけで
  // 十分読み取れるため)。
  prefectureBoundaryLayer = L.polyline(internalChains, {
    pane: "prefecturePane",
    color: prefectureBoundaryColor(),
    weight: PREFECTURE_BOUNDARY_WEIGHT,
    interactive: false,
    dashArray: PREFECTURE_DASH_ARRAY,
  }).addTo(map);

  // 海岸線はダークモードのときだけ描画する(暗い背景では陸地と海の明度差が
  // 付けにくく、境目が分かりづらいため)。線の色・種類は市区町村境界線と
  // 同じにする(実線・同じ太さ・同じ色)。
  coastlineLayer = L.polyline(coastlineChains, {
    pane: "prefecturePane",
    color: municipalityBoundaryColor(),
    weight: MUNICIPALITY_BOUNDARY_WEIGHT,
    interactive: false,
  });
  if (isDarkTheme()) coastlineLayer.addTo(map);

  const labelLayer = buildPrefectureLabelLayer(data);

  return { data, labelLayer };
}

// 都道府県ラベルは都道府県ポリゴン自体の重心(最大パーツ)に表示する。
function buildPrefectureLabelLayer(
  geojson: FeatureCollection<Geometry, PrefectureProperties>,
): L.LayerGroup {
  const group = L.layerGroup();

  for (const feature of geojson.features) {
    const name = feature.properties?.N03_001;
    if (!name) continue;

    const center = labelPositionOf(feature.geometry);
    if (!center) continue;

    L.marker(center, {
      icon: L.divIcon({
        className: "",
        html: `<span class="pref-label">${name}</span>`,
        iconSize: [0, 0],
      }),
      interactive: false,
    }).addTo(group);
  }

  return group;
}

interface MunicipalityProperties {
  N03_003?: string;
  N03_004?: string;
}

// 東京都(コード13)は特別扱いする(下記TOKYO_PREF_CODE参照)ため、このテーブルには含めない。
// 都道府県コード(N03-21_{code}_210101.jsonのcode)ごとの県庁所在地(の市区町村)名。
// 政令指定都市が県庁所在地の場合はその市名(例:"横浜市")、それ以外は市区町村名
// そのもの(例:"水戸市")。
const PREFECTURE_CAPITAL_NAME_BY_CODE: Record<string, string> = {
  "01": "札幌市", "02": "青森市", "03": "盛岡市", "04": "仙台市", "05": "秋田市",
  "06": "山形市", "07": "福島市", "08": "水戸市", "09": "宇都宮市", "10": "前橋市",
  "11": "さいたま市", "12": "千葉市", "14": "横浜市", "15": "新潟市",
  "16": "富山市", "17": "金沢市", "18": "福井市", "19": "甲府市", "20": "長野市",
  "21": "岐阜市", "22": "静岡市", "23": "名古屋市", "24": "津市", "25": "大津市",
  "26": "京都市", "27": "大阪市", "28": "神戸市", "29": "奈良市", "30": "和歌山市",
  "31": "鳥取市", "32": "松江市", "33": "岡山市", "34": "広島市", "35": "山口市",
  "36": "徳島市", "37": "高松市", "38": "松山市", "39": "高知市", "40": "福岡市",
  "41": "佐賀市", "42": "長崎市", "43": "熊本市", "44": "大分市", "45": "宮崎市",
  "46": "鹿児島市", "47": "那覇市",
};

// 都道府県別の市区町村GeoJson(N03-21_{code}_210101.json)を取得する。
// 同じ都道府県コードへの呼び出しはPromiseをキャッシュして使い回すので、
// 地図描画用(loadMunicipalityBoundaries)と、下書きの場所逆引き用
// (municipalityLookup.js)の両方から呼んでも二重取得にならない。
const municipalityGeoJsonCache = new Map<
  string,
  Promise<FeatureCollection<Geometry, MunicipalityProperties>>
>(); // prefCode -> Promise<GeoJSON>

export function fetchMunicipalityGeoJson(
  prefCode: string,
): Promise<FeatureCollection<Geometry, MunicipalityProperties>> {
  if (!municipalityGeoJsonCache.has(prefCode)) {
    const promise = fetch(`./data/maps/municipalities/N03-21_${prefCode}_210101.json`).then((res) => {
      if (!res.ok)
        throw new Error(`市区町村境界GeoJSONの読み込みに失敗しました(都道府県コード ${prefCode})。`);
      return res.json();
    });
    // 失敗したPromiseをキャッシュに残したままにすると、電波が回復した後も
    // 二度と再取得できなくなる。失敗時だけキャッシュから外し、次回の呼び出しで
    // 再試行できるようにする(成功時はそのままキャッシュに残す)。
    promise.catch(() => municipalityGeoJsonCache.delete(prefCode));
    municipalityGeoJsonCache.set(prefCode, promise);
  }
  return municipalityGeoJsonCache.get(prefCode)!;
}


export interface MunicipalityBoundaryResult {
  boundaryLayer: L.LayerGroup;
  labelLayer: L.LayerGroup;
  // 県庁所在地・政令指定都市の大きいラベル。regularなlabelLayerとは別の
  // ズーム閾値(main.jsのMIN_ZOOM_FOR_CAPITAL_LABELS)で表示/非表示を切り替える。
  prominentLabelLayer: L.LayerGroup;
}

// 市区町村境界は必要になったときだけ読み込む。全国版(10MB)は使わない。
// boundaryLayer・labelLayer・prominentLabelLayerを別に返すので、呼び出し側で
// それぞれ別のズーム閾値で表示/非表示を切り替えられる。陸地の塗りつぶしは
// 都道府県レベルで既に描画済みなので、市区町村側は境界線(線のみ)だけでよい。
export async function loadMunicipalityBoundaries(
  map: L.Map,
  prefCode: string,
): Promise<MunicipalityBoundaryResult> {
  const data = await fetchMunicipalityGeoJson(prefCode);

  const { cityBoundaryChains, wardInternalChains } = extractMunicipalityBoundaryChains(data);

  // 通常の市区町村境界(政令指定都市の場合はその市全体の外縁を含む)。
  const cityBoundaryLine = L.polyline(cityBoundaryChains, {
    pane: "municipalityPane",
    color: municipalityBoundaryColor(),
    weight: MUNICIPALITY_BOUNDARY_WEIGHT,
    interactive: false,
  });

  // 政令指定都市内部の区どうしの境界だけ、外縁より薄い色で重ねる。
  const wardBoundaryLine = L.polyline(wardInternalChains, {
    pane: "municipalityPane",
    color: wardBoundaryColor(),
    weight: MUNICIPALITY_BOUNDARY_WEIGHT,
    interactive: false,
    dashArray: WARD_DASH_ARRAY,
  });

  municipalityBoundaryLayersByPrefCode.set(prefCode, { cityBoundaryLine, wardBoundaryLine });

  const boundaryLayer = L.layerGroup([cityBoundaryLine, wardBoundaryLine]).addTo(map);

  const { labelLayer, prominentLabelLayer } = buildMunicipalityLabelLayers(data, prefCode);

  return { boundaryLayer, labelLayer, prominentLabelLayer };
}

interface RailwayProperties {
  N02_003?: string; // 路線名
  N02_004?: string; // 運営会社
}

interface StationProperties extends RailwayProperties {
  N02_005?: string; // 駅名
  N02_005g?: string; // グループコード(同じ物理的な駅を束ねるID。路線ごとに別フィーチャでも共通)
}

// 都道府県別の鉄道路線/駅GeoJson(N02-25_{code}.json、scripts/build-railways.mjs
// で全国データを都道府県ごとに分割・簡略化したもの)を取得する。
// 市区町村境界(fetchMunicipalityGeoJson)と同じ理由でPromiseをキャッシュする。
const railwayGeoJsonCache = new Map<
  string,
  Promise<FeatureCollection<Geometry, RailwayProperties>>
>(); // prefCode -> Promise<GeoJSON>
const stationGeoJsonCache = new Map<
  string,
  Promise<FeatureCollection<Geometry, StationProperties>>
>();

function fetchRailwayGeoJson(
  prefCode: string,
): Promise<FeatureCollection<Geometry, RailwayProperties>> {
  if (!railwayGeoJsonCache.has(prefCode)) {
    const promise = fetch(`./data/maps/railways/N02-25_${prefCode}.json`).then((res) => {
      if (!res.ok)
        throw new Error(`鉄道路線GeoJSONの読み込みに失敗しました(都道府県コード ${prefCode})。`);
      return res.json();
    });
    promise.catch(() => railwayGeoJsonCache.delete(prefCode));
    railwayGeoJsonCache.set(prefCode, promise);
  }
  return railwayGeoJsonCache.get(prefCode)!;
}

function fetchStationGeoJson(
  prefCode: string,
): Promise<FeatureCollection<Geometry, StationProperties>> {
  if (!stationGeoJsonCache.has(prefCode)) {
    const promise = fetch(`./data/maps/stations/N02-25_${prefCode}.json`).then((res) => {
      if (!res.ok)
        throw new Error(`駅GeoJSONの読み込みに失敗しました(都道府県コード ${prefCode})。`);
      return res.json();
    });
    promise.catch(() => stationGeoJsonCache.delete(prefCode));
    stationGeoJsonCache.set(prefCode, promise);
  }
  return stationGeoJsonCache.get(prefCode)!;
}

export interface RailwayResult {
  lineLayer: L.GeoJSON;
  stationLayer: L.GeoJSON;
  stationLabelLayer: L.LayerGroup;
}

// 鉄道路線・駅も市区町村境界と同じく必要になったときだけ読み込む。
// 元データが都道府県境で機械的に分割されておらず、県境をまたぐ路線・駅は
// 隣接する都道府県のファイルにも重複して含まれているため、そのまま重ねて
// 描画しても隙間や二重線・二重の点にはならない(単純な重ね描き)。
export async function loadRailways(map: L.Map, prefCode: string): Promise<RailwayResult> {
  const [lineData, stationData] = await Promise.all([
    fetchRailwayGeoJson(prefCode),
    fetchStationGeoJson(prefCode),
  ]);

  const lineLayer = L.geoJSON(lineData, {
    // GeoJSONOptionsの型定義自体にはrendererが無いため、PathOptionsを
    // 受け付けるstyle側に含める(実行時はここからPolylineの構築optionsに
    // マージされ、rendererとして機能する)。
    style: { color: railwayColor(), weight: RAILWAY_WEIGHT, renderer: railwayRenderer! },
    interactive: false,
  }).addTo(map);
  railwayLineLayersByPrefCode.set(prefCode, lineLayer);

  // 駅データはgml上「短い線」だが、build-railways.mjs側でPointに変換済み。
  // 小さい●として打つ(路線と同じ色に揃える)。
  // 注意: L.geoJSONのトップレベルのrenderer/paneオプションは、pointToLayerで
  // 自前生成するレイヤーには伝播しない。circleMarker自身のoptionsに明示しないと
  // 既定のSVGレンダラー・overlayPane(z-index 400、landPaneの405より背面)に
  // 描画され、陸地の塗りつぶしの下に隠れてしまう(実際にこの不具合が発生した)。
  // 路線の線より近くまでズームしないと表示しない(main.ts: MIN_ZOOM_FOR_STATIONS)
  // ため、こちらはlineLayerと違ってここではmapに追加せず、呼び出し側に委ねる。
  const stationLayer = L.geoJSON(stationData, {
    pointToLayer: (_feature, latlng) =>
      L.circleMarker(latlng, {
        renderer: stationRenderer!,
        radius: STATION_RADIUS,
        color: railwayColor(),
        weight: 1,
        fillColor: railwayColor(),
        fillOpacity: 1,
      }),
    interactive: false,
  });
  stationLayersByPrefCode.set(prefCode, stationLayer);

  // 同じ物理的な駅でも路線ごとに別フィーチャになっている(例: 大阪梅田駅が
  // 阪急神戸線・宝塚線・京都線でそれぞれ1件ずつ)。groupCode(N02_005g)が
  // 同じフィーチャは同じ駅とみなし、ラベルは重複させず最初の1件だけ出す。
  // ●自体(stationLayer)は路線ごとに重なって描かれても実害が無いためそのまま。
  const stationLabelLayer = L.layerGroup();
  const seenStationGroups = new Set<string>();
  for (const feature of stationData.features) {
    const name = feature.properties?.N02_005;
    if (!name) continue;
    const groupKey = feature.properties?.N02_005g ?? name;
    if (seenStationGroups.has(groupKey)) continue;
    seenStationGroups.add(groupKey);

    const geom = feature.geometry;
    if (!geom || geom.type !== "Point") continue;
    const [lon, lat] = geom.coordinates;
    L.marker([lat, lon], {
      icon: L.divIcon({
        className: "",
        html: `<span class="station-label">${name}</span>`,
        iconSize: [0, 0],
      }),
      interactive: false,
    }).addTo(stationLabelLayer);
  }

  return { lineLayer, stationLayer, stationLabelLayer };
}

// テーマ切り替え時(main.ts: applyTheme)に呼ぶ。陸地の塗りつぶし・都道府県境界線・
// これまでに読み込み済みの市区町村境界線(すべてloadPrefectureBoundaries/
// loadMunicipalityBoundariesが保持しているモジュールスコープの参照)を、
// GeoJsonを読み直すことなくsetStyleだけで再着色する。
export function restyleMapForTheme(): void {
  landLayer?.setStyle({ fillColor: landFillColor() });
  prefectureBoundaryLayer?.setStyle({ color: prefectureBoundaryColor() });
  if (coastlineLayer) {
    coastlineLayer.setStyle({ color: municipalityBoundaryColor() });
    // ダークモードのときだけ地図に乗せる(ライトモードでは海岸線を引かない)。
    const shouldShow = isDarkTheme();
    const isShown = mapRef?.hasLayer(coastlineLayer) ?? false;
    if (shouldShow && !isShown) coastlineLayer.addTo(mapRef!);
    else if (!shouldShow && isShown) mapRef!.removeLayer(coastlineLayer);
  }
  for (const { cityBoundaryLine, wardBoundaryLine } of municipalityBoundaryLayersByPrefCode.values()) {
    cityBoundaryLine.setStyle({ color: municipalityBoundaryColor() });
    wardBoundaryLine.setStyle({ color: wardBoundaryColor() });
  }
  for (const lineLayer of railwayLineLayersByPrefCode.values()) {
    lineLayer.setStyle({ color: railwayColor() });
  }
  for (const stationLayer of stationLayersByPrefCode.values()) {
    stationLayer.setStyle({ color: railwayColor(), fillColor: railwayColor() });
  }
}

interface MunicipalityLabelLayers {
  labelLayer: L.LayerGroup;
  prominentLabelLayer: L.LayerGroup;
}

// 東京都(特別区)のコード。東京23区は政令指定都市の区と違いN03_003に親市名を
// 持たず(23区それぞれが独立した自治体のため)、「東京市」のような上位の市区分も
// 存在しない。そのためprominentLabelGroupKeyでは、区名(「〜区」)を持つ東京都の
// フィーチャを、政令指定都市の区と同じ「大きいラベル用グループ」の一種として
// (県庁所在地名の新宿区ではなく)「東京」にまとめる。
// 新宿区自体は他の22区と同じ通常の市区町村ラベル(labelLayer)は変わらず出す。
const TOKYO_PREF_CODE = "13";
const TOKYO_WARDS_LABEL = "東京";

// 「大きいラベル」を出す対象かどうかを判定し、そのグループキーを返す。
// - 政令指定都市の区 → 親市名(例:"横浜市")
// - 東京都の特別区(区が無い政令指定都市の一種として扱う) → "東京"
// - どちらでもなければnull(この時点では県庁所在地かどうかは見ていない。
//   政令指定都市ではない県庁所在地は呼び出し側でcapitalNameと比較して扱う)
function prominentLabelGroupKey(props: MunicipalityProperties, prefCode: string): string | null {
  const designatedCity = designatedCityNameOf(props);
  if (designatedCity) return designatedCity;
  if (prefCode === TOKYO_PREF_CODE && props.N03_004?.endsWith("区")) return TOKYO_WARDS_LABEL;
  return null;
}

function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  let list = map.get(key);
  if (!list) {
    list = [];
    map.set(key, list);
  }
  list.push(value);
}

// 市区町村ラベルを組み立てる。通常のlabelLayerには各フィーチャ(区・市町村)
// 自身の名前ラベルを入れる。prominentLabelLayerには、区名・区が無い市町村よりも
// 大きいラベル(都道府県ラベルと同じ見た目=pref-labelクラスを流用)を、
// 政令指定都市(全区をまとめた重心、「○○市」)・東京23区(全区をまとめた重心、
// 「東京」)・県庁所在地(政令指定都市でなければ自分自身の重心、「○○市」)の
// 分だけ入れる。県庁所在地が政令指定都市の場合は二重に出さないよう1つにまとめる。
function buildMunicipalityLabelLayers(
  geojson: FeatureCollection<Geometry, MunicipalityProperties>,
  prefCode: string,
): MunicipalityLabelLayers {
  const labelLayer = L.layerGroup();
  const prominentLabelLayer = L.layerGroup();
  const prominentGeometries = new Map<string, Geometry[]>();

  // 東京都は上記の通り特別扱いするため、県庁所在地テーブルには含まれていない
  // (PREFECTURE_CAPITAL_NAME_BY_CODE参照)。
  const capitalName = PREFECTURE_CAPITAL_NAME_BY_CODE[prefCode];

  for (const feature of geojson.features) {
    const props = feature.properties;
    const name = props?.N03_004;
    // 県庁所在地自身の通常ラベルは省略する(prominentLabelLayer側に
    // 同じ名前の大きいラベルを出すため、二重表示にしないようにする)。
    // 東京23区はここでの特別扱いの対象外(新宿区も他の区と同じ通常ラベルを出す)。
    if (name && name !== capitalName) {
      const center = labelPositionOf(feature.geometry);
      if (center) {
        L.marker(center, {
          icon: L.divIcon({
            className: "",
            html: `<span class="municipality-label">${name}</span>`,
            iconSize: [0, 0],
          }),
          interactive: false,
        }).addTo(labelLayer);
      }
    }

    const groupKey = props && prominentLabelGroupKey(props, prefCode);
    if (groupKey) {
      pushInto(prominentGeometries, groupKey, feature.geometry);
    } else if (name && name === capitalName) {
      // 政令指定都市ではない県庁所在地(水戸市など)は、自分自身の
      // フィーチャ1件だけを対象にしても同じ計算で重心が求まる。
      prominentGeometries.set(name, [feature.geometry]);
    }
  }

  for (const [cityName, geometries] of prominentGeometries) {
    const center = combinedCentroid(geometries);
    if (!center) continue;

    L.marker(center, {
      icon: L.divIcon({
        className: "",
        html: `<span class="pref-label">${cityName}</span>`,
        iconSize: [0, 0],
      }),
      interactive: false,
    }).addTo(prominentLabelLayer);
  }

  return { labelLayer, prominentLabelLayer };
}

// GeoJSONの各featureについて、名前ラベルを1つ作ってLayerGroupにまとめる。
// ラベル位置は「一番面積が大きいポリゴンパーツの重心」。離島持ちのfeature
// (例: 本土+飛び地をまとめた都道府県)で、全パーツをまとめて重心を取ると
// 本土と離島の間の海上に落ちることがあるため、最大パーツだけを使う。
function labelPositionOf(geometry: Geometry): [number, number] | null {
  const polygons =
    geometry.type === "Polygon" ? [geometry.coordinates] :
    geometry.type === "MultiPolygon" ? geometry.coordinates :
    [];

  let best: { lat: number; lon: number; area: number } | null = null;
  for (const polygon of polygons) {
    const c = ringCentroid(polygon[0]); // 外接だけ。穴は無視。
    if (!best || c.area > best.area) best = c;
  }
  return best ? [best.lat, best.lon] : null;
}

// 経緯度単位での、標準的な符号付き面積に基づく多角形重心（靴ひも公式）
// 正確な測地線上の重心ではないが、テキストラベルを配置するには十分な精度
function ringCentroid(ring: number[][]): { lat: number; lon: number; area: number } {
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

// 複数フィーチャ(政令指定都市の各区など)をまとめて1つの塊とみなした場合の重心。
// labelPositionOfは1フィーチャの中で最大のパーツだけを使うが、こちらは全パーツ・
// 全フィーチャの重心を面積で重み付けして平均する(離島等の飛び地区は通常無いため、
// 最大パーツに絞る必要はない)。
function combinedCentroid(geometries: Geometry[]): [number, number] | null {
  let totalArea = 0;
  let sumLat = 0;
  let sumLon = 0;

  for (const geometry of geometries) {
    const polygons =
      geometry.type === "Polygon" ? [geometry.coordinates] :
      geometry.type === "MultiPolygon" ? geometry.coordinates :
      [];
    for (const polygon of polygons) {
      const c = ringCentroid(polygon[0]);
      totalArea += c.area;
      sumLat += c.lat * c.area;
      sumLon += c.lon * c.area;
    }
  }

  if (totalArea === 0) return null;
  return [sumLat / totalArea, sumLon / totalArea];
}

// あしあとセルの境界線(outline)の内側への割合(INSET_FRACTION)はconfig.ts参照
// (addAshiatoGroup参照)。

// 7桁(約150m、現地探索の中で最も判定エリアが狭く見つけにくい)セルだけ、
// 単色ではなくガチャゲーの「SSR確定」演出のような斜めの虹色グラデーションで
// 塗る。LeafletのfillColor/color(stroke)オプションはCSSの<paint>値を
// そのままSVGのfill/stroke属性へ渡すだけなので、"url(#id)"を渡せば
// グラデーション定義への参照として機能する(Leaflet自体にグラデーション用の
// 専用APIは無いが、素のSVG機能を素通しできる)。
// ただし参照先のグラデーション要素は、参照する<path>と同じ<svg>ルート内に
// 無ければならない(別の<svg>にあるidは参照できない)。Leafletは対象の
// ペイン(ここではashiatoPane7)ごとに1つの<svg>を使い回すため、そのペインの
// <svg>に一度だけ<defs>ごと差し込めば、以降このペインに追加される7桁セルは
// 全て同じグラデーションを再利用できる。
const ASHIATO_RARE_GRADIENT_ID = "ashiato-rare-gradient";
const SVG_NS = "http://www.w3.org/2000/svg";

function ensureRareGradient(svg: SVGSVGElement): void {
  if (svg.querySelector(`#${ASHIATO_RARE_GRADIENT_ID}`)) return;

  let defs = svg.querySelector("defs");
  if (!defs) {
    defs = document.createElementNS(SVG_NS, "defs");
    svg.insertBefore(defs, svg.firstChild);
  }

  const gradient = document.createElementNS(SVG_NS, "linearGradient");
  gradient.setAttribute("id", ASHIATO_RARE_GRADIENT_ID);
  gradient.setAttribute("x1", "0%");
  gradient.setAttribute("y1", "0%");
  gradient.setAttribute("x2", "100%");
  gradient.setAttribute("y2", "100%");
  // ピンク→紫→青→水色→黄緑と回る、ホログラム風の帯。
  // (色の一覧はconfig.ts: ASHIATO_RARE_GRADIENT_STOPSを唯一の情報源とし、
  // チップ・吹き出しのグロー(main.ts)と重複定義しない)。
  for (const [offset, stopColor] of ASHIATO_RARE_GRADIENT_STOPS) {
    const stop = document.createElementNS(SVG_NS, "stop");
    stop.setAttribute("offset", offset);
    stop.setAttribute("stop-color", stopColor);
    gradient.append(stop);
  }
  defs.append(gradient);
}

// rect(塗り)・outline(枠線)を地図に追加した後に呼ぶこと(Leafletが実際の
// <path>要素を作るのはonAdd時のため)。
function applyRareGradient(rect: L.Rectangle, outline: L.Rectangle): void {
  const rectEl = rect.getElement() as SVGGraphicsElement | undefined;
  const svg = rectEl?.ownerSVGElement;
  if (!rectEl || !svg) return;
  ensureRareGradient(svg);
  rectEl.setAttribute("fill", `url(#${ASHIATO_RARE_GRADIENT_ID})`);
  outline.getElement()?.setAttribute("stroke", `url(#${ASHIATO_RARE_GRADIENT_ID})`);
}

// 表示対象レコードが全て既読かどうかで、マーカーの見た目を変えるためのCSSクラス。
// 全て既読ならフェード(薄く・明滅なし)、1件でも未読が残っていればゆっくり明滅させる
// (実際のスタイル・アニメーションはstyle.css参照)。
function readStateClassName(allRead: boolean): string {
  return allRead ? "ashiato-marker-read" : "ashiato-marker-unread";
}

// 1つのgeohashセルにつき、セルの範囲そのものを矩形で描画する(中心に丸マーカーを
// 打つ方式は、実際の当たり判定エリアの広さと見た目が一致せず紛らわしいため廃止した)。
// 塗りの矩形自体には枠線(stroke)を持たせない: 同じ色(同じ桁数)のセルが隣接
// すると、境界線上に引かれる不透明な枠線が互いの半透明な塗りにまたがって
// 重なり、そこだけ色が濃い帯のように見えてしまう(crispEdgesでアンチエイリア
// シングの重なりを抑えても、この枠線由来の濃さは解消しなかったため)。
// 代わりに、一回り内側に隙間を空けた細い枠線だけの矩形(outline)を別途重ねる。
// 隣接セルの境界線同士が同じ位置に来ないため、枠線が重なって濃くなることが
// 構造的に起こらないまま、セルの境界がなんとなく分かるようにしている。
// 件数(1件/複数件)による濃淡の違いも廃止し、常に同じ不透明度にする
// (複数件かどうかはポップアップを開けば分かるため、地図上での色分けは
// 桁数(色)と既読状態(フェード/明滅)だけで表す)。
// クリック判定(hitArea)もセル全体の矩形にする(以前の中心の小さな円に比べて
// タップ領域が実際のセルの広さと一致し、押しやすくなる)。
// 色・ペインはgeohashの桁数(3〜7)に応じて決まる(呼び出し側でこの桁数のみに絞り込み済み)。
// allReadは、表示対象レコードが全て既読(readAtあり)かどうか(呼び出し側で判定済み)。
export function addAshiatoGroup(
  map: L.Map,
  geohash: string,
  allRead: boolean,
  onOpen: () => void,
): AshiatoGroupHandle {
  const b = decodeGeohash(geohash);
  const bounds: L.LatLngBoundsExpression = [
    [b.minLat, b.minLon],
    [b.maxLat, b.maxLon],
  ];
  const geohashLength = geohash.length;
  const pane = `ashiatoPane${geohashLength}`;
  const hitPane = `ashiatoHitPane${geohashLength}`;
  const color = ashiatoColor(geohashLength);
  const className = readStateClassName(allRead);

  const rect = L.rectangle(bounds, {
    stroke: false,
    fillColor: color,
    fillOpacity: 0.25,
    interactive: false,
    pane,
    className,
  });

  // セルの境界がなんとなく分かるよう、塗りの矩形より一回り内側に細い枠線だけの
  // 矩形を重ねる。縦横それぞれ独立にINSET_FRACTION分小さくすると、縦横比が
  // 偏ったセルで内側への寄り具合が不揃いに見えるため、短辺(縦横のうち短い方)
  // を基準にした1つのinset値を縦横共通で使う。
  // 隣接セルの境界線同士が同じ位置に来ない(必ず隙間ができる)ため、
  // 枠線を境界ぴったりに引いていた以前の実装で起きていた「隣接セル同士の
  // 枠線が重なって濃く見える」問題を、位置的に起こりようがない形で防げる。
  const inset = Math.min(b.maxLat - b.minLat, b.maxLon - b.minLon) * INSET_FRACTION;
  const outline = L.rectangle(
    [
      [b.minLat + inset, b.minLon + inset],
      [b.maxLat - inset, b.maxLon - inset],
    ],
    {
      color,
      weight: 1.5,
      fill: false,
      interactive: false,
      pane,
      className,
    },
  );

  const visualLayers: L.Rectangle[] = [rect, outline];

  // タップ判定用。見た目の矩形と同じ範囲・同じ形にすることで、
  // 実際のセル(当たり判定エリア)の広さそのものがタップ領域になる。
  const hitArea = L.rectangle(bounds, {
    stroke: false,
    fill: true,
    fillOpacity: 0,
    interactive: true,
    pane: hitPane,
    className,
  });

  hitArea.on("click", () => onOpen());

  for (const v of visualLayers) v.addTo(map);
  hitArea.addTo(map);

  if (geohashLength === 7) applyRareGradient(rect, outline);

  return { visualLayers, hitArea, geohashLength };
}

export function removeAshiatoGroup(
  map: L.Map,
  { visualLayers, hitArea }: Pick<AshiatoGroupHandle, "visualLayers" | "hitArea">,
): void {
  for (const v of visualLayers) map.removeLayer(v);
  map.removeLayer(hitArea);
}



interface PrecisionPreviewLayer {
  show(lat: number, lon: number, geohashLength: number): string;
  hide(): void;
}

// 投稿UI表示中、選択中の精度でのGeohashセル範囲をプレビュー表示する。
// areaOverlay(既存の「エリア」トグル)とは独立(投稿UI固有)。
// あしあと本体の色(3桁=青灰, 4桁=青緑, 5桁=緑, 6桁=赤ピンク, 7桁=虹色)と
// 紛らわしくならないよう、あしあとでは使っていない紫系(PRECISION_PREVIEW_COLOR、
// config.ts参照)で統一して表示する。
// show()はプレビュー用に計算したgeohash文字列を返す(呼び出し側で投稿本文の
// 組み立てに使い回せるように)。

export function createPrecisionPreviewLayer(map: L.Map): PrecisionPreviewLayer {
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
    show(lat: number, lon: number, geohashLength: number) {
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

interface CurrentLocationLayer {
  show(lat: number, lon: number, accuracyM: number): void;
  hide(): void;
  // 端末のコンパス方位(0=北、時計回り)を現在地マーカー上の矢印に反映する。
  // マップ本体は回転させない(座標変換が絡む地図回転はGPL依存のプラグインが
  // 前提になるため見送り、方位の可視化だけこの矢印で行う)。
  showHeading(headingDeg: number): void;
  hideHeading(): void;
}

// 現在地マーカー+精度円。専用paneに乗せ、Ashiatoより手前に表示する
export function createCurrentLocationLayer(map: L.Map): CurrentLocationLayer {
  const accuracyCircle = L.circle([0, 0], {
    radius: 0,
    pane: "currentLocationPane",
    color: CURRENT_LOCATION_COLOR,
    weight: 1,
    fillColor: CURRENT_LOCATION_COLOR,
    fillOpacity: 0.15,
    interactive: false,
  });

  const dot = L.circleMarker([0, 0], {
    radius: 6,
    pane: "currentLocationPane",
    color: CURRENT_LOCATION_COLOR,
    weight: 2,
    fillColor: CURRENT_LOCATION_COLOR,
    fillOpacity: 1,
    interactive: false,
  });

  // 矢印本体はdivIcon内のさらに子要素(.current-location-heading-arrow)を
  // 回転させる。leaflet-marker-icon自体の transform はLeafletが位置決めに
  // 使っているため、そこを直接上書きすると位置がずれてしまう。
  const headingMarker = L.marker([0, 0], {
    pane: "currentLocationPane",
    interactive: false,
    keyboard: false,
    icon: L.divIcon({
      className: "current-location-heading",
      html: `<div class="current-location-heading-arrow" style="color: ${CURRENT_LOCATION_COLOR}">${createIcon("navigation-2").outerHTML}</div>`,
      iconSize: [22, 22],
      iconAnchor: [11, 11],
    }),
  });

  // ●(dot)と▲(headingMarker)は同時には出さない。方位が取れている間は▲だけ、
  // 取れていない(またはGPS自体OFF)間は●だけを表示する。
  let hasPosition = false;
  let hasHeading = false;
  // 回転角は0〜360に丸めず、直前の角度からの連続値として保持する。丸めた値を
  // そのままrotate()に渡すと、真北をまたぐ瞬間(例: 359度→1度)にCSS
  // transitionが「358度分回転する」向きの最短距離を取ってしまい、ぐるっと
  // 一回転して見えるバグになる。常に直前の角度に一番近い等価角(±360の倍数)
  // へ寄せてから渡すことで、実際の回転方向と一致する最短経路だけを取らせる。
  let continuousAngle: number | null = null;

  function syncVisibility(): void {
    if (!hasPosition) {
      if (map.hasLayer(dot)) map.removeLayer(dot);
      if (map.hasLayer(accuracyCircle)) map.removeLayer(accuracyCircle);
      if (map.hasLayer(headingMarker)) map.removeLayer(headingMarker);
      return;
    }
    if (!map.hasLayer(accuracyCircle)) accuracyCircle.addTo(map);
    if (hasHeading) {
      if (map.hasLayer(dot)) map.removeLayer(dot);
      if (!map.hasLayer(headingMarker)) headingMarker.addTo(map);
    } else {
      if (!map.hasLayer(dot)) dot.addTo(map);
      if (map.hasLayer(headingMarker)) map.removeLayer(headingMarker);
    }
  }

  return {
    show(lat: number, lon: number, accuracyM: number) {
      const latlng: [number, number] = [lat, lon];
      dot.setLatLng(latlng);
      headingMarker.setLatLng(latlng);
      accuracyCircle.setLatLng(latlng).setRadius(accuracyM);
      hasPosition = true;
      syncVisibility();
    },
    hide() {
      hasPosition = false;
      syncVisibility();
    },
    showHeading(headingDeg: number) {
      hasHeading = true;
      if (continuousAngle === null) {
        continuousAngle = headingDeg;
      } else {
        const delta = (((headingDeg - continuousAngle) % 360) + 540) % 360 - 180;
        continuousAngle += delta;
      }
      syncVisibility();
      const arrow = headingMarker
        .getElement()
        ?.querySelector<HTMLElement>(".current-location-heading-arrow");
      if (arrow) arrow.style.transform = `rotate(${continuousAngle}deg)`;
    },
    hideHeading() {
      hasHeading = false;
      continuousAngle = null;
      syncVisibility();
    },
  };
}

// 開いている吹き出し(あしあと一覧のポップアップ)を全て閉じるボタン。
// 別のL.Controlとして追加し、margin-topで+/-ボタンとの間隔を
// (見た目上は同じ5pxになるよう)re-createしようとしたところ、Windows版の
// Vivaldi/Firefoxで実測+/-間8px・ここ7pxと1pxだけズレる現象が起きた。
// flexboxのgapとbox modelのmarginは、ブラウザ内部では別々の計算パスで
// 端数(表示スケーリングが100%でない場合等)を丸めるため、指定値が同じ
// "5px"でも仕組みが違うと必ずしも同じ物理pxに丸まらない。
// 確実に同じ間隔にするため、別コントロールにはせず、+/-ボタンと同じ
// .leaflet-control-zoomコンテナ(display:flex; flex-direction:column;
// gap:5px;)の3つ目の子要素として追加する。同じgapプロパティ1つに
// 支配されるようになるため、ブラウザの丸め方に関わらず必ず一致する。
// クリック時の実際の処理(開いているポップアップの一覧の取得・close())は
// main.ts側(openAshiatoPopups)の状態に依存するため持たず、ボタン要素だけを
// 返して呼び出し側でonclickを組み立ててもらう。
export function createClosePopupsButton(map: L.Map): HTMLAnchorElement {
  const zoomContainer = map
    .getContainer()
    .querySelector<HTMLElement>(".leaflet-bar.leaflet-control-zoom")!;
  const button = L.DomUtil.create(
    "a",
    "leaflet-control-close-popups-btn",
    zoomContainer,
  ) as HTMLAnchorElement;
  button.href = "#";
  button.setAttribute("role", "button");
  button.title = "吹き出しを全て閉じる";
  button.setAttribute("aria-label", "吹き出しを全て閉じる");
  // ズームボタンと同じく、地図側にクリックが伝わって(パン等)しまわない
  // ようにする(L.control.zoomも内部で自身のコンテナに同じ処理をしているが、
  // 念のためこのボタン自身にも掛けておく)。
  L.DomEvent.disableClickPropagation(button);
  L.DomEvent.on(button, "click", L.DomEvent.preventDefault);
  button.append(createIcon("message-square-x"));
  return button;
}
