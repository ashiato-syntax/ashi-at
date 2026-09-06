import L from "leaflet";

/**
 * Draws a plain latitude/longitude grid — README_JP.md §15's "白地図 / グリッド"
 * — with no tile server, no bundled map data, no network request of any kind.
 * Every line is computed from pure math, so this works fully offline and
 * never depends on a third party (§16: インフラの最小化).
 *
 * This exists purely so a decoded Geohash rectangle has *something* to be
 * visually checked against (roughly the right latitude band / hemisphere /
 * side of the date line) — it is not meant to look like a real map.
 *
 * @param {L.Map} map
 * @param {{ stepDeg?: number }} [opts] stepDeg: grid spacing in degrees (default 10)
 * @returns {L.LayerGroup}
 */
export function addGraticule(map, opts = {}) {
  const step = opts.stepDeg ?? 5;
  const group = L.layerGroup();

  const lineStyle = { color: "#9aa0a6", weight: 1, interactive: false };
  const axisStyle = { color: "#5f6368", weight: 1.5, interactive: false };
  const label = (text) =>
    L.divIcon({
      className: "graticule-label",
      html: `<span>${text}</span>`,
      iconSize: [0, 0],
    });

  // Parallels (constant latitude, horizontal lines)
  for (let lat = -80; lat <= 80; lat += step) {
    const style = lat === 0 ? axisStyle : lineStyle;
    L.polyline(
      [
        [lat, -180],
        [lat, 180],
      ],
      style,
    ).addTo(group);
    L.marker([lat, -179], { icon: label(`${lat}°`), interactive: false }).addTo(
      group,
    );
  }

  // Meridians (constant longitude, vertical lines)
  for (let lon = -180; lon <= 180; lon += step) {
    const style = lon === 0 ? axisStyle : lineStyle;
    L.polyline(
      [
        [-85, lon],
        [85, lon],
      ],
      style,
    ).addTo(group);
    L.marker([84, lon], { icon: label(`${lon}°`), interactive: false }).addTo(
      group,
    );
  }

  group.addTo(map);
  return group;
}
