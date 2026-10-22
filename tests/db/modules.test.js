// Тести на справжній БД: npm run test:db — усе в одній транзакції з ROLLBACK (у базі нічого не лишається).
// Бот / пошта / HRappka не викликаються.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const tx = require("./txdb");

let fines, office, hr, coord;
let admin, plain, plainFacs, mine, other;

test.before(async () => {
  await tx.begin();
  fines = require(path.join(tx.root, "bot", "fines.js"));
  office = require(path.join(tx.root, "bot", "office.js"));
  hr = require(path.join(tx.root, "bot", "hr_sign.js"));
  coord = require(path.join(tx.root, "bot", "coord.js"));
  const admId = (await tx.one(`SELECT coordinator_id FROM coordinator_auth WHERE is_admin LIMIT 1`)).coordinator_id;
  admin = await coord.coordById(admId); admin.is_admin = true;
  // звичайний координатор з обʼєктом: не адмін, не head, не регіональний
  const pid = (await tx.one(
    `SELECT cf.coordinator_id FROM coordinator_facilities cf JOIN coordinators c ON c.id = cf.coordinator_id
      WHERE cf.is_primary AND c.role <> 'head' AND COALESCE(c.is_active, true)
        AND NOT EXISTS (SELECT 1 FROM reg.region_leads rl WHERE rl.coordinator_id = cf.coordinator_id)
        AND NOT EXISTS (SELECT 1 FROM coordinator_auth ca WHERE ca.coordinator_id = cf.coordinator_id AND ca.is_admin)
        AND EXISTS (SELECT 1 FROM v_worker_current v WHERE v.facility_id = cf.facility_id AND v.status = 'pracuje' AND v.login NOT LIKE 'TEST_%')
      LIMIT 1`)).coordinator_id;
  plain = await coord.coordById(pid); plain.is_admin = false;
  plainFacs = await fines.issueFacs(plain);
  mine = (await tx.one(`SELECT id FROM v_worker_current WHERE facility_id = ANY($1) AND status = 'pracuje' AND login NOT LIKE 'TEST_%' LIMIT 1`, [plainFacs])).id;
  other = (await tx.one(`SELECT id FROM v_worker_current WHERE NOT (facility_id = ANY($1)) AND status = 'pracuje' AND login NOT LIKE 'TEST_%' LIMIT 1`, [plainFacs])).id;
});
test.after(() => tx.end());

// ── Штрафи ────────────────────────────────────────────────────────────
test("fines: координатор виписує лише на своїх обʼєктах; без суми й з майбутньою датою — ні", async () => {
  const t = (await fines.types(false))[0];
  const manual = (await fines.types(false)).find((x) => x.amount == null);
  assert.equal((await fines.issue(plain, { worker_id: other, type_id: t.id, amount: 500 })).ok, false);
  assert.equal((await fines.issue(plain, { worker_id: mine, type_id: manual.id })).error, "bad_amount");
  assert.equal((await fines.issue(plain, { worker_id: mine, type_id: t.id, amount: 100, fine_date: "2099-01-01" })).error, "bad_date");
  const ok = await fines.issue(plain, { worker_id: mine, type_id: t.id, amount: 450 });
  assert.equal(ok.ok, true);
});

test("fines: після «в офіс» змінити / скасувати може лише адмін", async () => {
  const t = (await fines.types(false))[0];
  const a = await fines.issue(plain, { worker_id: mine, type_id: t.id, amount: 300 });
  const m = await tx.one(`INSERT INTO tgc.office_mails (kind, sent_by, mail_to, status) VALUES ('fin', $1, ARRAY['t@t.pl'], 'sent') RETURNING id`, [plain.id]);
  await tx.q(`INSERT INTO tgc.office_items (mail_id, kind, ref_id) VALUES ($1, 'fin', $2)`, [m.id, a.id]);
  assert.equal((await fines.cancel(plain, a.id, "x")).error, "sent_admin_only");
  assert.equal((await fines.cancel(admin, a.id, "x")).ok, true);
  assert.equal((await fines.cancel(admin, a.id, "x")).error, "already_cancelled");
});

test("fines: штраф тестовому працівнику (TEST_) не йде в підсумки й в офіс", async () => {
  const tw = await tx.one(`SELECT v.id FROM v_worker_current v WHERE v.login LIKE 'TEST_%' AND v.status = 'pracuje' LIMIT 1`);
  if (!tw) return;
  const t = (await fines.types(false))[0];
  const r = await fines.issue(admin, { worker_id: tw.id, type_id: t.id, amount: 500 });
  assert.equal(r.ok, true);
  assert.equal((await fines.forSend(admin, [r.id])).length, 0);
  const row = (await fines.list(admin, { ids: [r.id] })).rows[0];
  assert.equal(row.is_test, true);
});

test("fines: типи змінює лише адмін / head", async () => {
  assert.equal((await fines.saveType(plain, { name_pl: "X" })).error, "forbidden");
  assert.equal((await fines.saveType(admin, { name_pl: "Y", amount: -1 })).error, "bad_amount");
  assert.equal((await fines.saveType(admin, { name_pl: "Test kara", amount: 75 })).ok, true);
});

// ── Медогляд ──────────────────────────────────────────────────────────
test("med: панель увімкнена за замовчуванням, вимкнена — коли вимкнули", async () => {
  await tx.q(`DELETE FROM tgc.med_coords WHERE coordinator_id = $1`, [plain.id]);
  assert.equal(await office.medAccess(plain), true);
  assert.equal((await office.medSaveCoord(admin, plain.id, false)).ok, true);
  assert.equal(await office.medAccess(plain), false);
  assert.equal((await office.medSaveCoord(plain, plain.id, true)).error, "forbidden");
});

test("med: вимкнені заклади не показуються в налаштуваннях; тип sanepid зберігається", async () => {
  const s = await office.medSettings(admin);
  const inactive = await tx.one(`SELECT count(*)::int n FROM facilities WHERE id = ANY($1::int[]) AND is_active = false`, [s.rows.map((x) => x.facility_id)]);
  assert.equal(inactive.n, 0);
  const f = s.rows[0];
  assert.equal((await office.medSaveFacility(admin, f.facility_id, "sanepid", "  ul. Test 1 ")).ok, true);
  assert.equal((await office.medSaveFacility(admin, f.facility_id, "xx", "")).error, "bad_kind");
  const after = (await office.medSettings(admin)).rows.find((x) => x.facility_id === f.facility_id);
  assert.equal(after.kind, "sanepid");
  assert.equal(after.address, "ul. Test 1");
});

// ── Підписи HRappka ───────────────────────────────────────────────────
test("hr: вікно ±10 днів від BHP, повторний документ — останній, анкети рахуються", async () => {
  const w = await tx.one(`SELECT v.id, to_char(v.bhp_date, 'YYYY-MM-DD') AS bhp FROM v_worker_current v WHERE v.bhp_date IS NOT NULL AND v.login NOT LIKE 'TEST_%' LIMIT 1`);
  await tx.q(`DELETE FROM hrs.docs WHERE worker_id = $1`, [w.id]);
  await tx.q(`DELETE FROM hrs.surveys WHERE worker_id = $1`, [w.id]);
  await tx.q(`INSERT INTO hrs.checks (worker_id, checked_at, found) VALUES ($1, now(), true) ON CONFLICT (worker_id) DO UPDATE SET found = true, error = NULL`, [w.id]);
  const d = (n) => `(DATE '${w.bhp}' + ${n})::timestamp`;
  await tx.q(`INSERT INTO hrs.docs (hr_doc_id, worker_id, display_name, hr_created_at, status) VALUES
    (-1, $1, 'x___umowa_2026_01_01_00_00_00.pdf', ${d(-30)}, 'SEND'),     -- старий період — не рахується
    (-2, $1, 'x___umowa_2026_01_01_00_00_00.pdf', ${d(0)},  'SEND'),      -- перша відправка
    (-3, $1, 'x___umowa_2026_01_01_00_00_01.pdf', ${d(2)},  'SIGN'),      -- повторна, підписана — рахується вона
    (-4, $1, 'x___pit_2_2026_01_01_00_00_00.pdf', ${d(1)},  'SEND')`, [w.id]);
  await tx.q(`INSERT INTO hrs.surveys (hr_answer_id, worker_id, name, state, hr_created_at) VALUES
    (-1, $1, 'ANKIETA DO PRACOWNIKA', 'SENT', ${d(1)}), (-2, $1, 'STARA', 'SENT', ${d(-40)})`, [w.id]);
  const s = (await hr.summary([w.id]))[w.id];
  assert.equal(s.total, 3);                                   // umowa (остання), pit 2, анкета; старі — ні
  assert.equal(s.signed, 1);
  assert.deepEqual(s.docs.filter((x) => x.kind === "survey").map((x) => x.label), ["ANKIETA DO PRACOWNIKA"]);
  assert.equal(s.docs.find((x) => x.label === "umowa").status, "SIGN");
});

test("hr: нагадування — раз на пакет, повторно не надсилається", async () => {
  const sent = [];
  hr._test.setBot({ telegram: { sendMessage: async (chat, text) => { sent.push(text); return {}; } } });
  const before = (await hr.reminders()).length;
  const r1 = await hr.remind();
  assert.equal(r1.sent, before);
  if (before) assert.match(sent[0], /e-mail|почт|poczt/i);
  assert.equal((await hr.remind()).sent, 0);
  hr._test.setBot(null);
});
