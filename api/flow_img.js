// ══════════════════════════════════════════════════════════════════════
//  Картинки-таблиці для Telegram (розділ «Wyjazdy / przyjazdy»).
//  Таблиця → SVG → PNG. Без браузера: @resvg/resvg-js малює PNG,
//  opentype.js рахує ширину тексту, шрифт Inter лежить у assets/fonts.
//    npm install @resvg/resvg-js@2.6.2 opentype.js@1.3.4
//  Якщо пакетів немає — render() кидає помилку, а flow.js шле звичайний текст.
// ══════════════════════════════════════════════════════════════════════
const path = require("path");

const FONT_DIR = path.join(__dirname, "..", "assets", "fonts");
const FONT_FILES = { 400: "Inter_400Regular.ttf", 600: "Inter_600SemiBold.ttf", 700: "Inter_700Bold.ttf" };
let LIB = null;
function lib() {
  if (LIB) return LIB;
  const { Resvg } = require("@resvg/resvg-js");
  const ot = require("opentype.js");
  const fonts = {};
  for (const [w, f] of Object.entries(FONT_FILES)) fonts[w] = ot.loadSync(path.join(FONT_DIR, f));
  LIB = { Resvg, fonts, files: Object.values(FONT_FILES).map((f) => path.join(FONT_DIR, f)) };
  return LIB;
}

// ── Вигляд ────────────────────────────────────────────────────────────
const C = {
  text: "#1f2328", muted: "#5f6b7a", faint: "#8a94a3", zero: "#c3c9d1",
  line: "#eef0f3", rule: "#dfe3e8", ruleStrong: "#c9d1db", totalBg: "#f6f8fa",
  redBg: "#fdecea", red: "#d93025", redText: "#c5221f",
  amberBg: "#fff4e0", amber: "#e8a33d", amberText: "#a15c00",
};
const PAD = 24;          // поля картки
const CELL = 10;         // поля клітинки зліва і справа
const ROW = 36;          // висота рядка
const F = { title: 21, sub: 14, head: 11.5, group: 11, body: 15, muted: 14, foot: 12 };

// без керівних символів (з таблиці можуть прийти \u000B тощо): у XML вони недопустимі і ламають рендер
const xml = (s) => String(s == null ? "" : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
function width(text, size, weight) {
  const f = lib().fonts[weight] || lib().fonts[400];
  return f.getAdvanceWidth(String(text == null ? "" : text), size, { kerning: true });
}
function txt(x, y, s, { size = F.body, weight = 400, fill = C.text, anchor = "start" } = {}) {
  return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="Inter" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${xml(s)}</text>`;
}
const rect = (x, y, w, h, fill) => `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${fill}"/>`;
const hline = (x1, x2, y, color, w = 1) => `<line x1="${x1.toFixed(1)}" x2="${x2.toFixed(1)}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${color}" stroke-width="${w}"/>`;
const vline = (x, y1, y2, color) => `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y1.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${color}" stroke-width="1"/>`;

// Клітинка: число, рядок або { v, tone: "red" | "amber" | "muted" | "bold" }
function cellOf(c) {
  if (c && typeof c === "object") return { v: c.v == null ? "—" : String(c.v), tone: c.tone || null, raw: c.v };
  return { v: c == null ? "—" : String(c), tone: null, raw: c };
}
// Стиль клітинки за видом колонки і тоном рядка
function cellStyle(col, cell, rowTone, isTotal) {
  let size = F.body, weight = 400, fill = C.text;
  if (col.kind === "site") weight = 600;
  if (col.kind === "muted") { size = F.muted; fill = C.muted; }
  if (col.kind === "pct") weight = 600;
  if (col.kind === "num" && (cell.raw === 0 || cell.v === "0")) fill = C.zero;
  if (cell.v === "—") fill = C.faint;
  if (cell.tone === "muted") fill = C.faint;
  if (cell.tone === "bold") weight = 700;
  if (cell.tone === "red" || (col.kind === "pct" && rowTone === "red" && cell.v !== "—")) { fill = C.redText; weight = 700; }
  if (cell.tone === "amber" || (col.kind === "status" && rowTone === "amber")) { fill = C.amberText; weight = 600; }
  if (col.kind === "status" && rowTone === "red") { fill = C.redText; weight = 600; }
  if (isTotal) { weight = 700; if (col.kind === "muted") fill = C.text; }
  return { size, weight, fill };
}

// ── Таблиця → масив PNG (по maxRows рядків на картинку) ───────────────
// spec: { title, sub, groups: [{ label, span }] | null (над колонками після lead перших),
//         lead: скільки перших колонок без групи, cols: [{ label: "…" | ["рядок 1", "рядок 2"],
//         kind: "site" | "muted" | "num" | "pct" | "text" | "status", align: "left" | "center", sep }],
//         rows: [{ cells: [...], tone: null | "red" | "amber" }], total: { cells } | null,
//         legend: [{ tone: "red" | "amber", text }], note, footRight, maxRows, scale }
function render(spec) {
  const L = lib();
  const maxRows = spec.maxRows || 30;
  const pages = [];
  const all = spec.rows || [];
  for (let i = 0; i < Math.max(1, all.length); i += maxRows) pages.push(all.slice(i, i + maxRows));
  // ширини колонок — одні на всі сторінки, щоб картинки альбому були однакові
  const cols = spec.cols.map((c) => ({ ...c, lines: Array.isArray(c.label) ? c.label : [c.label] }));
  const headLines = Math.max(...cols.map((c) => c.lines.length));
  const widths = cols.map((c, i) => {
    let w = Math.max(...c.lines.map((l) => width(String(l).toUpperCase(), F.head, 600)));
    for (const r of all.concat(spec.total ? [spec.total] : [])) {
      const cell = cellOf(r.cells[i]);
      const st = cellStyle(c, cell, r.tone, r === spec.total);
      w = Math.max(w, width(cell.v, st.size, st.weight));
    }
    return Math.ceil(w + 2 * CELL + (c.kind === "num" || c.kind === "pct" ? 6 : 0));
  });
  // групи: ширина групи не менша за її підпис
  const lead = spec.lead || 0;
  if (spec.groups) {
    let at = lead;
    for (const g of spec.groups) {
      const need = width(String(g.label).toUpperCase(), F.group, 600) + 2 * CELL;
      const have = widths.slice(at, at + g.span).reduce((a, b) => a + b, 0);
      if (need > have) for (let k = at; k < at + g.span; k++) widths[k] += Math.ceil((need - have) / g.span);
      at += g.span;
    }
  }
  let tableW = widths.reduce((a, b) => a + b, 0);
  const legendW = (spec.legend || []).reduce((a, l) => a + 22 + width(l.text, F.foot, 400), 0) + Math.max(0, (spec.legend || []).length - 1) * 14;
  const noteW = spec.note ? width(spec.note, F.foot, 400) : 0;
  const footRightW = spec.footRight ? width(spec.footRight, F.foot, 400) : 0;
  const titleW = width(spec.title + (pages.length > 1 ? " (9/9)" : ""), F.title, 700);
  const subW = spec.sub ? width(spec.sub, F.sub, 400) : 0;
  const inner = Math.ceil(Math.max(tableW, titleW, subW, legendW, noteW, Math.min(footRightW + 200, tableW)));
  if (inner > tableW) { widths[0] += inner - tableW; tableW = inner; }
  const W = inner + 2 * PAD;

  const out = [];
  pages.forEach((rows, pi) => {
    const S = [];
    let y = PAD;
    const title = spec.title + (pages.length > 1 ? ` (${pi + 1}/${pages.length})` : "");
    S.push(txt(PAD, y + 20, title, { size: F.title, weight: 700 }));
    y += 28;
    if (spec.sub) { S.push(txt(PAD, y + 15, spec.sub, { size: F.sub, fill: C.muted })); y += 22; }
    y += 14;
    const x0 = PAD;
    const xs = [];
    widths.reduce((x, w) => { xs.push(x); return x + w; }, x0);
    const tableTop = y;
    // рядок груп
    if (spec.groups) {
      let at = lead;
      for (const g of spec.groups) {
        const gx = xs[at], gw = widths.slice(at, at + g.span).reduce((a, b) => a + b, 0);
        S.push(txt(gx + gw / 2, y + 13, String(g.label).toUpperCase(), { size: F.group, weight: 600, fill: C.faint, anchor: "middle" }));
        S.push(hline(gx, gx + gw, y + 21, C.ruleStrong, 2));
        at += g.span;
      }
      if (lead) S.push(hline(x0, xs[lead], y + 21, C.rule));
      y += 22;
    }
    // шапка
    const headH = 12 + headLines * 14;
    cols.forEach((c, i) => {
      const left = c.align === "left";
      const cx = left ? xs[i] + CELL : xs[i] + widths[i] / 2;
      c.lines.forEach((l, k) => {
        const ly = y + headH - 9 - (c.lines.length - 1 - k) * 14;
        S.push(txt(cx, ly, String(l).toUpperCase(), { size: F.head, weight: 600, fill: C.muted, anchor: left ? "start" : "middle" }));
      });
    });
    y += headH;
    S.push(hline(x0, x0 + tableW, y, C.ruleStrong));
    // рядки
    const drawRow = (r, isTotal) => {
      if (isTotal) { S.push(rect(x0, y, tableW, ROW, C.totalBg)); S.push(hline(x0, x0 + tableW, y, C.ruleStrong, 2)); }
      else if (r.tone === "red") { S.push(rect(x0, y, tableW, ROW, C.redBg)); S.push(rect(x0, y, 4, ROW, C.red)); }
      else if (r.tone === "amber") { S.push(rect(x0, y, tableW, ROW, C.amberBg)); S.push(rect(x0, y, 4, ROW, C.amber)); }
      cols.forEach((c, i) => {
        const cell = cellOf(r.cells[i]);
        const st = cellStyle(c, cell, r.tone, isTotal);
        const left = c.align === "left";
        S.push(txt(left ? xs[i] + CELL + (i === 0 ? 2 : 0) : xs[i] + widths[i] / 2, y + ROW / 2 + st.size * 0.36, cell.v,
          { ...st, anchor: left ? "start" : "middle" }));
      });
      y += ROW;
      if (!isTotal) S.push(hline(x0, x0 + tableW, y, C.line));
    };
    rows.forEach((r) => drawRow(r, false));
    if (!rows.length && spec.empty) {
      S.push(txt(x0 + CELL, y + ROW / 2 + 5, spec.empty, { size: F.body, fill: C.faint }));
      y += ROW;
    }
    const last = pi === pages.length - 1;
    if (last && spec.total) drawRow(spec.total, true);
    const tableBottom = y;
    // вертикальні роздільники груп
    cols.forEach((c, i) => { if (c.sep) S.push(vline(xs[i], tableTop + (spec.groups ? 22 : 0), tableBottom, C.rule)); });
    // підвал: легенда, примітка, час
    y += 12;
    let lx = x0;
    for (const l of spec.legend || []) {
      const tone = l.tone === "amber" ? [C.amberBg, C.amber] : [C.redBg, C.red];
      S.push(rect(lx, y + 2, 14, 12, tone[0]), rect(lx, y + 2, 3, 12, tone[1]));
      S.push(txt(lx + 20, y + 12.5, l.text, { size: F.foot, fill: C.faint }));
      lx += 22 + width(l.text, F.foot, 400) + 14;
    }
    let footY = y;
    if (spec.legend && spec.legend.length) footY += 18;
    if (spec.note) { S.push(txt(x0, footY + 12.5, spec.note, { size: F.foot, fill: C.faint })); footY += 18; }
    // час — праворуч у першому рядку підвалу, якщо влазить, інакше окремим рядком
    const firstLineW = (spec.legend && spec.legend.length) ? lx - x0 : spec.note ? noteW : 0;
    if (spec.footRight) {
      if (firstLineW + footRightW + 24 <= tableW) S.push(txt(x0 + tableW, y + 12.5, spec.footRight, { size: F.foot, fill: C.faint, anchor: "end" }));
      else { S.push(txt(x0 + tableW, footY + 12.5, spec.footRight, { size: F.foot, fill: C.faint, anchor: "end" })); footY += 18; }
    }
    const H = Math.ceil(Math.max(footY, y + 18) + PAD - 6);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
      + rect(0, 0, W, H, "#ffffff") + S.join("") + `</svg>`;
    const r = new L.Resvg(svg, {
      fitTo: { mode: "zoom", value: spec.scale || 2 },
      font: { fontFiles: L.files, loadSystemFonts: false, defaultFontFamily: "Inter" },
      background: "#ffffff",
    });
    out.push(r.render().asPng());
  });
  return out;
}

module.exports = { render, available: () => { try { lib(); return true; } catch (e) { return false; } } };
