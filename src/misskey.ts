export function normalizeInstanceUrl(value: string): string {
  const u = new URL(value.trim());
  if (!["http:", "https:"].includes(u.protocol))
    throw new Error("HTTP/HTTPS のインスタンスURLを指定してください。");
  return u.origin;
}

export async function apiRequest<T>(
  instance: string,
  endpoint: string,
  body: Record<string, unknown> = {},
): Promise<T> {
  const origin = normalizeInstanceUrl(instance);
  // 開発用: misskey.io向けには、Viteのプロキシ（vite.config.jsを参照）を介して
  // 同一オリジンの相対パスとしてリクエストする。
  // これにより、Cloudflareにブロックされる `Origin: http://localhost:...` ヘッダーが
  // ブラウザから送信されなくなる。
  // 本番ビルド（import.meta.env.DEV === false）では常に実際のオリジンが使用されるので、
  // READMEに記載の「バックエンドプロキシを使用しない」という方針はクリアされる。
  const base =
    import.meta.env.DEV && origin === "https://misskey.io" ? "" : origin;

  const res = await fetch(`${base}/api/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    credentials: "omit",
  });

  if (!res.ok) throw new Error(`Misskey API error: HTTP ${res.status}`);
  return res.json();
}

// カスタム絵文字一覧(shortcode -> 画像URL)。
// ノート単体のnote.emojisは最近のMisskeyでは空になっていることが多く当てにできないため、
// 代わりにインスタンス単位のエンドポイント(/api/emojis、認証不要)から一覧を取得し、
// クライアント側でshortcodeを引く方式にする。
// カスタム絵文字はノートの投稿元インスタンス(フェデレーションしてきたリモートユーザーの
// 場合はそのユーザーのホームインスタンス)に属するため、呼び出し側は「検索に使っている
// インスタンス」ではなく「そのノートの投稿元インスタンス」を渡すこと(main.jsのemojiHost参照)。
// 同じインスタンスへの呼び出しはPromiseキャッシュして使い回す
// (map.jsのfetchMunicipalityGeoJsonと同じ方針)。
const emojiMapCache = new Map<string, Promise<Map<string, string>>>(); // origin -> Promise<Map<name, url>>

interface EmojisResponse {
  emojis?: { name: string; url: string }[];
}

export function fetchEmojiMap(instance: string): Promise<Map<string, string>> {
  const origin = normalizeInstanceUrl(instance);
  if (!emojiMapCache.has(origin)) {
    emojiMapCache.set(
      origin,
      apiRequest<EmojisResponse>(origin, "emojis", {}).then((res) => {
        const map = new Map<string, string>();
        for (const e of res.emojis ?? []) map.set(e.name, e.url);
        return map;
      }),
    );
  }
  return emojiMapCache.get(origin)!;
}

const SHARE_HUB_ORIGIN = "https://misskey-hub.net";

// Misskey Hubの共有フォーム中継(/share)へのURLを組み立てる。
// これを使うことで、Ashi@自身は投稿先インスタンス・認証トークンを一切
// 意識しなくてよい(ユーザーが既にログイン済みの自分のインスタンスへ、
// Misskey Hub側が誘導してくれる)。
export function buildShareUrl(text: string): string {
  const params = new URLSearchParams({
    text,
    visibility: "public",
    localOnly: "0",
  });
  return `${SHARE_HUB_ORIGIN}/share/?${params.toString()}`;
}

export interface MisskeyUser {
  username: string;
  host: string | null;
  name: string | null;
}

export interface MisskeyNote {
  id: string;
  text: string | null;
  createdAt: string | null;
  deletedAt?: string | null;
  user?: MisskeyUser | null;
}

export interface SearchNotesByTagOptions {
  limit?: number;
  /** これより新しいノートを取得(「最新を確認」方向) */
  sinceId?: string;
  /** これより古いノートを取得(「さらに過去を探す」方向) */
  untilId?: string;
}

/**
 * 両方省略すれば「最新から」の初回検索になる。
 */
export function searchNotesByTag(
  instance: string,
  tag: string,
  opts: SearchNotesByTagOptions = {},
): Promise<MisskeyNote[]> {
  const { limit = 50, sinceId, untilId } = opts;
  const clean = tag.trim().replace(/^#/, "");

  if (!clean) throw new Error("ハッシュタグを指定してください。");

  const body: Record<string, unknown> = {
    tag: clean,
    limit: Math.min(Math.max(limit, 1), 100),
  };
  if (sinceId) body.sinceId = sinceId;
  if (untilId) body.untilId = untilId;

  return apiRequest<MisskeyNote[]>(instance, "notes/search-by-tag", body);
}
