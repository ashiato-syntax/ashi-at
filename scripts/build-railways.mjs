// 国土数値情報「鉄道データ(N02)」の全国版GeoJSON(路線+駅)を、市区町村データ(N03)と
// 同じ「都道府県ごとに分割 + 簡略化」の形に変換するビルドスクリプト。
// N02にはN03と違って都道府県コードの属性が無いため、prefectures.json側の
// 都道府県ポリゴンのbbox(パーツごと、離島対策はprefectureIndex.tsと同じ考え方)
// と、各フィーチャ自身のbboxが交差するかどうかで振り分ける。
// 県境をまたぐ路線・駅は複数の都道府県ファイルに重複して含める(セグメント自体を
// 県境で切る処理は複雑な割に見た目のメリットが薄いため)。
//
// 実行: node scripts/build-railways.mjs
// 入力:
//   N02-25_GML/UTF-8/N02-25_RailroadSection.geojson (路線, 手動でダウンロード済み)
//   N02-25_GML/UTF-8/N02-25_Station.geojson (駅, 同上)
// 出力:
//   public/data/maps/railways/N02-25_{都道府県コード}.json (路線, 簡略化済み)
//   public/data/maps/stations/N02-25_{都道府県コード}.json (駅)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mapshaperModule from "mapshaper";

const mapshaper = mapshaperModule.default ?? mapshaperModule;

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const GML_DIR = path.join(REPO_ROOT, "N02-25_GML", "UTF-8");
const PREFECTURES_PATH = path.join(REPO_ROOT, "public", "data", "maps", "prefectures.json");
const RAILWAYS_OUT_DIR = path.join(REPO_ROOT, "public", "data", "maps", "railways");
const STATIONS_OUT_DIR = path.join(REPO_ROOT, "public", "data", "maps", "stations");

// prefectureIndex.ts(src/)と同じ表。都道府県名(N03_001の表記)→2桁のJIS行政コード。
const PREF_CODE_BY_NAME = {
  "北海道": "01", "青森県": "02", "岩手県": "03", "宮城県": "04", "秋田県": "05",
  "山形県": "06", "福島県": "07", "茨城県": "08", "栃木県": "09", "群馬県": "10",
  "埼玉県": "11", "千葉県": "12", "東京都": "13", "神奈川県": "14", "新潟県": "15",
  "富山県": "16", "石川県": "17", "福井県": "18", "山梨県": "19", "長野県": "20",
  "岐阜県": "21", "静岡県": "22", "愛知県": "23", "三重県": "24", "滋賀県": "25",
  "京都府": "26", "大阪府": "27", "兵庫県": "28", "奈良県": "29", "和歌山県": "30",
  "鳥取県": "31", "島根県": "32", "岡山県": "33", "広島県": "34", "山口県": "35",
  "徳島県": "36", "香川県": "37", "愛媛県": "38", "高知県": "39", "福岡県": "40",
  "佐賀県": "41", "長崎県": "42", "熊本県": "43", "大分県": "44", "宮崎県": "45",
  "鹿児島県": "46", "沖縄県": "47",
};

function boundingBoxOfRing(ring) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [lon, lat] of ring) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return { minLat, maxLat, minLon, maxLon };
}

// prefectureIndex.tsのboundingBoxesOfと同じ: 都道府県全体を囲む単一のボックスに
// せず、パーツ(ポリゴンごと)のbboxにする(離島だけのために県全体が広範囲に
// 判定されるのを防ぐ)。
function boundingBoxesOfPrefGeometry(geometry) {
  const polygons =
    geometry.type === "Polygon" ? [geometry.coordinates] :
    geometry.type === "MultiPolygon" ? geometry.coordinates :
    [];
  return polygons.map((polygon) => boundingBoxOfRing(polygon[0]));
}

function rectsIntersect(a, b) {
  return a.minLon <= b.maxLon && a.maxLon >= b.minLon && a.minLat <= b.maxLat && a.maxLat >= b.minLat;
}

function bboxOfCoordsList(coordsList) {
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const coords of coordsList) {
    for (const [lon, lat] of coords) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  return { minLat, maxLat, minLon, maxLon };
}

function buildPrefIndex(prefData) {
  const prefIndex = [];
  for (const feature of prefData.features) {
    const name = feature.properties?.N03_001;
    const code = name ? PREF_CODE_BY_NAME[name] : undefined;
    if (!name || !code) {
      console.warn(`未知の都道府県名 "${name}" — スキップ`);
      continue;
    }
    prefIndex.push({ name, code, parts: boundingBoxesOfPrefGeometry(feature.geometry) });
  }
  return prefIndex;
}

// 都道府県ごとに振り分けたフィーチャ配列を返す(bbox交差判定、重複あり)。
function groupFeaturesByPrefecture(features, prefIndex, bboxOfFeature) {
  const byPrefCode = new Map(prefIndex.map((p) => [p.code, []]));
  for (const feature of features) {
    const featBbox = bboxOfFeature(feature);
    if (!featBbox) continue;
    for (const pref of prefIndex) {
      if (pref.parts.some((part) => rectsIntersect(part, featBbox))) {
        byPrefCode.get(pref.code).push(feature);
      }
    }
  }
  return byPrefCode;
}

function lineStringsBboxOf(geom) {
  const lines =
    geom.type === "LineString" ? [geom.coordinates] :
    geom.type === "MultiLineString" ? geom.coordinates :
    [];
  return lines.length === 0 ? null : bboxOfCoordsList(lines);
}

// 路線データ(N02-25_RailroadSection.geojson)を都道府県ごとに分割+簡略化する。
async function buildRailways(prefIndex) {
  console.log("N02-25_RailroadSection.geojson を読み込み中...(数秒かかります)");
  const railData = JSON.parse(
    fs.readFileSync(path.join(GML_DIR, "N02-25_RailroadSection.geojson"), "utf8"),
  );
  console.log(`路線セグメント: ${railData.features.length}件`);

  const featuresByPrefCode = groupFeaturesByPrefecture(
    railData.features.filter((f) => f.geometry),
    prefIndex,
    (f) => lineStringsBboxOf(f.geometry),
  );

  fs.mkdirSync(RAILWAYS_OUT_DIR, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ashi-at-railways-"));

  let totalRawBytes = 0;
  let totalOutBytes = 0;
  for (const pref of prefIndex) {
    const features = featuresByPrefCode.get(pref.code);
    const rawJson = JSON.stringify({ type: "FeatureCollection", features });
    const rawPath = path.join(tmpDir, `N02-25_${pref.code}.json`);
    fs.writeFileSync(rawPath, rawJson);
    totalRawBytes += Buffer.byteLength(rawJson);

    const outPath = path.join(RAILWAYS_OUT_DIR, `N02-25_${pref.code}.json`);
    if (features.length === 0) {
      fs.writeFileSync(outPath, JSON.stringify({ type: "FeatureCollection", features: [] }));
      console.log(`  ${pref.code} ${pref.name}: 0件(路線なし)`);
      continue;
    }

    // 座標を間引いて軽量化する(表示用途であり測量用途ではないため)。
    // 割合指定(パーセンテージ)だと、駅間の1区間が数点しか無いような点の
    // 少ない区間(例: ポートアイランド線の駅間)でまで一律に間引かれてしまい、
    // カーブがガタガタに暴れて見える結果になっていた。区間ごとの点数に関係なく
    // 「これ以上近い点は間引く」という距離基準(interval、メートル単位)に
    // 変えることで、もともと点が少ない区間はほぼ間引かれず形状を保ちつつ、
    // 点が密集している区間だけ効果的に軽量化する。
    await mapshaper.runCommands(
      `-i "${rawPath}" -simplify dp interval=8m -o "${outPath}" format=geojson`,
    );
    const outBytes = fs.statSync(outPath).size;
    totalOutBytes += outBytes;
    console.log(`  ${pref.code} ${pref.name}: ${features.length}件 → ${(outBytes / 1024).toFixed(0)}KB`);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(
    `路線: 完了。簡略化前(重複込み) ${(totalRawBytes / 1024 / 1024).toFixed(1)}MB → ` +
    `簡略化後 ${(totalOutBytes / 1024 / 1024).toFixed(1)}MB`,
  );
}

// 駅データ(N02-25_Station.geojson)を都道府県ごとに分割する。
// スキーマ上、駅もgml:CurvePropertyType(線)を継承しているため、実際の座標は
// ごく短い2点のLineStringになっている。地図上には点(●)として置きたいので、
// LineStringの先頭座標を駅の代表点として使い、Point geometryに変換する。
// 点データなので簡略化(座標間引き)は不要。乗換駅など同じ場所に複数路線分の
// 駅フィーチャが重複することがあるが、重ねて描いても見た目上問題ないため
// 重複除去はしない。
async function buildStations(prefIndex) {
  console.log("N02-25_Station.geojson を読み込み中...");
  const stationData = JSON.parse(
    fs.readFileSync(path.join(GML_DIR, "N02-25_Station.geojson"), "utf8"),
  );
  console.log(`駅フィーチャ: ${stationData.features.length}件`);

  const pointFeatures = [];
  for (const feature of stationData.features) {
    const geom = feature.geometry;
    if (!geom) continue;
    const coord =
      geom.type === "LineString" ? geom.coordinates[0] :
      geom.type === "Point" ? geom.coordinates :
      null;
    if (!coord) continue;
    pointFeatures.push({
      type: "Feature",
      properties: feature.properties,
      geometry: { type: "Point", coordinates: coord },
    });
  }

  const featuresByPrefCode = groupFeaturesByPrefecture(
    pointFeatures,
    prefIndex,
    (f) => {
      const [lon, lat] = f.geometry.coordinates;
      return { minLat: lat, maxLat: lat, minLon: lon, maxLon: lon };
    },
  );

  fs.mkdirSync(STATIONS_OUT_DIR, { recursive: true });

  let totalOutBytes = 0;
  for (const pref of prefIndex) {
    const features = featuresByPrefCode.get(pref.code);
    const outJson = JSON.stringify({ type: "FeatureCollection", features });
    const outPath = path.join(STATIONS_OUT_DIR, `N02-25_${pref.code}.json`);
    fs.writeFileSync(outPath, outJson);
    totalOutBytes += Buffer.byteLength(outJson);
    console.log(`  ${pref.code} ${pref.name}: ${features.length}件 → ${(Buffer.byteLength(outJson) / 1024).toFixed(0)}KB`);
  }

  console.log(`駅: 完了。合計(重複込み) ${(totalOutBytes / 1024 / 1024).toFixed(1)}MB`);
}

async function main() {
  console.log("prefectures.json を読み込み中...");
  const prefData = JSON.parse(fs.readFileSync(PREFECTURES_PATH, "utf8"));
  const prefIndex = buildPrefIndex(prefData);
  console.log(`都道府県: ${prefIndex.length}件`);

  await buildRailways(prefIndex);
  await buildStations(prefIndex);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
