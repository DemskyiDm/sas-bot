// Premie koordynatorów на справжній БД: node --test tests/db/premie.test.js (одна транзакція з ROLLBACK).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const tx = require("./txdb");

let prm;

test.before(async () => {
  await tx.begin();
  const sql = fs.readFileSync(path.join(tx.root, "db", "migration_premie.sql"), "utf8");
  // міграція — у тій самій транзакції; COMMIT у файлі закрив би її, тому його там бути не повинно
  assert.doesNotMatch(sql, /^\s*(BEGIN|COMMIT)\s*;/im);
  await tx.q(sql);
  prm = require(path.join(tx.root, "bot", "premie.js"));
});
test.after(() => tx.end());

test("premie: вересень з бази — учасники з Excel, суми сходяться, «як у» бере об'єкти іншого", async () => {
  const r = await prm.computeLive("2026-09");
  assert.equal(r.live, false);
  assert.equal(r.end, "2026-09-30");
  assert.equal(r.config_from, "2026-09");
  assert.ok(r.participants.length >= 18, `учасників ${r.participants.length}`);
  assert.equal(r.total, Math.round(r.participants.reduce((a, p) => a + (p.total || 0), 0) * 100) / 100);
  const by = (re) => r.participants.find((p) => re.test(p.name));
  // «як у» — ті самі об'єкти, що в того, чий результат бере; з тим самим k-t — та сама премія
  const pol = r.participants.find((p) => p.basis === "as" && r.participants.some((q) => q.id === p.as_id));
  const hord = pol && r.participants.find((p) => p.id === pol.as_id), bry = r.participants.find((p) => p.basis === "region");
  assert.ok(pol && bry, "є «як у» і регіональний");
  assert.deepEqual(pol.sites, hord.sites);
  if (pol.kt === hord.kt) assert.equal(pol.total, hord.total);
  assert.equal(bry.basis, "region");
  // прив'язки — на 30.09 (історія): «свої» об'єкти — де він головний; регіон — об'єкти з регіоном регіонального
  const own = await tx.q(
    `SELECT site_key, coordinator_id, region_id FROM reg.site_owner
      WHERE valid_from <= '2026-09-30' AND (valid_to IS NULL OR valid_to >= '2026-09-30')`);
  const owner = new Map(own.rows.map((x) => [x.site_key, x.coordinator_id]));
  for (const p of r.participants.filter((x) => x.basis === "own")) for (const k of p.sites) assert.equal(owner.get(k), p.id, `${p.name}: ${k}`);
  const regs = (await tx.q(`SELECT region_id FROM reg.region_leads WHERE coordinator_id = $1`, [bry.id])).rows.map((x) => x.region_id);
  assert.deepEqual(bry.sites, own.rows.filter((x) => regs.includes(x.region_id)).map((x) => x.site_key).sort((a, b) => a.localeCompare(b, "pl")));
  // ядро не більше кадру, набрані ваги не більше можливих
  for (const p of r.participants) { assert.ok(p.core <= p.kadr, p.name); assert.ok(p.ach <= p.poss, p.name); }
});

test("premie: ручне виключення зменшує можливі ваги координатора; жовтень успадковує список і параметри", async () => {
  const r = await prm.computeLive("2026-09");
  const x = r.items.find((i) => !i.ex && i.poss > 0 && r.participants.some((p) => p.basis === "own" && p.sites.includes(i.k)));
  assert.ok(x, "є людина з порогом у вересні");
  const p0 = r.participants.find((p) => p.basis === "own" && p.sites.includes(x.k));
  const same = r.items.filter((i) => i.w === x.w && !i.ex).reduce((a, i) => a + (p0.sites.includes(i.k) ? i.poss : 0), 0);
  await tx.q(`INSERT INTO prm.exclusions (worker_id, month, reason) VALUES ($1, '2026-09', 'test')`, [x.w]);
  const r2 = await prm.computeLive("2026-09");
  const p1 = r2.participants.find((p) => p.id === p0.id);
  assert.equal(p1.poss, p0.poss - same);
  assert.ok(r2.items.filter((i) => i.w === x.w).every((i) => i.ex === "manual"));
  assert.equal((await prm.configFor("2026-10")).from, "2026-09");
  assert.equal((await prm.paramsFor("2026-10")).from, "2026-09");
});

test("premie: затвердження — знімок, повторно не можна, скасування; поточний місяць не затверджується", async () => {
  const a = await prm.approve("2026-09", null);
  assert.equal(a.ok, true);
  assert.equal((await prm.approve("2026-09", null)).ok, false);
  const m = await prm.getMonth("2026-09");
  assert.equal(m.run.status, "approved");
  assert.equal(m.total, a.total);
  // знімок не змінюється від нових виключень
  const any = m.items.find((i) => !i.ex);
  await tx.q(`INSERT INTO prm.exclusions (worker_id, month, reason) VALUES ($1, NULL, 'test')`, [any.w]);
  assert.equal((await prm.getMonth("2026-09")).total, a.total);
  assert.equal((await prm.setPaid("2026-09", true, null)).ok, true);
  assert.equal((await prm.unapprove("2026-09", null)).ok, false);       // виплачений — не скасувати
  assert.equal((await prm.setPaid("2026-09", false, null)).ok, true);
  assert.equal((await prm.unapprove("2026-09", null)).ok, true);
  assert.equal(await prm.runOf("2026-09"), null);
  const cur = (await prm.today()).slice(0, 7);
  assert.equal((await prm.approve(cur, null)).ok, false);
});
