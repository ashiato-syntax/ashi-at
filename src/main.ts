import {
  searchNotesByTag,
  normalizeInstanceUrl,
  buildShareUrl,
  fetchEmojiMap,
  type MisskeyNote,
} from "./misskey.js";
import { parseText, extractCandidates, buildMinimalCandidate } from "./parser.js";
import { isAshiatoActiveNow } from "./ashiatoEval.js";
import { parse as parseMfm, type MfmNode } from "mfm-js";
import {
  createMap,
  addAshiatoGroup,
  removeAshiatoGroup,
  loadPrefectureBoundaries,
  loadMunicipalityBoundaries,
  createCurrentLocationLayer,
  createAreaOverlay,
  createPrecisionPreviewLayer,
  ashiatoColor,
  type MunicipalityBoundaryResult,
} from "./map.js";
import {
  decodeGeohash,
  encodeGeohash,
  geohashCellSizeMeters,
  isInsideGeohashCell,
} from "./geohash.js";
import {
  buildPrefectureIndex,
  findPrefecturesInView,
  type PrefectureIndexEntry,
} from "./prefectureIndex.js";
import { lookupMunicipality, lookupPrefectureName } from "./municipalityLookup.js";
import {
  makeRecord,
  getCursor,
  putCursor,
  getAshiatoRecords,
  putAshiatoRecords,
  pruneCache,
  clearSearchCache,
  clearCollectedAshiatoByIds,
  markAshiatoUnlocked,
  markAshiatoRead,
  getSetting,
  putSetting,
  makeDraft,
  putDraft,
  getDrafts,
  deleteDraft,
  updateDraftPrecision,
  getEmojiImageBlob,
  putEmojiImageBlob,
  resetAllCache,
} from "./cache.js";
import L from "leaflet";
import type {
  AshiatoRecord,
  AshiatoCell,
  AshiatoFile,
  Draft,
  Cursor,
  GeohashLength,
} from "./types.js";
import { createIcon } from "./icons.js";

// これよりズームしたら、都道府県名ラベルを表示
const MIN_ZOOM_FOR_PREFECTURE_LABELS = 7;
// これよりズームしたら、当該都道府県の市区町村GeoJsonを読み込む
const MIN_ZOOM_FOR_MUNICIPALITIES = 10;
// これよりズームしたら、県庁所在地・政令指定都市の大きいラベルを表示。
const MIN_ZOOM_FOR_CAPITAL_LABELS = 10;
// これよりズームしたら、区・区が無い市町村等、通常の市区町村名ラベルを表示
const MIN_ZOOM_FOR_MUNICIPALITY_LABELS = 11;

// 固定タグ。将来複数タグに対応するなら cache.js のhostTagキーはそのまま使い回せる。
const TAG = "Ashiato";
const PAGE_SIZE = 30;

// Ashi@で扱うgeohashの桁数(精度)。これ以外の精度の「あしあと」は対象外として無視する
// (地図表示にも「見つけたあしあと」にも一切出さない)。
const MIN_GEOHASH_LENGTH = 5;
const MAX_GEOHASH_LENGTH = 7;

// 投稿からこの時間が経過するまでは、その「あしあと」を発見判定の対象にしない
// (セルにすら登録しないので、現在地判定も一切かからない)。桁数が細かい(=判定エリアが
// 狭い)ほど投稿者の居場所が絞り込まれやすいが、5桁(約4km)は十分広いため15分、
// 6桁・7桁(約1km/約150m)は30分とする。
// PENDING_PROMOTION_INTERVAL_MSごとに保留分を再チェックし、経過後は
// 手動で「探す」し直さなくても自動的に対象へ昇格する。
const MIN_NOTE_AGE_MS_BY_LENGTH: Record<GeohashLength, number> = {
  5: 15 * 60 * 1000, // 15分
  6: 30 * 60 * 1000, // 30分
  7: 30 * 60 * 1000, // 30分
};
const PENDING_PROMOTION_INTERVAL_MS = 60 * 1000; // 1分ごとに再チェック

// 投稿機能: この精度(Geohash桁数)は「高精度」とみなし、プライバシー配慮のため
// 作成からDRAFT_HIGH_PRECISION_DELAY_MSが経過するまで投稿できないようにする
// (isDraftPostable/updateComposeButtonsの両方でこの定数を参照すること)。
const HIGH_PRECISION_GEOHASH_LENGTH: GeohashLength = 7;
const DRAFT_HIGH_PRECISION_DELAY_MS = 30 * 60 * 1000; // 30分

const PRECISION_LABELS: Record<GeohashLength, string> = { 5: "約4km", 6: "約1km", 7: "約150m" };

// 「見つけたあしあと」一覧・ポップアップに表示する本文プレビューの
// 安全弁としての最大文字数。表示上の省略はCSS(.mfm-preview)での高さクリップ
// +「続きを表示」ヒントで行うため、通常はここで切り詰められることはない
// (Misskeyの標準的な投稿文字数上限を大きく超えるような極端なケースにのみ働く、
// 文字数で機械的に切ると:name:のようなMFM記法の途中で千切れる恐れがあるため)。
const TEXT_PREVIEW_SAFETY_CAP_LENGTH = 3000;

// デバッグ用: trueにすると、未発見(ロック中)のAshiatoも地図に表示する。
// GPSによる発見判定や「集めたあしあと」一覧の仕様は変えない。本番ではfalse。
const SHOW_LOCKED_ASHIATO_FOR_DEBUG = false;

// インスタンスのorigin(https://misskey.io等)を、画面表示用に"misskey.io"の
// ようなホスト名だけへ短縮する。
function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, "");
}

function isSupportedGeohashLength(geohash: string): boolean {
  return (
    geohash.length >= MIN_GEOHASH_LENGTH &&
    geohash.length <= MAX_GEOHASH_LENGTH
  );
}

// noteCreatedAtが無い/不正な場合は、安全側に倒して「まだ扱わない」扱いにする。
// 必要な経過時間はgeohashの桁数によって異なる(MIN_NOTE_AGE_MS_BY_LENGTH参照)ため、
// 呼び出し側は対象レコードのgeohash桁数を渡すこと(isSupportedGeohashLengthで
// 5〜7桁に絞り込み済みのレコードのみがここに来る想定)。
function isOldEnough(noteCreatedAt: string | null, geohashLength: number): boolean {
  if (!noteCreatedAt) return false;
  const postedAt = new Date(noteCreatedAt).getTime();
  if (Number.isNaN(postedAt)) return false;
  const threshold =
    MIN_NOTE_AGE_MS_BY_LENGTH[geohashLength as GeohashLength] ??
    MIN_NOTE_AGE_MS_BY_LENGTH[MAX_GEOHASH_LENGTH as GeohashLength];
  return Date.now() - postedAt >= threshold;
}

const $ = <T extends Element = HTMLElement>(s: string): T => document.querySelector<T>(s)!,
  map = createMap("map"),
  areaOverlay = createAreaOverlay(map),
  precisionPreview = createPrecisionPreviewLayer(map),
  statusToast = $("#statusToast"),
  statusIcon = $("#statusIcon"),
  statusText = $("#statusText"),
  statusCloseBtn = $<HTMLButtonElement>("#statusClose"),
  precisionWarning = $("#precisionWarning"),
  discoveryBanner = $("#discoveryBanner"),
  unlockedList = $("#unlockedList"),
  unlockedSortModeSelect = $<HTMLSelectElement>("#unlockedSortMode"),
  unreadOnlyFilterCheckbox = $<HTMLInputElement>("#unreadOnlyFilter"),
  unlockedBadge = $("#unlockedBadge"),
  menuBadge = $("#menuBadge");

// メニューFAB・ハンバーガーメニュー各項目のアイコン(絵文字は端末フォント依存で
// 意図した絵文字が無い環境だと崩れるため、lucide-staticのインラインSVGに置き換える)。
$(".menu-fab-icon").append(createIcon("menu"));
// フライアウトはボタンの左側に開くため、その向きを示す左向きシェブロンを使う
// (展開時は180度回転して右向きになり、閉じる方向を示す)。
$("#togglePanelCollapse .toggle-panel-handle-icon").append(createIcon("chevron-left"));
$("#loadNewer .toolbar-btn-icon").append(createIcon("refresh-cw"));
$("#search .toolbar-btn-icon").append(createIcon("history"));
$("#composeAshiatoMenuItem .menu-item-icon").append(createIcon("footprints"));
$("#unlockedListToggle .menu-item-icon").append(createIcon("map-pinned"));
$("#draftListToggle .menu-item-icon").append(createIcon("notebook-pen"));
$("#changeInstanceIcon").append(createIcon("server"));
$("#clearSearchCacheIcon").append(createIcon("trash-2"));
$("#resetAllIcon").append(createIcon("rotate-ccw"));
$("#aboutButton .menu-item-icon").append(createIcon("info"));
$("#settingsToggle .menu-item-icon").append(createIcon("settings"));
$("#mediaVisibilityIcon").append(createIcon("eye"));
$("#composePrecisionIcon").append(createIcon("ruler"));
$("#mediaVisibilityToggle .settings-collapsible-toggle-icon").append(createIcon("chevron-down"));
$("#ashiatoActionShowOnMapIcon").append(createIcon("map-pin"));
$("#ashiatoActionOpenPostIcon").append(createIcon("external-link"));
$("#ashiatoActionDeleteIcon").append(createIcon("trash-2"));

// ×(閉じる)ボタンも絵文字ではないが文字グリフのため、他アイコンとの見た目統一のためSVGに置き換える。
$("#statusClose").append(createIcon("x"));
$("#unlockedListCloseX").append(createIcon("x"));
$("#ashiatoActionCloseX").append(createIcon("x"));
$("#composeCloseX").append(createIcon("x"));
$("#draftListCloseX").append(createIcon("x"));
$("#aboutCloseX").append(createIcon("x"));
$("#settingsCloseX").append(createIcon("x"));

// 地図の表示位置(中心緯度経度・ズーム)をTTL無しで保存しておき、次回起動時に
// 復元する(復元自体は起動処理の中でsetView()する形で行う。createMap()の
// デフォルト位置で一瞬描画されてから復元位置へ飛ぶが、体感できるほどの
// 遅延ではないため許容している)。
// moveendは操作の区切り(ドラッグ終了・ズーム完了)でまとめて発火するので、
// 追加のデバウンスなしでもIndexedDBへの書き込み頻度は十分少ない。
map.on("moveend", () => {
  const center = map.getCenter();
  putSetting("mapView", { lat: center.lat, lon: center.lng, zoom: map.getZoom() });
});

let prefectureIndex: PrefectureIndexEntry[] = [];
let prefectureLabelLayer: L.LayerGroup | null = null;
let prefectureLabelsVisible = false;

const municipalityLayers = new Map<string, "loading" | MunicipalityBoundaryResult>();
let municipalitiesVisible = false;
let municipalityLabelsVisible = false;
let capitalLabelsVisible = false;

// ページング/キャッシュ用の状態。host(インスタンスのorigin)ごとに区画が分かれる。
let currentHost: string | null = null;
let cursor: Cursor | null = null;

// 同じgeohash(=同じ発見判定エリア)を持つAshiatoは、地図上では1グループとして
// まとめて表示する(桁数の短いgeohashだと複数レコードが同じセルに乗ることがあり、
// レコードごとに描画するとマーカーが完全に重なってタップ不能になるため)。
// geohash文字列 -> { geohash, records: Map<id, record>, visualLayers, hitArea, geohashLength, color }
// ロック中(未発見)のレコードもrecordsには保持する(GPS判定に必要)が、
// 発見済みが1件も無い間はvisualLayers/hitArea/colorはnullのまま(=地図に描画しない)。
const ashiatoCells = new Map<string, AshiatoCell>();

// geohashの桁数条件は満たすが、投稿からまだMIN_NOTE_AGE_MS経っていないレコード。
// promoteAgedRecords()が定期的にチェックし、条件を満たしたらashiatoCellsへ昇格させる。
const pendingRecords = new Map<string, AshiatoRecord>();

const currentLocationLayer = createCurrentLocationLayer(map);
let watchId: number | null = null;
let gpsEnabled = false;

const STATUS_AUTO_HIDE_MS = 3500;
const ERROR_AUTO_HIDE_MS = 6000; // エラーも時間経過で自動的に消す(内容確認の猶予として少し長め)
let statusHideTimer: ReturnType<typeof setTimeout> | undefined;

// 通常メッセージ・エラーメッセージいずれも、一定時間で自動的に消える
// (地図の面積を占有し続けないように)。エラーは見落とし防止のため
// ×ボタンでも明示的に閉じられるが、自動消去自体は行う。
function setStatus(t: string, e = false): void {
  clearTimeout(statusHideTimer);
  statusText.textContent = t;
  statusToast.classList.toggle("error", e);
  statusIcon.replaceChildren(createIcon(e ? "triangle-alert" : "info"));
  statusToast.hidden = false;
  statusCloseBtn.hidden = !e;

  statusHideTimer = setTimeout(
    () => {
      statusToast.hidden = true;
    },
    e ? ERROR_AUTO_HIDE_MS : STATUS_AUTO_HIDE_MS,
  );
}

statusCloseBtn.onclick = () => {
  clearTimeout(statusHideTimer);
  statusToast.hidden = true;
};

// --- alert/confirmの代替ダイアログ -----------------------------------------
// ネイティブのalert()/confirm()は他のUIと見た目が揃わないため、既存のdialog群と
// 同じ見た目のダイアログで代替する。showConfirmはPromise<boolean>を返し、
// OKボタンなら true、キャンセル/ESC/外側クリックならすべて false になる。

// ダイアログの外側(::backdrop)をクリックしたら閉じる、というほぼ全ダイアログ
// 共通の挙動をまとめたヘルパー。矩形の内外判定でrect.top/left等を毎回
// 書き下すのではなく、Element.contains()同等の簡易版として使う。
function closeOnBackdropClick(dialog: HTMLDialogElement): void {
  dialog.addEventListener("click", (e) => {
    const rect = dialog.getBoundingClientRect();
    const inside =
      rect.top <= e.clientY &&
      e.clientY <= rect.top + rect.height &&
      rect.left <= e.clientX &&
      e.clientX <= rect.left + rect.width;
    if (!inside) dialog.close(); // キャンセル扱い(showConfirm等ではresultはfalseのまま)
  });
}

const confirmDialog = $<HTMLDialogElement>("#confirmDialog");
const confirmMessage = $("#confirmMessage");
const confirmOkBtn = $<HTMLButtonElement>("#confirmOk");
const confirmCancelBtn = $<HTMLButtonElement>("#confirmCancel");

function showConfirm(
  message: string,
  {
    okLabel = "OK",
    cancelLabel = "キャンセル",
    danger = false,
  }: { okLabel?: string; cancelLabel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    confirmMessage.textContent = message;
    confirmOkBtn.textContent = okLabel;
    confirmOkBtn.className = danger ? "btn-danger" : "btn-primary";
    confirmCancelBtn.textContent = cancelLabel;

    // resultは「OKが押されたか」を保持するだけの変数。close()の実行順に
    // 依存しないよう、close()を呼ぶ前に必ずresultを確定させてから閉じる。
    let result = false;

    const handleOk = () => {
      result = true;
      confirmDialog.close();
    };
    const handleCancel = () => {
      result = false;
      confirmDialog.close();
    };
    // ESCキー/外側クリックによるネイティブcloseも含め、閉じたタイミングで
    // 一度だけresultを読み取ってPromiseを解決する。
    const handleClose = () => {
      confirmOkBtn.removeEventListener("click", handleOk);
      confirmCancelBtn.removeEventListener("click", handleCancel);
      confirmDialog.removeEventListener("close", handleClose);
      resolve(result);
    };

    confirmOkBtn.addEventListener("click", handleOk);
    confirmCancelBtn.addEventListener("click", handleCancel);
    confirmDialog.addEventListener("close", handleClose);

    confirmDialog.showModal();
  });
}

closeOnBackdropClick(confirmDialog);

// --- 「つまんで高さ調整」ドラッグ操作の共通処理 -----------------------------
// 下部シート(投稿UI/見つけたあしあと/下書き)・マップの吹き出し(同一地点の
// 複数あしあと一覧)のどちらも、上部のハンドルをつまんで高さを直接調整でき、
// 素早く下方向にフリックした場合、または一定以上(START_HEIGHT×
// DRAG_RESIZE_CLOSE_HEIGHT_RATIO)まで小さくした場合は、指を離した時点で
// そのまま閉じる、という同じ操作感にする。高さの取得/反映方法と「閉じる」の
// 実体(dialog.close() / map.closePopup())は対象ごとに異なるので、
// DragResizeTargetとして注入する。
const MIN_DRAG_RESIZE_HEIGHT_PX = 120;
const DRAG_RESIZE_FLICK_VELOCITY_PX_PER_MS = 0.6;
const DRAG_RESIZE_CLOSE_HEIGHT_RATIO = 0.35;
// マップの吹き出し(showAshiatoCellPopup)をドラッグで広げられる上限。
// Leaflet側のL.popup({maxHeight:260})はあくまで初期表示時の上限で、
// ドラッグ操作はこちらの値(とウィンドウ高さ)を上限にする。
const POPUP_DRAG_MAX_HEIGHT_PX = 480;

interface DragResizeTarget {
  handle: HTMLElement;
  getHeightPx(): number;
  setHeightPx(px: number): void;
  getMaxHeightPx(): number;
  onDismiss(): void; // フリック/縮めすぎで閉じる際に呼ぶ
}

function enableDragResize({
  handle,
  getHeightPx,
  setHeightPx,
  getMaxHeightPx,
  onDismiss,
}: DragResizeTarget): void {
  // hasPointerCapture()ではなくこのフラグでドラッグ中かどうかを判定する。
  // ブラウザによってはpointercancel発火前に暗黙的にpointer captureが
  // 解放されていることがあり、hasPointerCapture()に頼ると
  // pointercancel時にfinishDragが何もしないまま抜けてしまう
  // (中途半端な高さで固まって見える)ことがあるため。
  let dragging = false;
  let startY = 0;
  let startHeight = 0;
  let maxHeightPx = 0;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0; // 直近の指の移動速度(px/ms)。正=下方向。

  handle.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    handle.setPointerCapture(e.pointerId);
    dragging = true;

    startY = e.clientY;
    lastY = e.clientY;
    lastT = e.timeStamp;
    velocity = 0;
    startHeight = getHeightPx();
    maxHeightPx = getMaxHeightPx();
  });

  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;

    const dy = e.clientY - startY;
    const dt = e.timeStamp - lastT;
    if (dt > 0) velocity = (e.clientY - lastY) / dt;
    lastY = e.clientY;
    lastT = e.timeStamp;

    const newHeight = Math.min(maxHeightPx, Math.max(MIN_DRAG_RESIZE_HEIGHT_PX, startHeight - dy));
    setHeightPx(newHeight);
  });

  const finishDrag = () => {
    if (!dragging) return;
    dragging = false;

    const currentHeight = getHeightPx();
    const isFastDownwardFlick = velocity > DRAG_RESIZE_FLICK_VELOCITY_PX_PER_MS;
    const isTooShort = currentHeight < startHeight * DRAG_RESIZE_CLOSE_HEIGHT_RATIO;

    if (isFastDownwardFlick || isTooShort) onDismiss();
  };
  handle.addEventListener("pointerup", finishDrag);
  handle.addEventListener("pointercancel", finishDrag);
}

// 下部シート(投稿UI/見つけたあしあと/下書き)用。CSSのmax-heightを上限にする。
// 開閉のスライドアニメーション自体はstyle.css側(transform+@starting-style)で
// 完結しているため、ここではclose()を呼ぶだけでよい。
function enableSheetDragResize(dialog: HTMLDialogElement): void {
  const handle = dialog.querySelector<HTMLElement>(".sheet-handle");
  if (!handle) return;

  enableDragResize({
    handle,
    getHeightPx: () => dialog.getBoundingClientRect().height,
    setHeightPx: (px) => {
      dialog.style.height = `${px}px`;
    },
    // ドラッグで広げられる上限は、そのシートのCSS上のmax-heightまでとする。
    getMaxHeightPx: () =>
      parseFloat(getComputedStyle(dialog).maxHeight) || dialog.getBoundingClientRect().height,
    onDismiss: () => dialog.close(),
  });

  // 次に開いたときは常にCSSで指定された既定の高さから始める
  // (前回ドラッグで変更した高さを持ち越さない)。
  dialog.addEventListener("close", () => {
    dialog.style.height = "";
  });
}

async function initBoundaries(): Promise<void> {
  try {
    const { data: prefectureData, labelLayer } =
      await loadPrefectureBoundaries(map);
    prefectureIndex = buildPrefectureIndex(prefectureData);
    prefectureLabelLayer = labelLayer;
    syncLabelVisibility();
    await syncMunicipalityLayers();
    map.on("moveend", () => {
      syncLabelVisibility();
      syncMunicipalityLayers();
    });
  } catch (error) {
    console.error(error);
    setStatus("地図境界の読み込みに失敗しました。", true);
  }
}

function syncLabelVisibility(): void {
  const zoom = map.getZoom();

  // 県庁所在地・政令指定都市の大きいラベルが表示されるレベルまでズームしたら、
  // 都道府県ラベルは邪魔になるため非表示にする。
  const wantPrefLabels =
    zoom >= MIN_ZOOM_FOR_PREFECTURE_LABELS && zoom < MIN_ZOOM_FOR_CAPITAL_LABELS;
  if (wantPrefLabels !== prefectureLabelsVisible && prefectureLabelLayer) {
    if (wantPrefLabels) prefectureLabelLayer.addTo(map);
    else map.removeLayer(prefectureLabelLayer);
    prefectureLabelsVisible = wantPrefLabels;
  }

  const wantMunicipalityLabels = zoom >= MIN_ZOOM_FOR_MUNICIPALITY_LABELS;
  if (wantMunicipalityLabels !== municipalityLabelsVisible) {
    for (const entry of municipalityLayers.values()) {
      if (entry === "loading") continue;
      if (wantMunicipalityLabels) entry.labelLayer.addTo(map);
      else map.removeLayer(entry.labelLayer);
    }
    municipalityLabelsVisible = wantMunicipalityLabels;
  }

  // 県庁所在地・政令指定都市の大きいラベルは、通常の市区町村ラベルとは
  // 独立したズーム閾値(MIN_ZOOM_FOR_CAPITAL_LABELS)で切り替える。
  const wantCapitalLabels = zoom >= MIN_ZOOM_FOR_CAPITAL_LABELS;
  if (wantCapitalLabels !== capitalLabelsVisible) {
    for (const entry of municipalityLayers.values()) {
      if (entry === "loading") continue;
      if (wantCapitalLabels) entry.prominentLabelLayer.addTo(map);
      else map.removeLayer(entry.prominentLabelLayer);
    }
    capitalLabelsVisible = wantCapitalLabels;
  }
}

async function syncMunicipalityLayers(): Promise<void> {
  if (map.getZoom() < MIN_ZOOM_FOR_MUNICIPALITIES) {
    if (municipalitiesVisible) {
      for (const entry of municipalityLayers.values()) {
        if (entry === "loading") continue;
        map.removeLayer(entry.boundaryLayer);
        map.removeLayer(entry.labelLayer);
        map.removeLayer(entry.prominentLabelLayer);
      }
      municipalitiesVisible = false;
    }
    return;
  }

  if (!municipalitiesVisible) {
    // ズームが閾値を超えた場合は、市区町村境界を読み込み表示するが、
    // 既に読み込み済みであればそちらを再利用する
    for (const entry of municipalityLayers.values()) {
      if (entry === "loading") continue;
      entry.boundaryLayer.addTo(map);
      if (municipalityLabelsVisible) entry.labelLayer.addTo(map);
      if (capitalLabelsVisible) entry.prominentLabelLayer.addTo(map);
    }
    municipalitiesVisible = true;
  }

  const b = map.getBounds();
  const viewRect = {
    minLat: b.getSouth(),
    maxLat: b.getNorth(),
    minLon: b.getWest(),
    maxLon: b.getEast(),
  };
  const needed = findPrefecturesInView(prefectureIndex, viewRect);

  for (const pref of needed) {
    if (municipalityLayers.has(pref.code)) continue; // 読み込み済み or 読み込み中

    municipalityLayers.set(pref.code, "loading");
    try {
      const entry = await loadMunicipalityBoundaries(map, pref.code);
      // loadMunicipalityBoundariesはboundaryLayerを内部で無条件にaddTo(map)して
      // いるため、取得を待っている間にズームアウトされてmunicipalitiesVisibleが
      // falseに戻っていた場合は、ここで取り除いておかないと次にこの閾値を
      // 跨ぐまで境界線が残留してしまう(entry自体はキャッシュしておき、
      // 再度ズームインしたときは既存のentryをそのまま使い回す)。
      if (!municipalitiesVisible) {
        map.removeLayer(entry.boundaryLayer);
      } else {
        if (municipalityLabelsVisible) entry.labelLayer.addTo(map);
        if (capitalLabelsVisible) entry.prominentLabelLayer.addTo(map);
      }
      municipalityLayers.set(pref.code, entry);
    } catch (error) {
      console.error(`市区町村境界の読み込みに失敗(${pref.name}):`, error);
      municipalityLayers.delete(pref.code); // 後の moveend で再試行
    }
  }
}

initBoundaries();

// --- Ashiatoのページング + ローカルキャッシュ ---------------------------

// geohash1件分の判定エリアサイズを、案内文の断片として作る
function cellSizeText(geohash: string): string {
  const { widthM, heightM } = geohashCellSizeMeters(geohash);
  return `東西 ${Math.round(widthM)}m, 南北 ${Math.round(heightM)}m`;
}

// 日付+時刻(分単位)まで含むフォーマッタ。「過去を探す」の到達地点表示や
// 下書きの作成日時表示に使う。値が無い/不正なら null。
function formatDateTime(value: string | number | null): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// 一覧・ポップアップの行ヘッダーに表示する投稿日時の「相対表示」。
// 1時間未満は分、1日未満は時間、5日未満は日数だけを表示し(「◯前」等の接尾辞は付けない)、
// それ以上は日付(今年なら月/日、年をまたぐなら年/月/日、いずれも0埋めなし)にする。
// 「情報」ダイアログの投稿日時・発見日時はこれとは別に、常にformatDateTime(yyyy/MM/dd hh:mm)を使う。
function formatRelativePostedAt(value: string | number | null): string {
  if (!value) return "不明";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "不明";

  const now = new Date();
  const diffMs = Math.max(0, now.getTime() - d.getTime());
  const diffMin = diffMs / 60000;
  if (diffMin < 60) return `${Math.floor(diffMin)}分`;

  const diffHour = diffMin / 60;
  if (diffHour < 24) return `${Math.floor(diffHour)}時間`;

  const diffDay = diffHour / 24;
  if (diffDay < 5) return `${Math.floor(diffDay)}日`;

  const month = d.getMonth() + 1;
  const date = d.getDate();
  return d.getFullYear() === now.getFullYear()
    ? `${month}/${date}`
    : `${d.getFullYear()}/${month}/${date}`;
}

// 投稿者のラベルを「{表示名} @{アカウント名}@{投稿元インスタンス}」の形式で組み立てる。
// 表示名(note.user.name)を設定していないユーザーもいるため、その場合は
// 「@アカウント名@インスタンス」のみになる。usernameそのものが無い
// (通常は起こらないはずだが念のため)場合は不明ユーザー扱いにする。
// ホストはemojiHost(投稿元インスタンスのorigin。無ければ検索に使ったhost)から導出する。
function formatUserLabel(record: AshiatoRecord): string {
  if (!record.username) return "(不明なユーザー)";
  const host = stripProtocol(record.emojiHost ?? record.host);
  const handle = `@${record.username}@${host}`;
  return record.displayName ? `${record.displayName} ${handle}` : handle;
}

// --- 本文プレビュー中のカスタム絵文字描画 ---------------------------------
// textPreview(MFMをプレーンテキスト化したもの)には、カスタム絵文字が
// 「:name:」という記法のまま残っている(mfmNodeToPlainText参照)。
// ポップアップ・見つけたあしあと一覧の2箇所だけ、record.emojiHost(投稿元インスタンス)
// のmisskey.js:fetchEmojiMapを使ってshortcode→画像URLを解決し、実際の画像に置き換えて
// 表示する(note.emojisは最近のMisskeyでは空のことが多く当てにできないため使わない)。
// 下書き一覧はユーザーが本文を入力する欄自体が無いため対象外。

const EMOJI_SHORTCODE_RE = /:([0-9a-zA-Z_+-]+):/g;

// 画像取得結果(Object URL)のセッション内メモリキャッシュ。キーは`${emojiHost}::${name}`
// (同じshortcodeでもインスタンスが違えば別の絵文字になりうるため、hostも含めて区別する)。
// IndexedDB(cache.js)側は「ネットワーク再取得を避ける」ための永続キャッシュ、
// こちらは「同じセッション中に何度もcreateObjectURLし直さない」ための即席キャッシュ。
const emojiObjectUrlCache = new Map<string, string | null>(); // "host::name" -> objectURL | null(取得失敗)

// shortcode(name)を、そのカスタム絵文字の投稿元インスタンス(emojiHost)に問い合わせて
// 画像URLへ解決し、Blobをcache.js経由でキャッシュした上でObject URLを返す。
// emojiHostのインスタンスにその名前の絵文字が無い(=ローカルの通常絵文字や、
// 既に削除された絵文字など)場合はnullを返し、呼び出し側でテキストへフォールバックする。
async function resolveEmojiImageUrl(emojiHost: string, name: string): Promise<string | null> {
  const cacheKey = `${emojiHost}::${name}`;
  if (emojiObjectUrlCache.has(cacheKey)) return emojiObjectUrlCache.get(cacheKey)!;

  try {
    const emojiMap = await fetchEmojiMap(emojiHost);
    const url = emojiMap.get(name);
    if (!url) throw new Error(`絵文字が見つかりません: ${name}@${emojiHost}`);

    let blob = await getEmojiImageBlob(url);
    if (!blob) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`絵文字画像の取得に失敗: HTTP ${res.status}`);
      blob = await res.blob();
      await putEmojiImageBlob(url, blob); // 次回以降はネットワーク取得しない
    }
    const objectUrl = URL.createObjectURL(blob);
    emojiObjectUrlCache.set(cacheKey, objectUrl);
    return objectUrl;
  } catch (error) {
    console.warn(`main: カスタム絵文字画像の取得に失敗(${cacheKey}):`, error);
    emojiObjectUrlCache.set(cacheKey, null); // 失敗も覚えておき、同じセッション内で無駄な再取得をしない
    return null;
  }
}

// text中の「:name:」を、emojiHost(投稿元インスタンス)から解決した画像があれば<img>に、
// 無ければそのままのテキストとしてcontainerへ追加していく。画像の解決は非同期のため、
// 一旦プレースホルダーのimgを差し込んでおき、後から src を差し替える
// (取得に失敗した場合はテキストへフォールバックする)。
// onEmojiSettledは、各絵文字の解決(成功/失敗いずれか)が完了するたびに呼ばれる。
// 画像挿入によってcontainerの高さが変わりうるため、呼び出し側は「続きを表示」ヒントの
// 表示要否(applyPreviewOverflowChecks)を再計算するのに使う。
function appendTextWithEmojis(
  container: HTMLElement,
  text: string,
  emojiHost: string,
  onEmojiSettled?: () => void,
): void {
  let lastIndex = 0;
  EMOJI_SHORTCODE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = EMOJI_SHORTCODE_RE.exec(text))) {
    if (m.index > lastIndex) {
      container.append(document.createTextNode(text.slice(lastIndex, m.index)));
    }

    const name = m[1];
    const img = document.createElement("img");
    img.className = "mfm-emoji-inline";
    img.alt = `:${name}:`;
    img.decoding = "async";
    container.append(img);

    resolveEmojiImageUrl(emojiHost, name).then((objectUrl) => {
      if (objectUrl) {
        img.src = objectUrl;
      } else if (img.isConnected) {
        img.replaceWith(document.createTextNode(`:${name}:`));
      }
      onEmojiSettled?.();
    });

    lastIndex = EMOJI_SHORTCODE_RE.lastIndex;
  }

  if (lastIndex < text.length) {
    container.append(document.createTextNode(text.slice(lastIndex)));
  }
}

// mfm-preview(本文プレビュー)が実際に高さでクリップされているかどうかを判定し、
// 直後のmfm-preview-hint(「続きを表示」)の表示/非表示を切り替える。
// 要素がまだ画面に表示されていない(閉じたdialog内・ポップアップ生成直後でDOM未接続 等)
// タイミングで呼んでも高さが正しく測れないため、実際に画面へ表示されたタイミング
// (dialogを開いた直後、ポップアップをopenOn()した直後)、および絵文字画像の非同期
// 読み込みで高さが変わりうるタイミング(appendTextWithEmojisのonEmojiSettled経由)で呼ぶ。
function applyPreviewOverflowChecks(root: ParentNode): void {
  for (const preview of root.querySelectorAll<HTMLElement>(".mfm-preview")) {
    // 手動で「続きを表示」→展開済みのものは、クリップが外れて overflow が
    // 無くなった状態になるため、ここで再計算すると「折りたたむ」ヒントが
    // 誤って隠れてしまう。展開中は判定自体をスキップする。
    if (preview.classList.contains("mfm-preview-expanded")) continue;
    const hint = preview.nextElementSibling as HTMLElement | null;
    if (!hint?.classList.contains("mfm-preview-hint")) continue;
    hint.hidden = preview.scrollHeight <= preview.clientHeight + 1;
  }
}

// 投稿者名部分(ヘッダー行内)を組み立てる。表示名は太字・改行しない固定幅、
// 「@アカウント名@インスタンス」のハンドル部分は一回り小さく薄い色にした上で、
// 長い場合は後半を省略記号(…)で切り詰める(投稿日時の表示を圧迫しないように。
// 幅の制御自体はCSS側、.ashiato-user/.ashiato-handle参照)。
function buildUserNameNode(record: AshiatoRecord): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "ashiato-user";

  if (!record.username) {
    wrap.textContent = "(不明なユーザー)";
    return wrap;
  }

  if (record.displayName) {
    const name = document.createElement("span");
    name.className = "ashiato-display-name";
    name.textContent = record.displayName;
    wrap.append(name);
  }

  const host = stripProtocol(record.emojiHost ?? record.host);
  const handle = document.createElement("span");
  handle.className = "ashiato-handle";
  handle.textContent = `@${record.username}@${host}`;
  wrap.append(handle);

  return wrap;
}

// あしあと1件分の行を組み立てる(見つけたあしあと一覧・マップ同一位置ポップアップ共通)。
// SNSのタイムライン表示に近い3段構成:
//   ヘッダー(未読ドット+投稿者名+ハンドル+投稿日時[相対表示]) → 本文プレビュー →
//   フッター(発見日時[yyyy/MM/dd hh:mm]+「…」ボタン)
// 行タップ自体では何も起きず、「…」ボタンだけがアクションシートを開く。
// overflowRootは「続きを表示」ヒントの再計算対象(applyPreviewOverflowChecks)に渡すルート要素。
// ここでは既読化は一切行わない(呼び出し側がobserveRowsForReadで返り値の行要素を
// 監視し、実際にスクロールされて画面内に表示された時点で初めて既読にする)。
// 未読ドットは、呼び出し時点でまだ未読だったレコードにのみ表示する。
function renderAshiatoRow(
  record: AshiatoRecord,
  overflowRoot: ParentNode,
  onMore: () => void,
): HTMLElement {
  const isUnread = !record.readAt;

  const row = document.createElement("div");
  row.className = "ashiato-row";

  // 投稿者アイコン(丸くクロップ)。取得できない/読み込み失敗時は
  // 背景色だけのプレースホルダーになる(style.css参照)。
  const avatar = document.createElement("img");
  avatar.className = "ashiato-avatar";
  avatar.alt = "";
  avatar.loading = "lazy";
  if (record.avatarUrl) avatar.src = record.avatarUrl;
  row.append(avatar);

  const main = document.createElement("div");
  main.className = "ashiato-row-main";
  row.append(main);

  const header = document.createElement("div");
  header.className = "ashiato-row-header";
  if (isUnread) {
    const dot = document.createElement("span");
    dot.className = "unread-dot";
    // マップ上の丸と同じ配色(Geohashの桁数=精度で色分け)に揃える。
    // .unread-dotのbackground/box-shadowはcurrentColorを参照しているため、
    // ここでcolorを指定するだけで明滅の色も追従する(style.css参照)。
    dot.style.color = ashiatoColor(record.geohash.length);
    dot.setAttribute("aria-label", "未読");
    header.append(dot);
  }
  header.append(buildUserNameNode(record));
  const postedAt = document.createElement("span");
  postedAt.className = "ashiato-posted-at";
  postedAt.textContent = formatRelativePostedAt(record.noteCreatedAt);
  header.append(postedAt);
  main.append(header);

  if (record.textPreview) {
    const preview = document.createElement("span");
    preview.className = "mfm-preview";
    const hint = document.createElement("button");
    hint.type = "button";
    hint.className = "mfm-preview-hint";
    hint.textContent = "続きを表示";
    hint.hidden = true;
    // クリックのたびに高さクリップ(max-height)の解除/再適用を切り替える。
    hint.onclick = () => {
      const expanded = preview.classList.toggle("mfm-preview-expanded");
      hint.textContent = expanded ? "折りたたむ" : "続きを表示";
    };
    appendTextWithEmojis(
      preview,
      record.textPreview,
      record.emojiHost ?? record.host,
      () => applyPreviewOverflowChecks(overflowRoot),
    );
    main.append(preview, hint);
  }

  if (record.files.length > 0) {
    main.append(buildMediaGrid(record.files));
  }

  const footer = document.createElement("div");
  footer.className = "ashiato-row-footer";

  const discovered = document.createElement("span");
  discovered.className = "ashiato-discovered";
  discovered.textContent = `発見: ${formatDateTime(record.unlockedAt) ?? "不明"}`;
  footer.append(discovered);

  const moreBtn = document.createElement("button");
  moreBtn.type = "button";
  moreBtn.className = "ashiato-more-btn";
  moreBtn.setAttribute("aria-label", "その他の操作");
  moreBtn.append(createIcon("ellipsis"));
  moreBtn.onclick = onMore;
  footer.append(moreBtn);

  main.append(footer);

  return row;
}

// 「設定」ダイアログのメディア表示モード。起動時にsettingsから復元する
// (起動時処理参照)。putSettingを使うため、「リセット」(IndexedDBごと削除)を
// 実行しない限り永続する。
type MediaVisibilityMode = "hide-all" | "hide-sensitive" | "show-all";
let mediaVisibilityMode: MediaVisibilityMode = "hide-sensitive";

// この添付ファイルを最初はモザイク(ぼかし)状態で表示すべきかどうか。
// - hide-all: 全てのメディアを隠す
// - hide-sensitive: isSensitiveなものだけ隠す(既定)
// - show-all: 何も隠さない(ただしセンシティブタグ自体は別途常に表示する)
function shouldBlurMedia(file: AshiatoFile): boolean {
  if (mediaVisibilityMode === "show-all") return false;
  if (mediaVisibilityMode === "hide-all") return true;
  return file.isSensitive;
}

// 添付画像/GIF/動画のグリッドを組み立てる(Twitter風、1〜4枚以上に対応)。
// 動画1件だけの投稿はグリッドでクロップせず全幅で表示し、シーク・音声ON/OFFは
// ブラウザ標準のvideo controlsに任せる(カスタムUIは作らない)。
// 画像は押すと画面いっぱいのライトボックスで拡大表示する(openMediaLightbox参照)。
// 複数画像中、動画は数に含めつつライトボックスのナビゲーションからは除外する
// (画像同士の送り/戻りだけを行う)。
function buildMediaGrid(files: AshiatoFile[]): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "ashiato-media-grid";
  grid.dataset.count = String(Math.min(files.length, 4));

  if (files.length === 1 && files[0].type.startsWith("video/")) {
    grid.classList.add("ashiato-media-grid-single-video");
    grid.append(buildMediaItem(files[0], [], -1, 0, 1));
    return grid;
  }

  const images = files.filter((f) => !f.type.startsWith("video/"));
  files.forEach((file, index) => {
    grid.append(buildMediaItem(file, images, images.indexOf(file), index, files.length));
  });
  return grid;
}

// imagesForLightbox/lightboxIndexは、この1件が画像の場合の「ライトボックスに
// 渡す画像だけの配列とその中でのインデックス」。動画の場合は使わない(-1)。
// position/totalは添付ファイル全体(動画も含む)の中での位置と総数で、
// 複数枚あることを示すバッジ(1/3等)の表示に使う。
// モザイク(ぼかし)の状態はitemの"ashiato-media-blurred"クラスの有無だけで管理する。
// veil(タップで表示)とeyeBtn(タップでモザイクをかけ直す)はどちらも常にDOM上に
// 存在し、どちらを見せるかはCSS側でそのクラスの有無から切り替える
// (style.css: .ashiato-media-blurred .ashiato-media-veil / :not(...) .ashiato-media-eye-btn)。
// センシティブタグは、モザイク状態に関わらずisSensitiveなら常に表示する
// (ライトボックス側には付けない = このitem内だけの要素なので自然に満たされる)。
function buildMediaItem(
  file: AshiatoFile,
  imagesForLightbox: AshiatoFile[],
  lightboxIndex: number,
  position: number,
  total: number,
): HTMLElement {
  const item = document.createElement("div");
  item.className = "ashiato-media-item";
  if (shouldBlurMedia(file)) item.classList.add("ashiato-media-blurred");

  const isVideo = file.type.startsWith("video/");
  if (isVideo) {
    const video = document.createElement("video");
    video.src = file.url;
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    item.append(video);
  } else {
    const img = document.createElement("img");
    img.src = file.thumbnailUrl ?? file.url;
    img.alt = "";
    img.loading = "lazy";
    img.onclick = () => {
      // モザイク中はveilがimgの上を覆っておりクリックはveil側に吸収されるはずだが、
      // 念のため二重にガードしておく。
      if (item.classList.contains("ashiato-media-blurred")) return;
      openMediaLightbox(imagesForLightbox, lightboxIndex);
    };
    item.append(img);
  }

  if (file.isSensitive) {
    const tag = document.createElement("span");
    tag.className = "ashiato-media-sensitive-tag";
    tag.textContent = "センシティブ";
    item.append(tag);
  }

  const veil = document.createElement("button");
  veil.type = "button";
  veil.className = "ashiato-media-veil";
  veil.textContent = file.isSensitive ? "閲覧注意\n（タップで表示）" : "タップで表示";
  veil.onclick = (e) => {
    e.stopPropagation();
    item.classList.remove("ashiato-media-blurred");
  };
  item.append(veil);

  const eyeBtn = document.createElement("button");
  eyeBtn.type = "button";
  eyeBtn.className = "ashiato-media-eye-btn";
  eyeBtn.setAttribute("aria-label", "モザイクをかけ直す");
  eyeBtn.append(createIcon("eye"));
  eyeBtn.onclick = (e) => {
    e.stopPropagation();
    item.classList.add("ashiato-media-blurred");
  };
  item.append(eyeBtn);

  // 複数枚あるときだけ、何枚中の何枚目かを示すバッジを付ける(横スクロールで
  // 1枚ずつしか見えないため、境界線の装飾だけでは複数枚あることに気づきにくい)。
  if (total > 1) {
    const counter = document.createElement("span");
    counter.className = "ashiato-media-counter";
    counter.textContent = `${position + 1}/${total}`;
    item.append(counter);
  }

  return item;
}

// セルの地図上の見た目(円+タップ判定)だけを取り除く。cell.records自体は
// 変更しないので、呼び出し側がその後cellを削除するか、rebuildCellVisualで
// 作り直すかを決める。
function clearCellVisual(cell: AshiatoCell): void {
  if (cell.hitArea) removeAshiatoGroup(map, { visualLayers: cell.visualLayers!, hitArea: cell.hitArea });
}

// セルの見た目(円)を、現在のrecords件数・状態に合わせて作り直す。
// ロック中(未発見)のレコードは地図上に一切表示しない方針のため、
// 表示対象は「発見済み(unlockedAtあり)」のレコードだけに絞る。
// 発見済みレコードが1件も無いセルは、円そのものを描画しない
// (GPS判定用の内部データとしてはcell.recordsに保持し続ける)。
function rebuildCellVisual(cell: AshiatoCell): void {
  clearCellVisual(cell);
  cell.visualLayers = null;
  cell.hitArea = null;

  const visibleRecords = [...cell.records.values()].filter(
    (r) =>
      (SHOW_LOCKED_ASHIATO_FOR_DEBUG || r.unlockedAt) && (!hideReadEnabled || !r.readAt),
  );

  if (visibleRecords.length > 0) {
    const allRead = visibleRecords.every((r) => r.readAt);
    const { visualLayers, hitArea } = addAshiatoGroup(
      map,
      cell.geohash,
      visibleRecords.length,
      allRead,
      () => handleCellClick(cell.geohash),
    );
    cell.visualLayers = visualLayers;
    cell.hitArea = hitArea;
  }

  areaOverlay.refresh([...ashiatoCells.values()]);
}

// レコードを対応するセルに追加する。セルが無ければ新設する。
// 同じidのレコードが既にあれば何もしない(重複読み込み対策)。
function addRecordToCell(record: AshiatoRecord): void {
  let cell = ashiatoCells.get(record.geohash);
  if (!cell) {
    cell = { geohash: record.geohash, records: new Map(), visualLayers: null, hitArea: null };
    ashiatoCells.set(record.geohash, cell);
  }
  if (cell.records.has(record.id)) return;

  cell.records.set(record.id, record);
  rebuildCellVisual(cell);
}

// geohashの桁数条件は満たしているレコードを、状態に応じて登録する。
// - 既に発見済み(unlockedAt)、または投稿からMIN_NOTE_AGE_MS_BY_LENGTH(桁数依存)分
//   経過済み: 即座にセルへ登録する(これ以降、現在地判定(GPS)の対象になる)
// - まだ経っていない: pendingRecordsで保留する(セルには一切登録しない=
//   現在地判定も一切かからない)。promoteAgedRecords()が定期的に昇格させる。
function registerRecord(record: AshiatoRecord): void {
  if (record.unlockedAt || isOldEnough(record.noteCreatedAt, record.geohash.length)) {
    pendingRecords.delete(record.id);
    addRecordToCell(record);
  } else {
    pendingRecords.set(record.id, record);
  }
}

// 保留中のレコードを定期的に再チェックし、必要な経過時間(桁数依存)を過ぎたものを
// 自動的にセルへ昇格させる(ページを開きっぱなしでも、手動で「探す」し直す
// 必要が無いように)。
// 併せて、GPSが有効な間は毎回checkCurrentPositionAgainstCellsも呼ぶ。Ashiato
// Syntaxの時間条件(d/w/t/o等)は位置が変わらなくても時刻の経過だけでActive/Inactive
// が切り替わりうるため、位置情報の更新を待たずにこの1分間隔のタイマーで
// 定期的に再評価する。
function promoteAgedRecords(): void {
  for (const [id, record] of pendingRecords) {
    if (isOldEnough(record.noteCreatedAt, record.geohash.length)) {
      pendingRecords.delete(id);
      addRecordToCell(record);
    }
  }
  if (gpsEnabled) checkCurrentPositionAgainstCells();
}

setInterval(promoteAgedRecords, PENDING_PROMOTION_INTERVAL_MS);

// 「見つけたあしあと」一覧の並び順。"unlocked"=発見日順、"posted"=投稿日順。
// いずれも新しい方が上(降順固定)。起動時にsettingsから復元する(initSortMode参照)。
type UnlockedSortMode = "unlocked" | "posted";
let unlockedSortMode: UnlockedSortMode = "unlocked";

// 「未読のみ」フィルター(見つけたあしあと一覧の表示フィルター)。
let showOnlyUnread = false;

// 見つけたあしあと一覧に現在張られている可視性ベース既読判定(observeRowsForRead)の
// 解除関数。refreshUnlockedListで作り直すたびに、古いものをここで解除する。
let disposeUnlockedListReadObserver: (() => void) | null = null;

function sortKeyFor(record: AshiatoRecord, mode: UnlockedSortMode): number {
  if (mode === "posted") {
    const posted = record.noteCreatedAt ? new Date(record.noteCreatedAt).getTime() : NaN;
    return Number.isNaN(posted) ? 0 : posted;
  }
  return record.unlockedAt ?? 0;
}

// 発見済み(unlockedAt)かつ未読(readAtが無い)のレコードが1件でもあれば、
// メニューFABとハンバーガーメニュー内「見つけたあしあと」項目に緑の点を出す。
// 一覧・ポップアップの描画後、および可視性ベースの既読化(observeRowsForRead)が
// 実際に既読化を行った後、いずれのタイミングでも呼ぶこと。
function updateUnreadBadge(): void {
  const hasUnread = [...ashiatoCells.values()].some((cell) =>
    [...cell.records.values()].some((r) => r.unlockedAt && !r.readAt),
  );
  menuBadge.hidden = !hasUnread;
  unlockedBadge.hidden = !hasUnread;
}

// 一定時間(このミリ秒数)表示され続けたレコードだけを既読にする。開いた瞬間
// (=表示された瞬間)に即既読化すると未読ドットを目にする間もなく消えてしまうため、
// 「ちゃんと表示された」とみなせるだけの猶予を設ける。この間にスクロールで
// 画面外に出た場合はタイマーを取り消し、既読にしない。
const READ_DWELL_MS = 1000;

// 「開いただけ」ではなく「実際にスクロールされて画面内に表示された」行だけを
// 既読にする(可視性ベースの既読判定)。rootは実際のスクロール領域
// (見つけたあしあと一覧ではunlockedList自身、マップの吹き出しではLeafletが
// 用意する.leaflet-popup-content)を渡すこと — スクロールしないrootを渡すと、
// 交差判定がその要素の矩形基準になってしまい正しく機能しない。
// 60%以上表示された状態がREAD_DWELL_MS続いた時点で既読と判定する
// (端がわずかに覗いただけ・一瞬スクロールで通り過ぎただけでは既読にしない)。
// 既読化したレコードのマップ上の丸(セル)は、その場でrebuildCellVisualして
// 既読/未読の見た目(色を薄くする/明滅を止める)を更新する。
// 既に既読のレコードは監視対象から除外する。返り値は監視解除用のdispose関数。
// IntersectionObserver非対応の古い環境では、判定しようがないため即座に既読にする
// (未読のまま何も表示できなくなるより安全側に倒す)。
function observeRowsForRead(
  root: Element,
  rows: { row: HTMLElement; record: AshiatoRecord }[],
): () => void {
  const pending = rows.filter(({ record }) => !record.readAt);
  if (pending.length === 0) return () => {};

  if (!("IntersectionObserver" in window)) {
    const cellsToRebuild = new Set<AshiatoCell>();
    for (const { record } of pending) {
      record.readAt = Date.now();
      markAshiatoRead(record.id, record.readAt);
      const cell = ashiatoCells.get(record.geohash);
      if (cell) cellsToRebuild.add(cell);
    }
    for (const cell of cellsToRebuild) rebuildCellVisual(cell);
    updateUnreadBadge();
    return () => {};
  }

  const recordByRow = new Map(pending.map(({ row, record }) => [row as Element, record]));
  const dwellTimers = new Map<Element, ReturnType<typeof setTimeout>>();

  const markRead = (target: Element, record: AshiatoRecord) => {
    dwellTimers.delete(target);
    if (record.readAt) return; // 他経路(削除→再発見など)で既に確定済みなら何もしない
    observer.unobserve(target);

    record.readAt = Date.now();
    markAshiatoRead(record.id, record.readAt);
    target.querySelector(".unread-dot")?.remove();

    const cell = ashiatoCells.get(record.geohash);
    if (cell) rebuildCellVisual(cell);
    updateUnreadBadge();
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const pendingTimer = dwellTimers.get(entry.target);
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          dwellTimers.delete(entry.target);
        }
        if (!entry.isIntersecting) continue;

        const record = recordByRow.get(entry.target);
        if (!record || record.readAt) continue;

        dwellTimers.set(
          entry.target,
          setTimeout(() => markRead(entry.target, record), READ_DWELL_MS),
        );
      }
    },
    { root, threshold: 0.6 },
  );

  for (const { row } of pending) observer.observe(row);

  return () => {
    observer.disconnect();
    for (const timer of dwellTimers.values()) clearTimeout(timer);
    dwellTimers.clear();
  };
}

// 「見つけたあしあと」ダイアログの中身を、アンロック済みのものだけ・
// 選択中の並び順で再構築する。ロック中(未発見)のものはここには載せない。
// 各行の「…」ボタンから、詳細確認・地図表示・SNSを開く・削除をまとめた
// アクションシート(openAshiatoActions)を開く。
function refreshUnlockedList(): void {
  const unlocked = [...ashiatoCells.values()]
    .flatMap((cell) => [...cell.records.values()])
    .filter((r) => r.unlockedAt)
    .sort((a, b) => sortKeyFor(b, unlockedSortMode) - sortKeyFor(a, unlockedSortMode));

  const visible = showOnlyUnread ? unlocked.filter((r) => !r.readAt) : unlocked;

  disposeUnlockedListReadObserver?.();
  disposeUnlockedListReadObserver = null;
  unlockedList.replaceChildren();

  if (visible.length === 0) {
    const empty = document.createElement("p");
    empty.className = "unlocked-list-empty";
    empty.textContent =
      unlocked.length === 0
        ? "まだ発見したあしあとありません。"
        : "未読のあしあとはありません。";
    unlockedList.append(empty);
    updateUnreadBadge();
    return;
  }

  const rowsForReadTracking: { row: HTMLElement; record: AshiatoRecord }[] = [];
  for (const record of visible) {
    const li = document.createElement("li");
    const row = renderAshiatoRow(record, unlockedList, () => openAshiatoActions(record));
    rowsForReadTracking.push({ row, record });
    li.append(row);
    unlockedList.append(li);
  }

  // このタイミングでdialogが開いていれば正しく測れる(閉じていれば後で
  // showModal()後に再度呼ばれて補正される。unlockedListToggleのonclick参照)。
  applyPreviewOverflowChecks(unlockedList);
  // ダイアログが閉じている間はunlockedList自体に表示領域が無いため交差が
  // 発生しないだけで、observer自体は張っておいて問題ない
  // (実際に開かれた時点で自動的に判定が始まる)。
  disposeUnlockedListReadObserver = observeRowsForRead(unlockedList, rowsForReadTracking);
  updateUnreadBadge();
}

// セルをクリックしたときの入口。
// ポップアップ等に出すのは発見済み(unlockedAt)のレコードのみ
// (ロック中のものは地図に表示していないため、そもそもクリックしようがない)。
// レコードが1件なら直接開封フローへ、複数件ならポップアップで一覧を出し、
// 選んだものだけ開封フローへ進む。
function handleCellClick(geohash: string): void {
  showAshiatoCellPopup(geohash);
}

// geohash1セル分のあしあとを、地図上に吹き出し(ポップアップ)で表示する。
// 件数が1件でも複数件でも表示形式は統一する(件数によって挙動を分けない)。
// アクションシートの「マップで表示する」からも同じ表示を再利用する。
function showAshiatoCellPopup(geohash: string): void {
  const cell = ashiatoCells.get(geohash);
  if (!cell) return;

  const records = [...cell.records.values()]
    .filter((r) => r.unlockedAt)
    .sort((a, b) => sortKeyFor(b, "posted") - sortKeyFor(a, "posted"));
  if (records.length === 0) return; // 通常は来ないはずだが念のため

  const { centerLat, centerLon } = decodeGeohash(geohash);
  const container = document.createElement("div");
  container.className = "ashiato-popup-list";

  // 下部シートと同じ「つまんで高さ調整」ハンドル(このあとのenableDragResize呼び出し参照)。
  const handle = document.createElement("div");
  handle.className = "sheet-handle";
  handle.setAttribute("aria-hidden", "true");
  const grip = document.createElement("span");
  grip.className = "sheet-handle-grip";
  handle.append(grip);
  container.append(handle);

  const rowsForReadTracking: { row: HTMLElement; record: AshiatoRecord }[] = [];
  for (const record of records) {
    // ポップアップは閉じない(「…」を押しても地図上の吹き出しはそのまま残る)。
    // アクションシートはモーダルダイアログとしてその上に重なって表示される。
    const row = renderAshiatoRow(record, container, () => {
      openAshiatoActions(record);
    });
    rowsForReadTracking.push({ row, record });
    container.append(row);
  }
  updateUnreadBadge();

  // maxHeightを指定すると、件数が多い場合にLeafletがポップアップ内を
  // 自動でスクロール可能にしてくれる(popupPaneのzIndexは createMap 側で
  // Ashiato/現在地より前面に設定済み)。
  // ashiato-popup-list内のbuttonはwidth:100%指定のため、Leafletが
  // コンテンツの自然な幅(scrollWidth)を測ろうとしても常に小さい値に
  // つぶれてしまい、maxWidthだけでは広がらない(実際に描画される幅は
  // minWidthとの兼ね合いで決まる)。minWidthで下限を明示して確実に
  // 横幅を確保する。
  const popup = L.popup({ minWidth: 280, maxWidth: 320, maxHeight: 260 })
    .setLatLng([centerLat, centerLon])
    .setContent(container)
    .openOn(map);

  // openOn()でDOMに接続・表示された直後なので、ここで初めて高さが正しく測れる。
  applyPreviewOverflowChecks(container);

  // container.parentElement は Leaflet が用意する実際のスクロール領域
  // (.leaflet-popup-content。maxHeight超過時にoverflow-y:autoが付く、
  // map.ts/L.popup呼び出し側のmaxHeight指定を参照)。
  const popupContent = container.parentElement!;

  // 上部のハンドルをつまんで、吹き出しの高さを直接調整できるようにする。
  // Leafletが決めたmaxHeight(260px)はあくまで初期表示時の上限で、
  // ドラッグではPOPUP_DRAG_MAX_HEIGHT_PXまで広げられるようにする
  // (viewportより大きくならないようウィンドウ高さでもクランプする)。
  enableDragResize({
    handle,
    getHeightPx: () => popupContent.getBoundingClientRect().height,
    setHeightPx: (px) => {
      popupContent.style.height = `${px}px`;
    },
    getMaxHeightPx: () => Math.min(POPUP_DRAG_MAX_HEIGHT_PX, window.innerHeight * 0.7),
    onDismiss: () => map.closePopup(),
  });

  // このポップアップが閉じられたら(他の吹き出しに差し替わった場合を含む)
  // observerを解放する。
  const disposeReadObserver = observeRowsForRead(popupContent, rowsForReadTracking);
  map.once("popupclose", (e) => {
    if (e.popup === popup) disposeReadObserver();
  });
}

// あしあと1件分の「…」ボタンから呼ばれるアクションシート。地図/一覧いずれの行から
// 呼ばれた場合も対象は常に発見済み(unlockedAtがある)レコードのみ。
// 情報(投稿者・投稿日時・発見日時・当たり判定エリア)を表示した上で、
// マップ表示・SNSを開く・「見つけたあしあと」からの削除の3アクションを提供する。
function openAshiatoActions(record: AshiatoRecord): void {
  ashiatoActionInfo.replaceChildren();
  const infoRows: [string, string][] = [
    ["投稿者", formatUserLabel(record)],
    ["場所", "取得中…"],
    ["投稿", formatDateTime(record.noteCreatedAt) ?? "不明"],
    ["発見", formatDateTime(record.unlockedAt) ?? "不明"],
    ["当たり判定エリア", cellSizeText(record.geohash)],
  ];
  let placeDd: HTMLElement | null = null;
  for (const [label, value] of infoRows) {
    const dt = document.createElement("dt");
    dt.textContent = label;
    const dd = document.createElement("dd");
    dd.textContent = value;
    ashiatoActionInfo.append(dt, dd);
    if (label === "場所") placeDd = dd;
  }

  // 市区町村境界GeoJsonのオンデマンド取得が絡むため非同期。取得完了まで「取得中…」
  // のまま表示し、終わり次第「場所」の行だけを差し替える(他の行は待たせない)。
  const { centerLat, centerLon } = decodeGeohash(record.geohash);
  lookupMunicipality(prefectureIndex, centerLat, centerLon, { includePrefecture: true })
    .then((place) => {
      if (placeDd) placeDd.textContent = place ?? "不明";
    })
    .catch(() => {
      if (placeDd) placeDd.textContent = "不明";
    });

  ashiatoActionShowOnMapBtn.onclick = () => {
    ashiatoActionDialog.close();
    unlockedListDialog.close();
    map.closePopup();
    const { minLat, maxLat, minLon, maxLon } = decodeGeohash(record.geohash);
    map.fitBounds(
      [
        [minLat, minLon],
        [maxLat, maxLon],
      ],
      { maxZoom: 18, padding: [40, 40] },
    );
    showAshiatoCellPopup(record.geohash);
  };

  ashiatoActionOpenPostBtn.onclick = () => {
    ashiatoActionDialog.close();
    window.open(`${record.host}/notes/${record.noteId}`, "_blank", "noopener");
  };

  ashiatoActionDeleteBtn.onclick = async () => {
    ashiatoActionDialog.close();
    const wantsToDelete = await showConfirm(
      "このあしあとを「見つけたあしあと」から削除しますか？(現地に行けば再度発見できます)",
      { okLabel: "削除する", danger: true },
    );
    if (!wantsToDelete) return;

    await clearCollectedAshiatoByIds([record.id]);

    const cell = ashiatoCells.get(record.geohash);
    if (cell) {
      const target = cell.records.get(record.id);
      if (target) {
        target.unlockedAt = null;
        target.readAt = null;
      }
      rebuildCellVisual(cell); // ロック中に戻るので円は消える(セルは保持)
      areaOverlay.refresh([...ashiatoCells.values()]);
    }

    refreshUnlockedList();
    setStatus("あしあとを削除しました。(現地に行けば再度発見できます)");
  };

  ashiatoActionDialog.showModal();
}

// --- 現在地(GPS)によるAshiatoのアンロック判定 -----------------------------

const gpsToggleBtn = $<HTMLButtonElement>("#toggleGps");
const composeAshiatoMenuItem = $<HTMLButtonElement>("#composeAshiatoMenuItem");

// GPSトグルON中、直近で取得できた現在地。投稿UIを開くとき、既にこれが
// あれば新たな位置情報取得を待たずに即座に投稿UIを表示できる。
// GPSトグルOFFのときは常にnull(古い位置情報を使い回さないため)。
let lastKnownPosition: { lat: number; lon: number } | null = null;
// 直近の位置精度(半径, メートル)。GPSトグルOFF中は常にnull。
let lastKnownAccuracy: number | null = null;

// 位置精度がこの半径(メートル)を超えたら「精度が悪い」とみなす。
// この状態では、あしあとの発見(当たり判定)・新規投稿・新規下書きを行わない
// (下書き済みのあしあとの投稿はisDraftPostableのルールのみに従い、ここでは制限しない)。
const BAD_ACCURACY_RADIUS_M = 200;

function isPrecisionBad(): boolean {
  return gpsEnabled && lastKnownAccuracy !== null && lastKnownAccuracy > BAD_ACCURACY_RADIUS_M;
}

function updatePrecisionWarning(): void {
  precisionWarning.hidden = !isPrecisionBad();
}

// 新規発見時、画面中央に一時的に出す通知バンド。precisionWarningと違い常時表示ではなく、
// 一定時間後に自動で消える(setStatusのトースト表示と同様のタイマー方式)。
let discoveryBannerHideTimer: ReturnType<typeof setTimeout> | undefined;

function showDiscoveryBanner(count: number): void {
  clearTimeout(discoveryBannerHideTimer);
  discoveryBanner.textContent = `あしあとが${count}個見つかりました！`;
  discoveryBanner.hidden = false;

  // 連続して発見した場合でもアニメーションが最初からやり直されるよう、
  // 一旦クラスを外して強制的にレイアウトさせてから付け直す。
  discoveryBanner.classList.remove("show");
  void discoveryBanner.offsetWidth;
  discoveryBanner.classList.add("show");

  discoveryBannerHideTimer = setTimeout(() => {
    discoveryBanner.hidden = true;
    discoveryBanner.classList.remove("show");
  }, 3500);
}

// GPSトグルON/OFF・位置精度いずれの変化でも、投稿メニュー項目(新規投稿・新規下書きの入口)の
// 有効/無効を再計算する。
function updateComposeAvailability(): void {
  composeAshiatoMenuItem.disabled = !gpsEnabled || isPrecisionBad();
}

// 起動時、そもそもGeolocation APIが無い端末なら見た目で分かるようにしておく
if (!("geolocation" in navigator)) {
  gpsToggleBtn.classList.add("unavailable");
  gpsToggleBtn.title = "この端末では位置情報が使えません";
}
// GPSトグルは初期状態でOFFなので、投稿メニュー項目も初期状態は無効。
composeAshiatoMenuItem.disabled = true;

function setGpsEnabled(enabled: boolean): void {
  if (enabled && !("geolocation" in navigator)) {
    setStatus("この端末では位置情報が使えません。", true);
    return;
  }

  if (!enabled) {
    gpsEnabled = false;
    gpsToggleBtn.setAttribute("aria-pressed", "false");
    // 投稿UIは現在地が前提の機能のため、GPSトグルOFF中は投稿メニュー項目も無効化する。
    updateComposeAvailability();
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    currentLocationLayer.hide();
    lastKnownPosition = null; // OFFにしたら古い位置情報は使い回さない
    lastKnownAccuracy = null;
    updatePrecisionWarning();
    // 投稿UIを開いたままGPSをOFFにした場合、古い位置情報のまま投稿できて
    // しまわないよう、開いていれば閉じて下書き用の位置情報も破棄する。
    if (composeDialog.open) composeDialog.close();
    composePosition = null;
    return;
  }

  if (watchId !== null) return; // 既に取得試行中(確定前含む)なら二重に開始しない

  // ここではまだgpsEnabled/aria-pressedをONにしない。スマホ側の位置情報
  // サービスがOFFになっている等でこの後のwatchPositionが失敗する可能性が
  // あり、要求した時点で即座にONの見た目にしてしまうと、実際には取得できて
  // いないのに一瞬(あるいはエラーが返るまでの間)「ONにできてしまった」ように
  // 見えてしまうため。ON状態の確定はhandlePositionUpdateで初回取得に
  // 成功した時点で行う。
  setStatus("現在地を取得中…");
  watchId = navigator.geolocation.watchPosition(
    handlePositionUpdate,
    handlePositionError,
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  );
}

function handlePositionError(error: GeolocationPositionError): void {
  console.error(error);
  const messages: Record<number, string> = {
    1: "位置情報の利用が許可されていません。",
    2: "現在地を取得できませんでした。",
    3: "現在地の取得がタイムアウトしました。",
  };
  setStatus(messages[error.code] ?? "位置情報の取得に失敗しました。", true);
  // 権限拒否(1)、または取得不能(2: 端末側の位置情報サービスがOFFの場合もこのコードで
  // 返ってくることが多い)なら、トグルもOFFに戻す。Web Geolocation APIには
  // OS側の位置情報サービスON/OFFを直接判定する手段が無いため、これを代理シグナルとして使う。
  if (error.code === 1 || error.code === 2) setGpsEnabled(false);
}

// 現在地(lastKnownPosition)と全セルを突き合わせて、未発見のものを判定する。
// 位置が一致しているだけでなく、Ashiato Syntaxの時間条件(isAshiatoActiveNow)も
// 満たしていて初めて発見扱いにする。watchPositionのコールバック(位置そのものが
// 変わった時)だけでなく、GPS ON中に新しいAshiatoを読み込んだ(=セル自体が
// 増減した)時、および時間条件が変化しうる定期タイマー(promoteAgedRecords)からも
// 呼ばれる。位置精度が悪いとき(isPrecisionBad)は、誤発見を避けるため判定自体を行わない。
async function checkCurrentPositionAgainstCells(): Promise<void> {
  if (!lastKnownPosition || isPrecisionBad()) return;
  const { lat, lon } = lastKnownPosition;
  let discoveredCount = 0;

  for (const cell of ashiatoCells.values()) {
    const locked = [...cell.records.values()].filter((r) => !r.unlockedAt);
    if (locked.length === 0) continue;
    if (!isInsideGeohashCell(lat, lon, cell.geohash)) continue;

    // 位置が一致していても、Ashiato Syntaxの時間条件(s/e/d/w/t/o/z/tz)を
    // 満たしていなければ発見扱いにしない(ashiatoEval.ts参照)。
    const activeNow = locked.filter((r) => isAshiatoActiveNow(r));
    if (activeNow.length === 0) continue;

    const unlockedAt = Date.now();
    for (const record of activeNow) {
      // DBへの書き込み(await)を待つ前に確定させる。GPSの更新が連続して
      // 届いた場合、この関数の呼び出しが重なることがあり、awaitの間に
      // 別の呼び出しが同じレコードを「まだロック中」として二重に処理して
      // しまわないようにするため。
      record.unlockedAt = unlockedAt;
      discoveredCount++;
      await markAshiatoUnlocked(record.id, unlockedAt);
    }
    rebuildCellVisual(cell); // 初めて発見された/丸の数が増えたケースに対応
    refreshUnlockedList();
  }

  if (discoveredCount > 0) showDiscoveryBanner(discoveredCount);
}

// 現在地が更新されるたびに呼ばれる。実際の判定はcheckCurrentPositionAgainstCellsに委譲する
// (「過去を探す」等でセル自体が増減したタイミングでも同じ判定を再利用できるようにするため)。
async function handlePositionUpdate(position: GeolocationPosition): Promise<void> {
  if (!gpsEnabled) {
    // 初回の取得成功。ここで初めてトグルのON状態を確定させる(setGpsEnabled参照)。
    gpsEnabled = true;
    gpsToggleBtn.setAttribute("aria-pressed", "true");
  }

  const { latitude, longitude, accuracy } = position.coords;
  lastKnownPosition = { lat: latitude, lon: longitude };
  lastKnownAccuracy = accuracy;
  currentLocationLayer.show(latitude, longitude, accuracy);
  updatePrecisionWarning();
  updateComposeAvailability();
  if (composeDialog.open) updateComposeButtons(); // 開いたまま精度が変化した場合に備える
  await checkCurrentPositionAgainstCells();
}

// --- 開封可能なAshiatoリスト(ダイアログ) ----------------------------------

const unlockedListDialog = $<HTMLDialogElement>("#unlockedListDialog");
enableSheetDragResize(unlockedListDialog);

$<HTMLButtonElement>("#unlockedListToggle").onclick = () => {
  closeMenu();
  unlockedListDialog.showModal();
  // 開いている間にデータが変化している可能性があるため念のため再構築する。
  // 既読化自体はobserveRowsForReadによる可視性ベースの判定に任せるため、
  // ここで明示的に既読化する処理は不要(実際に表示された行だけが既読になる)。
  refreshUnlockedList();
  // refreshUnlockedList()が閉じた状態で呼ばれていた場合、高さが正しく
  // 測れず「続きを表示」ヒントの表示要否判定が不正確なことがあるため、
  // 実際に表示された直後に測り直す。
  applyPreviewOverflowChecks(unlockedListDialog);
};
$<HTMLButtonElement>("#unlockedListCloseX").onclick = () => unlockedListDialog.close();

unlockedSortModeSelect.onchange = () => {
  unlockedSortMode = unlockedSortModeSelect.value as UnlockedSortMode;
  putSetting("unlockedSortMode", unlockedSortMode);
  refreshUnlockedList();
};

unreadOnlyFilterCheckbox.onchange = () => {
  showOnlyUnread = unreadOnlyFilterCheckbox.checked;
  refreshUnlockedList();
};

closeOnBackdropClick(unlockedListDialog);

// --- あしあと1件のアクションシート(「…」ボタン) ----------------------------

const ashiatoActionDialog = $<HTMLDialogElement>("#ashiatoActionDialog");
const ashiatoActionInfo = $("#ashiatoActionInfo");
const ashiatoActionShowOnMapBtn = $<HTMLButtonElement>("#ashiatoActionShowOnMap");
const ashiatoActionOpenPostBtn = $<HTMLButtonElement>("#ashiatoActionOpenPost");
const ashiatoActionDeleteBtn = $<HTMLButtonElement>("#ashiatoActionDelete");

$<HTMLButtonElement>("#ashiatoActionCloseX").onclick = () => ashiatoActionDialog.close();

closeOnBackdropClick(ashiatoActionDialog);

// --- 画像ライトボックス(添付画像のタップで拡大表示) --------------------------

const mediaLightbox = $<HTMLDialogElement>("#mediaLightbox");
const mediaLightboxImg = $<HTMLImageElement>("#mediaLightboxImg");
const mediaLightboxPrevBtn = $<HTMLButtonElement>("#mediaLightboxPrev");
const mediaLightboxNextBtn = $<HTMLButtonElement>("#mediaLightboxNext");
const mediaLightboxCounter = $("#mediaLightboxCounter");

$("#mediaLightboxCloseX").append(createIcon("x"));
mediaLightboxPrevBtn.append(createIcon("chevron-left"));
mediaLightboxNextBtn.append(createIcon("chevron-right"));

let lightboxImages: AshiatoFile[] = [];
let lightboxIndex = 0;

function updateLightboxImage(): void {
  const file = lightboxImages[lightboxIndex];
  if (!file) return;
  mediaLightboxImg.src = file.url;

  const multi = lightboxImages.length > 1;
  mediaLightboxPrevBtn.hidden = !multi;
  mediaLightboxNextBtn.hidden = !multi;
  mediaLightboxCounter.hidden = !multi;
  mediaLightboxCounter.textContent = `${lightboxIndex + 1} / ${lightboxImages.length}`;
}

// images: 同じ投稿内の画像だけの配列(動画は含まない)、startIndex: その中での初期表示位置。
function openMediaLightbox(images: AshiatoFile[], startIndex: number): void {
  if (images.length === 0) return;
  lightboxImages = images;
  lightboxIndex = startIndex;
  updateLightboxImage();
  mediaLightbox.showModal();
}

mediaLightboxPrevBtn.onclick = () => {
  lightboxIndex = (lightboxIndex - 1 + lightboxImages.length) % lightboxImages.length;
  updateLightboxImage();
};
mediaLightboxNextBtn.onclick = () => {
  lightboxIndex = (lightboxIndex + 1) % lightboxImages.length;
  updateLightboxImage();
};
$<HTMLButtonElement>("#mediaLightboxCloseX").onclick = () => mediaLightbox.close();
// 表示中の画像を消しておく(閉じてもすぐ次を開く場合はupdateLightboxImageで
// 上書きされるが、読み込み中の古い画像が一瞬見えるのを避けるため)。
mediaLightbox.addEventListener("close", () => {
  mediaLightboxImg.src = "";
});
// mediaLightboxはビューポート全体を覆う(closeOnBackdropClickの「矩形の外側か」判定が
// 使えない)ため、代わりにクリックされた要素がdialog自身(=画像や各ボタン以外の
// 背景部分)かどうかで判定する。
mediaLightbox.addEventListener("click", (e) => {
  if (e.target === mediaLightbox) mediaLightbox.close();
});

// --- 「現在地」「エリア」「既読を隠す」のフライアウトの開閉 ---------------------
// デフォルトは展開状態(index.html側のaria-expanded="true"、togglePanelRowsも
// hidden無しが初期値)。状態は永続化しない(セッションごとに展開状態から始まる)。
// ハンバーガーメニュー(menuDropdown)と同じくhidden属性の付け外しで開閉する
// (style.css側のopacity/transform + allow-discreteでフェード+スケールする)。

const togglePanelCollapseBtn = $<HTMLButtonElement>("#togglePanelCollapse");
const togglePanelRows = $<HTMLElement>("#togglePanelRows");

togglePanelCollapseBtn.onclick = () => {
  const willOpen = togglePanelRows.hidden;
  togglePanelRows.hidden = !willOpen;
  togglePanelCollapseBtn.setAttribute("aria-expanded", String(willOpen));
};

// ボタンの高さをフライアウトの実測高さに揃え、1枚のカードのように見えるように
// する(フライアウトはposition:absoluteのため、CSSだけでは高さを自動的に
// 揃えられない)。ページ読み込み直後の1回だけの測定だと、フォントの読み込み
// タイミングや画面幅によって実際の行の高さが後から変わるケースに追従できない
// (PC表示でボタンだけ少し短くなる不具合の原因)ため、ResizeObserverで
// フライアウトの実際の高さを継続的に監視し、変化するたびボタン側に反映する。
new ResizeObserver(([entry]) => {
  const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height;
  if (height > 0) togglePanelCollapseBtn.style.height = `${height}px`;
}).observe(togglePanelRows);

// --- 「エリア」トグル(Geohashセルの範囲描画) ------------------------------

const toggleAreaBtn = $<HTMLButtonElement>("#toggleArea");
let areaEnabled = false;

toggleAreaBtn.onclick = () => {
  areaEnabled = !areaEnabled;
  toggleAreaBtn.setAttribute("aria-pressed", String(areaEnabled));
  areaOverlay.setEnabled(areaEnabled);
};

// --- 「既読を隠す」トグル(既読のAshiatoを地図に表示しない) -------------------

const toggleHideReadBtn = $<HTMLButtonElement>("#toggleHideRead");
let hideReadEnabled = false;

toggleHideReadBtn.onclick = () => {
  hideReadEnabled = !hideReadEnabled;
  toggleHideReadBtn.setAttribute("aria-pressed", String(hideReadEnabled));
  for (const cell of ashiatoCells.values()) rebuildCellVisual(cell);
};

// --- ハンバーガーメニュー(投稿ボタンを統合、画面下部・footprint型) -------

const menuToggle = $<HTMLButtonElement>("#menuToggle");
const menuDropdown = $("#menuDropdown");
const aboutDialog = $<HTMLDialogElement>("#aboutDialog");

function closeMenu(): void {
  menuDropdown.hidden = true;
  menuToggle.setAttribute("aria-expanded", "false");
}

menuToggle.onclick = (e) => {
  e.stopPropagation();
  const willOpen = menuDropdown.hidden;
  menuDropdown.hidden = !willOpen;
  menuToggle.setAttribute("aria-expanded", String(willOpen));
};

document.addEventListener("click", (e) => {
  if (!menuDropdown.hidden && !(e.target as Element).closest(".menu")) closeMenu();
});

$<HTMLButtonElement>("#aboutButton").onclick = () => {
  closeMenu();
  aboutDialog.showModal();
};
$<HTMLButtonElement>("#aboutCloseX").onclick = () => aboutDialog.close();

// ダイアログ外側(::backdrop)クリックでも閉じられるようにする
closeOnBackdropClick(aboutDialog);

// --- 設定ダイアログ(メディアの表示モード) -----------------------------------
// 「リセット」(resetAllCache、IndexedDBごと削除)を実行しない限り、
// settingsストア経由で永続する(他の設定値と同じ扱い)。

const settingsDialog = $<HTMLDialogElement>("#settingsDialog");

$<HTMLButtonElement>("#settingsToggle").onclick = () => {
  closeMenu();
  settingsDialog.showModal();
};
$<HTMLButtonElement>("#settingsCloseX").onclick = () => settingsDialog.close();
closeOnBackdropClick(settingsDialog);

// 「メディアの表示」は選択肢が3つあって縦に長いため、既定では折りたたんでおき、
// 必要なときだけ開く(style.css側のgrid-template-rowsの0fr/1frアニメーション。
// 既定は折りたたみ)。
const mediaVisibilityToggle = $<HTMLButtonElement>("#mediaVisibilityToggle");
const mediaVisibilityRows = $("#mediaVisibilityRows");

mediaVisibilityToggle.onclick = () => {
  const willExpand = !mediaVisibilityRows.classList.contains("expanded");
  mediaVisibilityRows.classList.toggle("expanded", willExpand);
  mediaVisibilityToggle.setAttribute("aria-expanded", String(willExpand));
};

document.querySelectorAll<HTMLInputElement>('input[name="mediaVisibility"]').forEach((el) => {
  el.onchange = () => {
    mediaVisibilityMode = el.value as MediaVisibilityMode;
    putSetting("mediaVisibilityMode", mediaVisibilityMode);
    // 開いたままの一覧があれば、変更を即座に反映する。
    if (unlockedListDialog.open) refreshUnlockedList();
  };
});

// --- インスタンス変更ダイアログ --------------------------------------------

const instanceDialog = $<HTMLDialogElement>("#instanceDialog");
const currentHostLabel = $("#currentHostLabel");

$<HTMLButtonElement>("#changeInstance").onclick = () => {
  instanceDialog.showModal();
};
$<HTMLButtonElement>("#instanceCancel").onclick = () => instanceDialog.close();

closeOnBackdropClick(instanceDialog);

$<HTMLButtonElement>("#instanceApply").onclick = () => {
  instanceDialog.close();
  fetchOlder();
};

// インスタンス欄が変わったら、表示中のAshiatoを一旦クリアして、
// そのhost用のキャッシュ(あれば)を読み込み直す。
async function switchHost(host: string): Promise<number> {
  currentHost = host;
  currentHostLabel.textContent = `現在: ${stripProtocol(host)}`;
  putSetting("instanceUrl", host); // TTL無し。次回起動時のデフォルト接続先にする

  for (const cell of ashiatoCells.values()) clearCellVisual(cell);
  ashiatoCells.clear();
  pendingRecords.clear();
  areaOverlay.refresh([]);

  await pruneCache(host, TAG); // 読み込み前に期限切れ・上限超過分を掃除
  const cached = await getAshiatoRecords(host, TAG);
  // 古い順に並べておくと、ページングで足された分と混ざっても違和感がない
  cached.sort((a, b) => a.cachedAt - b.cachedAt);
  for (const record of cached) {
    if (!isSupportedGeohashLength(record.geohash)) continue; // 対象外の桁数は無視
    registerRecord(record);
  }
  refreshUnlockedList();

  cursor = await getCursor(host, TAG);

  setStatus(
    cached.length > 0
      ? `キャッシュから${cached.length}件のAshiatoを復元しました。`
      : "準備完了。",
  );

  return cached.length;
}

async function ensureHost(): Promise<string> {
  const host = normalizeInstanceUrl($<HTMLInputElement>("#instance").value);
  if (host !== currentHost) await switchHost(host);
  return host;
}

// --- 本文プレビュー(MFM) ------------------------------------------------
// 「見つけたあしあと」を開封する前でも、内容を少しだけ確認できるように、
// ノート本文の冒頭をプレビュー表示する。ノート本文そのもの(全文)は
// これまで通りキャッシュに保存しない方針を維持し、ここで作った短い
// プレビュー文字列だけを例外的にレコードへ持たせる。
// MFM(Misskey Flavored Markdown)の構文記号がそのまま見えると読みにくいため、
// misskey-dev/mfm.js でパースした上でプレーンテキスト化する
// (https://github.com/misskey-dev/mfm.js)。
// 表示上の省略(3行程度でクリップし「続きを表示」を出す)はCSS側(.mfm-preview)で
// 行うため、ここでは文字数による切り詰めはしない(TEXT_PREVIEW_SAFETY_CAP_LENGTH参照)。

// mfm.jsのASTノードを再帰的にたどり、装飾を取り除いた素のテキストへ変換する。
// 未知のノード種別は子ノードだけを連結するフォールバックにしておく
// (mfm.jsのバージョン差異で多少ノード種別が増減しても壊れにくいように)。
function mfmNodeToPlainText(node: MfmNode): string {
  switch (node.type) {
    case "text":
      return node.props.text;
    case "unicodeEmoji":
      return node.props.emoji;
    case "emojiCode":
      return `:${node.props.name}:`;
    case "mention":
      return node.props.acct ? `@${node.props.acct}` : "";
    case "hashtag":
      return `#${node.props.hashtag}`;
    case "url":
      return node.props.url;
    case "inlineCode":
      return node.props.code;
    case "mathInline":
      return node.props.formula;
    case "search":
      return node.props.query ?? "";
    default:
      // bold/italic/strike/small/center/quote/link/fn等、子ノードを持つものは
      // 子ノードのテキストだけを連結する(装飾記号自体は落とす)。
      return Array.isArray(node.children)
        ? mfmNodesToPlainText(node.children)
        : "";
  }
}

function mfmNodesToPlainText(nodes: MfmNode[]): string {
  return nodes.map(mfmNodeToPlainText).join("");
}

// ノート本文からAshiato Syntax候補(⟦...⟧)を取り除いた上でMFMをプレーン
// テキスト化する。表示上の省略はCSSでの高さクリップで行うため、ここでは
// TEXT_PREVIEW_SAFETY_CAP_LENGTHを超える極端なケースの安全弁としてのみ切り詰める
// (文字数で機械的に切ると:name:のようなMFM記法の途中で千切れる恐れがあるため)。
// 残りが空文字列になった場合はnull(プレビュー無し)を返す。
function extractPreviewText(noteText: string): string | null {
  let stripped = noteText;
  for (const candidate of extractCandidates(noteText)) {
    stripped = stripped.split(candidate).join("");
  }
  stripped = stripped.trim();
  if (!stripped) return null;

  let plain: string;
  try {
    plain = mfmNodesToPlainText(parseMfm(stripped));
  } catch (error) {
    console.warn("main: MFM解析に失敗。プレーンテキストのまま使用します:", error);
    plain = stripped;
  }

  // 改行以外の空白(スペース・タブ等)は1つに正規化しつつ、改行そのものは残す
  // (表示側の.mfm-previewはwhite-space:pre-lineで改行を再現する想定)。
  // 3行以上連続する空行はさすがに詰める。
  plain = plain
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!plain) return null;

  const chars = [...plain];
  return chars.length > TEXT_PREVIEW_SAFETY_CAP_LENGTH
    ? chars.slice(0, TEXT_PREVIEW_SAFETY_CAP_LENGTH).join("") + "…"
    : plain;
}

async function ingestNotes(host: string, notes: MisskeyNote[]): Promise<AshiatoRecord[]> {
  const records: AshiatoRecord[] = [];

  for (const note of notes) {
    // 削除済みノート、本文が無いノートは対象外
    if (!note?.text || note.deletedAt) continue;

    const preview = extractPreviewText(note.text);
    // カスタム絵文字・acct表示のホストはノートの投稿元インスタンスに属する
    // (フェデレーション対応)。note.user.hostがあればリモートユーザー
    // (=そのホストが投稿元インスタンス)、無ければローカルユーザー
    // (=host、つまり今検索しているインスタンス自身が投稿元)。
    const emojiHost = note.user?.host ? `https://${note.user.host}` : host;
    const files: AshiatoFile[] = (note.files ?? []).map((f) => ({
      url: f.url,
      thumbnailUrl: f.thumbnailUrl,
      type: f.type,
      isSensitive: f.isSensitive,
    }));

    let idx = 0;
    for (const r of parseText(note.text)) {
      if (isSupportedGeohashLength(r.model.geohash)) {
        records.push(
          makeRecord(
            host,
            TAG,
            note.id,
            idx,
            r,
            note.createdAt ?? null,
            note.user?.username ?? null,
            preview,
            emojiHost,
            note.user?.name ?? null,
            note.user?.avatarUrl ?? null,
            files,
          ),
        );
      }
      idx++; // 対象外の桁数で弾いた分もidxは進める(ノート内位置とidの対応を崩さないため)
    }
  }

  await putAshiatoRecords(records);
  for (const record of records) registerRecord(record);

  // 「過去を探す」「最新を確認」でセルが新しく増えた場合、GPSが既にONで
  // その場から動いていない(=watchPositionが発火しない)状況でも、現在地がその
  // 新セル内に入っていれば即座に発見扱いにする。
  if (gpsEnabled) await checkCurrentPositionAgainstCells();

  return records;
}

// 「あなたが未発見のあしあとがn件あります」形式の検索結果メッセージを組み立てる。
// 現在地(lastKnownPosition)が取得できていれば、その都道府県内の件数も添える。
// suffixには「○○まで探しました。」等、呼び出し側で末尾に続けたい文をそのまま渡す
// (fetchOlderのみ使用。fetchNewerは空文字列)。
//
// 件数はashiatoCells(表示用の画面内メモリ状態)からではなく、必ずgetAshiatoRecords()で
// DBから直接数える。ashiatoCellsはaddRecordToCellの「同じidが既にあれば何もしない」
// ガードに依存しており、検索キャッシュを消した直後に再検索すると、既に発見済み
// (unlockedAtがDBには残っている)のレコードについて、再取得時に作られる
// unlockedAt無しの新しいレコードオブジェクトがそのガードで弾かれるかどうかに
// 挙動が左右されてしまう。DBを直接数えれば、putAshiatoRecords側の
// 「既存のunlockedAt/readAtを引き継ぐ」マージ処理(cache.ts参照)の結果をそのまま
// 信頼できるため、画面内メモリの状態とズレようがない。
// なお「未読」(readAt無し)は発見済み(unlockedAtあり)に含まれるため、ここでは
// unlockedAtの有無だけを見る(readAtは一切参照しない)。
async function buildDiscoveryStatusMessage(suffix: string): Promise<string> {
  const records = currentHost ? await getAshiatoRecords(currentHost, TAG) : [];
  const undiscovered = records.filter((r) => !r.unlockedAt);

  // 都道府県の逆引き(ネットワーク取得を伴いうる)は、同じgeohashについて
  // 1回で済ませる。
  const countByGeohash = new Map<string, number>();
  for (const r of undiscovered) {
    countByGeohash.set(r.geohash, (countByGeohash.get(r.geohash) ?? 0) + 1);
  }

  let prefectureClause = "";
  if (lastKnownPosition) {
    const prefName = await lookupPrefectureName(
      prefectureIndex,
      lastKnownPosition.lat,
      lastKnownPosition.lon,
    ).catch(() => null);

    if (prefName) {
      let inPrefecture = 0;
      for (const [geohash, count] of countByGeohash) {
        const { centerLat, centerLon } = decodeGeohash(geohash);
        const cellPref = await lookupPrefectureName(prefectureIndex, centerLat, centerLon).catch(
          () => null,
        );
        if (cellPref === prefName) inPrefecture += count;
      }
      prefectureClause = `${prefName}内に${inPrefecture}個。`;
    }
  }

  return `あなたが未発見のあしあとが${undiscovered.length}件あります。${prefectureClause}${suffix}`;
}

// 過去方向(untilId): 「過去を探す」(初回・2回目以降とも同じボタン)
async function fetchOlder(): Promise<void> {
  const btn = $<HTMLButtonElement>("#search");
  btn.disabled = true;
  setStatus("Misskeyから検索中…");

  try {
    const host = await ensureHost();

    const notes = await searchNotesByTag(host, TAG, {
      limit: PAGE_SIZE,
      untilId: cursor?.oldestSeenNoteId,
    });

    // 検索中にインスタンスが切り替えられていたら、この結果は今のcurrentHostの
    // ものではないので破棄する(取り込むとホストをまたいでセル/cursorが混線する)。
    if (host !== currentHost) return;

    await ingestNotes(host, notes);

    if (notes.length > 0) {
      const oldestId = notes[notes.length - 1].id;
      const newestId = cursor?.newestSeenNoteId ?? notes[0].id;
      cursor = { hostTag: `${host}::${TAG}`, host, tag: TAG, oldestSeenNoteId: oldestId, newestSeenNoteId: newestId };
      await putCursor(host, TAG, cursor);
    }

    if (notes.length > 0) {
      // 今回のレスポンスの中で一番古い投稿日時を、「どこまで過去を探索したか」の
      // 目安として表示する(ボタンの挙動を利用者に理解してもらうため)。
      const oldestCreatedAt = notes.reduce<string | null>((oldest, n) => {
        if (!n.createdAt) return oldest;
        return !oldest || new Date(n.createdAt) < new Date(oldest)
          ? n.createdAt
          : oldest;
      }, null);
      const oldestLabel = formatDateTime(oldestCreatedAt);

      setStatus(
        await buildDiscoveryStatusMessage(oldestLabel ? `${oldestLabel}まで探しました。` : ""),
      );
    } else {
      setStatus("これより古いAshiatoは見つかりませんでした。");
    }
  } catch (e) {
    console.error(e);
    setStatus((e as Error).message || "検索に失敗しました。", true);
  } finally {
    btn.disabled = false;
  }
}

// 最新方向(sinceId): 前回訪問後に増えた新着だけを取得。
// カーソルが無い(＝まだ一度も検索していない)状態でも呼べるようにし、
// その場合はfetchOlderにフォールバックする(「探す」ボタン廃止に伴う対応)。
async function fetchNewer(): Promise<void> {
  const btn = $<HTMLButtonElement>("#loadNewer");
  btn.disabled = true;
  setStatus("Misskeyから検索中…(最新)");

  try {
    const host = await ensureHost();
    if (!cursor) {
      await fetchOlder();
      return;
    }

    const notes = await searchNotesByTag(host, TAG, {
      limit: PAGE_SIZE,
      sinceId: cursor.newestSeenNoteId,
    });

    // 検索中にインスタンスが切り替えられていたら、この結果は今のcurrentHostの
    // ものではないので破棄する(取り込むとホストをまたいでセル/cursorが混線する)。
    if (host !== currentHost) return;

    await ingestNotes(host, notes);

    if (notes.length > 0) {
      const newestId = notes[0].id;
      const oldestId = notes[notes.length - 1].id;
      // 中抜け対策: 今回取得したバッチの最古ノートで oldestSeenNoteId も進めておく。
      // これにより「過去を探す」の起点が必ずこのバッチの範囲を通過するようになり、
      // fetchNewer の limit 上限で取りこぼした区間が永久に未取得のまま残ることを防ぐ。
      // (直前に fetchOlder で取得済みの範囲を再要求することになる場合があるが、
      //  host::noteId::index で重複排除されるので実害はない)
      cursor = { hostTag: `${host}::${TAG}`, host, tag: TAG, newestSeenNoteId: newestId, oldestSeenNoteId: oldestId };
      await putCursor(host, TAG, cursor);
    }

    setStatus(
      notes.length > 0
        ? await buildDiscoveryStatusMessage("")
        : "新しいAshiatoはありませんでした。",
    );
  } catch (e) {
    console.error(e);
    setStatus((e as Error).message || "検索に失敗しました。", true);
  } finally {
    btn.disabled = false;
  }
}

// 「検索キャッシュを消す」。まだ発見していない(unlockedAtが無い)レコードと
// 保留中(pendingRecords)のレコード、カーソルだけを消す。
// 「見つけたあしあと」(発見済み)は地図上にもそのまま残す。
async function handleClearSearchCache(): Promise<void> {
  await clearSearchCache();
  pendingRecords.clear();

  for (const [geohash, cell] of [...ashiatoCells]) {
    for (const [id, record] of [...cell.records]) {
      if (!record.unlockedAt) cell.records.delete(id);
    }
    if (cell.records.size === 0) {
      clearCellVisual(cell);
      ashiatoCells.delete(geohash);
    } else {
      rebuildCellVisual(cell); // 残るのは発見済みだけなので、見た目は基本変わらない
    }
  }
  areaOverlay.refresh([...ashiatoCells.values()]);

  cursor = null;
  setStatus("検索キャッシュを消去しました。");
}

$<HTMLButtonElement>("#search").onclick = fetchOlder;
$<HTMLButtonElement>("#loadNewer").onclick = fetchNewer;
// 確定ON(gpsEnabled)・取得試行中で未確定(watchId!==nullだがgpsEnabledはまだfalse)の
// いずれの状態でもOFFに戻す。完全にOFFの状態からのみONにする試行を開始する。
$<HTMLButtonElement>("#toggleGps").onclick = () =>
  setGpsEnabled(!(gpsEnabled || watchId !== null));
$<HTMLButtonElement>("#clearSearchCache").onclick = async () => {
  const wantsToClear = await showConfirm(
    "検索キャッシュを削除しますか？(見つけたあしあとは残ります)",
    { okLabel: "削除する", danger: true },
  );
  if (!wantsToClear) return;
  await handleClearSearchCache();
};

// 「リセット」: 見つけたあしあと・検索キャッシュ・下書き・設定(インスタンスURL等)を
// 含む全キャッシュを削除する(cache.jsのresetAllCacheがIndexedDBごと削除する)。
// 削除後はアプリの状態(ashiatoCells等の変数)も含めて丸ごと作り直すのが確実なため、
// 個別に状態をクリアするのではなくページをリロードする。
$<HTMLButtonElement>("#resetAll").onclick = async () => {
  const wantsToReset = await showConfirm(
    "すべてのキャッシュを削除しますか？\n\n見つけたあしあと・下書き・インスタンス設定など、保存されているデータがすべて消えます。この操作は取り消せません。",
    { okLabel: "削除する", danger: true },
  );
  if (!wantsToReset) return;

  await resetAllCache();
  location.reload();
};
$<HTMLInputElement>("#instance").onkeydown = (e) => {
  if (e.key === "Enter") {
    instanceDialog.close();
    fetchOlder();
  }
};

// --- 投稿機能(共有フォーム経由) ---------------------------------------
// Ashi@自身は投稿APIを一切呼ばない(認証不要・静的Webページというコンセプト
// のため)。Misskey Hubの共有フォーム中継(/share)を新規タブで開き、実際の
// 投稿操作はユーザーが普段使っているMisskeyインスタンス側で行ってもらう。
// そのためAshi@側では「投稿が実際に成功したか」を厳密には検知できないが、
// 下書きについては「投稿する」ボタン押下(=確認ダイアログでOKして共有
// フォームまで開いた)時点でその下書きを削除する(役目を終えたとみなす)。

const composeDialog = $<HTMLDialogElement>("#composeDialog");
enableSheetDragResize(composeDialog);
const composePrecisionNote = $("#composePrecisionNote");
const draftListDialog = $<HTMLDialogElement>("#draftListDialog");
enableSheetDragResize(draftListDialog);
const draftList = $("#draftList");

let composePosition: { lat: number; lon: number } | null = null; // 投稿UI表示中のみ有効

function selectedPrecision(): GeohashLength {
  return Number(
    document.querySelector<HTMLInputElement>('input[name="precision"]:checked')!.value,
  ) as GeohashLength;
}

// 精度「約150m」(7桁)は、作成から30分経つまで投稿不可
// (下書きの精度をあとから変更しても、常にこの条件で都度再評価する)。
function isDraftPostable(draft: Draft): boolean {
  if (draft.geohashLength !== HIGH_PRECISION_GEOHASH_LENGTH) return true;
  return Date.now() - draft.createdAt >= DRAFT_HIGH_PRECISION_DELAY_MS;
}

function updateComposeButtons(): void {
  const isHighPrecision = selectedPrecision() === HIGH_PRECISION_GEOHASH_LENGTH;
  const precisionBad = isPrecisionBad();

  $<HTMLButtonElement>("#composePost").disabled = isHighPrecision || precisionBad;
  $<HTMLButtonElement>("#composeSaveDraft").disabled = precisionBad;

  composePrecisionNote.hidden = !isHighPrecision && !precisionBad;
  if (precisionBad) {
    composePrecisionNote.textContent =
      "現在地の精度が低いため、新規投稿・下書きの保存はできません。精度が改善してからお試しください。";
  } else if (isHighPrecision) {
    composePrecisionNote.textContent =
      "この精度はプライバシー保護のため直接投稿できません。いったん下書きに保存し、30分経過後に投稿してください。";
  }
}

function updateComposePreview(): void {
  if (!composePosition) return;
  const hash = precisionPreview.show(
    composePosition.lat,
    composePosition.lon,
    selectedPrecision(),
  );
  fitMapToComposeCell(hash);
}

// 投稿UI(下部シート)に隠れないよう、シートの高さぶんを下側の余白として
// 確保した上で、選択中の精度のセル全体が見えるように地図をフィットさせる。
// composeDialogがまだ開いていない(高さが取れない)場合は何もしない。
function fitMapToComposeCell(hash: string): void {
  const sheetHeight = composeDialog.getBoundingClientRect().height;
  if (sheetHeight === 0) return; // dialogがまだ表示されていない

  const b = decodeGeohash(hash);
  map.fitBounds(
    [
      [b.minLat, b.minLon],
      [b.maxLat, b.maxLon],
    ],
    {
      paddingTopLeft: [20, 20],
      paddingBottomRight: [20, sheetHeight + 20],
      maxZoom: 18,
    },
  );
}

document.querySelectorAll<HTMLInputElement>('input[name="precision"]').forEach((el) => {
  el.onchange = () => {
    updateComposePreview();
    updateComposeButtons();
  };
});

$<HTMLButtonElement>("#composeAshiatoMenuItem").onclick = () => {
  closeMenu();
  if (!gpsEnabled || isPrecisionBad()) return; // ボタン自体を無効化済みだが念のため

  // GPSトグルが既にONで現在地が分かっていれば、新たに取得し直さず即座に開く。
  if (lastKnownPosition) {
    composePosition = { ...lastKnownPosition };
    updateComposeButtons();
    composeDialog.show(); // 非モーダル: マップ操作(ドラッグ/ズーム/エリアトグル等)を妨げない
    updateComposePreview();
    return;
  }

  // ONにした直後などでまだ現在地が届いていない場合だけ、改めて取得する。
  setStatus("現在地を取得中…");
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      // 取得を待っている間にGPSがOFFにされていたら、古い位置情報で
      // 投稿UIを開き直さない。
      if (!gpsEnabled) return;
      composePosition = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      updateComposeButtons();
      // dialogを開いてから高さを測ってfitBoundsする必要があるため、
      // show()を先に呼ぶ(まだ非表示の時点でupdateComposePreviewを
      // 呼ぶとcomposeDialogの高さが0になりfitMapToComposeCellが動かない)。
      composeDialog.show(); // 非モーダル
      updateComposePreview();
    },
    handlePositionError,
    { enableHighAccuracy: true, timeout: 15000 },
  );
};

$<HTMLButtonElement>("#composeCloseX").onclick = () => composeDialog.close();

// 非モーダル(show())にしたことで、showModal()標準の「Escapeで閉じる」挙動が
// 自動では効かなくなるため、他のダイアログとの一貫性のために手動で対応する。
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && composeDialog.open) composeDialog.close();
});

// 閉じ方(ボタン/Escapeいずれでも)に関わらず、プレビュー矩形は消す。
composeDialog.addEventListener("close", () => precisionPreview.hide());

// 投稿本文(Ashiato Syntax + #Ashiatoタグ)を組み立てる。
// 自由記述コメントはAshi@側では持たない(共有フォーム側で書けるため)。
function shareTextFor(lat: number, lon: number, geohashLength: GeohashLength): string {
  const geohash = encodeGeohash(lat, lon, geohashLength);
  return `${buildMinimalCandidate(geohash)} #Ashiato`;
}

$<HTMLButtonElement>("#composePost").onclick = async () => {
  if (!composePosition) return;

  const wantsToPost = await showConfirm(
    "現在地の情報を含んだ投稿フォームを開きます。内容は共有フォーム上で確認・編集できます。",
    { okLabel: "共有フォームを開く" },
  );
  if (!wantsToPost) return;

  const text = shareTextFor(composePosition.lat, composePosition.lon, selectedPrecision());
  window.open(buildShareUrl(text), "_blank", "noopener");
  composeDialog.close();
};

$<HTMLButtonElement>("#composeSaveDraft").onclick = async () => {
  if (!composePosition) return;

  const { lat, lon } = composePosition;
  const geohashLength = selectedPrecision();
  // Nominatim等の外部APIは使わず、既存の市区町村境界GeoJsonから逆引きする。
  // 見つからなければnull(下書きリスト側で「@緯度, 経度」表示にフォールバック)。
  const municipalityLabel = await lookupMunicipality(prefectureIndex, lat, lon).catch(
    () => null,
  );

  await putDraft(makeDraft(lat, lon, geohashLength, municipalityLabel));
  composeDialog.close();
  setStatus("下書きに保存しました。");
};

// --- 下書きリスト(ダイアログ) ------------------------------------------

async function refreshDraftList(): Promise<void> {
  const drafts = await getDrafts();
  draftList.replaceChildren();

  if (drafts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "unlocked-list-empty";
    empty.textContent = "下書きはありません。";
    draftList.append(empty);
    return;
  }

  for (const draft of drafts) {
    const li = document.createElement("li");

    const header = document.createElement("div");
    header.className = "draft-card-header";
    const headerMain = document.createElement("div");
    headerMain.className = "draft-card-header-main";
    const placeIcon = document.createElement("span");
    placeIcon.className = "action-sheet-icon";
    placeIcon.append(createIcon("map-pin"));
    const place = document.createElement("span");
    place.className = "draft-place";
    place.textContent =
      draft.municipalityLabel ?? `@${draft.lat.toFixed(4)}, ${draft.lon.toFixed(4)}`;

    // 日時は地名の右隣に表示する。
    const meta = document.createElement("span");
    meta.className = "draft-meta";
    meta.append(createIcon("clock"), document.createTextNode(formatDateTime(draft.createdAt) ?? ""));

    headerMain.append(placeIcon, place, meta);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "draft-delete-btn";
    deleteBtn.setAttribute("aria-label", "削除");
    deleteBtn.append(createIcon("trash-2"));
    header.append(headerMain, deleteBtn);

    // 精度・「投稿する」は同じ行に並べる。
    const footer = document.createElement("div");
    footer.className = "draft-footer";

    // 精度はあとから変更できる(位置・作成時刻はそのまま)。ラベルテキストの
    // 代わりにアイコンだけを添えているため、スクリーンリーダー向けに明示する。
    const precisionSelect = document.createElement("select");
    precisionSelect.setAttribute("aria-label", "判定エリアの広さ");
    for (const [value, label] of Object.entries(PRECISION_LABELS)) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label;
      opt.selected = String(draft.geohashLength) === value;
      precisionSelect.append(opt);
    }
    const precision = document.createElement("label");
    precision.className = "draft-precision";
    precision.append(createIcon("ruler"), precisionSelect);

    const postBtn = document.createElement("button");
    postBtn.type = "button";
    postBtn.className = "btn-primary draft-post-btn";

    // 残り時間は「下書きリストを開いた(=このリストを描画した)タイミング」で
    // 計算する。ダイアログを開いたままの秒単位カウントダウンはしない
    // (open中は既存のsetIntervalで1分ごとに再描画されるので、その都度更新される)。
    function renderPostButton() {
      const postable = isDraftPostable(draft);
      postBtn.disabled = !postable;
      if (postable) {
        postBtn.textContent = "投稿する";
      } else {
        const remainingMs =
          DRAFT_HIGH_PRECISION_DELAY_MS - (Date.now() - draft.createdAt);
        const remainingMin = Math.max(1, Math.ceil(remainingMs / 60000));
        postBtn.textContent = `投稿できません(あと${remainingMin}分)`;
      }
    }
    renderPostButton();

    precisionSelect.onchange = async () => {
      draft.geohashLength = Number(precisionSelect.value) as GeohashLength;
      await updateDraftPrecision(draft.id, draft.geohashLength);
      renderPostButton();
    };

    // 投稿本体と同じ確認ダイアログを経由する。OKで共有フォームを開いたら、
    // この下書きは役目を終えたものとして削除する(投稿ボタンを押した=
    // 少なくとも共有フォームまでは進んだ、という前提。投稿が実際に成功
    // したかどうかまではAshi@側では検知できない)。
    postBtn.onclick = async () => {
      const wantsToPost = await showConfirm(
        "現在地の情報を含んだ投稿フォームを開きます。内容は共有フォーム上で確認・編集できます。",
        { okLabel: "共有フォームを開く" },
      );
      if (!wantsToPost) return;

      const text = shareTextFor(draft.lat, draft.lon, draft.geohashLength);
      window.open(buildShareUrl(text), "_blank", "noopener");

      await deleteDraft(draft.id);
      refreshDraftList();
    };

    deleteBtn.onclick = async () => {
      const wantsToDelete = await showConfirm("この下書きを削除しますか？", {
        okLabel: "削除する",
        danger: true,
      });
      if (!wantsToDelete) return;
      await deleteDraft(draft.id);
      refreshDraftList();
    };

    footer.append(precision, postBtn);
    li.append(header, footer);
    draftList.append(li);
  }
}

// 30分経過による投稿可否の変化を、リストを開いたまま待っていても反映されるように
setInterval(() => {
  if (draftListDialog.open) refreshDraftList();
}, 60 * 1000);

$<HTMLButtonElement>("#draftListToggle").onclick = () => {
  closeMenu();
  refreshDraftList();
  draftListDialog.showModal();
};
$<HTMLButtonElement>("#draftListCloseX").onclick = () => draftListDialog.close();

closeOnBackdropClick(draftListDialog);

// --- スプラッシュ画面 -------------------------------------------------
// ヘッダーから「Ashi@」「どこにいた？」を外した代わりに、起動直後だけ
// 全画面でこれらを表示する。タップ、または一定時間経過で消える。
// 表示中は#appにinertを付けてあり(index.html側)、背後のボタンにキーボード
// フォーカスが移ったり、スクリーンリーダーから読み上げられたりしないように
// している。スプラッシュを閉じるタイミングでinertを解除する。
const splash = document.querySelector<HTMLElement>("#splash");
const appRoot = $("#app");
if (splash) {
  let splashHidden = false;
  const hideSplash = () => {
    if (splashHidden) return;
    splashHidden = true;
    splash.classList.add("hide");
    appRoot.removeAttribute("inert");
  };
  splash.addEventListener("click", hideSplash);
  setTimeout(hideSplash, 1600);
}

// 起動時:
// 1. TTL無しで保存してあるインスタンスURL・地図の表示位置があれば復元する
//    (どちらも無ければ、input要素のデフォルト値/createMap()のデフォルト位置のまま)
// 2. その上で、今のインスタンス欄の値でAshiatoキャッシュを復元し(ブラウザ再訪時の復元)、
//    復元できたものが0件だった場合だけ、自動で「過去を探す」を1回実行する。
(async () => {
  try {
    const savedInstance = await getSetting<string>("instanceUrl");
    if (savedInstance) $<HTMLInputElement>("#instance").value = savedInstance;

    const savedSortMode = await getSetting<UnlockedSortMode>("unlockedSortMode");
    if (savedSortMode === "unlocked" || savedSortMode === "posted") {
      unlockedSortMode = savedSortMode;
      unlockedSortModeSelect.value = savedSortMode;
    }

    const savedMediaVisibility = await getSetting<MediaVisibilityMode>("mediaVisibilityMode");
    if (
      savedMediaVisibility === "hide-all" ||
      savedMediaVisibility === "hide-sensitive" ||
      savedMediaVisibility === "show-all"
    ) {
      mediaVisibilityMode = savedMediaVisibility;
      const radio = document.querySelector<HTMLInputElement>(
        `input[name="mediaVisibility"][value="${savedMediaVisibility}"]`,
      );
      if (radio) radio.checked = true;
    }

    const savedMapView = await getSetting<{ lat: number; lon: number; zoom: number }>("mapView");
    if (savedMapView) {
      map.setView([savedMapView.lat, savedMapView.lon], savedMapView.zoom, {
        animate: false,
      });
    }

    const restoredCount = await switchHost(
      normalizeInstanceUrl($<HTMLInputElement>("#instance").value),
    );
    if (restoredCount === 0) fetchOlder();
  } catch (error) {
    console.error(error);
    setStatus("キャッシュの読み込みに失敗しました。", true);
  }
})();
