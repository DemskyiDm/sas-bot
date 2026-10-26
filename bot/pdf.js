// bot/pdf.js — PDF з фото сторінок (JPEG) без залежностей: кожне фото — окрема сторінка A4, вписане з полями.
// JPEG кладеться в PDF як є (DCTDecode), без перекодування — якість і розмір такі, як прийшли з телефона.
// Використовує міні-застосунок працівника (api/wapp.js): довідка студента, паспорт, карта побиту.
"use strict";

const A4 = { w: 595.28, h: 841.89 };
const MARGIN = 24;

// Розмір і кількість каналів JPEG — з маркера SOF (baseline / progressive)
function jpegInfo(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    const sof = m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
    if (sof) {
      const h = buf.readUInt16BE(i + 5), w = buf.readUInt16BE(i + 7), comps = buf[i + 9];
      return w && h ? { w, h, comps } : null;
    }
    if (m === 0xda) return null;   // почалися дані, а SOF не було
    i += 2 + len;
  }
  return null;
}

// Фото, вписане в A4 з полями, по центру
function fit(img) {
  const bw = A4.w - 2 * MARGIN, bh = A4.h - 2 * MARGIN;
  const k = Math.min(bw / img.w, bh / img.h);
  const w = img.w * k, h = img.h * k;
  return { x: (A4.w - w) / 2, y: (A4.h - h) / 2, w, h };
}
const n2 = (v) => (Math.round(v * 100) / 100).toString();

// jpegs: [Buffer] → Buffer (PDF). Невалідний JPEG — помилка (щоб не зібрати порожній документ)
function jpegsToPdf(jpegs, title) {
  if (!Array.isArray(jpegs) || !jpegs.length) throw new Error("no pages");
  const infos = jpegs.map((b, i) => {
    const x = jpegInfo(b);
    if (!x) throw new Error(`page ${i + 1}: not a JPEG`);
    return x;
  });
  const parts = [];
  const offsets = [];
  let size = 0;
  const push = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, "latin1"); parts.push(buf); size += buf.length; };
  const obj = (n, body) => { offsets[n] = size; push(`${n} 0 obj\n`); for (const b of [].concat(body)) push(b); push("\nendobj\n"); };

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  const pageIds = jpegs.map((_, i) => 3 + i * 3);
  const total = 2 + jpegs.length * 3;
  const info = total + 1;
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Count ${jpegs.length} /Kids [${pageIds.map((p) => `${p} 0 R`).join(" ")}] >>`);
  jpegs.forEach((jpg, i) => {
    const p = pageIds[i], c = p + 1, im = p + 2;
    const r = fit(infos[i]);
    const content = `q ${n2(r.w)} 0 0 ${n2(r.h)} ${n2(r.x)} ${n2(r.y)} cm /Im${i} Do Q`;
    obj(p, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.w} ${A4.h}] /Resources << /XObject << /Im${i} ${im} 0 R >> >> /Contents ${c} 0 R >>`);
    obj(c, [`<< /Length ${content.length} >>\nstream\n`, content, "\nendstream"]);
    const cs = infos[i].comps === 1 ? "/DeviceGray" : infos[i].comps === 4 ? "/DeviceCMYK" : "/DeviceRGB";
    obj(im, [`<< /Type /XObject /Subtype /Image /Width ${infos[i].w} /Height ${infos[i].h} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`, jpg, "\nendstream"]);
  });
  // назва документа — лише ASCII (решту прибираємо), щоб не возитися з кодуванням рядків PDF
  const t = String(title || "").replace(/[^\x20-\x7e]/g, "").replace(/[()\\]/g, "").slice(0, 120);
  obj(info, `<< /Title (${t}) /Producer (SAS Praca) >>`);

  const xref = size;
  const lines = [`xref\n0 ${info + 1}\n`, "0000000000 65535 f \n"];
  for (let n = 1; n <= info; n++) lines.push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  push(lines.join(""));
  push(`trailer\n<< /Size ${info + 1} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

const isPdf = (buf) => Buffer.isBuffer(buf) && buf.length > 8 && buf.slice(0, 5).toString("latin1") === "%PDF-";

module.exports = { jpegInfo, jpegsToPdf, isPdf, _test: { fit, A4, MARGIN } };
