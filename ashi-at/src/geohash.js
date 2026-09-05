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
