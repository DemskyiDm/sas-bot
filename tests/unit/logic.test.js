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
  assert.equal(hr.WINDOW_BEFORE, 5);
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
