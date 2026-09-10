import type L from "leaflet";

// ノートに添付されていた画像/GIF/動画1件分。実体(バイナリ)は保存せず、
// 表示時にブラウザが直接参照するURLだけを保持する(カスタム絵文字画像のような
// Blobキャッシュは行わない。カスタム絵文字と違いshortcode解決が不要で、
// URLそのものがノートJSONに含まれているため)。
export interface AshiatoFile {
  url: string;
  thumbnailUrl: string | null;
  type: string; // MIMEタイプ(例: "image/jpeg", "image/gif", "video/mp4")
  isSensitive: boolean;
}

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
  avatarUrl: string | null;
  files: AshiatoFile[];
  cachedAt: number;
  unlockedAt: number | null;
  readAt: number | null;
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
// visualLayers/hitAreaがnullのまま(地図に未描画)。
export interface AshiatoCell {
  geohash: string;
  records: Map<string, AshiatoRecord>;
  visualLayers: L.CircleMarker[] | null;
  hitArea: L.CircleMarker | null;
}
