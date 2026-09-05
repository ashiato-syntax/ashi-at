import { searchNotesByTag } from "./misskey.js";
import { parseText } from "./parser.js";
import { createMap, addAshiato, addBoundaries} from "./map.js";
import { decodeGeohash } from "./geohash.js";

const $ = (s) => document.querySelector(s),
  map = createMap("map"),
  status = $("#status"),
  list = $("#results");

addBoundaries(map).catch((error) => {
  console.error(error);
  setStatus(status, "地図の読み込みに失敗しました。", "error");
});

let layers = [];

function setStatus(t, e = false) {
  status.textContent = t;
  status.className = e ? "status error" : "status";
}

async function search() {
  const btn = $("#search");

  btn.disabled = true;
  setStatus("Misskeyから検索中…");

  try {
    const notes = await searchNotesByTag(
      $("#instance").value,
      $("#hashtag").value,
    );

    layers.forEach((x) => map.removeLayer(x));
    layers = [];
    list.replaceChildren();

    const found = [];
    for (const note of notes) {
      if (!note?.text) continue;
      for (const r of parseText(note.text))
        found.push({ ...r, noteId: note.id, note });
    }

    for (const r of found) {
      layers.push(addAshiato(map, r, openAshiato));

      const li = document.createElement("li"),
        b = document.createElement("button");

      b.textContent = `${r.model.geohash} — ${r.canonical}`;
      // FIX: map.setView() expects [lat, lon], but this previously passed
      // [r.model.geohash] — a 1-element array containing the raw geohash
      // string, not coordinates. Decode it first.
      b.onclick = () => {
        const { centerLat, centerLon } = decodeGeohash(r.model.geohash);
        map.setView([centerLat, centerLon], 13);
      };

      li.append(b);
      list.append(li);
    }

    setStatus(
      `${notes.length}件のノートから、${found.length}件のAshiatoを発見。`,
    );
  } catch (e) {
    console.error(e);
    setStatus(e.message || "検索に失敗しました。", true);

  } finally {
    btn.disabled = false;
  }
}
function openAshiato(r) {
  alert(
    `Ashiatoを発見しました。\n\nGeohash: ${r.model.geohash}\n\n現地到達判定は次の実装段階で有効化します。`,
  );
}
$("#search").onclick = search;
$("#hashtag").onkeydown = (e) => {
  if (e.key === "Enter") search();
};
