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

test("fines_sheet.sheetFacilityOf: «Предприятие» як у списку таблиці", () => {
  const cases = {
    "CEVA Dipico": "Ceva Łozienica", "Rawa Mazowiecka SAS": "Partners", "Partners Lowicz SAS ": "Partners",
    "id logistics wro  sas": "IDL Pietrzykowice", "ILS Błonie SAS": "ILS Błonie", "Nieznany SAS": "Nieznany SAS", "": "",
  };
  for (const [fac, want] of Object.entries(cases)) assert.equal(sheet.sheetFacilityOf(fac), want, fac);
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
  // людина вже знову працює — HRappka причину не стерла, це причина останнього звільнення
  assert.equal(reason.decide({ ...old, next_bhp: "2025-08-01" }, { ...dis, state: "Pracuje" }, [{ reason: "Редукция", baseline: true, d: "2026-10-25" }], ctx).value, "Редукция");
  // …але не для періоду, після якого було ще одне звільнення
  assert.deepEqual(reason.decide({ ...old, later_dis: true }, dis, [{ reason: "Редукция", baseline: true, d: "2026-10-25" }], ctx), { problem: "stale" });
  // звільнення вже після початку журналу з новим періодом — значення з першого знімка не беремо
  assert.deepEqual(reason.decide({ status: "zwolniony", bhp: "2026-08-01", lwd: "2026-10-28", next_bhp: "2026-11-02" }, { ...dis, state: "Pracuje" },
    [{ reason: "Редукция", baseline: true, d: "2026-10-25" }], ctx), { problem: "next_period" });
});

const hrImport = require("../../bot/hr_import");
test("hr_import.compare: статус, останній день, кого немає", () => {
  const P = (id, state, extra = {}) => ({ id, state, passport: `P${id}`, pesel: null, lastDay: null, department: "X", ...extra });
  const W = (id, status, extra = {}) => ({ id, login: `P${id}`, pesel: null, status, bhp: "2026-01-10", lwd: null, facility: "F", ...extra });
  const people = [
    P(1, "Pracuje"), P(2, "Dotarł"), P(3, "Zwolniony", { lastDay: "2026-05-01" }), P(4, "Umowa zamknięta", { lastDay: "2026-04-01" }),
    P(5, "Czarna lista"), P(6, "Do zatrudnienia (=Harmonogram)"), P(7, "Pracuje", { lastDay: "2025-03-01" }),
    P(8, "Pracuje"), P(9, "Pracuje", { department: "JÓZEF PERLIK" }), P(10, "Nie dotarł"),
    P(13, "Pracuje", { passport: "NEW13", name: "KOWAL JAN" }), P(14, "Pracuje", { pesel: "90010112345" }),
  ];
  const workers = [
    W(1, "pracuje"), W(2, "unknown"), W(3, "zwolniony", { lwd: "2026-05-01" }), W(4, "zwolniony", { lwd: "2026-04-03" }),
    W(5, "zwolniony", { lwd: "2025-01-01" }), W(6, "pracuje"), W(7, "pracuje"), W(11, "pracuje"), W(12, "zwolniony", { lwd: "2025-01-01" }),
    W(13, "pracuje", { full_name: "JAN KOWAL" }), W(14, "pracuje", { pesel: "90010112346" }),
  ];
  const { diffs } = hrImport.compare(people, workers, "2026-10-27");
  const got = diffs.map((d) => `${d.type}:${(d.w || d.p).id}`).sort();
  assert.deepEqual(got, ["Немає в HRappka:11", "Немає в таблиці:8", "Останній день:4", "Паспорт:13", "Статус:6"]);
});

test("hr_import.compare: статус залежить від таблиці й останнього дня", () => {
  const P = (id, state, extra = {}) => ({ id, state, passport: `P${id}`, pesel: null, lastDay: null, department: "X", ...extra });
  const W = (id, status, extra = {}) => ({ id, login: `P${id}`, pesel: null, status, bhp: "2026-01-10", lwd: null, facility: "F", ...extra });
  const people = [
    P(20, "Nie dotarł", { lastDay: "2026-02-01" }), P(21, "Umowa zamknięta"), P(22, "Umowa zamknięta"),
    P(23, "Zwolniony, przejście bezpośrednio", { lastDay: "2026-11-05" }), P(24, "Zwolniony, przejście bezpośrednio", { lastDay: "2026-10-01" }),
    P(25, "Rezygnacja"), P(26, "Rezygnacja", { lastDay: "2026-03-01" }), P(27, "Do zatrudnienia (=Harmonogram)"), P(28, "Długi urlop"),
    P(29, "Zwolniony, przejście bezpośrednio", { lastDay: "2026-11-05" }), P(30, "Nie dotarł"),
    P(31, "Nie dotarł"), P(32, "Zwolniony"), P(33, "Zwolniony", { lastDay: "2026-03-05" }), P(34, "Zwolniony", { lastDay: "2026-03-25" }),
  ];
  const workers = [
    W(20, "pracuje"), W(21, "rezygnacja", { lwd: "2026-02-01" }), W(22, "przeniesiony", { lwd: "2026-02-01" }),
    W(23, "pracuje", { lwd: "2026-11-05" }), W(24, "pracuje", { lwd: "2026-10-01" }), W(25, "rezygnacja", { lwd: "2026-02-01" }),
    W(26, "rezygnacja"), W(27, "unknown"), W(28, "unknown"),
    W(31, "zwolniony"), W(32, "rezygnacja"), W(33, "zwolniony", { lwd: "2026-03-01" }), W(34, "zwolniony", { lwd: "2026-03-01" }),
  ];
  const { diffs } = hrImport.compare(people, workers, "2026-10-27");
  const got = diffs.map((d) => `${d.type}:${(d.w || d.p).id}${d.hr ? ":" + d.hr : ""}${d.note && /днів/.test(d.note) ? ":" + d.note.slice(0, 7) : ""}`).sort();
  assert.deepEqual(got, ["Немає в таблиці:29", "Останній день:22", "Останній день:33:до 20 д", "Останній день:34:понад 2",
    "Статус:22:zwolniony", "Статус:24:zwolniony", "Статус:28:urlop", "Статус:31:nie_dotarl"]);
});

test("hr_import.plan: поточний період з HRappka, об'єкт APT / APT 2 — з таблиці", () => {
  const { plan, facilityMap } = hrImport._test;
  const P = (id, state, extra = {}) => ({ id, state, passport: `P${id}`, pesel: null, lastDay: null, department: "CAINIAO", firm: "APT", start: "2026-05-01", ...extra });
  const W = (id, extra = {}) => ({ id, hid: 100 + id, login: `P${id}`, status: "pracuje", bhp: "2026-05-03", lwd: null, facility_id: 1, facility: "APT", ...extra });
  const S = (id, fac, extra = {}) => ({ id, login: `P${id}`, status: "pracuje", bhp: "2026-05-03", lwd: null, facility_id: fac, ...extra });
  const people = [
    P(1, "Pracuje"), P(2, "Pracuje"), P(3, "Zwolniony", { lastDay: "2026-09-30" }),
    P(4, "Pracuje", { start: "2026-09-01" }),                               // новий договір на іншому об'єкті → новий період, старий закрити
    P(5, "Pracuje", { start: "2026-08-01" }),                               // продовження на тому ж об'єкті → BHP лишається
    P(6, "Nie dotarł"), P(7, "Pracuje"), P(8, "Kandydat"),
  ];
  const db = [W(1), W(2, { facility_id: 2 }), W(3), W(4, { facility_id: 2 }), W(5), W(6, { status: "zwolniony" })];
  const sheets = [S(1, 1), S(2, 2), S(3, 1), S(4, 1), S(5, 1, { bhp: "2026-05-01" }), S(6, 1, { status: "zwolniony" }), S(9, 2)];
  const fmap = facilityMap([...sheets.slice(0, 3).map((w, i) => ({ w, p: people[i] })), { w: S(9, 2), p: P(9, "Pracuje") }]);
  const { ops } = plan(people, db, sheets, fmap, "2026-10-27");
  const got = ops.map((o) => `${o.op}:${(o.w || o.p).id}:${o.t.facility_id || ""}:${o.t.bhp || ""}:${o.t.lwd || ""}:${o.t.status}`);
  assert.deepEqual(got, [
    "update:1:1:2026-05-01::pracuje",
    "update:2:2:2026-05-01::pracuje",
    "update:3:1:2026-05-01:2026-09-30:zwolniony",
    "insert:4:1:2026-09-01::pracuje", "close:4:::2026-08-31:przeniesiony",
    "update:5:1:2026-05-03::pracuje",
    "update:6:1:2026-05-01::rezygnacja",
    "create:7:1:2026-05-01::pracuje",
  ]);
});

test("hr_import.plan: лише зміни HRappka після попереднього знімка", () => {
  const { plan, facilityMap } = hrImport._test;
  const P = (id, state, extra = {}) => ({ id, state, passport: `P${id}`, pesel: null, lastDay: null, department: "D", firm: "F", start: "2026-05-01", position: "x", ...extra });
  const W = (id, extra = {}) => ({ id, hid: 100 + id, login: `P${id}`, status: "pracuje", bhp: "2026-05-03", lwd: null, facility_id: 1, facility: "A", ...extra });
  const before = [P(1, "Pracuje"), P(2, "Pracuje"), P(3, "Pracuje"), P(4, "Pracuje"), P(5, "Kandydat")];
  const now = [P(1, "Pracuje"),                                            // без змін — період не чіпаємо (BHP 03.05 лишається)
    P(2, "Zwolniony", { lastDay: "2026-10-20" }),                           // звільнили — статус і останній день, BHP той самий
    P(3, "Pracuje", { start: "2026-10-01", department: "E" }),              // новий договір в іншому відділі — новий період
    P(4, "Pracuje", { position: "y" }),                                     // лише посада
    P(5, "Dotarł", { department: "E" }), P(6, "Pracuje", { department: "E" })];                                     // стали працювати, у базі немає — нові люди
  const db = [W(1), W(2), W(3), W(4)];
  const sheets = [{ id: 9, login: "P9", status: "pracuje", bhp: "2026-10-01", facility_id: 2 }];
  const fmap = facilityMap([{ w: sheets[0], p: P(9, "Pracuje", { start: "2026-10-01", department: "E" }) }]);
  const prev = new Map(before.map((x) => [x.id, x]));
  const { ops } = plan(now, db, sheets, fmap, "2026-10-27", new Map(), { prev });
  const got = ops.map((o) => `${o.op}:${(o.w || o.p).id}:${(o.changed || []).join("+")}:${o.t.bhp || ""}:${o.t.lwd || ""}:${o.t.status || ""}`);
  assert.deepEqual(got, [
    "update:2:lwd+status+hr_state:2026-05-03:2026-10-20:zwolniony",
    "insert:3::2026-10-01::pracuje", "close:3:::2026-09-30:przeniesiony",
    "update:4:stanowisko:2026-05-03::pracuje",
    "create:5::2026-05-01::pracuje", "create:6::2026-05-01::pracuje",
  ]);
});

test("hr_import.plan: незаписане пробуємо знову, лише за ПІБ не пишемо, закритий період не відкриваємо", () => {
  const { plan, facilityMap } = hrImport._test;
  const P = (id, state, extra = {}) => ({ id, state, name: `N${id} X`, passport: `P${id}`, pesel: null, lastDay: null, department: "D", firm: "F", start: "2026-05-01", position: "x", ...extra });
  const W = (id, extra = {}) => ({ id, hid: 100 + id, login: `P${id}`, full_name: `N${id} X`, status: "pracuje", bhp: "2026-05-03", lwd: null, facility_id: 1, facility: "A", ...extra });
  const before = [P(1, "Pracuje"), P(2, "Pracuje"), P(3, "Zwolniony", { lastDay: "2026-08-01" }), P(4, "Pracuje", { start: "2026-09-01" }), P(5, "Pracuje", { start: "2025-01-01" })];
  const now = [
    P(1, "Zwolniony", { passport: "NEW1", lastDay: "2026-10-20" }),         // паспорт інший, знайшли за ПІБ — не пишемо, пробуємо знову
    P(2, "Zwolniony", { department: "Q", lastDay: "2026-10-01" }),          // об'єкт невідомий — пробуємо знову
    P(3, "Długi urlop", { lastDay: "2026-08-01" }),                         // закритий період — робочий статус не ставимо
    P(4, "Zwolniony", { start: "2026-09-01", lastDay: "2026-10-20" }),      // договір у HRappka давно новіший, ніж період у базі:
                                                                            //  статус і останній день — так, BHP і об'єкт — ні
    P(5, "Zwolniony", { start: "2025-01-01", lastDay: "2026-10-20" }),      // у базі новіший період — не чіпаємо
  ];
  const db = [W(1, { login: "OLD1" }), W(2, { facility_id: null }), W(3, { status: "zwolniony", lwd: "2026-08-01" }), W(4, { facility_id: 2 }), W(5)];
  const fmap = facilityMap([{ w: { facility_id: 1, bhp: "2026-05-01" }, p: P(9, "Pracuje") }, { w: { facility_id: 1, bhp: "2026-05-01" }, p: P(8, "Pracuje") }]);
  const prev = new Map(before.map((x) => [x.id, x]));
  const { ops, skip, pending } = plan(now, db, [], fmap, "2026-10-27", new Map(), { prev });
  const got = ops.map((o) => `${o.op}:${(o.w || o.p).id}:${(o.changed || []).join("+")}:${o.t.facility_id}:${o.t.bhp}:${o.t.lwd || ""}:${o.t.status || ""}`);
  assert.deepEqual(got, ["update:4:lwd+status+hr_state:2:2026-05-03:2026-10-20:zwolniony"]);
  assert.deepEqual([...pending].sort(), [1, 2]);
  assert.equal(skip["період закрито, а в HRappka людина працює — перевірити"], 1);
  assert.equal(skip["у базі новіший період, ніж договір HRappka"], 1);
});

test("hr_import.toPerson: посада з діючого договору, без нього — з останнього", () => {
  const { toPerson } = hrImport._test;
  const N = "newestUserContract_USER_CONTRACT_userContract_position_POSITION_name";
  const CUR = "currentUserContract_USER_CONTRACT_userContract_position_POSITION_name";
  assert.equal(toPerson({ id: 1, [N]: { pl: "magazyn" }, [CUR]: { pl: "produkcja" } }).position, "produkcja");
  assert.equal(toPerson({ id: 2, [N]: { pl: "magazyn" }, [CUR]: null }).position, "magazyn");
  assert.equal(toPerson({ id: 3, [N]: null, [CUR]: null }).position, null);
});

test("hr_import.takeLastDays: останній день до 20 днів — з HRappka у поточний період; порожній у HRappka — наш", async () => {
  const { takeLastDays } = hrImport._test;
  const D = (id, note, lastDay, cur = {}) => ({ type: "Останній день", note, w: { id, bhp: "2026-05-01", lwd: "2026-09-14" }, p: { id, lastDay },
    cur: { hid: 100 + id, login: `P${id}`, status: "zwolniony", bhp: "2026-05-01", lwd: "2026-09-14", ...cur } });
  const diffs = [
    D(1, hrImport.LWD_SMALL, "2026-10-04"),                              // 20 днів — пишемо
    D(2, hrImport.LWD_BIG, "2026-10-20"),                                // понад 20 — ні
    D(3, "у HRappka не внесено", null),                                  // у HRappka порожньо — лишаємо наш
    D(4, hrImport.LWD_SMALL, "2026-09-20", { status: "rezygnacja" }),    // rezygnacja — ні
    D(5, hrImport.LWD_SMALL, "2026-09-20", { bhp: "2026-08-01" }),       // у базі інший період — ні
  ];
  const q = [];
  const client = { query: async (sql, args) => { if (/UPDATE/.test(sql)) q.push(args); } };
  const done = await takeLastDays(client, diffs, (d) => d.cur);
  assert.deepEqual(q, [[101, "2026-10-04"]]);
  assert.deepEqual([...done].map((d) => d.p.id), [1]);
});
