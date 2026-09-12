// アプリ全体の「調整用の値」をまとめたファイル。
// ここに置くのは、値を変えるだけで見た目・挙動が完結して調整できる定数
// (デバッグフラグ・色・太さ・遅延時間・しきい値等)だけにしている。
// 地図のペインのz-index(重なり順)のように、周囲のコード・コメントと
// セットで読まないと意味が分からない値はあえてここに移さず、元の場所
// (map.tsのcreateMap内)に残している。
import type { GeohashLength } from "./types.js";

// --- デバッグ用フラグ ------------------------------------------------------

// trueにすると、未発見(ロック中)のAshiatoも地図に表示する。
// GPSによる発見判定や「集めたあしあと」一覧の仕様は変えない。本番ではfalse。
export const SHOW_LOCKED_ASHIATO_FOR_DEBUG = false;

// trueにすると、テスト用の文脈識別子(c;test)を持つ候補も表示対象に含める。
// 本番ではfalse。
export const SHOW_TEST_CONTEXT_ASHIATO_FOR_DEBUG = true;

// --- キャッシュ(IndexedDB) --------------------------------------------------

// 通常のキャッシュ(未発見のAshiato)の保存期限。これを過ぎたレコードは
// getAshiatoRecordsで読み込まれなくなり、pruneCacheで削除される。
// 発見済み(unlockedAtあり)のAshiatoにはTTLを設けない。「達成の記録」なので、
// ユーザーが「リセット」等で明示的に削除しない限り永続させる(cache.ts参照)。
export const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90日

// host::tagごとに保持する未発見レコードの上限件数。超過分は古い順に間引く
// (発見済みレコードはこの上限の対象外。cache.ts: pruneCache参照)。
export const MAX_RECORDS_PER_HOST_TAG = 1000;

// --- Ashiato Syntax・検索まわり ---------------------------------------------

// 検索対象の固定タグ。将来複数タグに対応するなら cache.js のhostTagキーは
// そのまま使い回せる。
export const TAG = "Ashiato";

// 検索1ページあたりの取得件数。
export const PAGE_SIZE = 30;

// Ashiato Syntaxの"c"(contextId)。Ashi@が扱う候補として受け入れる文脈識別子。
// これ以外のcを持つ候補(他アプリ・他運用が同じ#Ashiatoタグ・構文を使っている
// ケース等)は無視する(SHOW_TEST_CONTEXT_ASHIATO_FOR_DEBUGがtrueの間は
// "test"も例外的に受け入れる)。
export const ASHIATO_CONTEXT_ID = "asat";

// Ashi@で扱うgeohashの桁数(精度)。これ以外の精度の「あしあと」は対象外として
// 無視する(地図表示にも「見つけたあしあと」にも一切出さない)。
export const MIN_GEOHASH_LENGTH = 4;
export const MAX_GEOHASH_LENGTH = 7;

// 投稿UIの「投稿エリアサイズ」の選択肢に出す表示ラベル。
export const PRECISION_LABELS: Record<GeohashLength, string> = {
  4: "約20km",
  5: "約4km",
  6: "約1km",
  7: "約150m",
};

// 投稿機能: geohashの桁数(判定エリアの狭さ)に応じて、下書き保存から投稿できる
// ようになるまでの遅延時間を設ける(プライバシー配慮。投稿者の現在地が即座に
// 特定されないようにするため)。桁数が細かい(=判定エリアが狭い)ほど投稿者の
// 居場所が絞り込まれやすいため、4桁(約20km)・5桁(約4km)は遅延なし(直接投稿可)、
// 6桁(約1km)は下書き保存から20分、7桁(約150m)は40分経過するまで投稿できない
// ようにする(isDraftPostable/updateComposeButtonsの両方でこの定数を参照すること)。
export const DRAFT_POST_DELAY_MS_BY_LENGTH: Record<GeohashLength, number> = {
  4: 0,
  5: 0,
  6: 20 * 60 * 1000, // 20分
  7: 40 * 60 * 1000, // 40分
};

// Ashiato Syntaxの時間条件(d/w/t/o等)は位置が変わらなくても時刻の経過だけで
// Active/Inactiveが切り替わりうるため、位置情報の更新を待たずにこの間隔で
// 定期的に再評価する(main.ts: reevaluateActiveConditions参照)。
export const PENDING_PROMOTION_INTERVAL_MS = 60 * 1000; // 1分ごとに再チェック

// 「見つけたあしあと」一覧・ポップアップに表示する本文プレビューの
// 安全弁としての最大文字数。表示上の省略はCSS(.mfm-preview)での高さクリップ
// +「続きを表示」ヒントで行うため、通常はここで切り詰められることはない
// (Misskeyの標準的な投稿文字数上限を大きく超えるような極端なケースにのみ働く、
// 文字数で機械的に切ると:name:のようなMFM記法の途中で千切れる恐れがあるため)。
export const TEXT_PREVIEW_SAFETY_CAP_LENGTH = 3000;

// 位置精度がこの半径(メートル)を超えたら「精度が悪い」とみなす。
// この状態では、あしあとの発見(当たり判定)・新規投稿・新規下書きを行わない
// (下書き済みのあしあとの投稿はisDraftPostableのルールのみに従い、ここでは制限しない)。
export const BAD_ACCURACY_RADIUS_M = 500;

// --- 地図の色・線の太さ -----------------------------------------------------

// 陸地の塗りつぶし色。海は#mapのCSS背景色(style.css)で表現しているので、
// ここでは都道府県ポリゴンの塗りつぶしだけを指定する。
export const LAND_FILL_COLOR = "#F7F2EC";

// 都道府県境界線の一点鎖線(長い破線, 隙間, 点, 隙間 の繰り返し)。
// 「点」はlineCap:'round'(Path options既定値)により短い線分が丸い点として描画される。
export const PREFECTURE_DASH_ARRAY = "10,4,1,4";
// 都道府県境界線の色・太さ。
export const PREFECTURE_BOUNDARY_COLOR = "#707070";
export const PREFECTURE_BOUNDARY_WEIGHT = 1.0;

// 市区町村境界線(実線)の色・太さ。
export const MUNICIPALITY_BOUNDARY_COLOR = "#B9B9B9";
export const MUNICIPALITY_BOUNDARY_WEIGHT = 0.7;

// 政令指定都市内部の区どうしの境界は、色は市区町村境界と同じまま、
// 点線(dashArray)だけで見分けられるようにしている。
export const WARD_DASH_ARRAY = "1,3";
export const WARD_BOUNDARY_COLOR = "#B9B9B9";

// Geohashの桁数(精度)ごとの色。精度が細かい(=判定エリアが狭い)ほど暖色にして
// 目立たせる。4桁=青, 5桁=緑, 6桁=黄色, 7桁=赤。Ashi@が扱うのはこの4種類の
// 桁数のみ。(UIのテーマカラーがマゼンタになったため、緑に戻せるようになった)
export const ASHIATO_COLORS_BY_LENGTH: Record<number, string> = {
  4: "#00acc1",
  5: "#4caf50",
  6: "#fbc02d",
  7: "#e53935",
};

// あしあとセルの境界線(outline)を、塗りの矩形よりどれだけ内側に描くか
// (セルの縦横それぞれの長さに対する割合)。map.ts: addAshiatoGroup参照。
export const INSET_FRACTION = 0.05;

// 投稿UI表示中、選択中の精度でのGeohashセル範囲をプレビュー表示する色。
// あしあと本体の色(4桁=青緑, 5桁=緑, 6桁=黄, 7桁=赤)と紛らわしくならないよう、
// あしあとでは使っていない紫系で統一して表示する。
export const PRECISION_PREVIEW_COLOR = "#8e24aa";

// 現在地マーカー+精度円の色。テーマカラーがマゼンタになったので、
// あしあとの丸(4桁=青緑, 5桁=緑, 6桁=黄, 7桁=赤)とも被らない青に戻せる。
export const CURRENT_LOCATION_COLOR = "#4285f4";

// --- タイマー・アニメーションの時間 -----------------------------------------

// 通常メッセージの自動非表示までの時間。
export const STATUS_AUTO_HIDE_MS = 3500;
// エラーも時間経過で自動的に消す(内容確認の猶予として少し長め)。
export const ERROR_AUTO_HIDE_MS = 6000;

// 下部シート・マップの吹き出しを「つまんで高さ調整」する際の挙動。
// 素早く下方向にフリックした場合、または一定以上(START_HEIGHT×
// DRAG_RESIZE_CLOSE_HEIGHT_RATIO)まで小さくした場合は、指を離した時点で
// そのまま閉じる。
export const MIN_DRAG_RESIZE_HEIGHT_PX = 120;
export const DRAG_RESIZE_FLICK_VELOCITY_PX_PER_MS = 0.6;
export const DRAG_RESIZE_CLOSE_HEIGHT_RATIO = 0.35;

// マップの吹き出し(showAshiatoCellPopup)をドラッグで広げられる上限。
// Leaflet側のL.popup({maxHeight:260})はあくまで初期表示時の上限で、
// ドラッグ操作はこちらの値(とウィンドウ高さ)を上限にする。
export const POPUP_DRAG_MAX_HEIGHT_PX = 480;

// 一定時間(このミリ秒数)表示され続けたレコードだけを既読にする。開いた瞬間
// (=表示された瞬間)に即既読化すると未読ドットを目にする間もなく消えてしまうため、
// 「ちゃんと表示された」とみなせるだけの猶予を設ける。この間にスクロールで
// 画面外に出た場合はタイマーを取り消し、既読にしない。
export const READ_DWELL_MS = 700;

// --- 地図のズームしきい値 ---------------------------------------------------

// これよりズームしたら、都道府県名ラベルを表示。
export const MIN_ZOOM_FOR_PREFECTURE_LABELS = 7;
// これよりズームしたら、当該都道府県の市区町村GeoJsonを読み込む。
export const MIN_ZOOM_FOR_MUNICIPALITIES = 10;
// これよりズームしたら、県庁所在地・政令指定都市の大きいラベルを表示。
export const MIN_ZOOM_FOR_CAPITAL_LABELS = 10;
// これよりズームしたら、区・区が無い市町村等、通常の市区町村名ラベルを表示。
export const MIN_ZOOM_FOR_MUNICIPALITY_LABELS = 11;

// --- 利用規約・プライバシーポリシーのバージョン -----------------------------

// src/docs/利用規約.md・プライバシーポリシー.mdの内容を変更するたびに、
// この日付も更新すること(yyyy/mm/dd表記。表示にも使うため、この形式のまま)。
// 起動時、利用者が最後に確認した時点のこの値(putSetting保存)と比較し、
// 異なっていれば(初回利用時を含む)「Ashi@について」を自動表示し、確認を促す
// (main.ts: maybeShowTermsNotice参照)。
export const TERMS_VERSION_DATE = "2026/09/12";
export const PRIVACY_VERSION_DATE = "2026/09/12";
