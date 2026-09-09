// Lucideアイコン(https://lucide.dev/)をインラインSVGとして埋め込むためのヘルパー。
// 絵文字は端末のフォントに依存し、意図した絵文字が無い環境では表示が崩れるため、
// SVGアイコンに置き換える。lucide-staticの各SVGはstroke="currentColor"のため、
// CSSのcolorプロパティで色を制御できる(width/height属性は外し、CSS側でサイズ指定する)。
import footprints from "lucide-static/icons/footprints.svg?raw";
import mapPinned from "lucide-static/icons/map-pinned.svg?raw";
import notebookPen from "lucide-static/icons/notebook-pen.svg?raw";
import server from "lucide-static/icons/server.svg?raw";
import trash2 from "lucide-static/icons/trash-2.svg?raw";
import info from "lucide-static/icons/info.svg?raw";
import rotateCcw from "lucide-static/icons/rotate-ccw.svg?raw";
import ellipsis from "lucide-static/icons/ellipsis.svg?raw";
import mapPin from "lucide-static/icons/map-pin.svg?raw";
import externalLink from "lucide-static/icons/external-link.svg?raw";
import x from "lucide-static/icons/x.svg?raw";

const ICONS = {
  footprints,
  "map-pinned": mapPinned,
  "notebook-pen": notebookPen,
  server,
  "trash-2": trash2,
  info,
  "rotate-ccw": rotateCcw,
  ellipsis,
  "map-pin": mapPin,
  "external-link": externalLink,
  x,
} as const;

export type IconName = keyof typeof ICONS;

export function createIcon(name: IconName): SVGSVGElement {
  const template = document.createElement("template");
  template.innerHTML = ICONS[name].trim();
  const svg = template.content.firstElementChild as SVGSVGElement;
  svg.classList.add("icon");
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  return svg;
}
