import {
  searchNotesByTag,
  normalizeInstanceUrl,
  buildShareUrl,
  fetchEmojiMap,
  type MisskeyNote,
} from "./misskey.js";
import { parseText, extractCandidates, buildMinimalCandidate } from "./parser.js";
import { isAshiatoActiveNow } from "./ashiatoEval.js";
import { parse as parseMfm, type MfmNode, type MfmFn } from "mfm-js";
import { marked } from "marked";
// 「Ashi@について」に表示するMarkdown文書。実行時にfetchするのではなく、
// ?rawでビルド時にJSへ直接埋め込む(ネットワーク状況に関わらず必ず読めるように
// するため。特に利用規約は「読めないのにアプリを使用できてしまう」ことを
// 避けたい)。
import overviewMd from "./docs/概要.md?raw";
import termsMd from "./docs/利用規約.md?raw";
import privacyMd from "./docs/プライバシーポリシー.md?raw";
import licenseMd from "./docs/ライセンス情報.md?raw";
import composeWarningMd from "./docs/投稿前の注意.md?raw";
import resetConfirmMd from "./docs/リセット確認.md?raw";
import clearSearchCacheConfirmMd from "./docs/マップ上のタイムラインのクリア確認.md?raw";
import {
  createMap,
  addAshiatoGroup,
  removeAshiatoGroup,
  loadPrefectureBoundaries,
  loadMunicipalityBoundaries,
  loadRailways,
  type RailwayResult,
  createCurrentLocationLayer,
  createClosePopupsButton,
  createPrecisionPreviewLayer,
  ashiatoColor,
  restyleMapForTheme,
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
import { lookupMunicipality } from "./municipalityLookup.js";
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
  updateDraftMemo,
  updateDraftInsertMemoIntoPost,
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
import { createIcon, type IconName } from "./icons.js";
import {
  SHOW_LOCKED_ASHIATO_FOR_DEBUG,
  SHOW_TEST_CONTEXT_ASHIATO_FOR_DEBUG,
  TAG,
  PAGE_SIZE,
  ASHIATO_CONTEXT_ID,
  MIN_GEOHASH_LENGTH,
  MAX_GEOHASH_LENGTH,
  PRECISION_LABELS,
  DRAFT_POST_DELAY_MS_BY_LENGTH,
  PENDING_PROMOTION_INTERVAL_MS,
  TEXT_PREVIEW_SAFETY_CAP_LENGTH,
  BAD_ACCURACY_RADIUS_M,
  STATUS_AUTO_HIDE_MS,
  ERROR_AUTO_HIDE_MS,
  MIN_DRAG_RESIZE_HEIGHT_PX,
  DRAG_RESIZE_FLICK_VELOCITY_PX_PER_MS,
  DRAG_RESIZE_CLOSE_HEIGHT_RATIO,
  POPUP_DRAG_MAX_HEIGHT_PX,
  READ_DWELL_MS,
  MIN_ZOOM_FOR_PREFECTURE_LABELS,
  MIN_ZOOM_FOR_MUNICIPALITIES,
  MIN_ZOOM_FOR_CAPITAL_LABELS,
  MIN_ZOOM_FOR_MUNICIPALITY_LABELS,
  MIN_ZOOM_FOR_RAILWAYS,
  MIN_ZOOM_FOR_STATIONS,
  MIN_ZOOM_FOR_STATION_LABELS,
  TERMS_VERSION_DATE,
  PRIVACY_VERSION_DATE,
  ashiatoRareGradientCss,
  ashiatoRareGlowBoxShadow,
} from "./config.js";

// 4桁(約20km)・5桁(約4km)はエリアが広すぎて「現地に行って発見する」体験に
// そぐわないため、現地探索(GPSでの発見判定=unlockedAt付与)の対象外とする。
// 地図上には検索結果に含まれた時点で常に表示するが、「見つけたあしあと」
// (収集物としての一覧・バッジ・未読管理)には一切含めない。これらのレコードは
// unlockedAtを常にnullのまま保ち(=決して「発見」扱いにしない)、地図描画側の
// 表示判定だけをunlockedAtの有無とは別に行う(rebuildCellVisual/
// showAshiatoCellPopup参照)。6桁・7桁は従来通りGPSでの現地探索が必要。
// (投稿自体はどの桁数でも常に現在地からのみ可能で、この区別は投稿側には影響しない)
function requiresOnSiteDiscovery(geohashLength: number): boolean {
  return geohashLength >= 6;
}

function isAcceptedContextId(contextId: string | null): boolean {
  if (contextId === ASHIATO_CONTEXT_ID) return true;
  return SHOW_TEST_CONTEXT_ASHIATO_FOR_DEBUG && contextId === "test";
}

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

const $ = <T extends Element = HTMLElement>(s: string): T => document.querySelector<T>(s)!,
  map = createMap("map"),
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
  menuBadge = $("#menuBadge"),
  draftBadge = $("#draftBadge");

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
$("#precisionFilterInfo").append(createIcon("info"));
$("#settingsToggle .menu-item-icon").append(createIcon("settings"));
$("#themeIcon").append(createIcon("moon"));
$("#themeToggle .settings-collapsible-toggle-icon").append(createIcon("chevron-down"));
$("#mediaVisibilityIcon").append(createIcon("eye"));
$("#mfmDisplayIcon").append(createIcon("sparkles"));
$("#layerDisplayIcon").append(createIcon("layers"));
$("#popupModeIcon").append(createIcon("messages-square"));
$("#composePrecisionIcon").append(createIcon("ruler"));
$("#mediaVisibilityToggle .settings-collapsible-toggle-icon").append(createIcon("chevron-down"));
$("#mfmDisplayToggle .settings-collapsible-toggle-icon").append(createIcon("chevron-down"));
$("#layerDisplayToggle .settings-collapsible-toggle-icon").append(createIcon("chevron-down"));
$("#popupModeToggle .settings-collapsible-toggle-icon").append(createIcon("chevron-down"));
$("#termsIcon").append(createIcon("file-text"));
$("#privacyIcon").append(createIcon("shield"));
$("#licenseIcon").append(createIcon("copyright"));
$("#termsToggle .settings-collapsible-toggle-icon").append(createIcon("chevron-down"));
$("#privacyToggle .settings-collapsible-toggle-icon").append(createIcon("chevron-down"));
$("#licenseToggle .settings-collapsible-toggle-icon").append(createIcon("chevron-down"));
$("#ashiatoInfoHeadingIcon").append(createIcon("info"));
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
$("#onboardingCloseX").append(createIcon("x"));

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

const railwayLayers = new Map<string, "loading" | RailwayResult>();
let railwaysVisible = false;
let stationsVisible = false;
let stationLabelsVisible = false;

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

// 同時に複数開ける吹き出し(showAshiatoCellPopup参照)。geohash文字列 -> 現在
// 開いているそのセルのL.Popupインスタンス。Leaflet標準のmap.openPopup()/
// .openOn(map)は「地図につき同時に1個だけ」という制約(新しく開くと既存の
// ものを自動で閉じる)があるため、代わりに.addTo(map)で個別に地図へ追加し、
// この一覧で自前管理する。同じセルを指すボタンを連打しても吹き出しが
// 重複しないよう、開く前にここで既存のものを閉じてから作り直す。
const openAshiatoPopups = new Map<string, L.Popup>();

// 「設定」ダイアログの吹き出しの表示モード。single(既定): 新しい吹き出しを
// 開くと、それ以外の吹き出しは全て閉じる(以前の、Leaflet標準に近い挙動)。
// multiple: 複数の吹き出しを同時に開いたままにできる。
// showAshiatoCellPopup参照。他の設定値と同じくputSettingで永続する。
type PopupMode = "multiple" | "single";
let popupMode: PopupMode = "single";

// +/-ズームボタンのすぐ下(map.ts:createClosePopupsButton参照)。開いている
// 吹き出しを1つずつ.close()していく(closeイベント経由でopenAshiatoPopups
// からも個別に外れる、showAshiatoCellPopup参照)。
createClosePopupsButton(map).onclick = () => {
  for (const popup of [...openAshiatoPopups.values()]) popup.close();
};

const currentLocationLayer = createCurrentLocationLayer(map);
let watchId: number | null = null;
let gpsEnabled = false;

let statusHideTimer: ReturnType<typeof setTimeout> | undefined;

// 通常メッセージ・エラーメッセージいずれも、一定時間で自動的に消える
// (地図の面積を占有し続けないように)が、読み終えたら即座に閉じたい場合も
// あるため、×ボタンでも明示的に閉じられるようにしておく。
function setStatus(t: string, e = false): void {
  clearTimeout(statusHideTimer);
  statusText.textContent = t;
  statusToast.classList.toggle("error", e);
  statusIcon.replaceChildren(createIcon(e ? "triangle-alert" : "info"));
  statusToast.hidden = false;
  statusCloseBtn.hidden = false;

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
// キャプチャフェーズ(第3引数true)で判定する: バブリングフェーズだと、
// クリックされたボタン自身のonclick(例: オンボーディングの「次へ」で
// スライドの中身が変わり、ダイアログの高さが縮む)が先に実行されてから
// この判定が走ってしまい、「クリックした瞬間はダイアログの中だったのに、
// 中身が変わって縮んだ後の矩形と比べたら外に見える」という誤判定で
// 閉じてしまうことがあった。キャプチャフェーズなら、中身を変える
// ボタン自身のハンドラより前に、変化前の矩形で正しく判定できる。
function closeOnBackdropClick(dialog: HTMLDialogElement): void {
  dialog.addEventListener(
    "click",
    (e) => {
      const rect = dialog.getBoundingClientRect();
      const inside =
        rect.top <= e.clientY &&
        e.clientY <= rect.top + rect.height &&
        rect.left <= e.clientX &&
        e.clientX <= rect.left + rect.width;
      if (!inside) dialog.close(); // キャンセル扱い(showConfirm等ではresultはfalseのまま)
    },
    true,
  );
}

const confirmDialog = $<HTMLDialogElement>("#confirmDialog");
const confirmMessage = $("#confirmMessage");
const confirmOkBtn = $<HTMLButtonElement>("#confirmOk");
const confirmCancelBtn = $<HTMLButtonElement>("#confirmCancel");

function showConfirm(
  message: string | Node,
  {
    okLabel = "OK",
    cancelLabel = "キャンセル",
    danger = false,
    hideCancel = false,
  }: { okLabel?: string; cancelLabel?: string; danger?: boolean; hideCancel?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    // 色見本(span)等を差し込みたい呼び出し側向けに、Nodeもそのまま受け付ける。
    if (typeof message === "string") confirmMessage.textContent = message;
    else confirmMessage.replaceChildren(message);
    confirmOkBtn.textContent = okLabel;
    confirmOkBtn.className = danger ? "btn-danger" : "btn-primary";
    confirmCancelBtn.textContent = cancelLabel;
    // 純粋な案内(OKしか意味を持たない)ではキャンセルボタンを出さない
    // (showInfo相当の用途で使う場合、呼び出し側がhideCancel:trueを渡す)。
    confirmCancelBtn.hidden = hideCancel;

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
// DragResizeTargetとして注入する。数値の調整はconfig.tsを参照。

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

  // 見つけたあしあと/下書きはCSS側にmin-height(空リストでも表示領域を
  // 確保するための下限、style.css参照)があり、min-heightはheightより
  // 常に優先されるため、そのままだとドラッグでその下限より縮められない。
  // 摘まんだ瞬間、今の実際の高さをそのままheightとして固定してから
  // min-heightを打ち消すことで、見た目を変えずにドラッグでの縮小を
  // 効くようにする。次に開いたときは(下のclose時のリセットで)既定の
  // min-heightに戻る。
  handle.addEventListener("pointerdown", () => {
    dialog.style.height = `${dialog.getBoundingClientRect().height}px`;
    dialog.style.minHeight = "0";
  });

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

  // 次に開いたときは常にCSSで指定された既定の高さ・min-heightから始める
  // (前回ドラッグで変更した高さを持ち越さない)。
  dialog.addEventListener("close", () => {
    dialog.style.height = "";
    dialog.style.minHeight = "";
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
    await syncRailwayLayers();
    map.on("moveend", () => {
      syncLabelVisibility();
      syncMunicipalityLayers();
      syncRailwayLayers();
    });
  } catch (error) {
    console.error(error);
    setStatus("地図境界の読み込みに失敗しました", true);
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

  // 駅の●は、路線の線(MIN_ZOOM_FOR_RAILWAYS)より近くまでズームしたときだけ
  // 表示する独立した閾値(MIN_ZOOM_FOR_STATIONS)を持つ。
  const wantStations = zoom >= MIN_ZOOM_FOR_STATIONS;
  if (wantStations !== stationsVisible) {
    for (const entry of railwayLayers.values()) {
      if (entry === "loading") continue;
      if (wantStations) entry.stationLayer.addTo(map);
      else map.removeLayer(entry.stationLayer);
    }
    stationsVisible = wantStations;
  }

  // 駅名ラベルは、●自体(MIN_ZOOM_FOR_STATIONS)よりさらに近くまでズームした
  // ときだけ表示する。
  const wantStationLabels = zoom >= MIN_ZOOM_FOR_STATION_LABELS;
  if (wantStationLabels !== stationLabelsVisible) {
    for (const entry of railwayLayers.values()) {
      if (entry === "loading") continue;
      if (wantStationLabels) entry.stationLabelLayer.addTo(map);
      else map.removeLayer(entry.stationLabelLayer);
    }
    stationLabelsVisible = wantStationLabels;
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

// 市区町村境界(syncMunicipalityLayers)と同じ考え方: ズームが閾値未満なら
// 読み込み済みのものもまとめて非表示にし、閾値以上ならviewport内の都道府県の
// 鉄道路線だけを(未読み込みなら取得して)表示する。
async function syncRailwayLayers(): Promise<void> {
  if (map.getZoom() < MIN_ZOOM_FOR_RAILWAYS) {
    if (railwaysVisible) {
      for (const entry of railwayLayers.values()) {
        if (entry === "loading") continue;
        map.removeLayer(entry.lineLayer);
        map.removeLayer(entry.stationLayer);
        map.removeLayer(entry.stationLabelLayer);
      }
      railwaysVisible = false;
    }
    return;
  }

  if (!railwaysVisible) {
    for (const entry of railwayLayers.values()) {
      if (entry === "loading") continue;
      entry.lineLayer.addTo(map);
      if (stationsVisible) entry.stationLayer.addTo(map);
      if (stationLabelsVisible) entry.stationLabelLayer.addTo(map);
    }
    railwaysVisible = true;
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
    if (railwayLayers.has(pref.code)) continue; // 読み込み済み or 読み込み中

    railwayLayers.set(pref.code, "loading");
    try {
      const entry = await loadRailways(map, pref.code);
      // loadRailwaysは内部でlineLayerを無条件にaddTo(map)しているため、取得を
      // 待っている間にズームアウトされてrailwaysVisibleがfalseに戻っていた
      // 場合は、ここで取り除いておく(市区町村境界と同じ理由)。stationLayer/
      // stationLabelLayerはloadRailways側では追加しない(現在のstationsVisible/
      // stationLabelsVisibleに従う)。
      if (!railwaysVisible) {
        map.removeLayer(entry.lineLayer);
      } else {
        if (stationsVisible) entry.stationLayer.addTo(map);
        if (stationLabelsVisible) entry.stationLabelLayer.addTo(map);
      }
      railwayLayers.set(pref.code, entry);
    } catch (error) {
      console.error(`鉄道路線の読み込みに失敗(${pref.name}):`, error);
      railwayLayers.delete(pref.code); // 後の moveend で再試行
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
// 本文プレビュー(record.textPreview、MFM原文のまま)には、カスタム絵文字が
// 「:name:」という記法で含まれている。ポップアップ・見つけたあしあと一覧の
// 2箇所だけ、record.emojiHost(投稿元インスタンス)のmisskey.js:fetchEmojiMapを
// 使ってshortcode→画像URLを解決し、実際の画像に置き換えて表示する
// (note.emojisは最近のMisskeyでは空のことが多く当てにできないため使わない)。
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

// shortcode(name)1個分を、emojiHost(投稿元インスタンス)から解決した画像が
// あれば<img>として、無ければそのままのテキスト「:name:」としてcontainerへ
// 追加する。画像の解決は非同期のため、一旦プレースホルダーのimgを差し込んで
// おき、後から src を差し替える(取得に失敗した場合はテキストへフォール
// バックする)。簡易表示(appendTextWithEmojis)・フル表示(appendMfmNodeFull)
// の両方から呼ばれる共通処理。
// onEmojiSettledは、この絵文字の解決(成功/失敗いずれか)が完了した時に呼ばれる。
// 画像挿入によってcontainerの高さが変わりうるため、呼び出し側は「続きを表示」ヒントの
// 表示要否(applyPreviewOverflowChecks)を再計算するのに使う。
function appendEmojiImage(
  container: HTMLElement,
  name: string,
  emojiHost: string,
  onEmojiSettled?: () => void,
): void {
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
}

// プレーンテキスト中の「:name:」をappendEmojiImageで画像に差し替えながら、
// それ以外はテキストノードとしてcontainerへ追加していく(簡易表示用)。
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
    appendEmojiImage(container, m[1], emojiHost, onEmojiSettled);
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
// 読み込みで高さが変わりうるタイミング(renderMfmPreviewのonEmojiSettled経由)で呼ぶ。
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
  const avatarWrap = document.createElement("div");
  avatarWrap.className = "ashiato-avatar-wrap";
  {
    // 未読/既読に関わらず常にドットの分の場所を確保しておく(visibilityだけ
    // 切り替える)。既読化時にDOMから消す(旧実装)と、そのぶんアイコンが
    // 左へ詰まって見えてしまうため(markRead参照)。
    const dot = document.createElement("span");
    dot.className = "unread-dot";
    // テーマカラー(黄色)にする。.unread-dotのbackground/box-shadowは
    // currentColorを参照しているため、ここでcolorを指定するだけで
    // 明滅の色も追従する(style.css参照)。
    dot.style.color = "var(--color-accent)";
    dot.setAttribute("aria-label", "未読");
    if (!isUnread) dot.classList.add("is-read");
    avatarWrap.append(dot);
  }

  const avatar = document.createElement("img");
  avatar.className = "ashiato-avatar";
  avatar.alt = "";
  avatar.loading = "lazy";
  if (record.avatarUrl) avatar.src = record.avatarUrl;
  avatarWrap.append(avatar);
  row.append(avatarWrap);

  const main = document.createElement("div");
  main.className = "ashiato-row-main";
  row.append(main);

  const header = document.createElement("div");
  header.className = "ashiato-row-header";
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
    renderMfmPreview(
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

  // 4桁・5桁(現地探索の対象外、requiresOnSiteDiscovery参照)は「発見」という
  // 概念自体が無いため、レイアウト(space-between)維持のため空のspanのままにする。
  const discovered = document.createElement("span");
  discovered.className = "ashiato-discovered";
  discovered.textContent = requiresOnSiteDiscovery(record.geohash.length)
    ? `発見: ${formatDateTime(record.unlockedAt) ?? "不明"}`
    : "";
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

// 「設定」ダイアログのMFM表示モード。本文プレビュー(record.textPreview、
// MFM原文のまま保存済み)を、装飾記号を取り除いたプレーンテキストにするか
// (simple)、太字・拡大・回転等の装飾込みでHTMLへ描画するか(full)を選ぶ。
// mediaVisibilityModeと同じくputSettingで永続する。
type MfmDisplayMode = "simple" | "full";
let mfmDisplayMode: MfmDisplayMode = "simple";

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
    grid.append(buildMediaItem(files[0], [], -1));
    return grid;
  }

  const images = files.filter((f) => !f.type.startsWith("video/"));
  files.forEach((file) => {
    grid.append(buildMediaItem(file, images, images.indexOf(file)));
  });
  return grid;
}

// imagesForLightbox/lightboxIndexは、この1件が画像の場合の「ライトボックスに
// 渡す画像だけの配列とその中でのインデックス」。動画の場合は使わない(-1)。
// モザイク(ぼかし)の状態はitemの"ashiato-media-blurred"クラスの有無だけで管理する。
// veil(タップで表示)とeyeBtn(タップでモザイクをかけ直す)はどちらも常にDOM上に
// 存在し、どちらを見せるかはCSS側でそのクラスの有無から切り替える
// (style.css: .ashiato-media-blurred .ashiato-media-veil / :not(...) .ashiato-media-eye-btn)。
// センシティブタグは、モザイク状態に関わらずisSensitiveなら常に表示する
// (ライトボックス側には付けない = このitem内だけの要素なので自然に満たされる)。
// 何枚中の何枚目か(n/m)は、一覧側では表示せずライトボックス(拡大表示)側だけで
// 表示する(openMediaLightbox参照)。
function buildMediaItem(
  file: AshiatoFile,
  imagesForLightbox: AshiatoFile[],
  lightboxIndex: number,
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

  return item;
}

// セルの地図上の見た目(円+タップ判定)だけを取り除く。cell.records自体は
// 変更しないので、呼び出し側がその後cellを削除するか、rebuildCellVisualで
// 作り直すかを決める。
function clearCellVisual(cell: AshiatoCell): void {
  if (cell.hitArea) removeAshiatoGroup(map, { visualLayers: cell.visualLayers!, hitArea: cell.hitArea });
}

// 「24H以内」トグル用。投稿日時(noteCreatedAt)が現在時刻から24時間以内かどうか。
// 日時が取得できない場合は安全側(非表示)にfalseを返す。
const WITHIN_24H_MS = 24 * 60 * 60 * 1000;
function isPostedWithin24h(record: AshiatoRecord): boolean {
  if (!record.noteCreatedAt) return false;
  const postedMs = new Date(record.noteCreatedAt).getTime();
  if (Number.isNaN(postedMs)) return false;
  return Date.now() - postedMs <= WITHIN_24H_MS;
}

// セルの見た目(矩形)を、現在のrecords件数・状態に合わせて作り直す。
// ロック中(未発見)のレコードは地図上に一切表示しない方針のため、
// 表示対象は「発見済み(unlockedAtあり)」のレコードに絞る。ただし4桁・5桁は
// 現地探索の対象外(requiresOnSiteDiscovery参照)で、そもそもunlockedAtを
// 持たない設計のため、それらは常に表示対象に含める。
// 桁数ごとの表示フィルター(visiblePrecisionLengths)でオフにされている
// 桁数も除外する。
// 表示対象が1件も無いセルは、矩形そのものを描画しない
// (GPS判定用の内部データとしてはcell.recordsに保持し続ける)。
function rebuildCellVisual(cell: AshiatoCell): void {
  clearCellVisual(cell);
  cell.visualLayers = null;
  cell.hitArea = null;

  const visibleRecords = [...cell.records.values()].filter(
    (r) =>
      visiblePrecisionLengths.has(r.geohash.length) &&
      (SHOW_LOCKED_ASHIATO_FOR_DEBUG ||
        r.unlockedAt ||
        !requiresOnSiteDiscovery(r.geohash.length)) &&
      (!hideReadEnabled || !r.readAt) &&
      (!within24hEnabled || isPostedWithin24h(r)),
  );

  if (visibleRecords.length > 0) {
    const allRead = visibleRecords.every((r) => r.readAt);
    const { visualLayers, hitArea } = addAshiatoGroup(
      map,
      cell.geohash,
      allRead,
      () => handleCellClick(cell.geohash),
    );
    cell.visualLayers = visualLayers;
    cell.hitArea = hitArea;
  }
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

// GPSが有効な間、この間隔でcheckCurrentPositionAgainstCellsを呼び直す。Ashiato
// Syntaxの時間条件(d/w/t/o等)は位置が変わらなくても時刻の経過だけでActive/Inactive
// が切り替わりうるため、位置情報の更新を待たずにこの1分間隔のタイマーで
// 定期的に再評価する。
function reevaluateActiveConditions(): void {
  if (gpsEnabled) checkCurrentPositionAgainstCells();
}

setInterval(reevaluateActiveConditions, PENDING_PROMOTION_INTERVAL_MS);

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

// 発見済み(unlockedAt)かつ未読(readAtが無い)のレコード件数を、メールの受信
// トレイのような件数バッジとしてハンバーガーメニュー内「見つけたあしあと」項目に
// 出す(メニューFAB自体は場所が狭いので、従来通り点のままにする)。
// 一覧・ポップアップの描画後、および可視性ベースの既読化(observeRowsForRead)が
// 実際に既読化を行った後、いずれのタイミングでも呼ぶこと。
function updateUnreadBadge(): void {
  const unreadCount = [...ashiatoCells.values()].reduce(
    (total, cell) =>
      total + [...cell.records.values()].filter((r) => r.unlockedAt && !r.readAt).length,
    0,
  );
  menuBadge.hidden = unreadCount === 0;
  unlockedBadge.hidden = unreadCount === 0;
  unlockedBadge.textContent = String(unreadCount);
}

// 一定時間(READ_DWELL_MS、config.ts参照)表示され続けたレコードだけを既読にする。
// 開いた瞬間(=表示された瞬間)に即既読化すると未読ドットを目にする間もなく
// 消えてしまうため、「ちゃんと表示された」とみなせるだけの猶予を設ける。
// この間にスクロールで画面外に出た場合はタイマーを取り消し、既読にしない。

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
    // レイアウト幅を変えないよう、DOMから消すのではなくvisibilityだけ隠す
    // (renderAshiatoRow参照)。
    target.querySelector(".unread-dot")?.classList.add("is-read");

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
// 4桁・5桁(現地探索の対象外)は常にunlockedAtを持たない設計のため、
// 自然にこの一覧にも含まれない(見つけずに見れるので「見つけた」扱いにしない)。
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
// ポップアップ等に出すのは、発見済み(unlockedAt)のレコード、または現地探索の
// 対象外(4桁・5桁、requiresOnSiteDiscovery参照)のレコードのみ
// (それ以外のロック中のものは地図に表示していないため、そもそもクリックしようがない)。
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

  // 同じセルの吹き出しが既に開いていれば、内容(既読状態等)が古いままに
  // ならないよう一旦閉じてから作り直す(閉じるとpopupcloseイベント経由で
  // openAshiatoPopupsからも自動で外れる)。
  openAshiatoPopups.get(geohash)?.close();

  // 設定「吹き出しの表示」がsingle(1つのみ)の場合、他のセルの吹き出しは
  // ここで全て閉じる(multiple=既定では何もしない、他の吹き出しは残る)。
  if (popupMode === "single") {
    for (const [otherGeohash, popup] of [...openAshiatoPopups]) {
      if (otherGeohash !== geohash) popup.close();
    }
  }

  const records = [...cell.records.values()]
    .filter(
      (r) =>
        (r.unlockedAt || !requiresOnSiteDiscovery(r.geohash.length)) &&
        (!within24hEnabled || isPostedWithin24h(r)),
    )
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

  // 投稿一覧だけをスクロールさせる領域(ハンドルはこの外に置く)。理由は
  // style.css .ashiato-popup-rows のコメント参照
  // (スクロールバーが閉じるボタンと重ならないようにするため)。
  const rowsWrapper = document.createElement("div");
  rowsWrapper.className = "ashiato-popup-rows";
  container.append(rowsWrapper);

  const rowsForReadTracking: { row: HTMLElement; record: AshiatoRecord }[] = [];
  for (const record of records) {
    // ポップアップは閉じない(「…」を押しても地図上の吹き出しはそのまま残る)。
    // アクションシートはモーダルダイアログとしてその上に重なって表示される。
    const row = renderAshiatoRow(record, container, () => {
      openAshiatoActions(record);
    });
    rowsForReadTracking.push({ row, record });
    rowsWrapper.append(row);
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
  // .openOn(map)(=map.openPopup())は「地図につき同時に1個だけ」という
  // Leaflet標準の制約があり、新しく開くたびに既存の吹き出しを自動で
  // 閉じてしまう。複数のセルの吹き出しを同時に開けるようにするため、
  // 単なるレイヤーとして.addTo(map)する(popupopen/popupcloseイベントは
  // Popup自身のonAdd/onRemoveで発火するため、この方法でも変わらず使える)。
  // さらに、Leafletの各PopupインスタンスはオプションcloseOnClick
  // (未指定時はmap.options.closePopupOnClick、既定true)に応じて
  // 「地図上のどこをクリックしても(preclickイベントで)自分自身を閉じる」
  // という挙動を個別に持っている。これは.openOn/.addToのどちらを使うかとは
  // 無関係に効いてしまうため、別のセルをクリックして新しい吹き出しを開く
  // 操作そのものが既存の吹き出しを閉じる原因になっていた。
  // closeOnClick:falseで無効化し、閉じる手段を×ボタン/下スワイプ/
  // 同じセルの開き直しだけに限定する。
  const popup = L.popup({
    minWidth: 268,
    maxWidth: 308,
    maxHeight: 260,
    closeOnClick: false,
  })
    .setLatLng([centerLat, centerLon])
    .setContent(container)
    .addTo(map);
  openAshiatoPopups.set(geohash, popup);

  const popupEl = popup.getElement();
  // 複数の吹き出しが重なっているとき、奥にあるものをタップしたら最前面に
  // 出す。popupPane内でのDOM上の並び順(=最後の子要素が最前面に描画される)
  // を、Leaflet標準のbringToFront()(内部でtoFront()=親の最後の子に
  // 付け替えるだけ)で操作する。押した瞬間(pointerdown)に反応させ、
  // 実際のボタン操作等より前に手前へ出す。
  popupEl?.addEventListener("pointerdown", () => popup.bringToFront());

  // Leaflet既定の×ボタンはブラウザフォントの"×"文字のままで、他のダイアログの
  // .dialog-close-xで使っているアイコン(lucideのxアイコン)と見た目が違うため、
  // 同じアイコンに差し替えて揃える。
  const closeBtn = popupEl?.querySelector<HTMLAnchorElement>(".leaflet-popup-close-button");
  if (closeBtn) {
    closeBtn.textContent = "";
    closeBtn.append(createIcon("x"));
  }

  // 吹き出しの影を、Leaflet既定の黒系(rgba(0,0,0,0.4))ではなく、このセルの
  // 色(ashiatoColor)に揃える。hex末尾に16進数のアルファ(約40%=66)を足すだけで
  // 変換できるので、rgba()への変換処理は不要。
  // 7桁(約150m)だけ、地図上のセル・表示レイヤーのチップと揃えて単色ではなく
  // 虹色のグローにする(box-shadow自体はグラデーションにできないため、
  // 色ごとに半径違いで重ねがけして表現する、ashiatoRareGlowBoxShadow参照)。
  const shadow =
    geohash.length === 7
      ? ashiatoRareGlowBoxShadow()
      : `0 3px 14px ${ashiatoColor(geohash.length)}80`;
  const wrapperEl = popupEl?.querySelector<HTMLElement>(".leaflet-popup-content-wrapper");
  const tipEl = popupEl?.querySelector<HTMLElement>(".leaflet-popup-tip");
  if (wrapperEl) wrapperEl.style.boxShadow = shadow;
  if (tipEl) tipEl.style.boxShadow = shadow;

  // openOn()でDOMに接続・表示された直後なので、ここで初めて高さが正しく測れる。
  applyPreviewOverflowChecks(container);

  // container.parentElement は Leaflet が用意する.leaflet-popup-content
  // (maxHeight超過時にheightが明示的に付く、L.popup呼び出し側のmaxHeight
  // 指定を参照)。ドラッグでの高さ調整はこの要素に対して行う(実際に
  // スクロールする領域はrowsWrapper側。style.css .ashiato-popup-rows参照)。
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
    // map.closePopup()(引数無し)は「map.openPopup()で開いた単一の吹き出し」
    // 前提のAPIで、同時に複数開けるようにした今は意味を持たない。この
    // 吹き出し自身(popup)を指定して、これだけを閉じる。
    onDismiss: () => map.closePopup(popup),
  });

  // このポップアップが閉じられたら(他の吹き出しに差し替わった場合を含む)
  // observerを解放し、openAshiatoPopupsからも外す。実際にスクロールする
  // 領域はrowsWrapper(.ashiato-popup-rows)なので、可視判定のrootもそちらにする。
  const disposeReadObserver = observeRowsForRead(rowsWrapper, rowsForReadTracking);
  map.once("popupclose", (e) => {
    if (e.popup !== popup) return;
    disposeReadObserver();
    if (openAshiatoPopups.get(geohash) === popup) openAshiatoPopups.delete(geohash);
  });
}

// あしあと1件分の「…」ボタンから呼ばれるアクションシート。地図/一覧いずれの行からも
// 呼ばれうる(発見済み(unlockedAtがある)レコードか、現地探索の対象外(4桁・5桁、
// requiresOnSiteDiscovery参照)のレコードのいずれか)。
// 情報(投稿者・投稿日時・発見日時・当たり判定エリア)を表示した上で、
// マップ表示・SNSを開く・「見つけたあしあと」からの削除の3アクションを提供する。
// 「発見日時」の行と削除アクションは、現地探索の対象(=本当に「発見」した)
// レコードにのみ意味があるため、現地探索の対象外のレコードでは出さない。
function openAshiatoActions(record: AshiatoRecord): void {
  const isCollectible = requiresOnSiteDiscovery(record.geohash.length);

  ashiatoActionInfo.replaceChildren();
  const infoRows: [string, string][] = [
    ["投稿者", formatUserLabel(record)],
    ["場所", "取得中…"],
    ["投稿", formatDateTime(record.noteCreatedAt) ?? "不明"],
    ...(isCollectible
      ? ([["発見", formatDateTime(record.unlockedAt) ?? "不明"]] as [string, string][])
      : []),
    ["エリアサイズ", cellSizeText(record.geohash)],
  ];
  ashiatoActionDeleteBtn.hidden = !isCollectible;
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
    // このセルの吹き出しが既に開いていればshowAshiatoCellPopup内で
    // 閉じてから作り直される(他のセルの吹き出しは複数開けるようにした
    // 今、ここで無関係に全部閉じてしまう必要は無い)。
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
      rebuildCellVisual(cell); // ロック中に戻るので矩形は消える(セルは保持)
    }

    refreshUnlockedList();
    setStatus("あしあとを削除しました（現地に行けば再度発見できます）");
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

// 位置精度のしきい値(BAD_ACCURACY_RADIUS_M)はconfig.ts参照。この状態では、
// あしあとの発見(当たり判定)・新規投稿・新規下書きを行わない(下書き済みの
// あしあとの投稿はisDraftPostableのルールのみに従い、ここでは制限しない)。

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

// GPSトグルON/OFF・現在地の有無・位置精度いずれの変化でも、投稿メニュー項目
// (新規投稿・新規下書きの入口)の有効/無効を再計算する。
// GPSトグルがOFFの間はあえて無効化しない(押せる状態のままにしておき、
// クリック時に「現在地をONにしてください」と案内する。ボタンがずっと
// グレーアウトしたままだと、押しても反応がなく理由も分からないため)。
// トグルはタップした瞬間に見た目上ON表示になる(setGpsEnabled参照)が、
// 実際に現在地(lastKnownPosition)が取れるまでは投稿できないので、その間は
// 無効化しておく。
function updateComposeAvailability(): void {
  composeAshiatoMenuItem.disabled = gpsEnabled && (!lastKnownPosition || isPrecisionBad());
}

// 起動時、そもそもGeolocation APIが無い端末なら見た目で分かるようにしておく
if (!("geolocation" in navigator)) {
  gpsToggleBtn.classList.add("unavailable");
  gpsToggleBtn.title = "この端末では位置情報が使えません";
}

function setGpsEnabled(enabled: boolean): void {
  if (enabled && !("geolocation" in navigator)) {
    setStatus("この端末では位置情報が使えません", true);
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
    stopHeadingTracking();
    lastKnownPosition = null; // OFFにしたら古い位置情報は使い回さない
    lastKnownAccuracy = null;
    updatePrecisionWarning();
    // 投稿UIを開いたままGPSをOFFにした場合、古い位置情報のまま投稿できて
    // しまわないよう、開いていれば閉じて下書き用の位置情報も破棄する。
    if (composeDialog.open) composeDialog.close();
    composePosition = null;
    return;
  }

  if (watchId !== null) return; // 既に取得試行中なら二重に開始しない

  // タップした時点で即座にON表示にする(現在地の取得を待たせず、もたつき
  // 感を無くすため)。実際の現在地(lastKnownPosition)が届くまでは
  // 「あしあとを投稿」を押せないままにする(updateComposeAvailability参照)。
  // 取得が失敗/タイムアウトした場合は、handlePositionErrorが自動でOFFに戻す。
  gpsEnabled = true;
  gpsToggleBtn.setAttribute("aria-pressed", "true");
  updateComposeAvailability();

  setStatus("現在地を取得中…");
  watchId = navigator.geolocation.watchPosition(
    handlePositionUpdate,
    handlePositionError,
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
  );

  // iOS(13+)はコンパスの利用許可をユーザー操作由来の呼び出しでしか
  // 求められないため、このトグルON操作にそのまま便乗する。
  void startHeadingTracking();
}

// --- コンパス方位(現在地マーカーの矢印) -----------------------------------
// マップ自体は回転させず、現在地マーカー上の矢印だけを端末のコンパス方位に
// 合わせて回す(マップ回転はleaflet-rotate相当のプラグインが前提になり、
// 主要な実装がGPLライセンスのため見送った)。
let headingEventName: "deviceorientationabsolute" | "deviceorientation" | null = null;

function computeCompassHeading(event: DeviceOrientationEvent): number | null {
  // iOS SafariはwebkitCompassHeadingで真北基準の方位を直接くれる(画面回転補正込み)。
  const webkitHeading = (event as DeviceOrientationEvent & { webkitCompassHeading?: number })
    .webkitCompassHeading;
  if (typeof webkitHeading === "number") return webkitHeading;

  // それ以外(Android Chrome等)は絶対方位(event.absolute)が取れている場合のみ
  // alphaから計算する。相対値(端末を構えた向きが基準の0度)しか無い場合は
  // 実際の方位と無関係になるため使わない。
  if (!event.absolute || event.alpha === null) return null;
  const screenAngle = screen.orientation?.angle ?? 0;
  return (((360 - event.alpha - screenAngle) % 360) + 360) % 360;
}

function handleDeviceOrientation(event: DeviceOrientationEvent): void {
  const heading = computeCompassHeading(event);
  if (heading === null) return;
  currentLocationLayer.showHeading(heading);
}

async function startHeadingTracking(): Promise<void> {
  if (headingEventName) return; // 既に購読中

  const requestPermission = (
    DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<"granted" | "denied">;
    }
  ).requestPermission;
  if (typeof requestPermission === "function") {
    try {
      if ((await requestPermission()) !== "granted") return;
    } catch (error) {
      console.error(error);
      return;
    }
  }

  // 真北基準の絶対方位が取れるdeviceorientationabsoluteを優先し、
  // 無ければdeviceorientation(iOSはこちら経由でwebkitCompassHeadingが載る)。
  const eventName = "ondeviceorientationabsolute" in window
    ? "deviceorientationabsolute"
    : "deviceorientation";
  window.addEventListener(eventName, handleDeviceOrientation as EventListener);
  headingEventName = eventName;
}

function stopHeadingTracking(): void {
  if (!headingEventName) return;
  window.removeEventListener(headingEventName, handleDeviceOrientation as EventListener);
  headingEventName = null;
  currentLocationLayer.hideHeading();
}

function handlePositionError(error: GeolocationPositionError): void {
  console.error(error);
  const messages: Record<number, string> = {
    1: "位置情報の利用が許可されていません",
    2: "現在地を取得できませんでした",
    3: "現在地の取得がタイムアウトしました",
  };
  setStatus(messages[error.code] ?? "位置情報の取得に失敗しました", true);
  // 権限拒否(1)は再度許可し直すまで絶対に回復しないため、トグルをOFFに戻す
  // (タップした時点で見た目上ON表示にしている(setGpsEnabled参照)ため、
  // 現在地が一向に取れない状態のままONの見た目だけが残ることを防ぐ)。
  // 取得不能(2)・タイムアウト(3)は、建物内に入った等の一時的な電波状況でも
  // 起こりうる。watchPositionは元々その場合も監視を継続し続けるAPIなので、
  // ここでOFFに戻して監視自体を止めてしまうと、電波が回復しても自動で
  // 再取得されず、ユーザーが気づいてトグルを再度ONにし直す必要が生じる。
  // トーストで一時的な失敗を知らせるだけにして、watchPosition自体は継続させる。
  if (error.code === error.PERMISSION_DENIED) setGpsEnabled(false);
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
  let anyLengthAutoEnabled = false;

  for (const cell of ashiatoCells.values()) {
    // 4桁・5桁(現地探索の対象外、requiresOnSiteDiscovery参照)は、たとえ現在地が
    // セル内に入っていてもGPSでの発見処理そのものを行わない(=unlockedAtを
    // 決して付与しない。「見つけたあしあと」に絶対含めないため)。
    const locked = [...cell.records.values()].filter(
      (r) => !r.unlockedAt && requiresOnSiteDiscovery(r.geohash.length),
    );
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
      // 現地で発見した桁数(ここに来るのは常に6桁・7桁。requiresOnSiteDiscovery参照)の
      // 表示レイヤーがOFFなら、設定で有効な場合に限り自動でONにする。
      if (
        autoEnableLayerOnDiscoveryEnabled &&
        enablePrecisionLengthIfNeeded(record.geohash.length)
      ) {
        anyLengthAutoEnabled = true;
      }
      await markAshiatoUnlocked(record.id, unlockedAt);
    }
    rebuildCellVisual(cell); // 初めて発見された/丸の数が増えたケースに対応
    refreshUnlockedList();
  }

  // 表示レイヤーが自動でONになった場合、今回発見したセル以外にも同じ桁数の
  // (これまでOFFで非表示だった)セルがあるかもしれないため、全セルを描画し直す。
  if (anyLengthAutoEnabled) {
    for (const cell of ashiatoCells.values()) rebuildCellVisual(cell);
  }

  if (discoveredCount > 0) showDiscoveryBanner(discoveredCount);
}

// 現在地が更新されるたびに呼ばれる。実際の判定はcheckCurrentPositionAgainstCellsに委譲する
// (「過去を探す」等でセル自体が増減したタイミングでも同じ判定を再利用できるようにするため)。
async function handlePositionUpdate(position: GeolocationPosition): Promise<void> {
  // トグルOFF後に古いwatchPositionのコールバックが遅れて届いた場合の保険
  // (clearWatch済みのはずだが、念のため)。ON表示はsetGpsEnabledで即座に
  // 済ませているため、ここでgpsEnabledをtrueにする必要はない。
  if (!gpsEnabled) return;

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

// --- 精度(geohash桁数)ごとの表示フィルター ---------------------------------
// あしあと本体がセルの矩形そのものになった(中心の丸マーカー廃止)ことで、
// 従来の「エリア」トグル(セル範囲を別レイヤーで薄く重ね描きする機能)は
// 完全に重複表示になったため廃止し、代わりに桁数ごとに地図上へ表示するか
// どうかを選べるようにした。4桁・5桁の広いセルが密集地の7桁セルを覆い隠す
// ケースを、利用者側で個別にオフにして解消できる。
const visiblePrecisionLengths = new Set<number>([4, 5, 6, 7]);
const precisionFilterChipsByLength = new Map<number, HTMLButtonElement>();

for (const chip of document.querySelectorAll<HTMLButtonElement>(".precision-filter-chip")) {
  const length = Number(chip.dataset.length);
  precisionFilterChipsByLength.set(length, chip);
  chip.style.setProperty("--chip-color", ashiatoColor(length));
  // 7桁(約150m)だけ、地図上のセル(map.ts参照)と揃えて単色ではなく
  // 虹色グラデーションにする(ON状態の塗り・枠線、style.css参照)。
  // マップ上のセル(横長寄りの矩形)は135degのままでよいが、このチップは
  // 横26px・縦38px前後の縦長で、同じ角度だと中間色(水色)の帯が対角線の
  // 大部分を占めてしまい、両端のピンク・黄緑がほぼ角にしか見えなかった。
  // チップの縦横比に合わせて縦方向寄り(160deg)にし、5色をまんべんなく
  // 配分する。
  if (length === 7) chip.style.setProperty("--chip-rare-gradient", ashiatoRareGradientCss(160));
  chip.onclick = () => {
    const nowVisible = !visiblePrecisionLengths.has(length);
    if (nowVisible) visiblePrecisionLengths.add(length);
    else visiblePrecisionLengths.delete(length);
    chip.setAttribute("aria-pressed", String(nowVisible));
    for (const cell of ashiatoCells.values()) rebuildCellVisual(cell);
  };
}

// 「設定」の「現地で発見したら、その精度の表示レイヤーを自動でONにする」。
// デフォルト有効(index.htmlのcheckedと一致させる)。
let autoEnableLayerOnDiscoveryEnabled = true;
const autoEnableLayerOnDiscoveryCheckbox = $<HTMLInputElement>("#autoEnableLayerOnDiscovery");
autoEnableLayerOnDiscoveryCheckbox.onchange = () => {
  autoEnableLayerOnDiscoveryEnabled = autoEnableLayerOnDiscoveryCheckbox.checked;
  putSetting("autoEnableLayerOnDiscoveryEnabled", autoEnableLayerOnDiscoveryEnabled);
};

// 指定した桁数の表示レイヤーがまだOFFなら、ONにしてチップの見た目も更新する。
// 実際に切り替えた場合はtrueを返す(呼び出し側でまとめて再描画するため)。
function enablePrecisionLengthIfNeeded(length: number): boolean {
  if (visiblePrecisionLengths.has(length)) return false;
  visiblePrecisionLengths.add(length);
  precisionFilterChipsByLength.get(length)?.setAttribute("aria-pressed", "true");
  return true;
}

// 色見本(小さな正方形)をテキストに埋め込む。「青・緑」等の色名だけだと
// 実際の色との対応が分かりにくいため、その色そのものを見せる。
// 7桁(約150m)だけ、地図上のセル・チップ・吹き出しと揃えて単色ではなく
// 虹色グラデーション(ホロカード風)にする。
function colorSwatch(geohashLength: number): HTMLSpanElement {
  const swatch = document.createElement("span");
  swatch.className = "color-swatch";
  if (geohashLength === 7) swatch.style.background = ashiatoRareGradientCss();
  else swatch.style.backgroundColor = ashiatoColor(geohashLength);
  return swatch;
}

// エリアサイズ4種の色見本+ラベルの並び。トグルカード「表示レイヤー」の
// インフォ(#precisionFilterInfo)と同じ考え方で、使い方スライド
// (ONBOARDING_SLIDES、「投稿するには」)でも同じ色見本を流用する。
function buildPrecisionLegend(): HTMLSpanElement {
  const legend = document.createElement("span");
  legend.className = "precision-legend";
  for (const length of [4, 5, 6, 7] as const) {
    legend.append(colorSwatch(length), document.createTextNode(`${PRECISION_LABELS[length]} `));
  }
  return legend;
}

// 色だけでは何を切り替えているか分からないため、簡単な説明を出す入口。
// 「現地に行かなくても見れる/見るには現地で発見が必要」という区別
// (requiresOnSiteDiscovery参照)は色分けでしか示していないため、ここで補足する。
$<HTMLButtonElement>("#precisionFilterInfo").onclick = () => {
  const message = document.createDocumentFragment();
  // 色とエリアサイズの対応が分かりづらいため、まず凡例を出す
  // (■(20km) ■(4km) ■(1km) ■(150m) のように、桁数ごとの色とサイズを並べる)。
  const legend = document.createElement("span");
  for (const length of [4, 5, 6, 7] as const) {
    legend.append(
      colorSwatch(length),
      document.createTextNode(`(${PRECISION_LABELS[length].replace(/^約/, "")}) `),
    );
  }
  const line1 = document.createElement("span");
  line1.append(colorSwatch(4), colorSwatch(5), document.createTextNode("は現地に行かなくても見れます"));
  const line2 = document.createElement("span");
  line2.append(colorSwatch(6), colorSwatch(7), document.createTextNode("は現地で発見する必要があります"));
  message.append(legend, document.createElement("br"), line1, document.createElement("br"), line2);
  showConfirm(message, { okLabel: "閉じる", hideCancel: true });
};

// --- 「24H以内」トグル(投稿から24時間以内のAshiatoしか地図・吹き出しに表示しない) ---

const toggle24hBtn = $<HTMLButtonElement>("#toggle24h");
let within24hEnabled = false;

toggle24hBtn.onclick = () => {
  within24hEnabled = !within24hEnabled;
  toggle24hBtn.setAttribute("aria-pressed", String(within24hEnabled));
  for (const cell of ashiatoCells.values()) rebuildCellVisual(cell);
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

const menuWrapper = $(".menu");
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
  if (willOpen) {
    // ポップアップの左端を「過去を探す」ボタンの左端に、右端をトグル開閉
    // ボタン(#togglePanelCollapse、地図右上の「<」)の右端に揃える。
    // 両端とも外部の要素basisで決まるため、幅(width)もこの2点から逆算する。
    // .menu-dropdownのCSS側min-width(230px)がこの計算値を上回る場合、
    // widthを指定してもmin-widthに押し戻されて右端がはみ出してしまう
    // (実際に発生していた不具合)ため、ここでmin-widthも明示的に0へ
    // 上書きする。
    const searchLeft = $("#search").getBoundingClientRect().left;
    const toggleHandleRight = $("#togglePanelCollapse").getBoundingClientRect().right;
    const menuLeft = menuWrapper.getBoundingClientRect().left;
    menuDropdown.style.right = "auto";
    menuDropdown.style.left = `${searchLeft - menuLeft}px`;
    menuDropdown.style.minWidth = "0";
    menuDropdown.style.width = `${toggleHandleRight - searchLeft}px`;
  }
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

// maybeShowTermsNotice用: 「利用規約(2026/09/12)」のようなカード行を、
// 日付部分だけ右寄せ・淡色にした見た目で組み立てる。実際に押せるボタンにし、
// 押すとこの通知を閉じた上で「Ashi@について」を開き、該当セクションを展開して
// スクロールする(「確認しました」だけ押して中身を見ない場合は、わざわざ
// 「Ashi@について」を開かずに済むよう、ここで初めて開く)。
function buildTermsNoticeDocRow(
  icon: IconName,
  label: string,
  date: string,
  targetToggleId: string,
  targetRowsId: string,
): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "terms-notice-row";
  const iconSpan = document.createElement("span");
  iconSpan.className = "action-sheet-icon";
  iconSpan.append(createIcon(icon));
  const labelSpan = document.createElement("span");
  labelSpan.className = "terms-notice-label";
  labelSpan.textContent = label;
  const dateSpan = document.createElement("span");
  dateSpan.className = "terms-notice-date";
  dateSpan.textContent = date;
  button.append(iconSpan, labelSpan, dateSpan);
  button.onclick = () => {
    // 通知は閉じない(利用規約を読んだ後、続けてプライバシーポリシーも
    // 読みたい場合があるため)。「Ashi@について」を通知の上に重ねて開き、
    // 閉じれば通知に戻れるようにする。
    if (!aboutDialog.open) aboutDialog.showModal();
    expandCollapsible(targetToggleId, targetRowsId);
    $(`#${targetToggleId}`).scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return button;
}

// 初回利用時、または利用規約・プライバシーポリシーの内容が変わったとき
// (TERMS_VERSION_DATE/PRIVACY_VERSION_DATEが、前回確認した時点の値と
// 異なるとき)、スプラッシュが消えたタイミングで確認を促すダイアログを表示する。
// 「Ashi@について」自体は自動で開かない(内容を見ずに「確認しました」だけ
// 押すことも多いはずなので、そのケースで余計なダイアログが残らないように)。
// 中の「利用規約」「プライバシーポリシー」ボタンを押した場合だけ、そこで
// 初めて「Ashi@について」を開いて該当セクションへジャンプする
// (buildTermsNoticeDocRow参照)。閉じた時点で「確認済み」として今の
// バージョンをsettingsへ保存する。
async function maybeShowTermsNotice(): Promise<void> {
  const [ackTerms, ackPrivacy] = await Promise.all([
    getSetting<string>("acknowledgedTermsVersion"),
    getSetting<string>("acknowledgedPrivacyVersion"),
  ]);
  if (ackTerms === TERMS_VERSION_DATE && ackPrivacy === PRIVACY_VERSION_DATE) return;

  const message = document.createDocumentFragment();
  const intro = document.createElement("p");
  intro.className = "terms-notice-intro";
  intro.textContent = "利用規約・プライバシーポリシーを必ずご確認ください";
  const list = document.createElement("div");
  list.className = "terms-notice-list";
  list.append(
    buildTermsNoticeDocRow("file-text", "利用規約", TERMS_VERSION_DATE, "termsToggle", "termsRows"),
    buildTermsNoticeDocRow(
      "shield",
      "プライバシーポリシー",
      PRIVACY_VERSION_DATE,
      "privacyToggle",
      "privacyRows",
    ),
  );
  message.append(intro, list);

  await showConfirm(message, { okLabel: "確認しました", hideCancel: true });
  putSetting("acknowledgedTermsVersion", TERMS_VERSION_DATE);
  putSetting("acknowledgedPrivacyVersion", PRIVACY_VERSION_DATE);
}

// --- 初回オンボーディング(アプリの使い方スライド) ---------------------------
// 利用規約・プライバシーポリシーの確認(maybeShowTermsNotice)が終わった後、
// 本当の初回だけ表示する(利用規約のバージョン更新時は再表示しない、独立した
// フラグ"hasSeenOnboarding"で管理する)。「Ashi@について」の「アプリの使い方を
// 見る」からはいつでも見返せる(その場合はhasSeenOnboardingに触れない)。
interface OnboardingSlide {
  icon: IconName;
  title: string;
  body: string;
  // エリアサイズの色見本(「投稿するには」スライドのみ)。bodyの直後・
  // bodyAfterLegendの手前に差し込む(showOnboardingSlide参照)。
  legend?: () => Node;
  // legendのさらに後に続けるテキスト(legendが無いスライドでは使わない)。
  bodyAfterLegend?: string;
}

const ONBOARDING_SLIDES: OnboardingSlide[] = [
  {
    icon: "footprints",
    title: "Ashi@とは",
    body: "Ashi@は、現実世界の場所にMisskeyノートを投稿したり、それを現地で発見できたりする、Misskeyクライアントです。\n\nAshi@で投稿するノートのことを「あしあと」といいます。",
  },
  {
    icon: "ruler",
    title: "投稿するには",
    body: "あしあとを投稿するには、位置情報をONにする必要があります。\n投稿時には、投稿エリアのサイズを選択できます。選べるエリアのサイズは次の4種類です。\n",
    legend: buildPrecisionLegend,
    bodyAfterLegend:
      "\n小さいほど、位置情報の精度が高いです。詳細な位置情報を投稿したくない場合は、サイズを大きくしましょう。",
  },
  {
    icon: "triangle-alert",
    title: "プライバシーにご注意",
    body: "位置情報は、投稿の本文に直接挿入されます。これは誰でも解読できる仕様なので、プライバシーには十分ご注意ください。",
  },
  {
    icon: "eye",
    title: "みんなの投稿を見る",
    body: "みんなの投稿はマップ上で閲覧できます。約20km・約4kmの投稿は、現地に行かなくても表示できます。\n\n約1km・約150mの投稿は、現地に行き、そのエリア内に入らないと表示されません。現地で見つけたあしあとは、「見つけたあしあと」に記録されます。",
  },
];

const onboardingDialog = $<HTMLDialogElement>("#onboardingDialog");
const onboardingTitle = $("#onboardingTitle");
const onboardingIcon = $("#onboardingIcon");
const onboardingText = $("#onboardingText");
const onboardingDots = $("#onboardingDots");
const onboardingBack = $<HTMLButtonElement>("#onboardingBack");
const onboardingNext = $<HTMLButtonElement>("#onboardingNext");

const onboardingDotButtons: HTMLButtonElement[] = ONBOARDING_SLIDES.map((_, i) => {
  const dot = document.createElement("button");
  dot.type = "button";
  dot.className = "onboarding-dot";
  dot.setAttribute("aria-label", `${i + 1}枚目`);
  dot.onclick = () => showOnboardingSlide(i);
  onboardingDots.append(dot);
  return dot;
});

let onboardingIndex = 0;

function showOnboardingSlide(index: number): void {
  onboardingIndex = index;
  const slide = ONBOARDING_SLIDES[index];
  onboardingTitle.textContent = slide.title;
  onboardingIcon.replaceChildren(createIcon(slide.icon));
  // legendが無いスライドはこれまで通りテキストのみ。ある場合は
  // 色見本(要素)を間に挟み、bodyAfterLegend(あれば)をその後ろに続ける
  // (white-space:pre-lineは子要素の混在でもテキストノードには効き続ける)。
  onboardingText.replaceChildren(
    document.createTextNode(slide.body),
    ...(slide.legend ? [slide.legend()] : []),
    ...(slide.bodyAfterLegend ? [document.createTextNode(slide.bodyAfterLegend)] : []),
  );

  onboardingDotButtons.forEach((dot, i) => dot.classList.toggle("active", i === index));
  // 1枚目は「戻る」を押せなくする(場所は確保したまま、消えて詰まって
  // 見えないようvisibilityで隠す)。
  onboardingBack.style.visibility = index === 0 ? "hidden" : "visible";
  onboardingNext.textContent = index === ONBOARDING_SLIDES.length - 1 ? "はじめる" : "次へ";
}

onboardingBack.onclick = () => showOnboardingSlide(Math.max(0, onboardingIndex - 1));
onboardingNext.onclick = () => {
  if (onboardingIndex < ONBOARDING_SLIDES.length - 1) {
    showOnboardingSlide(onboardingIndex + 1);
  } else {
    onboardingDialog.close();
  }
};
$<HTMLButtonElement>("#onboardingCloseX").onclick = () => onboardingDialog.close();
closeOnBackdropClick(onboardingDialog);

function openOnboarding(): void {
  showOnboardingSlide(0);
  onboardingDialog.showModal();
}

// 閉じ方(最後まで進めた/×で閉じた/背景クリック)に関わらず、一度開いたら
// 「見た」ことにする(closeイベント経由なら閉じ方を問わず一箇所で拾える)。
onboardingDialog.addEventListener("close", () => {
  putSetting("hasSeenOnboarding", true);
});

$("#showOnboardingIcon").append(createIcon("info"));
$<HTMLButtonElement>("#showOnboarding").onclick = () => openOnboarding();

async function maybeShowOnboarding(): Promise<void> {
  const seen = await getSetting<boolean>("hasSeenOnboarding");
  if (seen) return;
  openOnboarding();
}

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

// 「メディアの表示」「表示レイヤー」は縦に長いため、既定では折りたたんでおき、
// 必要なときだけ開く(style.css側のgrid-template-rowsの0fr/1frアニメーション)。
function wireCollapsibleToggle(toggleId: string, rowsId: string): void {
  const toggle = $<HTMLButtonElement>(`#${toggleId}`);
  const rows = $(`#${rowsId}`);
  toggle.onclick = () => {
    const willExpand = !rows.classList.contains("expanded");
    rows.classList.toggle("expanded", willExpand);
    toggle.setAttribute("aria-expanded", String(willExpand));
  };
}

// 折りたたみを展開状態にする(プログラムから、クリックせずに)。
// toggle.click()で代用すると、そのクリックイベントが祖先のdialogまで
// バブリングし、closeOnBackdropClickの「クリック座標がdialogの矩形の外なら
// 閉じる」判定に引っかかってしまう(click()が生成する合成イベントは
// clientX/clientYが0になるため、ほぼ必ず矩形の外と判定されてしまう)。
// maybeShowTermsNoticeのボタンから「Ashi@について」側のセクションを開く際に
// dialogそのものが閉じてしまっていたのはこれが原因。
function expandCollapsible(toggleId: string, rowsId: string): void {
  $<HTMLButtonElement>(`#${toggleId}`).setAttribute("aria-expanded", "true");
  $(`#${rowsId}`).classList.add("expanded");
}

// 利用規約・プライバシーポリシー・ライセンス情報等のMarkdown文書をHTMLへ変換し、
// containerへ差し込む。src/docs/以下のファイルを?rawでビルド時にJSへ直接
// 埋め込んでいる(実行時にfetchで取得するのではない)ため、ネットワーク状況に
// 関わらず必ず表示できる(「利用規約が読めないのにアプリを使用できてしまう」
// ことを避けるため)。埋め込み済みの文字列を変換するだけなので同期的に完了する。
// 内容はAshi@自身がビルド時に同梱する文書(利用者の入力等ではない)なので、
// サニタイズせずそのままinnerHTMLへ描画してよい。
function renderMarkdownDocInto(container: HTMLElement, markdown: string): void {
  container.innerHTML = marked.parse(markdown, { async: false });
  // markedはリンクにtarget/relを付けないため、タップでAshi@から離脱しない
  // よう(新しいタブで開くよう)ここで補う。
  for (const a of container.querySelectorAll("a[href]")) {
    a.setAttribute("target", "_blank");
    a.setAttribute("rel", "noopener noreferrer");
  }
}

wireCollapsibleToggle("themeToggle", "themeRows");
wireCollapsibleToggle("mediaVisibilityToggle", "mediaVisibilityRows");
wireCollapsibleToggle("mfmDisplayToggle", "mfmDisplayRows");
wireCollapsibleToggle("layerDisplayToggle", "layerDisplayRows");
wireCollapsibleToggle("popupModeToggle", "popupModeRows");
wireCollapsibleToggle("termsToggle", "termsRows");
wireCollapsibleToggle("privacyToggle", "privacyRows");
wireCollapsibleToggle("licenseToggle", "licenseRows");

// ページ読み込みの段階で(ダイアログを開く前に)埋め込み済みなので、
// 開いたときには常に表示できる状態になっている。
renderMarkdownDocInto($("#aboutIntro"), overviewMd);
renderMarkdownDocInto($("#termsContent"), termsMd);
renderMarkdownDocInto($("#privacyContent"), privacyMd);
renderMarkdownDocInto($("#licenseContent"), licenseMd);

// --- テーマ(ライト/ダーク) ---------------------------------------------
// 設定は「デバイスの設定に従う/ライト/ダーク」の3択。実際に見た目に使うのは
// 解決後の"light"/"dark"のどちらか(resolveTheme)で、<html>のdata-theme属性
// に反映するとstyle.css側の:root[data-theme="dark"]が効く。
// IndexedDB(putSetting、他の設定と同じ)には常に選択した3択そのものを保存するが、
// 次回読み込み時にCSSペイント前に反映できるよう(でないと一瞬ライトで表示されてから
// ダークに切り替わる「フラッシュ」が起きる)、同じ値をlocalStorageにも同期で
// ミラーしておき、index.html側の<head>内インラインスクリプトがそちらを
// 同期的に読んで先にdata-theme属性を付けている。
const THEME_STORAGE_KEY = "ashi-at-theme";
type ThemeMode = "system" | "light" | "dark";
let themeMode: ThemeMode = "system";

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  if (mode !== "system") return mode;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = resolveTheme(mode);
  // 陸地・境界線の色はLeafletがSVG属性として直接書き込んでいるため、CSSの
  // data-theme切り替えだけでは追従しない(map.ts参照)。ここで明示的に
  // 再着色する。
  restyleMapForTheme();
  // あしあとセル(ashiatoColor、桁数ごとの色)も同じ理由で、既に描画済みの
  // ものは自動では追従しない。表示中の全セルを再描画して反映する。
  for (const cell of ashiatoCells.values()) rebuildCellVisual(cell);
  // 表示レイヤーのchip(--chip-color、インラインstyleで一度だけ設定している)
  // も同様に明示的に再設定する。
  for (const [length, chip] of precisionFilterChipsByLength) {
    chip.style.setProperty("--chip-color", ashiatoColor(length));
  }
}

function setThemeMode(mode: ThemeMode): void {
  themeMode = mode;
  applyTheme(mode);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // localStorageが使えない(プライベートブラウジング等)環境でも、
    // putSettingによるIndexedDBへの保存やアプリの動作自体は継続する。
  }
  putSetting("themeMode", mode);
}

document.querySelectorAll<HTMLInputElement>('input[name="theme"]').forEach((el) => {
  el.onchange = () => setThemeMode(el.value as ThemeMode);
});

// OS側のテーマが起動中に切り替わった場合、設定が「デバイスの設定に従う」の
// ときだけ追従させる(ライト/ダーク固定を選んでいる間は無視)。
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (themeMode === "system") applyTheme("system");
});

document.querySelectorAll<HTMLInputElement>('input[name="mediaVisibility"]').forEach((el) => {
  el.onchange = () => {
    mediaVisibilityMode = el.value as MediaVisibilityMode;
    putSetting("mediaVisibilityMode", mediaVisibilityMode);
    // 開いたままの一覧があれば、変更を即座に反映する。
    if (unlockedListDialog.open) refreshUnlockedList();
  };
});

document.querySelectorAll<HTMLInputElement>('input[name="mfmDisplay"]').forEach((el) => {
  el.onchange = () => {
    mfmDisplayMode = el.value as MfmDisplayMode;
    putSetting("mfmDisplayMode", mfmDisplayMode);
    // 開いたままの一覧があれば、変更を即座に反映する。
    if (unlockedListDialog.open) refreshUnlockedList();
  };
});

document.querySelectorAll<HTMLInputElement>('input[name="popupMode"]').forEach((el) => {
  el.onchange = () => {
    popupMode = el.value as PopupMode;
    putSetting("popupMode", popupMode);
    // singleに切り替えた時点で複数開いていれば、最新のもの以外を閉じて
    // すぐに反映する(次に何か開くまで待たせない)。
    if (popupMode === "single" && openAshiatoPopups.size > 1) {
      const popups = [...openAshiatoPopups.values()];
      for (const popup of popups.slice(0, -1)) popup.close();
    }
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

  await pruneCache(host, TAG); // 読み込み前に期限切れ・上限超過分を掃除
  const cached = await getAshiatoRecords(host, TAG);
  // 古い順に並べておくと、ページングで足された分と混ざっても違和感がない
  cached.sort((a, b) => a.cachedAt - b.cachedAt);
  // 4桁・5桁は「見つけたあしあと」の対象外(=unlockedAtを持たない)という不変条件を
  // 常に保つ。この機能追加より前に実際にGPSで発見済みになっていたキャッシュが
  // 残っていた場合に備え、ここで矯正しておく(地図上の表示自体はunlockedAtの
  // 有無に関わらず行われるため、矯正してもそのセルが見えなくなることはない)。
  const idsToUncollect = cached
    .filter((r) => r.unlockedAt && !requiresOnSiteDiscovery(r.geohash.length))
    .map((r) => r.id);
  if (idsToUncollect.length > 0) {
    await clearCollectedAshiatoByIds(idsToUncollect);
    for (const record of cached) {
      if (idsToUncollect.includes(record.id)) {
        record.unlockedAt = null;
        record.readAt = null;
      }
    }
  }
  for (const record of cached) {
    if (!isSupportedGeohashLength(record.geohash)) continue; // 対象外の桁数は無視
    if (!isAcceptedContextId(record.contextId)) continue; // 対象外のcontextIdは無視
    addRecordToCell(record);
  }
  refreshUnlockedList();

  cursor = await getCursor(host, TAG);

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
// プレビュー文字列(MFM原文のまま)だけを例外的にレコードへ持たせる。
// MFM(Misskey Flavored Markdown)は misskey-dev/mfm.js でパースする
// (https://github.com/misskey-dev/mfm.js)。設定の「MFMの表示」により、
// 構文記号を取り除いたプレーンテキストにする(簡易表示)か、太字・拡大・
// 回転等の装飾込みでHTMLへ描画する(フル表示)かを切り替える
// (renderMfmPreview参照)。
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

// mfm-jsのAST(MfmNode[])を、containerへ実際のDOM要素として描画する
// (フル表示用)。$[x2 ...]・$[rotate.deg=45 ...]等の装飾関数(fn)は
// appendMfmFnFullで名前ごとにCSSクラス/インラインstyleへ変換する。
// 未対応のノード種別・fn名は、装飾を諦めて子ノードだけをそのまま描画する
// (mfmNodeToPlainTextの「装飾記号を落として連結する」フォールバックと同じ考え方)。
function appendMfmNodeFull(
  container: HTMLElement,
  node: MfmNode,
  emojiHost: string,
  onEmojiSettled?: () => void,
): void {
  switch (node.type) {
    case "text":
      container.append(document.createTextNode(node.props.text));
      return;
    case "unicodeEmoji":
      container.append(document.createTextNode(node.props.emoji));
      return;
    case "emojiCode":
      appendEmojiImage(container, node.props.name, emojiHost, onEmojiSettled);
      return;
    case "mention": {
      const span = document.createElement("span");
      span.className = "mfm-mention";
      span.textContent = node.props.acct ? `@${node.props.acct}` : `@${node.props.username}`;
      container.append(span);
      return;
    }
    case "hashtag": {
      const span = document.createElement("span");
      span.className = "mfm-hashtag";
      span.textContent = `#${node.props.hashtag}`;
      container.append(span);
      return;
    }
    case "url": {
      const a = document.createElement("a");
      a.className = "mfm-link";
      a.href = node.props.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = node.props.url;
      container.append(a);
      return;
    }
    case "link": {
      const a = document.createElement("a");
      a.className = "mfm-link";
      a.href = node.props.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      appendMfmNodesFull(a, node.children, emojiHost, onEmojiSettled);
      container.append(a);
      return;
    }
    case "inlineCode": {
      const code = document.createElement("code");
      code.className = "mfm-code";
      code.textContent = node.props.code;
      container.append(code);
      return;
    }
    case "blockCode": {
      const pre = document.createElement("pre");
      pre.className = "mfm-code-block";
      const code = document.createElement("code");
      code.textContent = node.props.code;
      pre.append(code);
      container.append(pre);
      return;
    }
    case "mathInline":
    case "mathBlock": {
      // KaTeX等の数式レンダラは導入していないため、数式ソースをそのまま
      // コード風に表示するだけに留める。
      const code = document.createElement("code");
      code.className = "mfm-math";
      code.textContent = node.props.formula;
      container.append(code);
      return;
    }
    case "search": {
      const span = document.createElement("span");
      span.className = "mfm-search";
      span.textContent = node.props.content;
      container.append(span);
      return;
    }
    case "quote": {
      const bq = document.createElement("blockquote");
      bq.className = "mfm-quote";
      appendMfmNodesFull(bq, node.children, emojiHost, onEmojiSettled);
      container.append(bq);
      return;
    }
    case "center": {
      const div = document.createElement("div");
      div.className = "mfm-center";
      appendMfmNodesFull(div, node.children, emojiHost, onEmojiSettled);
      container.append(div);
      return;
    }
    case "bold": {
      const b = document.createElement("b");
      appendMfmNodesFull(b, node.children, emojiHost, onEmojiSettled);
      container.append(b);
      return;
    }
    case "italic": {
      const i = document.createElement("i");
      appendMfmNodesFull(i, node.children, emojiHost, onEmojiSettled);
      container.append(i);
      return;
    }
    case "strike": {
      const s = document.createElement("s");
      appendMfmNodesFull(s, node.children, emojiHost, onEmojiSettled);
      container.append(s);
      return;
    }
    case "small": {
      const small = document.createElement("small");
      appendMfmNodesFull(small, node.children, emojiHost, onEmojiSettled);
      container.append(small);
      return;
    }
    case "plain": {
      for (const child of node.children) container.append(document.createTextNode(child.props.text));
      return;
    }
    case "fn":
      appendMfmFnFull(container, node, emojiHost, onEmojiSettled);
      return;
    default: {
      // 将来ノード種別が増えた場合のフォールバック。子があれば装飾なしで連結する。
      const maybeParent = node as { children?: MfmNode[] };
      if (Array.isArray(maybeParent.children)) {
        appendMfmNodesFull(container, maybeParent.children, emojiHost, onEmojiSettled);
      }
    }
  }
}

function appendMfmNodesFull(
  container: HTMLElement,
  nodes: MfmNode[],
  emojiHost: string,
  onEmojiSettled?: () => void,
): void {
  for (const node of nodes) appendMfmNodeFull(container, node, emojiHost, onEmojiSettled);
}

// MFMの色指定引数(例: "f00"、"ff0000")の先頭に#を補う。既に#や
// rgb()等のCSS色関数っぽい記法ならそのまま使う(念のための保険)。
function normalizeMfmColorArg(value: string | true | undefined): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (value.startsWith("#") || /[a-z]{3,}\(/i.test(value)) return value;
  return /^[0-9a-fA-F]{3,8}$/.test(value) ? `#${value}` : value;
}

// speed引数(例: "5s"、"200ms")がCSSのtime値として妥当な形式かだけ検証する。
// 不正な値をそのままstyle.animationDurationへ入れると他の宣言ごと無視される
// ことがあるため、通さない。
function isValidCssTime(value: string): boolean {
  return /^[0-9]*\.?[0-9]+(ms|s)$/.test(value);
}

// $[name.arg1=val1,arg2 ...]形式の装飾関数(fn)を解釈し、対応するCSSクラス/
// インラインstyleを付けたspanで子ノードを包む。Misskeyの主要なMFM関数の
// うち、よく使われるものを一通りカバーする(sparkle・ruby・unixtimeのような
// 実装コストの高い/稀なものは非対応とし、装飾なしでフォールバックする)。
function appendMfmFnFull(
  container: HTMLElement,
  node: MfmFn,
  emojiHost: string,
  onEmojiSettled?: () => void,
): void {
  const { name, args } = node.props;
  const span = document.createElement("span");
  span.className = "mfm-fn";

  const ANIMATION_CLASS_BY_NAME: Record<string, string> = {
    jelly: "mfm-fn-jelly",
    tada: "mfm-fn-tada",
    jump: "mfm-fn-jump",
    bounce: "mfm-fn-bounce",
    shake: "mfm-fn-shake",
    twitch: "mfm-fn-twitch",
    rainbow: "mfm-fn-rainbow",
  };
  const FONT_FAMILY_BY_NAME: Record<string, string> = {
    serif: "serif",
    monospace: "monospace",
    cursive: "cursive",
    fantasy: "fantasy",
  };

  switch (name) {
    case "x2":
    case "x3":
    case "x4":
      span.classList.add(`mfm-fn-${name}`);
      break;
    case "blur":
      span.classList.add("mfm-fn-blur");
      break;
    case "flip": {
      const horizontal = !("v" in args) || "h" in args;
      const vertical = "v" in args;
      span.style.display = "inline-block";
      span.style.transform = `scale(${horizontal ? -1 : 1}, ${vertical ? -1 : 1})`;
      break;
    }
    case "rotate": {
      const deg = Number(args.deg ?? 90);
      span.style.display = "inline-block";
      span.style.transform = `rotate(${Number.isFinite(deg) ? deg : 90}deg)`;
      break;
    }
    case "position": {
      const x = Number(args.x ?? 0);
      const y = Number(args.y ?? 0);
      span.style.display = "inline-block";
      span.style.transform = `translate(${Number.isFinite(x) ? x : 0}em, ${Number.isFinite(y) ? y : 0}em)`;
      break;
    }
    case "scale": {
      const x = Number(args.x ?? 1);
      const y = Number(args.y ?? 1);
      span.style.display = "inline-block";
      span.style.transform = `scale(${Number.isFinite(x) ? x : 1}, ${Number.isFinite(y) ? y : 1})`;
      break;
    }
    case "fg": {
      const color = normalizeMfmColorArg(args.color);
      if (color) span.style.color = color;
      break;
    }
    case "bg": {
      const color = normalizeMfmColorArg(args.color);
      if (color) span.style.backgroundColor = color;
      break;
    }
    case "border": {
      const width = Number(args.width ?? 1);
      const style = typeof args.style === "string" ? args.style : "solid";
      const color = normalizeMfmColorArg(args.color) ?? "currentColor";
      const radius = Number(args.radius ?? 0);
      span.style.display = "inline-block";
      span.style.border = `${Number.isFinite(width) ? width : 1}px ${style} ${color}`;
      if (Number.isFinite(radius) && radius > 0) span.style.borderRadius = `${radius}px`;
      break;
    }
    case "font": {
      const key = Object.keys(FONT_FAMILY_BY_NAME).find((k) => k in args);
      if (key) span.style.fontFamily = FONT_FAMILY_BY_NAME[key];
      break;
    }
    case "spin": {
      span.classList.add(
        "v" in args ? "mfm-fn-spin-y" : "x" in args ? "mfm-fn-spin-x" : "mfm-fn-spin",
      );
      if ("alternate" in args) span.style.animationDirection = "alternate";
      else if ("left" in args) span.style.animationDirection = "reverse";
      break;
    }
    default: {
      const cls = ANIMATION_CLASS_BY_NAME[name];
      if (cls) span.classList.add(cls);
      // 未対応(sparkle/ruby/unixtime等)はここでは何もせず、下で子ノードだけ
      // 装飾なしで描画する。
    }
  }

  // アニメーション系はspeed引数(例: "5s")で周期を上書きできる。
  if (typeof args.speed === "string" && isValidCssTime(args.speed)) {
    span.style.animationDuration = args.speed;
  }

  appendMfmNodesFull(span, node.children, emojiHost, onEmojiSettled);
  container.append(span);
}

// 設定(mfmDisplayMode)に応じて、source(MFM原文)をプレビュー用にcontainerへ
// 描画する。simple: 装飾記号を取り除いたプレーンテキストにする(従来通り)。
// full: 太字・拡大・回転等の装飾込みでHTML要素へ描画する(appendMfmNodeFull)。
// どちらのモードでもカスタム絵文字(:name:)はappendEmojiImageで画像に
// 差し替える。onEmojiSettledは画像挿入で高さが変わりうるタイミングで呼ばれ、
// 呼び出し側は「続きを表示」ヒントの表示要否を再計算するのに使う。
function renderMfmPreview(
  container: HTMLElement,
  source: string,
  emojiHost: string,
  onEmojiSettled?: () => void,
): void {
  let nodes: MfmNode[];
  try {
    nodes = parseMfm(source);
  } catch (error) {
    console.warn("main: MFM解析に失敗。プレーンテキストのまま表示します:", error);
    appendTextWithEmojis(container, source, emojiHost, onEmojiSettled);
    return;
  }

  if (mfmDisplayMode === "full") {
    appendMfmNodesFull(container, nodes, emojiHost, onEmojiSettled);
    return;
  }

  // 簡易表示: プレーンテキスト化した上で、改行以外の空白は1つに正規化しつつ
  // 改行自体は残す(.mfm-previewはwhite-space:pre-line)。3行以上連続する
  // 空行はさすがに詰める(以前のextractPreviewTextと同じ正規化)。
  const plain = mfmNodesToPlainText(nodes)
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  appendTextWithEmojis(container, plain, emojiHost, onEmojiSettled);
}

// ノート本文からAshiato Syntax候補(⟦...⟧)を取り除いた上で、MFM原文のまま
// (装飾情報を保持したまま)保存する。表示側(renderMfmPreview)が設定
// (mfmDisplayMode)に応じて、フル装飾で描画するかプレーンテキスト化して
// 描画するかをその都度切り替える。
// 表示上の省略はCSSでの高さクリップで行うため、ここではTEXT_PREVIEW_SAFETY_
// CAP_LENGTHを超える極端なケースの安全弁としてのみ切り詰める(文字数で機械的に
// 切るとMFM記法の途中で千切れることがあるが、mfm-jsは閉じていない記法を素の
// テキストへフォールバックするパーサのため、描画自体が壊れることは無い)。
// 残りが空文字列になった場合はnull(プレビュー無し)を返す。
function extractPreviewSource(noteText: string): string | null {
  let stripped = noteText;
  for (const candidate of extractCandidates(noteText)) {
    stripped = stripped.split(candidate).join("");
  }
  stripped = stripped.trim();
  if (!stripped) return null;

  const chars = [...stripped];
  return chars.length > TEXT_PREVIEW_SAFETY_CAP_LENGTH
    ? chars.slice(0, TEXT_PREVIEW_SAFETY_CAP_LENGTH).join("") + "…"
    : stripped;
}

async function ingestNotes(host: string, notes: MisskeyNote[]): Promise<AshiatoRecord[]> {
  const records: AshiatoRecord[] = [];

  for (const note of notes) {
    // 削除済みノート、本文が無いノートは対象外
    if (!note?.text || note.deletedAt) continue;

    const preview = extractPreviewSource(note.text);
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
      if (isSupportedGeohashLength(r.model.geohash) && isAcceptedContextId(r.model.contextId)) {
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
  for (const record of records) addRecordToCell(record);

  // 「過去を探す」「最新を確認」でセルが新しく増えた場合、GPSが既にONで
  // その場から動いていない(=watchPositionが発火しない)状況でも、現在地がその
  // 新セル内に入っていれば即座に発見扱いにする。
  if (gpsEnabled) await checkCurrentPositionAgainstCells();

  return records;
}

// 検索結果内での最新/最古のノートIDを求める。Misskeyのnotes/search-by-tagは
// untilId指定時は新しい順、sinceId指定時は古い順で返ってくる(取りこぼし無く
// ページングできるようにするための仕様)ため、配列の並び順(notes[0]が最新か
// 最古か)は呼び出し方によって変わってしまう。これは仕様として保証された
// 契約ではなく、実装が変わる/インスタンスによって異なる可能性も否定できない
// ため、並び順を信用せず、ID文字列を比較して求める(Misskeyのid形式は
// aid/aidx/ulid/objectid/meidのいずれも生成時刻順にソート可能な文字列)。
function newestAndOldestId(notes: MisskeyNote[]): { newestId: string; oldestId: string } {
  let newestId = notes[0].id;
  let oldestId = notes[0].id;
  for (const note of notes) {
    if (note.id > newestId) newestId = note.id;
    if (note.id < oldestId) oldestId = note.id;
  }
  return { newestId, oldestId };
}

// 過去方向(untilId): 「過去を探す」(初回・2回目以降とも同じボタン)
async function fetchOlder(): Promise<void> {
  const btn = $<HTMLButtonElement>("#search");
  btn.disabled = true;

  try {
    const host = await ensureHost();
    setStatus(`${stripProtocol(host)}から検索中…`);

    const notes = await searchNotesByTag(host, TAG, {
      limit: PAGE_SIZE,
      untilId: cursor?.oldestSeenNoteId,
    });

    // 検索中にインスタンスが切り替えられていたら、この結果は今のcurrentHostの
    // ものではないので破棄する(取り込むとホストをまたいでセル/cursorが混線する)。
    if (host !== currentHost) return;

    const records = await ingestNotes(host, notes);

    if (notes.length > 0) {
      const { newestId: batchNewestId, oldestId } = newestAndOldestId(notes);
      const newestId = cursor?.newestSeenNoteId ?? batchNewestId;
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

      // 件数はnotes.length(#タグが付いた生のノート数)ではなく、実際に
      // ASHIATO_CONTEXT_ID(+対応桁数)に合致してレコード化できた件数(records.length)を
      // 表示する。タグは付いているがAshiato Syntaxとして無効なノートも
      // 混ざりうるため、notes.lengthのままだと実態と合わない件数になる。
      setStatus(oldestLabel ? `${oldestLabel}まで探しました` : `${records.length}件のAshiatoを検索しました`);
    } else {
      setStatus("これより古いAshiatoは見つかりませんでした");
    }
  } catch (e) {
    console.error(e);
    setStatus((e as Error).message || "検索に失敗しました", true);
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

  try {
    const host = await ensureHost();
    setStatus(`${stripProtocol(host)}から検索中…(最新)`);
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

    const records = await ingestNotes(host, notes);

    if (notes.length > 0) {
      const { newestId, oldestId } = newestAndOldestId(notes);
      // 中抜け対策: 今回取得したバッチの最古ノートで oldestSeenNoteId も進めておく。
      // これにより「過去を探す」の起点が必ずこのバッチの範囲を通過するようになり、
      // fetchNewer の limit 上限で取りこぼした区間が永久に未取得のまま残ることを防ぐ。
      // (直前に fetchOlder で取得済みの範囲を再要求することになる場合があるが、
      //  host::noteId::index で重複排除されるので実害はない)
      cursor = { hostTag: `${host}::${TAG}`, host, tag: TAG, newestSeenNoteId: newestId, oldestSeenNoteId: oldestId };
      await putCursor(host, TAG, cursor);
    }

    // 件数はnotes.length(#タグが付いた生のノート数)ではなく、実際に
    // ASHIATO_CONTEXT_ID(+対応桁数)に合致してレコード化できた件数(records.length)を
    // 表示する。タグは付いているがAshiato Syntaxとして無効なノートも
    // 混ざりうるため、notes.lengthのままだと実態と合わない件数になる
    // (「新しいあしあとはありませんでした」の分岐だけはnotes.length基準のままにし、
    // タグ付き投稿自体が無かった場合の文言と区別する)。
    setStatus(
      notes.length > 0
        ? `${records.length}件の新しいあしあとを検索しました`
        : "新しいあしあとはありませんでした",
    );
  } catch (e) {
    console.error(e);
    setStatus((e as Error).message || "検索に失敗しました", true);
  } finally {
    btn.disabled = false;
  }
}

// 「マップ上のタイムラインをクリア」。まだ発見していない(unlockedAtが無い)レコードと
// カーソルだけを消す。「見つけたあしあと」(発見済み)は地図上にもそのまま残す。
async function handleClearSearchCache(): Promise<void> {
  await clearSearchCache();

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

  cursor = null;
  setStatus("マップ上のタイムラインをクリアしました");
}

$<HTMLButtonElement>("#search").onclick = fetchOlder;
$<HTMLButtonElement>("#loadNewer").onclick = fetchNewer;
$<HTMLButtonElement>("#toggleGps").onclick = () => setGpsEnabled(!gpsEnabled);
$<HTMLButtonElement>("#clearSearchCache").onclick = async () => {
  const clearSearchCacheWarning = document.createElement("div");
  renderMarkdownDocInto(clearSearchCacheWarning, clearSearchCacheConfirmMd);
  const wantsToClear = await showConfirm(clearSearchCacheWarning, {
    okLabel: "削除する",
    danger: true,
  });
  if (!wantsToClear) return;
  await handleClearSearchCache();
};

// 「リセット」: 見つけたあしあと・検索キャッシュ・下書き・設定(インスタンスURL等)を
// 含む全キャッシュを削除する(cache.jsのresetAllCacheがIndexedDBごと削除する)。
// 削除後はアプリの状態(ashiatoCells等の変数)も含めて丸ごと作り直すのが確実なため、
// 個別に状態をクリアするのではなくページをリロードする。
$<HTMLButtonElement>("#resetAll").onclick = async () => {
  const resetWarning = document.createElement("div");
  renderMarkdownDocInto(resetWarning, resetConfirmMd);
  const wantsToReset = await showConfirm(resetWarning, { okLabel: "削除する", danger: true });
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
const composePrecisionNote = $("#composePrecisionNote");
const composeMemoInput = $<HTMLTextAreaElement>("#composeMemo");
const draftListDialog = $<HTMLDialogElement>("#draftListDialog");
enableSheetDragResize(draftListDialog);
const draftList = $("#draftList");

let composePosition: { lat: number; lon: number } | null = null; // 投稿UI表示中のみ有効

function selectedPrecision(): GeohashLength {
  return Number(
    document.querySelector<HTMLInputElement>('input[name="precision"]:checked')!.value,
  ) as GeohashLength;
}

// 精度に応じた遅延(DRAFT_POST_DELAY_MS_BY_LENGTH)が0より大きい場合、下書き保存から
// その時間が経つまで投稿不可(下書きの精度をあとから変更しても、常にこの条件で
// 都度再評価する)。
function isDraftPostable(draft: Draft): boolean {
  const delayMs = DRAFT_POST_DELAY_MS_BY_LENGTH[draft.geohashLength];
  return Date.now() - draft.createdAt >= delayMs;
}

function updateComposeButtons(): void {
  const requiresDraftDelay = DRAFT_POST_DELAY_MS_BY_LENGTH[selectedPrecision()] > 0;
  const precisionBad = isPrecisionBad();

  $<HTMLButtonElement>("#composePost").disabled = requiresDraftDelay || precisionBad;
  $<HTMLButtonElement>("#composeSaveDraft").disabled = precisionBad;

  composePrecisionNote.hidden = !requiresDraftDelay && !precisionBad;
  if (precisionBad) {
    composePrecisionNote.textContent =
      "現在地の精度が低いため、新規投稿・下書きの保存はできません。精度が改善してからお試しください。";
  } else if (requiresDraftDelay) {
    const delayMin = DRAFT_POST_DELAY_MS_BY_LENGTH[selectedPrecision()] / 60000;
    composePrecisionNote.textContent = `この精度はプライバシー保護のため直接投稿できません。いったん下書きに保存し、${delayMin}分経過後に投稿してください。`;
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
  // GPSがOFFの間はボタンをあえて無効化していない(updateComposeAvailability参照)
  // ため、ここで案内を出す。
  if (!gpsEnabled) {
    setStatus("現在地をONにしてください", true);
    return;
  }
  // ボタン自体を無効化済み(updateComposeAvailability参照。GPS ON かつ
  // 現在地取得済みでないと押せない)だが、念のため。
  if (!lastKnownPosition || isPrecisionBad()) return;

  composePosition = { ...lastKnownPosition };
  composeMemoInput.value = ""; // 前回開いたときの入力を持ち越さない
  updateComposeButtons();
  composeDialog.show(); // 非モーダル: マップ操作(ドラッグ/ズーム/エリアトグル等)を妨げない
  updateComposePreview();
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
// 自由記述コメントはAshi@側では持たない(共有フォーム側で書けるため)が、
// 下書きの「メモを本文に挿入」がONの場合だけ、memoを機械可読部分の上に
// 添える(⟦...⟧の候補文字列はextractCandidatesがテキスト中のどこにあっても
// 拾えるため、前に自由文を足しても解析に影響しない)。
function shareTextFor(
  lat: number,
  lon: number,
  geohashLength: GeohashLength,
  memo?: string,
): string {
  const geohash = encodeGeohash(lat, lon, geohashLength);
  const base = `${buildMinimalCandidate(geohash, ASHIATO_CONTEXT_ID)} #Ashiato`;
  return memo ? `${memo}\n${base}` : base;
}

$<HTMLButtonElement>("#composePost").onclick = async () => {
  if (!composePosition) return;

  const composeWarning = document.createElement("div");
  renderMarkdownDocInto(composeWarning, composeWarningMd);
  const wantsToPost = await showConfirm(
    composeWarning,
    { okLabel: "理解して進む" },
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

  await putDraft(makeDraft(lat, lon, geohashLength, municipalityLabel, composeMemoInput.value.trim()));
  await refreshDraftBadge();
  composeDialog.close();
  setStatus("下書きに保存しました");
};

// --- 下書きリスト(ダイアログ) ------------------------------------------

// 下書きの総数を、メールの受信トレイのような件数バッジとしてハンバーガー
// メニュー内「下書き」項目に出す(既読/未読の概念は無いので、常に総数を出す)。
function setDraftBadgeCount(count: number): void {
  draftBadge.hidden = count === 0;
  draftBadge.textContent = String(count);
}

// 下書きリストのダイアログを開いていないとき(投稿UIから直接保存した場合等)にも
// バッジだけ更新したいケース向けの軽量版。
async function refreshDraftBadge(): Promise<void> {
  setDraftBadgeCount((await getDrafts()).length);
}

// 「投稿する」ボタンの残り時間表示だけを、リスト全体を作り直さずに更新する
// ためのコールバック一覧(下のsetIntervalから毎秒呼ぶ)。refreshDraftListが
// 呼ばれるたびに(=行を作り直すたびに)ここを空にしてから積み直す。
let draftPostButtonRenderers: (() => void)[] = [];

async function refreshDraftList(): Promise<void> {
  const drafts = await getDrafts();
  setDraftBadgeCount(drafts.length);
  draftList.replaceChildren();
  draftPostButtonRenderers = [];

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
    // 場所をタップすると、下書き一覧を閉じてその場所を地図上に表示する。
    // <button>にすることでキーボード操作・スクリーンリーダーでも扱える。
    const headerMain = document.createElement("button");
    headerMain.type = "button";
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
    headerMain.onclick = () => {
      draftListDialog.close();
      // 投稿UI(composeDialog)と同じ紫のセルプレビューを使って場所を示す
      // (下書きはまだ投稿されていないため、実際のあしあと吹き出しは無い)。
      // 地図を次に操作した時点で消す(ずっと残り続けないように)。
      const hash = precisionPreview.show(draft.lat, draft.lon, draft.geohashLength);
      const b = decodeGeohash(hash);
      map.fitBounds(
        [
          [b.minLat, b.minLon],
          [b.maxLat, b.maxLon],
        ],
        { maxZoom: 18, padding: [40, 40] },
      );
      map.once("click", () => precisionPreview.hide());
    };

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "draft-delete-btn";
    deleteBtn.setAttribute("aria-label", "削除");
    deleteBtn.append(createIcon("trash-2"));
    header.append(headerMain, deleteBtn);

    // メモ(「どこで投稿しようとしたか」等の覚え書き)。入力のたびに
    // 少し待ってから保存する(このリストは60秒ごとに全体を再描画するため
    // (下の setInterval 参照)、キー入力のたびに保存しておかないと、
    // 保存前に再描画されて入力中の内容が消えてしまう)。
    const memoRow = document.createElement("div");
    memoRow.className = "draft-memo-row";
    const memoIcon = document.createElement("span");
    memoIcon.className = "action-sheet-icon";
    memoIcon.append(createIcon("pencil-line"));
    const memoInput = document.createElement("textarea");
    memoInput.className = "draft-memo-input";
    memoInput.rows = 2;
    memoInput.placeholder = "メモ";
    memoInput.value = draft.memo;
    memoInput.setAttribute("aria-label", "メモ");
    let memoSaveTimer: ReturnType<typeof setTimeout> | undefined;
    memoInput.oninput = () => {
      clearTimeout(memoSaveTimer);
      const value = memoInput.value;
      memoSaveTimer = setTimeout(() => {
        draft.memo = value;
        updateDraftMemo(draft.id, value);
      }, 400);
    };
    memoRow.append(memoIcon, memoInput);

    // 「メモを本文に挿入」。メモは元々「自分用の覚え書き」であり投稿内容では
    // ないため、既定はOFFで下書きごとに明示的に選んでもらう(設定でON/OFFを
    // 一括にすると、投稿するつもりのなかったメモまで混ざる恐れがあるため)。
    const insertMemoLabel = document.createElement("label");
    insertMemoLabel.className = "draft-memo-insert";
    const insertMemoCheckbox = document.createElement("input");
    insertMemoCheckbox.type = "checkbox";
    insertMemoCheckbox.checked = draft.insertMemoIntoPost;
    insertMemoCheckbox.onchange = () => {
      draft.insertMemoIntoPost = insertMemoCheckbox.checked;
      updateDraftInsertMemoIntoPost(draft.id, insertMemoCheckbox.checked);
    };
    insertMemoLabel.append(insertMemoCheckbox, document.createTextNode("メモを本文に挿入"));

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

    // 残り時間は、下の draftPostButtonRenderers 経由で毎秒呼び直される
    // (リスト全体は作り直さず、このボタンの表示だけをその都度更新する)。
    // 表示は分単位なので、実際に文字列が変わるのは60回に1回だけ。
    // textContentへの代入は値が同じでも子ノードを作り直すコストがかかる
    // (postableになった後は永久に変化しない)ため、前回と同じ文字列なら
    // 書き込みそのものをスキップする。
    let lastPostButtonLabel: string | null = null;
    function renderPostButton() {
      const postable = isDraftPostable(draft);
      postBtn.disabled = !postable;
      const label = postable
        ? "投稿する"
        : `あと${Math.max(
            1,
            Math.ceil(
              (DRAFT_POST_DELAY_MS_BY_LENGTH[draft.geohashLength] - (Date.now() - draft.createdAt)) /
                60000,
            ),
          )}分`;
      if (label !== lastPostButtonLabel) {
        postBtn.textContent = label;
        lastPostButtonLabel = label;
      }
    }
    renderPostButton();
    draftPostButtonRenderers.push(renderPostButton);

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
      // 「あしあとを投稿」の#composePostと同じ内容の確認にする(投稿前の注意.md)。
      const draftPostWarning = document.createElement("div");
      renderMarkdownDocInto(draftPostWarning, composeWarningMd);
      const wantsToPost = await showConfirm(draftPostWarning, { okLabel: "理解して進む" });
      if (!wantsToPost) return;

      const text = shareTextFor(
        draft.lat,
        draft.lon,
        draft.geohashLength,
        draft.insertMemoIntoPost ? draft.memo.trim() : undefined,
      );
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
    li.append(header, insertMemoLabel, memoRow, footer);
    draftList.append(li);
  }
}

// 遅延経過による投稿可否の変化(6桁=約1km/7桁=約150mの「あとN分」表示・
// 「投稿する」への切り替わり)を、リストを開いたまま待っていてもリアルタイムに
// 反映されるようにする。リスト全体(draftList.replaceChildren)は作り直さず、
// 各行のボタン表示だけを毎秒更新することで、メモ入力欄にフォーカス中でも
// 打鍵の邪魔をしない。
setInterval(() => {
  if (!draftListDialog.open) return;
  for (const render of draftPostButtonRenderers) render();
}, 1000);

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
    maybeShowTermsNotice().then(() => maybeShowOnboarding());
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

    // 見た目自体(data-theme属性)はindex.html側のインラインスクリプトが
    // localStorageを読んで既に反映済み(フラッシュ防止)。ここではIndexedDB側の
    // 値を正として設定UIのラジオ選択を合わせ、両者がズレていた場合(例:
    // 初回のこの機能追加より前からlocalStorageに値が無い状態でIndexedDBだけ
    // 値がある、という状況は通常起きないが念のため)はapplyThemeで再適用する。
    const savedTheme = await getSetting<ThemeMode>("themeMode");
    if (savedTheme === "system" || savedTheme === "light" || savedTheme === "dark") {
      themeMode = savedTheme;
      const radio = document.querySelector<HTMLInputElement>(
        `input[name="theme"][value="${savedTheme}"]`,
      );
      if (radio) radio.checked = true;
      applyTheme(savedTheme);
    }

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

    const savedMfmDisplay = await getSetting<MfmDisplayMode>("mfmDisplayMode");
    if (savedMfmDisplay === "simple" || savedMfmDisplay === "full") {
      mfmDisplayMode = savedMfmDisplay;
      const radio = document.querySelector<HTMLInputElement>(
        `input[name="mfmDisplay"][value="${savedMfmDisplay}"]`,
      );
      if (radio) radio.checked = true;
    }

    const savedPopupMode = await getSetting<PopupMode>("popupMode");
    if (savedPopupMode === "multiple" || savedPopupMode === "single") {
      popupMode = savedPopupMode;
      const radio = document.querySelector<HTMLInputElement>(
        `input[name="popupMode"][value="${savedPopupMode}"]`,
      );
      if (radio) radio.checked = true;
    }

    const savedAutoEnableLayer = await getSetting<boolean>("autoEnableLayerOnDiscoveryEnabled");
    if (typeof savedAutoEnableLayer === "boolean") {
      autoEnableLayerOnDiscoveryEnabled = savedAutoEnableLayer;
      autoEnableLayerOnDiscoveryCheckbox.checked = savedAutoEnableLayer;
    }

    const savedMapView = await getSetting<{ lat: number; lon: number; zoom: number }>("mapView");
    if (savedMapView) {
      map.setView([savedMapView.lat, savedMapView.lon], savedMapView.zoom, {
        animate: false,
      });
    }

    await refreshDraftBadge();

    const restoredCount = await switchHost(
      normalizeInstanceUrl($<HTMLInputElement>("#instance").value),
    );
    if (restoredCount === 0) fetchOlder();
  } catch (error) {
    console.error(error);
    setStatus("キャッシュの読み込みに失敗しました", true);
  }
})();
