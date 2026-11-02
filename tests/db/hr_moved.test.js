// HRappka-імпорт: закритий «zwolniony» без справжньої причини, а за ≤ 14 днів людина працює на іншому об'єкті → przeniesiony.
// На справжній БД: node --test tests/db/hr_moved.test.js (одна транзакція з ROLLBACK).
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const tx = require("./txdb");

let hr;

test.before(async () => {
  await tx.begin();
  hr = require(path.join(tx.root, "bot", "hr_import.js"));
});
test.after(() => tx.end());

test("hr_import.markMoved: переведення замість звільнення — лише без справжньої причини й на іншому об'єкті", async () => {
  const [f1, f2] = (await tx.q(`SELECT id FROM public.facilities ORDER BY id LIMIT 2`)).rows.map((x) => x.id);
  // період zwolniony 20.10–26.10 на f1 і наступний період людини
  const mk = async (tag, prev, next) => {
    const w = await tx.one(`INSERT INTO public.workers (login, full_name) VALUES ($1, $2) RETURNING id`, [`TEST_MOVED_${tag}`, `TEST MOVED ${tag}`]);
    const p = await tx.one(
      `INSERT INTO public.worker_facility_history
         (worker_id, facility_id, status, bhp_date, last_work_date, przyczyna_zwolnienia, przyczyna_zrodlo, przyczyna_problem, source_sheet)
       VALUES ($1, $2, 'zwolniony', '2026-10-20', '2026-10-26', $3, $4, $5, 'test') RETURNING id`,
      [w.id, f1, prev.reason || null, prev.src || null, prev.problem || null]);
    await tx.q(`INSERT INTO public.worker_facility_history (worker_id, facility_id, status, bhp_date, source_sheet)
                VALUES ($1, $2, $3::worker_status, $4, 'test')`, [w.id, next.same ? f1 : f2, next.status || "pracuje", next.bhp]);
    return p.id;
  };
  const ids = {
    andrii: await mk("A", { problem: "next_period" }, { bhp: "2026-10-29" }),                 // як YELPASHEV ANDRII
    viber: await mk("B", { reason: "przeniesienie", src: "viber" }, { bhp: "2026-10-28" }),
    fired: await mk("C", { reason: "Эффективность", src: "hrappka" }, { bhp: "2026-10-28" }), // справжнє звільнення з об'єкта
    late: await mk("D", { problem: "next_period" }, { bhp: "2026-11-15" }),                   // через 20 днів
    same: await mk("E", { problem: "next_period" }, { bhp: "2026-10-28", same: true }),       // той самий об'єкт
    rez: await mk("F", { problem: "next_period" }, { bhp: "2026-10-28", status: "rezygnacja" }),
    waiting: await mk("G", {}, { bhp: "2026-10-28" }),   // причину ще чекаємо — bot/hr_reason.js ще не поставив next_period
  };
  assert.ok((await hr._test.markMoved({ query: tx.q })) >= 2);
  const st = (id) => tx.one(
    `SELECT status::text AS status, przyczyna_zwolnienia AS r, przyczyna_zrodlo AS src, przyczyna_problem AS pr
       FROM public.worker_facility_history WHERE id = $1`, [id]);
  assert.deepEqual(await st(ids.andrii), { status: "przeniesiony", r: "przeniesienie", src: "auto", pr: null });
  assert.deepEqual(await st(ids.viber), { status: "przeniesiony", r: "przeniesienie", src: "viber", pr: null });
  for (const k of ["fired", "late", "same", "rez", "waiting"]) assert.equal((await st(ids[k])).status, "zwolniony", k);
  assert.equal(await hr._test.markMoved({ query: tx.q }), 0);   // повторно — нічого
});
