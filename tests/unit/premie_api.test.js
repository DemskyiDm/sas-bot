// Premie koordynatorów — права доступу API без БД: npm test
// (db/index.js і авторизація підмінені до підключення api/premie.js; node --test запускає кожен файл окремим процесом)
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const ctx = { who: null, level: null, regions: [] };
const dbPath = require.resolve("../../db");
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  query: async (sql) => {
    if (/FROM prm\.access WHERE coordinator_id = \$1\) AS level/.test(sql)) return { rows: [{ level: ctx.level, regions: ctx.regions }] };
    throw new Error(`БД у цьому тесті немає: ${sql.trim().slice(0, 60)}`);
  },
  pool: { connect: async () => { throw new Error("БД у цьому тесті немає"); } },
} };
const adminPath = require.resolve("../../api/admin");
require.cache[adminPath] = { id: adminPath, filename: adminPath, loaded: true, exports: {
  requireAuth: (req, res, next) => { req.coordinator = ctx.who; next(); },
} };
const express = require("express");
const { router, _test } = require("../../api/premie");

let server, base;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/premie", router);
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/api/premie`;
});
test.after(() => server.close());
async function call(method, path, body) {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json() };
}
const coord = (id) => ({ coordinator_id: id, full_name: `K${id}`, role: "coordinator", is_admin: false });

test("premie api: без доступу — /me каже has_access=false, усе інше 403", async () => {
  Object.assign(ctx, { who: coord(50), level: null, regions: [] });
  const me = await call("GET", "/me");
  assert.equal(me.status, 200);
  assert.deepEqual([me.body.has_access, me.body.full], [false, false]);
  for (const p of ["/month/2026-09", "/params", "/exclusions?month=2026-09", "/months"]) assert.equal((await call("GET", p)).status, 403, p);
});

test("premie api: координатор навіть з «✋ + Wykluczenia» не робить дій адміна / head", async () => {
  Object.assign(ctx, { who: coord(19), level: "excl", regions: [] });
  const admin = [
    ["GET", "/coordinators"], ["PUT", "/month/2026-10/coords", { rows: [] }], ["PUT", "/params", { valid_from: "2026-10", data: {} }],
    ["DELETE", "/params/2026-09"], ["PUT", "/settings", { notify_tg: "1" }], ["PUT", "/access", { ids: [19], level: "excl" }],
    ["POST", "/month/2026-09/approve"], ["POST", "/month/2026-09/unapprove"], ["POST", "/month/2026-09/paid", { paid: true }],
    ["POST", "/month/2026-09/notify"], ["GET", "/log"],
  ];
  for (const [m, p, b] of admin) {
    const r = await call(m, p, b);
    assert.equal(r.status, 403, `${m} ${p}`);
    assert.match(r.body.error, /kierownik działu/, `${m} ${p}`);
  }
});

test("premie api: адміністратор панелі без рівня в «Dostęp» розділу не бачить; з рівнем — лише цей рівень", async () => {
  Object.assign(ctx, { who: { ...coord(10), is_admin: true }, level: null, regions: [] });
  const me = await call("GET", "/me");
  assert.deepEqual([me.body.has_access, me.body.full], [false, false]);
  assert.equal((await call("GET", "/month/2026-09")).status, 403);
  assert.equal((await call("GET", "/coordinators")).status, 403);
  Object.assign(ctx, { level: "people" });
  const me2 = await call("GET", "/me");
  assert.deepEqual([me2.body.has_access, me2.body.full, me2.body.level], [true, false, "people"]);
  assert.equal((await call("POST", "/month/2026-09/approve")).status, 403);
});

test("premie api: рівні own / people не виключають працівників", async () => {
  for (const level of ["own", "people"]) {
    Object.assign(ctx, { who: coord(13), level, regions: [] });
    assert.equal((await call("POST", "/exclusions", { worker_id: 1, month: "2026-10", reason: "x", context_month: "2026-10" })).status, 403, level);
    assert.equal((await call("DELETE", "/exclusions/1?month=2026-10")).status, 403, level);
  }
});

test("premie api: head без запису в prm.access — повний доступ; регіональний — lead", async () => {
  Object.assign(ctx, { who: { ...coord(8), role: "head" }, level: null, regions: [] });
  assert.deepEqual((({ has_access, full, level }) => ({ has_access, full, level }))((await call("GET", "/me")).body), { has_access: true, full: true, level: "excl" });
  Object.assign(ctx, { who: coord(6), level: "own", regions: [1] });
  assert.equal((await call("GET", "/me")).body.lead, true);
});

test("premie api: scoped — координатор бачить лише себе, регіональний — свій регіон, люди — з рівня people", () => {
  const P = (id, basis, sites, total) => ({ id, name: `K${id}`, basis, sites, total, live: { total_min: 0, total_max: total } });
  const res = {
    participants: [P(1, "own", ["s1"], 100), P(2, "own", ["s2"], 200), P(3, "region", ["s1", "s3"], 300), P(4, "as", ["s2"], 400)],
    sites: [{ key: "s1", region_id: 10 }, { key: "s2", region_id: 20 }, { key: "s3", region_id: 10 }],
    items: [{ w: 1, k: "s1" }, { w: 2, k: "s2" }, { w: 3, k: "s3", ex: "manual" }],
    skipped: {}, uncovered: [{ key: "s9" }], config: [{}], total: 1000, range: { min: 0, max: 1000 },
  };
  const own = _test.scoped({ me: 1, full: false, level: "own", regionIds: [] }, res);
  assert.deepEqual([own.participants.map((p) => p.id), own.sites.map((s) => s.key), own.items.length, own.total], [[1], ["s1"], 0, 100]);
  assert.deepEqual([own.uncovered, own.config], [[], undefined]);
  const ppl = _test.scoped({ me: 1, full: false, level: "people", regionIds: [] }, res);
  assert.deepEqual(ppl.items.map((x) => x.w), [1]);
  const lead = _test.scoped({ me: 3, full: false, level: "people", regionIds: [10] }, res);
  assert.deepEqual([lead.participants.map((p) => p.id), lead.sites.map((s) => s.key), lead.items.map((x) => x.w)], [[1, 3], ["s1", "s3"], [1, 3]]);
  assert.deepEqual(lead.skipped, { status: {}, reason: {}, manual: 1, moved: 0 });
  assert.deepEqual([lead.total, lead.range], [400, { min: 0, max: 400 }]);
  assert.equal(_test.scoped({ me: 9, full: true, level: "excl", regionIds: [] }, res), res);
});
