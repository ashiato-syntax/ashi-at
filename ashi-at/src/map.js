import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { decodeGeohash } from "./geohash.js";
import { addGraticule } from "./graticule.js";

// NOTE: no L.tileLayer(...) is added here on purpose. README_JP.md §15
// ("商用地図APIへの依存を必要としない") rules out third-party tile providers,
// so this is a bare white Leaflet canvas with only a computed lat/lon grid
// (addGraticule) drawn on top for visual reference.
export function createMap(el) {
  const map = L.map(el, {attributionControl: false}).setView([35, 135], 5);
  addGraticule(map);
  return map;
}

export async function addBoundaries(map) {
  const [prefectureResponse, municipalityResponse] = await Promise.all([
    fetch("/data/prefectures.json"),
    fetch("/data/N03-21_210101.json"),
  ]);

  if (!prefectureResponse.ok || !municipalityResponse.ok) {
    throw new Error("行政区域GeoJSONの読み込みに失敗しました。");
  }

  const [prefectureData, municipalityData] = await Promise.all([
    prefectureResponse.json(),
    municipalityResponse.json(),
  ]);

  // 市町村境界：薄いグレー
  const municipalityLayer = L.geoJSON(municipalityData, {
    style: {
      color: "#ccc",
      weight: 0.8,
      fill: false,
      interactive: false,
    },
  }).addTo(map);

  // 都道府県境界：濃いグレー
  const prefectureLayer = L.geoJSON(prefectureData, {
    style: {
      color: "#666",
      weight: 1.5,
      fill: false,
      interactive: false,
    },
  }).addTo(map);

  return {
    municipalityLayer,
    prefectureLayer,
  };
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
