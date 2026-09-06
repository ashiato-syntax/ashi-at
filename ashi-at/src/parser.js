const OPEN = "⟦",
  CLOSE = "⟧",
  MAX = 4096,
  STD = new Set(["g", "c", "z", "tz", "s", "e", "d", "w", "t", "o"]);

const b36 = /^[0-9a-z]+$/;

const dec = (v) => {
  if (!b36.test(v)) throw Error(`Invalid Base36: ${v}`);
  return Number.parseInt(v, 36);
};

const enc = (v) => v.toString(36);


function signed(v) {
  if (!/^[+-]?[0-9a-z]+$/.test(v)) throw Error(`Invalid signed Base36: ${v}`);
  return (v[0] == "-" ? -1 : 1) * dec(v.replace(/^[+-]/, ""));
}


function time(v) {
  const m = /^([0-9a-z]+)-([0-9a-z]+)$/.exec(v);
  if (!m) throw Error(`Invalid t value: ${v}`);

  const s = dec(m[1]),
    e = dec(m[2]);

  if (s > 1439 || e > 1439 || s === e) throw Error("Invalid t range.");
  return { s, e };
}


function md(v) {
  if (!/^\d{4}$/.test(v)) throw Error(`Invalid month-day: ${v}`);

  const m = +v.slice(0, 2),
    d = +v.slice(2);

  const x = new Date(Date.UTC(2024, m - 1, d));

  if (x.getUTCMonth() != m - 1 || x.getUTCDate() != d)
    throw Error(`Invalid calendar date: ${v}`);
}


function field(tok) {
  const i = tok.indexOf(":");

  if (i <= 0) throw Error(`Invalid field: ${tok}`);

  const key = tok.slice(0, i),
    value = tok.slice(i + 1);
  if (!value) throw Error(`Empty field: ${key}`);

  if (key.startsWith("x-")) {
    if (
      !/^x-[a-z0-9-]+-[a-z0-9-]+$/.test(key) ||
      !/^[A-Za-z0-9.+-]+$/.test(value)
    )
      throw Error(`Invalid extension: ${tok}`);
    return { key, value, ext: true };
  }

  if (!STD.has(key)) throw Error(`Unknown field: ${key}`);
  return { key, value, ext: false };
}


export function extractCandidates(text) {
  const out = [];
  let p = 0;

  while ((p = text.indexOf(OPEN, p)) !== -1) {
    const e = text.indexOf(CLOSE, p + 1);
    if (e === -1) {
      out.push(text.slice(p));
      break;
    }
    out.push(text.slice(p, e + 1));
    p = e + 1;
  }
  return out;
}


export function parseCandidate(c) {
  if (
    [...c].length > MAX ||
    !c.startsWith(OPEN) ||
    !c.endsWith(CLOSE) ||
    /\s/u.test(c)
  )
    return { ok: false, error: "Invalid Candidate", candidate: c };

  const t = c.slice(1, -1).split(",");
  if (t[0] !== "as:1")
    return { ok: false, error: "Syntax must begin with as:1.", candidate: c };

  let i = 1;
  let ctxId = null;

  if (t[i]?.startsWith("c:")) {
    ctxId = t[i].slice(2);
    if (!/^[0-9a-z]{1,22}$/.test(ctxId))
      return { ok: false, error: "Invalid c.", candidate: c };
    i++;
  }

  if (!t[i]?.startsWith("g:"))
    return { ok: false, error: "g is required after as/c.", candidate: c };

  const g = t[i++].slice(2);
  if (!/^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/.test(g))
    return { ok: false, error: "Invalid g.", candidate: c };

  const f = new Map(),
    x = new Map();

  try {
    for (; i < t.length; i++) {
      const q = field(t[i]),
        m = q.ext ? x : f;
      if (m.has(q.key)) throw Error(`Duplicate field: ${q.key}`);
      m.set(q.key, q.value);
    }

    if (f.has("z") && f.has("tz"))
      throw Error("z and tz are mutually exclusive.");

    if (f.has("z")) {
      const z = signed(f.get("z"));
      if (z < -1440 || z > 1440) throw Error("z out of range.");
    }

    if (f.has("s")) dec(f.get("s"));
    if (f.has("e")) dec(f.get("e"));
    if (f.has("s") && f.has("e") && dec(f.get("s")) >= dec(f.get("e")))
      throw Error("s must be less than e.");

    if (f.has("d")) f.get("d").split(".").forEach(md);
    if (f.has("w") && !/^[1-7]+$/.test(f.get("w"))) throw Error("Invalid w.");

    const tr = f.has("t") ? time(f.get("t")) : null;
    if (f.has("o") && (f.get("o") !== "1" || !tr || tr.s <= tr.e))
      throw Error("Invalid o:1.");
  } catch (e) {
    return { ok: false, error: e.message, candidate: c };
  }
  const model = {
    version: 1,
    contextId: ctxId,
    geohash: g,
    utcOffsetMinutes: f.has("z") ? signed(f.get("z")) : 0,
    timezoneIndex: f.has("tz") ? dec(f.get("tz")) : null,
    startUnixMinute: f.has("s") ? dec(f.get("s")) : null,
    endUnixMinute: f.has("e") ? dec(f.get("e")) : null,
    dates: f.has("d") ? f.get("d").split(".") : null,
    weekdays: f.has("w") ? [...f.get("w")].map(Number) : null,
    timeRange: f.has("t") ? time(f.get("t")) : null,
    overnight: f.get("o") === "1",
    extensions: Object.fromEntries(x),
  };
  return { ok: true, candidate: c, model, canonical: canonicalize(model) };
}


function canonicalize(m) {
  const p = ["as:1"];
  if (m.contextId) p.push(`c:${m.contextId}`);

  p.push(`g:${m.geohash}`);
  if (m.utcOffsetMinutes) {
    const s = m.utcOffsetMinutes < 0 ? "-" : "+";
    p.push(`z:${s}${enc(Math.abs(m.utcOffsetMinutes))}`);
  }

  if (m.timezoneIndex !== null) p.push(`tz:${enc(m.timezoneIndex)}`);
  if (m.startUnixMinute !== null) p.push(`s:${enc(m.startUnixMinute)}`);
  if (m.endUnixMinute !== null) p.push(`e:${enc(m.endUnixMinute)}`);
  if (m.dates) p.push(`d:${[...new Set(m.dates)].sort().join(".")}`);
  if (m.weekdays)
    p.push(`w:${[...new Set(m.weekdays)].sort((a, b) => a - b).join("")}`);

  if (m.timeRange) p.push(`t:${enc(m.timeRange.s)}-${enc(m.timeRange.e)}`);
  if (m.overnight) p.push("o:1");

  for (const [k, v] of Object.entries(m.extensions).sort(([a], [b]) =>
    a.localeCompare(b),
  ))
    p.push(`${k}:${v}`);
  return `⟦${p.join(",")}⟧`;
}


export function parseText(text) {
  return extractCandidates(text)
    .map(parseCandidate)
    .filter((r) => r.ok);
}
