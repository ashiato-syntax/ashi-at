// Ashiato Syntax v1.0 仕様書 §48 "Reference Evaluation Algorithm" の実装。
// s/e(絶対有効期間)、d/w/t(ローカル日時条件)、o(日跨ぎ修飾子)、z/tz(タイムゾーン)を
// 踏まえて、あるAshiatoが「今Activeかどうか」を判定する。
//
// main.ts側の発見判定(checkCurrentPositionAgainstCells)は、位置が一致した上で
// このisAshiatoActiveNow()がtrueを返したレコードだけを発見扱いにする
import { parseCandidate, type AshiatoModel } from "./parser.js";
import type { AshiatoRecord } from "./types.js";
import { resolveTzid } from "./ashiatoTz.js";

// tzidごとにIntl.DateTimeFormatを使い回す(インスタンス生成コストの削減)。
const tzFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(tzid: string): Intl.DateTimeFormat {
  let dtf = tzFormatterCache.get(tzid);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    tzFormatterCache.set(tzid, dtf);
  }
  return dtf;
}

// 「そのtzidでの、その瞬間の壁時計時刻」をIntlで取得し、UTC値との差から
// UTCオフセット(分)を求める定番の手法。tzdataライブラリを別途持たず、
// ブラウザ組み込みのIANAタイムゾーンデータを利用できる。
function getTzOffsetMinutes(tzid: string, utcMs: number): number {
  const parts = getFormatter(tzid).formatToParts(new Date(utcMs));
  const map: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const p of parts) map[p.type] = p.value;

  const asIfUtc = Date.UTC(
    Number(map.year),
    Number(map.month) - 1,
    Number(map.day),
    Number(map.hour),
    Number(map.minute),
    Number(map.second),
  );
  return Math.round((asIfUtc - utcMs) / 60000);
}

// 仕様§48のアルゴリズムそのもの。nowMsはUTC epoch ms(Date.now()相当)。
export function evaluateAshiato(model: AshiatoModel, nowMs: number): boolean {
  const currentUnixMinute = Math.floor(nowMs / 60000);

  if (model.startUnixMinute !== null && currentUnixMinute < model.startUnixMinute) return false;
  if (model.endUnixMinute !== null && currentUnixMinute >= model.endUnixMinute) return false;

  // tz優先(z/tzは相互排他なので両方同時に来ることはparser.ts側で弾かれている)。
  // 未指定ならutcOffsetMinutesは0(UTC)になっている(parser.tsのデフォルト値参照)。
  let offsetMinutes = model.utcOffsetMinutes;
  if (model.timezoneIndex !== null) {
    const tzid = resolveTzid(model.timezoneIndex);
    if (!tzid) return false; // 本来parser.ts側の意味検証で弾かれ、ここには来ない想定
    offsetMinutes = getTzOffsetMinutes(tzid, nowMs);
  }

  // nowMsをオフセット分シフトした上でUTCゲッターで読むことで、
  // 「シフト済みの値=ローカルの壁時計値」として扱う(z/tz共通の手法)。
  const localMs = nowMs + offsetMinutes * 60000;
  const local = new Date(localMs);
  const localMinuteOfDay = local.getUTCHours() * 60 + local.getUTCMinutes();

  // o;1(overnight)が付いている場合だけ、d/wの判定基準をeffective_date/
  // effective_weekdayに差し替える(t.startより前の時間帯=前日の夜の続きとして扱う)。
  // parser.tsの意味検証により、overnightがtrueならtimeRangeは必ず存在し、
  // 日跨ぎの向き(start > end)であることが保証されている。
  let effective = local;
  if (model.overnight && localMinuteOfDay < model.timeRange!.s) {
    effective = new Date(localMs - 24 * 60 * 60 * 1000);
  }

  if (model.dates) {
    const mmdd =
      String(effective.getUTCMonth() + 1).padStart(2, "0") +
      String(effective.getUTCDate()).padStart(2, "0");
    if (!model.dates.includes(mmdd)) return false;
  }

  if (model.weekdays) {
    // getUTCDay(): 0=日曜〜6=土曜 → 仕様の1=月曜〜7=日曜へ変換
    const isoWeekday = ((effective.getUTCDay() + 6) % 7) + 1;
    if (!model.weekdays.includes(isoWeekday)) return false;
  }

  if (model.timeRange) {
    const { s, e } = model.timeRange;
    const inRange =
      s < e
        ? s <= localMinuteOfDay && localMinuteOfDay < e
        : localMinuteOfDay >= s || localMinuteOfDay < e; // 日内で折り返すリング判定
    if (!inRange) return false;
  }

  return true;
}

// record.canonical(正規化済みSyntax文字列)を再パースしてモデルを復元し、評価する。
// AshiatoRecordにはcanonicalが既に保存されているため、時間条件フィールドを
// 別途キャッシュに持たせる必要が無い。parseに失敗する(通常起こらない想定)場合は
// 安全側でfalseを返す。
export function isAshiatoActiveNow(
  record: Pick<AshiatoRecord, "canonical">,
  nowMs: number = Date.now(),
): boolean {
  const parsed = parseCandidate(record.canonical);
  if (!parsed.ok) return false;
  return evaluateAshiato(parsed.model, nowMs);
}
