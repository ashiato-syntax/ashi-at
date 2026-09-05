export function normalizeInstanceUrl(value) {
  const u = new URL(value.trim());
  if (!["http:", "https:"].includes(u.protocol))
    throw new Error("HTTP/HTTPS のインスタンスURLを指定してください。");
  return u.origin;
}

export async function apiRequest(instance, endpoint, body = {}) {
  const origin = normalizeInstanceUrl(instance);
  // Dev-only: for misskey.io specifically, go through the Vite proxy
  // (see vite.config.js) as a same-origin relative path, so the browser
  // never sends the `Origin: http://localhost:...` header that Cloudflare
  // blocks. Production builds (import.meta.env.DEV === false) always use
  // the real origin, matching README_JP.md's no-backend-proxy policy.
  // Other instances aren't proxied yet, so they'll still hit the same
  // localhost-CORS wall in dev until a matching proxy entry is added.
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
