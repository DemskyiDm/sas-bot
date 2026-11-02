// Premie koordynatorów — розрахунок без БД: npm test
const test = require("node:test");
const assert = require("node:assert/strict");

const prm = require("../../bot/premie");
const { evalRow, blocks, sumItems } = prm._test;

const P = prm.paramsOf(prm.DEFAULTS);
const SEPT = { d1: "2026-09-01", d2: "2026-09-30", end: "2026-09-30" };
let seq = 0;
const row = (s, l, extra) => ({ id: ++seq, worker_id: seq, name: `W${seq}`, login: `L${seq}`, facility: "F", site_key: "S",
  status: l ? "zwolniony" : "pracuje", reason: null, s, l: l || null, ...extra });

test("premie.scale: перший крок, до якого дотягує; рівно на порозі — зараховано", () => {
  assert.equal(prm.scale(P.scale_a, 0.95), 1);
  assert.equal(prm.scale(P.scale_a, 0.9499), 0.8);
  assert.equal(prm.scale(P.scale_a, 87 / 100), 0.8);
  assert.equal(prm.scale(P.scale_a, 0.6), 0.4);
  assert.equal(prm.scale(P.scale_a, 0.5999), 0);
  assert.equal(prm.scale(P.scale_b, 0.55), 0.7);
  assert.equal(prm.scale(P.scale_b, 0.39), 0);
});

// Підсумки координаторів з листа «Model» (kpi/09/Model_premiowy_prog80_v4.xlsx, вересень 2026) → та сама премія
test("premie.blocks: усі премії вересня з Excel", () => {
  const sept = [
    // [хто, кадр, можливі, набрані, ядро, k-t, А, Б, премія]
    ["K01 (регіон)", 390, 237, 166, 260, 1, 640, 765, 1405],
    ["K02", 214, 142, 110, 130, 1, 640, 765, 1405],
    ["K03", 93, 50, 26, 74, 1, 0, 810, 810],
    ["K04", 83, 45, 30, 56, 0.5, 320, 382.5, 702.5],
    ["K05", 41, 30, 27, 34, 0.5, 640, 450, 1090],
    ["K06", 147, 124, 104, 62, 1, 960, 180, 1140],
    ["K07", 152, 112, 35, 89, 0, 0, 0, 0],
    ["K08", 271, 303, 182, 175, 1, 640, 765, 1405],
    ["K09", 92, 20, 17, 65, 1, 960, 810, 1770],
    ["K10", 295, 114, 92, 190, 1, 960, 765, 1725],
    ["K11", 42, 15, 14, 0, 0, 0, 0, 0],
    ["K12", 164, 184, 122, 88, 1, 640, 180, 820],
    ["K13", 92, 53, 45, 64, 1, 960, 765, 1725],
    ["K14", 24, 0, 0, 0, 0, 0, 0, 0],
    ["K15", 96, 108, 66, 65, 1, 640, 765, 1405],
    ["K16", 287, 143, 105, 202, 1, 640, 810, 1450],
    ["K17", 107, 17, 13, 71, 1, 640, 765, 1405],
  ];
  for (const [who, kadr, poss, ach, core, kt, a, b, total] of sept) {
    const r = blocks({ kadr, poss, ach, core, pen: 0 }, P, kt, 1);
    assert.deepEqual([r.a, r.b, r.total], [a, b, total], who);
  }
});

test("premie.blocks: максимум, без об'єктів з кадром — премії немає, без порогів — блок А 0", () => {
  const big = { ...P, limit_a: 2000, limit_b: 1000 };
  assert.equal(blocks({ kadr: 10, poss: 10, ach: 10, core: 10, pen: 0 }, big, 1, 2).total, 2500);
  assert.equal(blocks({ kadr: 0, poss: 4, ach: 4, core: 0, pen: 0 }, P, 1, 0).total, null);
  const noThr = blocks({ kadr: 10, poss: 0, ach: 0, core: 9, pen: 0 }, P, 1, 1);
  assert.equal(noThr.a, 0);
  assert.equal(noThr.b, 900);
  // штраф додається до А і не множиться на k-t; премія може бути від'ємною
  assert.equal(blocks({ kadr: 10, poss: 10, ach: 0, core: 0, pen: -150 }, P, 0.5, 1).total, -150);
});

test("premie.evalRow: пороги 30 / 80 днів — дата, вага, зараховано / ні", () => {
  const a = evalRow(row("2026-08-02"), P, SEPT);                      // 30 днів → 01.09
  assert.deepEqual([a.poss, a.ach, a.thr[0].date], [1, 1, "2026-09-01"]);
  const b = evalRow(row("2026-08-02", "2026-08-31"), P, SEPT);        // пішов за день до порогу
  assert.deepEqual([b.poss, b.ach, b.thr[0].st], [1, 0, "fail"]);
  const c = evalRow(row("2026-07-10", "2026-09-28"), P, SEPT);        // 80 днів → 28.09; останній день = дата порогу
  assert.deepEqual([c.poss, c.ach], [3, 3]);
  const d = evalRow(row("2026-08-15"), P, SEPT);                      // 30 днів → 14.09; 80 → 03.11 — поза місяцем
  assert.deepEqual([d.poss, d.ach, d.thr.length], [1, 1, 1]);
});

test("premie.evalRow: кадр і ядро на кінець місяця, відхід", () => {
  const core = evalRow(row("2026-06-01"), P, SEPT);
  assert.deepEqual([core.staff, core.core, core.tEnd], [true, true, 121]);
  const young = evalRow(row("2026-08-01"), P, SEPT);
  assert.deepEqual([young.staff, young.core], [true, false]);
  const lastDay = evalRow(row("2026-05-01", "2026-09-30"), P, SEPT);   // останній день = кінець місяця: у кадрі й відхід (як у Excel)
  assert.deepEqual([lastDay.staff, lastDay.dep], [true, true]);
  const left = evalRow(row("2026-05-01", "2026-09-10"), P, SEPT);
  assert.deepEqual([left.staff, left.dep, left.tExit], [false, true, 132]);
});

test("premie.evalRow: статуси й причини зі списку, ручне виключення", () => {
  assert.equal(evalRow(row("2026-05-01", "2026-09-10", { status: "przeniesiony" }), P, SEPT).ex, "status");
  assert.equal(evalRow(row("2026-09-20", "2026-09-20", { status: "rezygnacja" }), P, SEPT).ex, "status");
  assert.equal(evalRow(row("2026-09-20", null, { status: "do_zatrudnienia" }), P, SEPT).ex, "status");
  // переведення вже після місяця — у вересні людина ще просто працювала
  const later = evalRow(row("2026-05-01", "2026-10-05", { status: "przeniesiony" }), P, SEPT);
  assert.deepEqual([later.ex, later.staff, later.core], [undefined, true, true]);
  assert.equal(evalRow(row("2026-08-20", "2026-09-05", { reason: "Редукция" }), P, SEPT).ex, "reason");
  assert.equal(evalRow(row("2026-08-20", "2026-09-05", { reason: "Другая работа" }), P, SEPT).ex, undefined);
  assert.equal(evalRow(row("2026-08-20", null, { reason: "Редукция" }), P, SEPT).ex, undefined);   // стара причина, працює
  const m = evalRow(row("2026-08-20"), P, SEPT, "błąd w grafiku");
  assert.deepEqual([m.ex, m.exr], ["manual", "błąd w grafiku"]);
});

test("premie.evalRow: «zwolniony», а за ≤ 14 днів новий період — переведення, не відхід", () => {
  const OCT = { d1: "2026-10-01", d2: "2026-10-31", end: "2026-10-31" };
  // як YELPASHEV ANDRII: Rawa Mazowiecka 26.10–26.10 zwolniony, з 29.10 знову Partners Lowicz
  const rawa = evalRow(row("2026-10-26", "2026-10-26", { next_s: "2026-10-29" }), P, OCT);
  assert.deepEqual([rawa.ex, rawa.nx], ["moved", "2026-10-29"]);
  // і поріг 30 днів цього періоду (25.11) у листопаді теж не рахується
  assert.equal(evalRow(row("2026-10-26", "2026-10-26", { next_s: "2026-10-29" }), P, { d1: "2026-11-01", d2: "2026-11-30", end: "2026-11-02" }).ex, "moved");
  assert.equal(evalRow(row("2026-09-01", "2026-09-10", { next_s: "2026-09-24" }), P, SEPT).ex, "moved");        // рівно 14 днів
  const late = evalRow(row("2026-09-01", "2026-09-10", { next_s: "2026-09-30" }), P, SEPT);                     // через 20 днів — відхід
  assert.deepEqual([late.ex, late.dep], [undefined, true]);
  assert.equal(evalRow(row("2026-09-01", "2026-09-10", { next_s: "2026-09-24" }), { ...P, rehire_days: 0 }, SEPT).ex, undefined);
  assert.equal(evalRow(row("2026-09-01", null, { next_s: "2026-09-05" }), P, SEPT).ex, undefined);             // працює — не чіпаємо
  // причина «przeniesienie» — теж переведення; справжня причина — справжнє звільнення з об'єкта, хоч людину й узяли на інший
  assert.equal(evalRow(row("2026-09-01", "2026-09-10", { next_s: "2026-09-12", reason: "przeniesienie" }), P, SEPT).ex, "moved");
  const fired = evalRow(row("2026-09-01", "2026-09-10", { next_s: "2026-09-12", reason: "Эффективность" }), P, SEPT);
  assert.deepEqual([fired.ex, fired.dep], [undefined, true]);
});

test("premie.evalRow: штраф за відхід на 8–15-й день — лише коли увімкнено", () => {
  const on = { ...P, penalty: { ...P.penalty, enabled: true } };
  assert.equal(evalRow(row("2026-09-01", "2026-09-11"), on, SEPT).pen, -50);   // стаж 10
  assert.equal(evalRow(row("2026-09-01", "2026-09-20"), on, SEPT).pen, 0);     // стаж 19
  assert.equal(evalRow(row("2026-09-01", "2026-09-11"), P, SEPT).pen, 0);      // вимкнено
  assert.equal(evalRow(row("2026-09-01", "2026-09-11", { status: "rezygnacja" }), on, SEPT).pen, undefined);
});

test("premie.evalRow: поточний місяць — пороги після сьогодні окремо", () => {
  const live = { d1: "2026-11-01", d2: "2026-11-30", end: "2026-11-02" };
  const up = evalRow(row("2026-10-10"), P, live);                          // 30 днів → 09.11
  assert.deepEqual([up.poss, up.upKeep, up.thr[0].st], [0, 1, "up"]);
  const lost = evalRow(row("2026-10-10", "2026-11-01"), P, live);           // уже пішов — поріг буде провалено
  assert.deepEqual([lost.poss, lost.upLost, lost.thr[0].st], [0, 1, "lost"]);
  const coreUp = evalRow(row("2026-08-20"), P, live);                       // 80 днів → 08.11
  assert.deepEqual([coreUp.core, coreUp.coreUp, coreUp.upKeep], [false, true, 3]);
});

test("premie.computeMonth: основа own / region / as, k-t, непокриті об'єкти", () => {
  const owners = new Map([
    ["A", { owner_id: 1, owner: "Kowal", region_id: 10, region: "Północ" }],
    ["B", { owner_id: 2, owner: "Nowak", region_id: 10, region: "Północ" }],
    ["C", { owner_id: 3, owner: "Lis", region_id: 20, region: "Południe" }],
  ]);
  const mk = (k, s, l) => ({ ...row(s, l), site_key: k });
  const rows = [mk("A", "2026-05-01"), mk("A", "2026-08-02"), mk("B", "2026-05-01"), mk("B", "2026-08-02", "2026-08-20"), mk("C", "2026-05-01")];
  const coords = new Map([[1, { name: "Kowal" }], [2, { name: "Nowak" }], [3, { name: "Lis" }], [9, { name: "Reg" }], [7, { name: "Pomoc" }]]);
  const config = [
    { coordinator_id: 1, basis: "own", kt: 1 },
    { coordinator_id: 2, basis: "own", kt: 0.5 },
    { coordinator_id: 9, basis: "region", kt: 1 },
    { coordinator_id: 7, basis: "as", as_id: 2, kt: 1 },
  ];
  const r = prm.computeMonth({ month: "2026-09", end: "2026-09-30", rows, owners, leads: new Map([[9, [10]]]), config,
    manual: new Map(), P, coords });
  const by = Object.fromEntries(r.participants.map((p) => [p.name, p]));
  assert.deepEqual([by.Kowal.kadr, by.Kowal.poss, by.Kowal.ach, by.Kowal.core], [2, 1, 1, 1]);
  assert.deepEqual([by.Nowak.kadr, by.Nowak.poss, by.Nowak.ach], [1, 1, 0]);
  assert.deepEqual([by.Reg.kadr, by.Reg.poss, by.Reg.ach, by.Reg.sites], [3, 2, 1, ["A", "B"]]);
  assert.deepEqual(by.Pomoc.sites, ["B"]);
  assert.equal(by.Pomoc.b, by.Nowak.b * 2);                 // ті самі об'єкти, свій k-t (1 проти 0,5)
  assert.deepEqual(r.uncovered.map((x) => x.key), ["C"]);  // Lis не на списку
  assert.equal(r.total, [by.Kowal, by.Nowak, by.Reg, by.Pomoc].reduce((a, p) => a + p.total, 0));
  assert.equal(r.live, false);
});

test("premie.computeMonth: ручне виключення прибирає людину з усіх показників", () => {
  const owners = new Map([["A", { owner_id: 1, owner: "Kowal", region_id: null, region: null }]]);
  const x = { ...row("2026-08-02", "2026-08-20"), site_key: "A", worker_id: 501 };
  const base = { month: "2026-09", end: "2026-09-30", rows: [x], owners, leads: new Map(),
    config: [{ coordinator_id: 1, basis: "own", kt: 1 }], P, coords: new Map([[1, { name: "Kowal" }]]) };
  assert.equal(prm.computeMonth({ ...base, manual: new Map() }).participants[0].poss, 1);
  const r = prm.computeMonth({ ...base, manual: new Map([[501, "decyzja kierownika"]]) });
  assert.equal(r.participants[0].poss, 0);
  assert.equal(r.skipped.manual, 1);
  assert.equal(sumItems(r.items).poss, 0);
});

test("premie.checkParams: стандартні параметри — ok, помилки — зрозумілий текст", () => {
  assert.equal(prm.checkParams(prm.DEFAULTS), null);
  assert.match(prm.checkParams({ ...prm.DEFAULTS, limit_a: -1 }), /kwota/);
  assert.match(prm.checkParams({ ...prm.DEFAULTS, thresholds: [{ days: 30, weight: 1 }, { days: 30, weight: 3 }] }), /powtarzają/);
  assert.match(prm.checkParams({ ...prm.DEFAULTS, scale_b: [{ from: 1.5, pct: 1 }] }), /od 0 do 100/);
  assert.match(prm.checkParams({ ...prm.DEFAULTS, excluded_statuses: ["zwolniony"] }), /odejścia/);
  assert.match(prm.checkParams({ ...prm.DEFAULTS, penalty: { enabled: true, amount: 50, from_days: 8, to_days: 15 } }), /Kara/);
  assert.match(prm.checkParams({ ...prm.DEFAULTS, rehire_days: -1 }), /Przeniesienie/);
});

test("premie.message: текст у Telegram", () => {
  const p = { total: 702.5, a: 320, b: 382.5, vyp: 30 / 45, pct_a: 0.4, share: 56 / 83, pct_b: 0.85, pen: 0, kt: 0.5 };
  assert.equal(prm.message(p, "2026-09", true), [
    "🏆 Премія за вересень 2026: 702,50 zł",
    "",
    "Блок А — доживання: 320 zł (виконання 66,7% → 40% блоку)",
    "Блок Б — ядро: 382,50 zł (ядро 67,5% → 85% блоку)",
    "Коефіцієнт: 0,5",
    "",
    "Деталі — у панелі: 🏆 Premie koordynatorów.",
  ].join("\n"));
  assert.equal(prm._test.zl(1725), "1 725 zł");
  assert.equal(prm._test.zl(-50), "−50 zł");
});

test("premie: місяці й межі", () => {
  assert.deepEqual(prm.monthBounds("2026-02"), { d1: "2026-02-01", d2: "2026-02-28" });
  assert.deepEqual(prm.monthBounds("2026-12"), { d1: "2026-12-01", d2: "2026-12-31" });
  assert.equal(prm.addMonths("2026-12", 1), "2027-01");
  assert.equal(prm.addMonths("2027-01", -1), "2026-12");
  assert.equal(prm.isMonth("2026-13"), false);
});
