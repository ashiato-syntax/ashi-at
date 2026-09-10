import type { Geometry, Position } from "geojson";
import { findPrefecturesInView, type PrefectureIndexEntry } from "./prefectureIndex.js";
import { fetchMunicipalityGeoJson } from "./map.js";

// 点(lon, lat)がリング(GeoJSON座標配列)の内側にあるかをray castingで判定
function pointInRing(lon: number, lat: number, ring: Position[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

// 外環の内側 かつ 穴の外側、を満たすかどうか
function pointInPolygon(lon: number, lat: number, polygon: Position[][]): boolean {
  if (!pointInRing(lon, lat, polygon[0])) return false;
  for (let i = 1; i < polygon.length; i++) {
    if (pointInRing(lon, lat, polygon[i])) return false; // 穴の中
  }
  return true;
}

function pointInGeometry(lon: number, lat: number, geometry: Geometry): boolean {
  const polygons: Position[][][] =
    geometry.type === "Polygon" ? [geometry.coordinates] :
    geometry.type === "MultiPolygon" ? geometry.coordinates :
    [];
  return polygons.some((p) => pointInPolygon(lon, lat, p));
}

/**
 * 緯度経度から市区町村名を逆引きする。都道府県境界インデックスでまず
 * 候補都道府県を絞り込み(バウンディングボックス交差)、該当都道府県の
 * 市区町村GeoJson(未取得ならオンデマンド取得、map.js側のキャッシュと共用)に
 * 対して点in多角形判定を行う。見つからなければnullを返す
 * (呼び出し側で「@緯度, 経度」表示にフォールバックする想定)。
 *
 * Nominatim等の外部APIは使わない方針(サードパーティ依存を増やさないため)。
 *
 * @param includePrefecture trueの場合、市区町村名の前に都道府県名も付ける
 *   (「東京都渋谷区」等)。下書き一覧は元々市区町村名だけの表示のため省略時はfalse。
 */
export async function lookupMunicipality(
  prefectureIndex: PrefectureIndexEntry[],
  lat: number,
  lon: number,
  { includePrefecture = false }: { includePrefecture?: boolean } = {},
): Promise<string | null> {
  const point = { minLat: lat, maxLat: lat, minLon: lon, maxLon: lon };
  const candidates = findPrefecturesInView(prefectureIndex, point);

  for (const pref of candidates) {
    try {
      const geojson = await fetchMunicipalityGeoJson(pref.code);
      for (const feature of geojson.features) {
        if (pointInGeometry(lon, lat, feature.geometry)) {
          const city = feature.properties?.N03_003;
          const ward = feature.properties?.N03_004;
          const municipality = city && ward ? `${city}${ward}` : city || ward || null;
          if (!includePrefecture) return municipality || pref.name;
          return municipality ? `${pref.name}${municipality}` : pref.name;
        }
      }
    } catch (error) {
      console.warn(`municipalityLookup: ${pref.name}の境界取得に失敗:`, error);
    }
  }
  return null;
}
