import type L from "leaflet";

export interface AshiatoRecord {
  id: string;
  hostTag: string;
  host: string;
  tag: string;
  noteId: string;
  indexInNote: number;
  geohash: string;
  contextId: string | null;
  canonical: string;
  noteCreatedAt: string | null;
  username: string | null;
  displayName: string | null;
  textPreview: string | null;
  emojiHost: string | null;
  cachedAt: number;
  unlockedAt: number | null;
  openedAt: number | null;
}

export interface Cursor {
  hostTag: string;
  host: string;
  tag: string;
  oldestSeenNoteId?: string;
  newestSeenNoteId?: string;
  updatedAt?: number;
}

export type GeohashLength = 5 | 6 | 7;

export interface Draft {
  id: string;
  createdAt: number;
  lat: number;
  lon: number;
  geohashLength: GeohashLength;
  municipalityLabel: string | null;
}

// map.jsのaddAshiatoGroup()が返す、地図上に実際に描画されている状態のハンドル。
export interface AshiatoGroupHandle {
  visualLayers: L.CircleMarker[];
  hitArea: L.CircleMarker;
  geohashLength: number;
}

// main.js側で保持する1セル分の状態。発見済みレコードが1件も無い間は
// visualLayers/hitArea/geohashLength/colorがnullのまま(地図に未描画)。
export interface AshiatoCell {
  geohash: string;
  records: Map<string, AshiatoRecord>;
  visualLayers: L.CircleMarker[] | null;
  hitArea: L.CircleMarker | null;
  geohashLength: number | null;
  color: string | null;
}

export type AshiatoCellState = "unlocked" | "opened";
