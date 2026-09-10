// Ashiato TZ Dictionary v1(IANA TZDB 2026cのzone1970.tab由来、312件)。
// ashiatoTzDictionary.jsonは
// https://github.com/ashiato-syntax/ashiato-syntax の tz/tz-dictionary/v1/dictionary.json
// をそのまま複製したもの。tzフィールドのBase36インデックス(0始まり)を
// IANA Time Zone Identifierへ解決するために使う(仕様6章参照)。
// 一度発行されたバージョンの index→TZID 対応は仕様上変更されないため、
// ここでの複製もその前提で扱う(新しい版が出た場合はv2として別ファイルにする)。
import tzDictionary from "./ashiatoTzDictionary.json";

interface TzDictionaryEntry {
  index: number;
  id: string;
  tzid: string;
}

const ENTRIES = (tzDictionary as { entries: TzDictionaryEntry[] }).entries;

// index番目にそのままTZIDが並ぶ配列にしておく(indexは0始まりで連番である前提。
// 辞書ファイル自体がその前提で生成されているため、ここでは検証しない)。
export const TZ_DICTIONARY: readonly string[] = ENTRIES.map((e) => e.tzid);

export function isValidTzIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < TZ_DICTIONARY.length;
}

export function resolveTzid(index: number): string | null {
  return isValidTzIndex(index) ? TZ_DICTIONARY[index] : null;
}
