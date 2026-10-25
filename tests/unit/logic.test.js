// Тести логіки без БД і мережі: npm test
// (модулі підключають db/index.js, але запитів до БД тут немає — Pool не відкриває зʼєднань, доки його не попросять)
const test = require("node:test");
const assert = require("node:assert/strict");

const hr = require("../../bot/hr_sign");
const sheet = require("../../bot/fines_sheet");
const office = require("../../bot/office");

test("hr_sign.docLabel: прибирає імʼя працівника, дату й .pdf", () => {
  assert.equal(hr.docLabel("kovtun_oleksandra___program_lojalnosciowy_2026_10_22_12_04_32.pdf", "KOVTUN OLEKSANDRA"), "program lojalnosciowy");
  assert.equal(hr.docLabel("mikhnova_iryna_wydruki_2026_10_20_10_00_00.pdf", "MIKHNOVA IRYNA"), "wydruki");
  assert.equal(hr.docLabel("makukha_vasyl_potracenia_na_zakladzie_vgl_pdf_2026_10_22_10_57_51.pdf", "MAKUKHA VASYL"), "potracenia na zakladzie vgl");
  assert.equal(hr.docLabel("pit_2_dok.pdf", "KOWAL JAN"), "pit 2 dok");
});

test("hr_sign: вікно ±10 днів і FROM за замовчуванням", () => {
  assert.equal(hr.WINDOW_BEFORE, 10);
  assert.equal(hr.WINDOW_AFTER, 10);
  assert.match(hr.FROM, /^\d{4}-\d{2}-\d{2}$/);
});

test("fines_sheet.agencyOf: агентство з назви закладу", () => {
  const cases = {
    "Hydro Łódź SAS": "SAS LOGISTIC", "CEVA APT": "APT EAST STAFF", "Fiege ZG Well": "WELL DONE", "CAINIAO Dipico 2": "DIPICO",
    "Hydro Trzcianka": "SAS LOGISTIC", "Hydro Trzcianka Well": "WELL DONE", "Oldar Agencja Work": "WORK PLACES", "Nieznany": "",
  };
  for (const [fac, want] of Object.entries(cases)) assert.equal(sheet.agencyOf(fac), want, fac);
});

test("fines_sheet.reasonOf: кирилиця з малої, латиниця без змін", () => {
  assert.equal(sheet.reasonOf({ name_ru: "Прогул" }), "прогул");
  assert.equal(sheet.reasonOf({ name_ru: "Обучение UDT" }), "обучение UDT");
  assert.equal(sheet.reasonOf({ name_ru: "RCP" }), "RCP");
  assert.equal(sheet.reasonOf({ name_ru: "Bonifikata za mieszkanie" }), "Bonifikata za mieszkanie");
  assert.equal(sheet.reasonOf({ type_name: "Absencja" }), "Absencja");
});

test("office.medRange: діапазон дат медогляду", () => {
  assert.deepEqual(office.medRange("2026-10-20", "2026-10-22"), { from: "2026-10-20", to: "2026-10-22" });
  assert.deepEqual(office.medRange("2026-10-22", "2026-10-20"), { from: "2026-10-20", to: "2026-10-22" });   // переставляє
  assert.deepEqual(office.medRange("2026-09-01", "2026-12-01"), { error: "range_too_long" });
});

test("office.splitName: прізвище / імʼя", () => {
  assert.deepEqual(office.splitName({ last_name: "KOWAL", first_name: "JAN", full_name: "X" }), { last: "KOWAL", first: "JAN" });
  const n = office.splitName({ full_name: "KOWALENKO IVAN PETRO" });
  assert.equal(n.last, "KOWALENKO");
});

test("office.MED_KINDS: три типи медогляду", () => {
  assert.deepEqual(Object.keys(office.MED_KINDS).sort(), ["badanie", "badanie_sanepid", "sanepid"]);
});

test.after(() => require("../../db").pool.end().catch(() => {}));

test("docs_sheet: дати клітинок, імена, колонки, зіставлення", () => {
  const ds = require("../../bot/docs_sheet")._test;
  assert.equal(ds.cellDate(46318), "2026-10-23");            // серійна дата Google
  assert.equal(ds.cellDate("5.01.2026"), "2026-01-05");
  assert.equal(ds.cellDate("в бумаге"), null);
  assert.equal(ds.serial("2026-10-23"), 46318);
  assert.equal(ds.nameKey("Varzhel  Inha"), ds.nameKey("INHA VARZHEL"));
  assert.equal(ds.nameKey("ŁUKASZ ŻÓŁW"), "LUKASZ ZOLW");
  const c = ds.columns(["DATA WYSLANIA", "UWAGI ", "PASZPORT", "NAZWISKO I IMIE", "ZAKLAD Z", "ZAKLAD DO", "UMOWA OD", "ANKIETA", "DOKUMENTY",
    "UMOWA", "ZAKWATEROWANIE", "PROGRAM LOJALNOŚCIOWY ( ZGODA/ODMOWA)", "PROGRAM LOJALNOŚCIOWY PODPISANY ( TAK/NIE )", "Rezygnacja z ubezp. STUDENTA "]);
  assert.deepEqual([c.pass, c.name, c.fac, c.umowa, c.ankieta, c.docs, c.loyal, c.loyalSigned, c.student], [2, 3, 5, 6, 7, 8, 11, 12, 13]);
  const p = (id, name, login, periods) => ({ id, full_name: name, login, periods });
  const a = p(1, "KOWAL JAN", "AA111", [{ bhp: "2026-10-20", fac: "Hydro Łódź SAS" }]);
  const b = p(2, "KOWAL JAN", "BB222", [{ bhp: "2026-10-21", fac: "Ceva APT" }]);
  const old = p(3, "NOWAK ADAM", "CC333", [{ bhp: "2025-01-10", fac: "Ceva APT" }]);
  const W = { byName: new Map([[ds.nameKey("KOWAL JAN"), [a, b]], [ds.nameKey("NOWAK ADAM"), [old]]]), byPass: new Map([["AA111", a]]) };
  assert.equal(ds.match(W, { name: "Jan Kowal", umowa: "2026-10-20", fac: "HYDRO L SAS" }).worker.id, 1);   // однофамільці — за закладом
  assert.equal(ds.match(W, { name: "x", pass: "aa 111" }).worker.id, 1);                                    // паспорт у таблиці
  assert.equal(ds.match(W, { name: "NOWAK ADAM", umowa: "2026-10-20" }).reason, "no_period");               // давній період — не він
  assert.equal(ds.match(W, { name: "KOWAL JAN", umowa: "2026-10-20", fac: "" }).reason, "ambiguous");
  const multi = p(4, "X Y", "", [{ bhp: "2026-03-01" }, { bhp: "2026-10-01" }, { bhp: "2026-10-22" }]);
  assert.equal(ds.prevBhp(multi, "2026-10-21"), "2026-10-01");                                            // період перед найближчим до UMOWA OD
  assert.equal(ds.prevBhp(a, "2026-10-20"), null);
});

const reason = require("../../bot/hr_reason");
test("hr_reason.decide: причина належить періоду, якщо змінилася після BHP і до +10 днів", () => {
  const ctx = { today: "2026-11-30", jstart: "2026-01-01" };
  const emp = { state: "Zwolniony", reason: "Другая работа" };
  const p = { status: "zwolniony", bhp: "2026-09-01", lwd: "2026-10-15", next_bhp: null };
  // внесли за 3 тижні до звільнення
  assert.deepEqual(reason.decide(p, emp, [{ reason: "Другая работа", baseline: false, d: "2026-09-25" }], ctx), { value: "Другая работа", source: "hrappka" });
  // перше значення, а не виправлене
  assert.equal(reason.decide(p, emp, [{ reason: "Редукция", baseline: false, d: "2026-10-16" }, { reason: "Другая работа", baseline: false, d: "2026-10-20" }], ctx).value, "Редукция");
  // стара причина з минулого періоду → stale
  assert.deepEqual(reason.decide(p, emp, [{ reason: "Другая работа", baseline: false, d: "2026-05-01" }], ctx), { problem: "stale" });
  // внесли пізніше ніж за 10 днів → не беремо
  assert.deepEqual(reason.decide(p, { ...emp, reason: null }, [{ reason: "Редукция", baseline: false, d: "2026-10-26" }, { reason: null, baseline: false, d: "2026-11-01" }], ctx), { problem: "empty" });
  // ще чекаємо
  assert.deepEqual(reason.decide(p, { ...emp, reason: null }, [], { ...ctx, today: "2026-10-20" }), { wait: true });
});

test("hr_reason.decide: новий період, перенесення, старі звільнення", () => {
  const ctx = { today: "2026-11-30", jstart: "2026-10-25" };
  const emp = { state: "Pracuje", reason: "Возврат Домой" };
  const p = { status: "zwolniony", bhp: "2026-06-01", lwd: "2026-10-01", next_bhp: "2026-10-05" };
  // змінилась до старту нового періоду — наша
  assert.equal(reason.decide(p, emp, [{ reason: "Возврат Домой", baseline: false, d: "2026-10-03" }], ctx).value, "Возврат Домой");
  // змінилась уже під час нового періоду — не наша
  assert.deepEqual(reason.decide(p, emp, [{ reason: "Возврат Домой", baseline: false, d: "2026-10-07" }], ctx), { problem: "next_period" });
  assert.deepEqual(reason.decide({ ...p, status: "przeniesiony" }, null, [], ctx), { value: "przeniesienie", source: "auto" });
  assert.deepEqual(reason.decide(p, null, [], ctx), { problem: "not_found" });
  // старе звільнення: значення з першого знімка, людина звільнена, наступного періоду немає
  const old = { status: "zwolniony", bhp: "2025-03-01", lwd: "2025-05-01", next_bhp: null };
  const dis = { state: "Zwolniony", reason: "Редукция" };
  assert.equal(reason.decide(old, dis, [{ reason: "Редукция", baseline: true, d: "2026-10-25" }], ctx).value, "Редукция");
  // …але не коли в HRappka людина знову працює
  assert.deepEqual(reason.decide(old, { ...dis, state: "Pracuje" }, [{ reason: "Редукция", baseline: true, d: "2026-10-25" }], ctx), { problem: "stale" });
});
