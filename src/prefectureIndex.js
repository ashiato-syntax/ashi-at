// 都道府県名（N03_001の表記）を2桁のJIS行政コード（例：「東京都」→「13」）にマッピング
// 都道府県ごとの市区町村GeoJson（N03-21_{code}_210101.json）を読み込む用
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

/**
* 都道府県のGeoJSONからインデックス作成
* 各都道府県につき1エントリとするが、バウンディングボックス（bbox）は「ポリゴンの各パーツ」ごとに設定する
* →都道府県全体を囲む単一のボックスではない
* →都道府県全体を囲むボックスにしちゃうと、離島（小笠原、奄美、等）がある都道府県で遅延読み込みの意味がなくなる
*
* @param {GeoJSON.FeatureCollection} prefectureGeoJSON
* @returns {Array<{ name: string, code: string, parts: Array<{minLat:number,maxLat:number,minLon:number,maxLon:number}> }>}
*/
export function buildPrefectureIndex(prefectureGeoJSON) {
  const index = [];
  for (const feature of prefectureGeoJSON.features) {
    const name = feature.properties?.N03_001;
    const code = PREF_CODE_BY_NAME[name];
    if (!code) {
      console.warn(`prefectureIndex: 未知の都道府県名 "${name}" — スキップします`);
      continue;
    }
    index.push({ name, code, parts: boundingBoxesOf(feature.geometry) });
  }
  return index;
}

function boundingBoxesOf(geometry) {
  const polygons =
    geometry.type === "Polygon" ? [geometry.coordinates] :
    geometry.type === "MultiPolygon" ? geometry.coordinates :
    [];

  // 琵琶湖対策
  return polygons.map((polygon) => boundingBoxOfRing(polygon[0]));
}

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

function rectsIntersect(a, b) {
  return a.minLon <= b.maxLon && a.maxLon >= b.minLon && a.minLat <= b.maxLat && a.maxLat >= b.minLat;
}

/**
 * @param {ReturnType<typeof buildPrefectureIndex>} index
 * @param {{minLat:number,maxLat:number,minLon:number,maxLon:number}} viewRect 現在の map viewport
 * @returns バウンディングボックス（のいずれかの部分）がビューポートと交差するエントリ
 */
export function findPrefecturesInView(index, viewRect) {
  return index.filter((pref) => pref.parts.some((part) => rectsIntersect(part, viewRect)));
}
