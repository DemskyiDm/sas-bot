// Poleć znajomego — премії за місяць на справжній БД: npm run test:db (одна транзакція з ROLLBACK).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const tx = require("./txdb");

let pay;

test.before(async () => {
  await tx.begin();
  // міграція — у тій самій транзакції (якщо ще не застосована)
  await tx.q(fs.readFileSync(path.join(tx.root, "db", "migration_referral_payouts.sql"), "utf8"));
  pay = require(path.join(tx.root, "bot", "referral_pay.js"));
});
test.after(() => tx.end());

// новий працівник із BHP і полецаючий, обидва з v_hires; відповідь «друг», підтверджена
async function seed(bhp, kind) {
  const h = await tx.one(
    `SELECT h.worker_id, h.bhp_date FROM ref.v_hires h
      WHERE NOT EXISTS (SELECT 1 FROM ref.answers a WHERE a.worker_id = h.worker_id AND a.bhp_date = h.bhp_date)
      ORDER BY h.bhp_date DESC LIMIT 1`);
  const ref = await tx.one(`SELECT id FROM v_worker_current WHERE status = 'pracuje' AND login NOT LIKE 'TEST_%' AND id <> $1 LIMIT 1`, [h.worker_id]);
  const co = await tx.one(`SELECT id FROM coordinators WHERE COALESCE(is_active, true) LIMIT 1`);
  // переносимо період нового на потрібну дату BHP, без дати закінчення
  await tx.q(`UPDATE worker_facility_history SET bhp_date = $2::date, last_work_date = NULL WHERE worker_id = $1 AND bhp_date = $3`,
    [h.worker_id, bhp, h.bhp_date]);
  const a = await tx.one(
    `INSERT INTO ref.answers (worker_id, bhp_date, status, source, referrer_text, answered_at, match_state, match_worker_id, match_coordinator_id)
     VALUES ($1, $2::date, 'answered', $3, 'Test Test', now(), 'confirmed', $4, $5) RETURNING id`,
    [h.worker_id, bhp, kind, kind === "friend" ? ref.id : null, kind === "coord" ? co.id : null]);
  return { answer_id: a.id, worker_id: h.worker_id };
}

test("referral_pay: список 11.2026 — друг 400 + координатор 100; повторний запуск — відмова; 12.2026 — друга виплата 200", async () => {
  await tx.q(`DELETE FROM ref.payouts`); await tx.q(`DELETE FROM ref.payout_runs`);
  const f = await seed("2026-10-02", "friend");
  const pre = (await pay.compute("2026-11")).filter((x) => x.answer_id === f.answer_id);
  assert.equal(pre.length, 1);
  assert.equal(pre[0].stage, 1);
  assert.equal(pre[0].worker_amount, 400);
  assert.equal(pre[0].due_date, "2026-10-31");
  if (pre[0].coordinator_id) assert.equal(pre[0].coord_amount, 100);
  else assert.match(pre[0].note, /koordynatora/);

  const r = await pay.run("2026-11", null);
  assert.equal(r.ok, true);
  assert.ok(r.n >= 1);
  assert.equal((await pay.run("2026-11", null)).ok, false);
  assert.equal((await pay.compute("2026-11")).filter((x) => x.answer_id === f.answer_id).length, 0);

  const dec = (await pay.compute("2026-12")).filter((x) => x.answer_id === f.answer_id);
  assert.equal(dec.length, 1);
  assert.equal(dec[0].stage, 2);
  assert.equal(dec[0].worker_amount, 200);
  assert.equal(dec[0].due_date, "2026-11-30");
});

test("referral_pay: координатор привів — 200 за перший місяць, за другий нічого", async () => {
  const c = await seed("2026-09-05", "coord");
  const nov = (await pay.compute("2026-11")).filter((x) => x.answer_id === c.answer_id);
  // 30-й день — 04.10 (у межах), список 11.2026 уже нараховано вище, тож кандидат — у наступному списку
  const dec = (await pay.compute("2026-12")).filter((x) => x.answer_id === c.answer_id);
  const all = [...nov, ...dec];
  assert.ok(all.length >= 1);
  assert.ok(all.every((x) => x.stage === 1 && x.coord_amount === 200 && x.worker_amount === null));
});

test("referral_pay: звільнений після 30-го дня — премія є, з приміткою", async () => {
  const f = await seed("2026-10-01", "friend");
  await tx.q(`UPDATE worker_facility_history SET last_work_date = '2026-10-31' WHERE worker_id = $1 AND bhp_date = '2026-10-01'`, [f.worker_id]);
  const x = (await pay.compute("2026-12")).find((y) => y.answer_id === f.answer_id);
  assert.ok(x);
  assert.equal(x.stage, 1);
  assert.match(x.note, /zwolniony 31\.10\.2026/);
});
