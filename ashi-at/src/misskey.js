export function normalizeInstanceUrl(value) {
  const u = new URL(value.trim());
  if (!["http:", "https:"].includes(u.protocol))
    throw new Error("HTTP/HTTPS のインスタンスURLを指定してください。");
  return u.origin;
}

export async function apiRequest(instance, endpoint, body = {}) {
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

export function searchNotesByTag(instance, tag, limit = 100) {
  const clean = tag.trim().replace(/^#/, "");

  if (!clean) throw new Error("ハッシュタグを指定してください。");
  return apiRequest(instance, "notes/search-by-tag", {
    tag: clean,
    limit: Math.min(Math.max(limit, 1), 100),
  });
}
