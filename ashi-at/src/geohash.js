const ALPHABET = "0123456789bcdefghjkmnpqrstuvwxyz";

export function decodeGeohash(hash) {
  if (!/^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/.test(hash))
    throw new Error(`Invalid Geohash: ${hash}`);

  let lat = [-90, 90],
    lon = [-180, 180],
    even = true;

  for (const ch of hash) {
    const bits = ALPHABET.indexOf(ch);

    for (let mask = 16; mask >= 1; mask >>= 1) {
      const interval = even ? lon : lat,
        mid = (interval[0] + interval[1]) / 2;

      if (bits & mask) interval[0] = mid;
      else interval[1] = mid;
      even = !even;
    }
  }
  return {
    minLat: lat[0],
    maxLat: lat[1],
    minLon: lon[0],
    maxLon: lon[1],
    centerLat: (lat[0] + lat[1]) / 2,
    centerLon: (lon[0] + lon[1]) / 2,
  };
}

// Geohashセル1つ分の、緯度・経度方向それぞれの物理サイズ(メートル)を概算する。
// 地球を球とみなした単純な近似(緯度1度 ≒ 111.32km)。
// 経度方向は緯度によって縮むので、セル中心の緯度でcos補正する。
// 発見判定の目安を表示する程度の用途なので、この精度で十分。
const METERS_PER_DEGREE_LAT = 111320;

export function geohashCellSizeMeters(hash) {
  const { minLat, maxLat, minLon, maxLon, centerLat } = decodeGeohash(hash);

  const heightM = (maxLat - minLat) * METERS_PER_DEGREE_LAT;
  const widthM =
    (maxLon - minLon) *
    METERS_PER_DEGREE_LAT *
    Math.cos((centerLat * Math.PI) / 180);

  return { widthM, heightM };
}

// 現在地(lat, lon)が、指定したgeohashセルの矩形範囲内に入っているかを判定する
export function isInsideGeohashCell(lat, lon, hash) {
  const { minLat, maxLat, minLon, maxLon } = decodeGeohash(hash);
  return lat >= minLat && lat <= maxLat && lon >= minLon && lon <= maxLon;
}
