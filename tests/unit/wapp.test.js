// Міні-застосунок працівника: PDF з фото, підпис Telegram, дати виплати й правки, стан довідки студента (без БД і мережі)
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");

const pdf = require("../../bot/pdf");
const student = require("../../bot/student");
const { verifyInitData } = require("../../api/tg");
const wapp = require("../../api/wapp");

// Найменший «JPEG» для розбору заголовка: SOI, APP0, SOF0 (w×h, канали), SOS, EOI
function fakeJpeg(w, h, comps = 3) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(2 + 2 + 6 + comps * 3);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8 + comps * 3, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  sof[9] = comps;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xda, 0x00, 0x02, 0x11, 0x22, 0xff, 0xd9])]);
}

test("pdf.jpegInfo: розмір і канали з SOF, не-JPEG — null", () => {
  assert.deepEqual(pdf.jpegInfo(fakeJpeg(1600, 1200)), { w: 1600, h: 1200, comps: 3 });
  assert.deepEqual(pdf.jpegInfo(fakeJpeg(800, 1000, 1)), { w: 800, h: 1000, comps: 1 });
  assert.equal(pdf.jpegInfo(Buffer.from("%PDF-1.4")), null);
  assert.equal(pdf.jpegInfo(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2])), null);
});

test("pdf.jpegsToPdf: сторінка на фото, xref вказує на обʼєкти", () => {
  const out = pdf.jpegsToPdf([fakeJpeg(1600, 1200), fakeJpeg(900, 1400, 1)], "10234 Paszport");
  const s = out.toString("latin1");
  assert.ok(pdf.isPdf(out));
  assert.match(s, /\/Type \/Pages \/Count 2/);
  assert.match(s, /\/ColorSpace \/DeviceGray/);
  assert.match(s, /\/Title \(10234 Paszport\)/);
  const xref = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.equal(s.slice(xref, xref + 4), "xref");
  const rows = s.slice(xref).split("\n").slice(3).filter((l) => / n $/.test(l));
  rows.forEach((l, i) => {
    const off = Number(l.slice(0, 10));
    assert.equal(s.slice(off, off + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `обʼєкт ${i + 1}`);
  });
  assert.throws(() => pdf.jpegsToPdf([Buffer.from("nope")]), /not a JPEG/);
  assert.throws(() => pdf.jpegsToPdf([]), /no pages/);
});

test("pdf: обрізана карта — у реальному розмірі, дві сторони на одному аркуші", () => {
  const { layout, CARD } = pdf._test;
  const card = { w: 1460, h: 910, comps: 3 }, page = { w: 1600, h: 2200, comps: 3 }, odd = { w: 1000, h: 1000, comps: 3 };
  // паспорт + дві сторони карти → 2 аркуші: паспорт окремо, обидві сторони разом
  const s = layout([{ card: false }, { card: true }, { card: true }], [page, card, card]);
  assert.equal(s.length, 2);
  assert.deepEqual(s[1].map((x) => x.i), [1, 2]);
  const [a, b] = s[1].map((x) => x.r);
  assert.ok(Math.abs(a.w - CARD.long) < 0.5, "ширина = 85,6 мм");
  assert.ok(a.y > b.y, "лицьова — вище за зворотну");
  assert.ok(a.y - (b.y + b.h) >= 39, "між сторонами проміжок");
  // третя картка — на новий аркуш; квадратне «не-картка» — звичайна сторінка
  assert.equal(layout([{ card: true }, { card: true }, { card: true }], [card, card, card]).length, 2);
  assert.equal(layout([{ card: true }], [odd])[0][0].r.w > CARD.long * 2, true);
  // повернута вертикально картка — вузька коробка
  const v = layout([{ card: true }], [{ w: 910, h: 1460 }])[0][0].r;
  assert.ok(Math.abs(v.h - CARD.long) < 0.5);
  // у PDF: 3 фото → 2 сторінки
  const out = pdf.jpegsToPdf([fakeJpeg(1600, 2200), { jpg: fakeJpeg(1460, 910), card: true }, { jpg: fakeJpeg(1460, 910), card: true }]).toString("latin1");
  assert.match(out, /\/Type \/Pages \/Count 2/);
  assert.match(out, /\/Im1 Do Q\nq .* \/Im2 Do Q/);
});

test("pdf: фото вписується в A4 з полями й не розтягується", () => {
  const { fit, A4, MARGIN } = pdf._test;
  const r = fit({ w: 4000, h: 1000 });
  assert.ok(Math.abs(r.w - (A4.w - 2 * MARGIN)) < 0.01);
  assert.ok(Math.abs(r.w / r.h - 4) < 0.001);
  const p = fit({ w: 1000, h: 4000 });
  assert.ok(Math.abs(p.h - (A4.h - 2 * MARGIN)) < 0.01);
});

test("verifyInitData: підпис бота, підробка й прострочення", () => {
  const token = "123456:TEST_TOKEN";
  const now = 1_800_000_000;
  const sign = (fields) => {
    const p = new URLSearchParams(fields);
    const dcs = [...p].map(([k, v]) => `${k}=${v}`).sort().join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
    p.set("hash", crypto.createHmac("sha256", secret).update(dcs).digest("hex"));
    return p.toString();
  };
  const ok = sign({ auth_date: String(now - 60), user: JSON.stringify({ id: 777, first_name: "A" }) });
  assert.equal(verifyInitData(ok, token, now).user.id, 777);
  assert.equal(verifyInitData(ok.replace("777", "778"), token, now), null);
  assert.equal(verifyInitData(ok, "999:OTHER", now), null);
  assert.equal(verifyInitData(sign({ auth_date: String(now - 2 * 86400), user: JSON.stringify({ id: 1 }) }), token, now), null);
});

test("wapp: виплата авансу в пʼятницю — як у боті", () => {
  const { payDate } = wapp._test;
  assert.equal(payDate("2026-10-26"), "2026-10-30");   // пн → ця пʼятниця
  assert.equal(payDate("2026-10-27"), "2026-11-06");   // вт → наступна
  assert.equal(payDate("2026-10-30"), "2026-11-06");   // пт → наступна
  assert.equal(payDate("2026-10-25"), "2026-10-30");   // нд → найближча
});

test("wapp: вікно правки годин — максимум 2 дні назад, плюс завтра", () => {
  const { editWindow, monthEnd, addMonths, inPeriods } = wapp._test;
  assert.deepEqual(editWindow("2026-10-26"), { from: "2026-10-24", to: "2026-10-27" });
  assert.deepEqual(editWindow("2026-01-01"), { from: "2025-12-30", to: "2026-01-02" });
  assert.deepEqual(editWindow("2026-03-31"), { from: "2026-03-29", to: "2026-04-01" });
  assert.equal(monthEnd("2026-02"), "2026-02-28");
  assert.equal(addMonths("2026-01", -3), "2025-10");
  const ps = [{ from: "2026-09-10", to: "2026-09-30" }, { from: "2026-10-05", to: null }];
  assert.equal(inPeriods(ps, "2026-09-09"), false);
  assert.equal(inPeriods(ps, "2026-10-02"), false);
  assert.equal(inPeriods(ps, "2026-10-20"), true);
});

test("student.stateOf: чинна / закінчується за 14 днів / закінчилась / без дати", () => {
  const t = "2026-10-26";
  assert.equal(student.stateOf(null, t), "none");
  assert.equal(student.stateOf({ is_student: false, valid_until: "2027-01-01" }, t), "none");
  assert.equal(student.stateOf({ is_student: true, valid_until: null }, t), "unknown");
  assert.equal(student.stateOf({ is_student: true, valid_until: "2026-11-30" }, t), "active");
  assert.equal(student.stateOf({ is_student: true, valid_until: "2026-11-08" }, t), "expiring");
  assert.equal(student.stateOf({ is_student: true, valid_until: "2026-10-26" }, t), "expiring");
  assert.equal(student.stateOf({ is_student: true, valid_until: "2026-10-25" }, t), "expired");
});
