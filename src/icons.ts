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
import menu from "lucide-static/icons/menu.svg?raw";
import refreshCw from "lucide-static/icons/refresh-cw.svg?raw";
import history from "lucide-static/icons/history.svg?raw";
import chevronDown from "lucide-static/icons/chevron-down.svg?raw";
import plus from "lucide-static/icons/plus.svg?raw";
import minus from "lucide-static/icons/minus.svg?raw";
import chevronLeft from "lucide-static/icons/chevron-left.svg?raw";
import chevronRight from "lucide-static/icons/chevron-right.svg?raw";
import eye from "lucide-static/icons/eye.svg?raw";
import settings from "lucide-static/icons/settings.svg?raw";

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
  menu,
  "refresh-cw": refreshCw,
  history,
  "chevron-down": chevronDown,
  plus,
  minus,
  "chevron-left": chevronLeft,
  "chevron-right": chevronRight,
  eye,
  settings,
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
