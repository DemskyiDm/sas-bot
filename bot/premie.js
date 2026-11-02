// ══════════════════════════════════════════════════════════════════════
//  «Premie koordynatorów» — премія координаторам за місяць
//  (db/migration_premie.sql, api/premie.js, public/premie.html, docs/PREMIE.md)
//
//  Блок А — доживання. Період роботи, у якого поріг стажу (30 / 80 днів від початку роботи на об'єкті)
//  випав на місяць, дає вагу порогу (1 / 3) у «можливі», а в «набрані» — якщо того дня людина ще працює.
//  Виконання = набрані ÷ можливі → шкала (від 95% — 100% … від 60% — 40%) → × ліміт А × k-t.
//  Блок Б — ядро. Кадр — хто працює на кінець місяця; ядро — з них зі стажем ≥ 80 днів.
//  Частка ядра → шкала → × ліміт Б × k-t.
//  Премія = MIN(А + Б, максимум). Штраф за ранній відхід (стаж 8–15 днів) — лише якщо увімкнено, додається до А.
//  Жодного об'єкта з кадром — премії немає (порожньо), як у Excel.
//
//  Не рахуються: статуси зі списку (rezygnacja, przeniesiony, unknown, do_zatrudnienia), звільнення
//  з причиною зі списку ігнорованих (Редукция …), ручні виключення працівників. Статус і причина важать,
//  лише якщо вихід не пізніше кінця місяця: хто перейшов чи звільнився пізніше, у цьому місяці ще працював.
//  Переведення: період на новому об'єкті починається з дати переведення — від неї й стаж (як у Excel).
//
//  Об'єкт = група закладів (facilities.group_name), як у Region. Головний координатор і регіон — на останній
//  день місяця (reg.site_owner з історією). Поточний місяць рахується «на сьогодні»; пороги, що ще попереду,
//  показуються окремо (хто має дотриматися до кінця місяця).
//  Основа учасника: own — об'єкти, де він головний; region — об'єкти регіонів, де він регіональний;
//  as — об'єкти іншого учасника (за його основою), k-t — свій.
// ══════════════════════════════════════════════════════════════════════
"use strict";

const db = require("../db");

const LOCK = 7_420_533;   // pg_advisory_xact_lock — два затвердження одного місяця одночасно не пройдуть
const STATUSES = ["pracuje", "zwolniony", "przeniesiony", "urlop", "rezygnacja", "l4", "unknown", "do_zatrudnienia"];
const DEFAULTS = {
  base_rate: 6500,
  max_bonus: 2500,
  limit_a: 1600,
  limit_b: 900,
  thresholds: [{ days: 30, weight: 1 }, { days: 80, weight: 3 }],
  scale_a: [{ from: 0.95, pct: 1 }, { from: 0.87, pct: 0.8 }, { from: 0.8, pct: 0.6 }, { from: 0.6, pct: 0.4 }],
  core_days: 80,
  scale_b: [{ from: 0.8, pct: 1 }, { from: 0.7, pct: 0.9 }, { from: 0.6, pct: 0.85 }, { from: 0.55, pct: 0.7 }, { from: 0.4, pct: 0.2 }],
  penalty: { enabled: false, amount: -50, from_days: 8, to_days: 15 },
  exit_status: "zwolniony",
  excluded_statuses: ["rezygnacja", "przeniesiony", "unknown", "do_zatrudnienia"],
  ignored_reasons: ["Редукция", "Лимит 18 месяцев", "Переход напрямую"],
};

// ── Дати ──────────────────────────────────────────────────────────────
const DAY = 86400000;
const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m || ""));
const ms = (iso) => Date.parse(iso + "T00:00:00Z");
const addDays = (iso, n) => new Date(ms(iso) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((ms(b) - ms(a)) / DAY);
// '2026-12' + 1 → '2027-01'
function addMonths(m, n) {
  const [y, mo] = m.split("-").map(Number);
  const t = y * 12 + mo - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}
const monthBounds = (m) => ({ d1: `${m}-01`, d2: addDays(`${addMonths(m, 1)}-01`, -1) });
const r2 = (x) => Math.round(x * 100) / 100;

// ── Параметри ─────────────────────────────────────────────────────────
// Збережені параметри + значення за замовчуванням для відсутніх ключів
function paramsOf(data) {
  const p = Object.assign({}, DEFAULTS, data || {});
  p.penalty = Object.assign({}, DEFAULTS.penalty, (data && data.penalty) || {});
  p.thresholds = [...p.thresholds].sort((a, b) => a.days - b.days);
  return p;
}
// Перевірка параметрів з панелі: текст помилки або null
function checkParams(p, statuses = STATUSES) {
  if (!p || typeof p !== "object") return "Brak parametrów";
  const num = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;
  for (const k of ["base_rate", "max_bonus", "limit_a", "limit_b"])
    if (!num(p[k], 0, 100000)) return `Nieprawidłowa kwota: ${k}`;
  if (!Array.isArray(p.thresholds) || !p.thresholds.length || p.thresholds.length > 4) return "Progi stażu: od 1 do 4";
  const days = new Set();
  for (const t of p.thresholds) {
    if (!t || !Number.isInteger(t.days) || t.days < 1 || t.days > 400) return "Próg stażu: dni od 1 do 400";
    if (!num(t.weight, 0, 10)) return "Waga progu: od 0 do 10";
    if (days.has(t.days)) return "Progi stażu się powtarzają";
    days.add(t.days);
  }
  for (const k of ["scale_a", "scale_b"]) {
    const s = p[k];
    if (!Array.isArray(s) || !s.length || s.length > 8) return `Skala ${k === "scale_a" ? "A" : "B"}: od 1 do 8 progów`;
    const seen = new Set();
    for (const x of s) {
      if (!x || !num(x.from, 0, 1) || !num(x.pct, 0, 1)) return `Skala ${k === "scale_a" ? "A" : "B"}: wartości od 0 do 100%`;
      if (seen.has(x.from)) return `Skala ${k === "scale_a" ? "A" : "B"}: progi się powtarzają`;
      seen.add(x.from);
    }
  }
  if (!Number.isInteger(p.core_days) || p.core_days < 1 || p.core_days > 400) return "Próg rdzenia: dni od 1 do 400";
  const pen = p.penalty;
  if (!pen || typeof pen.enabled !== "boolean" || !num(pen.amount, -10000, 0) ||
      !Number.isInteger(pen.from_days) || !Number.isInteger(pen.to_days) || pen.from_days < 0 || pen.to_days < pen.from_days || pen.to_days > 400)
    return "Kara: kwota ≤ 0, staż od–do w dniach";
  if (!statuses.includes(p.exit_status)) return "Nieznany status odejścia";
  if (!Array.isArray(p.excluded_statuses) || p.excluded_statuses.some((s) => !statuses.includes(s))) return "Nieznany status w pomijanych";
  if (p.excluded_statuses.includes(p.exit_status)) return "Status odejścia nie może być pomijany";
  if (!Array.isArray(p.ignored_reasons) || p.ignored_reasons.length > 50 ||
      p.ignored_reasons.some((r) => typeof r !== "string" || !r.trim() || r.length > 200))
    return "Przyczyny: do 50, każda do 200 znaków";
  return null;
}
// Частка (0–1) → частка блоку за шкалою (перший крок, до якого дотягує)
function scale(steps, x) {
  for (const s of [...steps].sort((a, b) => b.from - a.from)) if (x >= s.from) return s.pct;
  return 0;
}

// ── Розрахунок (чисті функції) ───────────────────────────────────────
// Чи стосується період місяця: працював у вікні або поріг випав на місяць
function relevant(r, P, w) {
  if (!r.s || r.s > w.end) return false;
  if (!r.l || r.l >= w.d1) return true;
  return P.thresholds.some((t) => { const d = addDays(r.s, t.days); return d >= w.d1 && d <= w.d2; });
}
// Один період роботи. w = {d1, d2, end}: end — кінець місяця або сьогодні (поточний місяць).
// manual — причина ручного виключення працівника (або undefined)
function evalRow(r, P, w, manual) {
  const it = { h: r.id, w: r.worker_id, n: r.name, lg: r.login, f: r.facility, k: r.site_key,
    s: r.s, l: r.l || null, st: r.status, rs: r.reason || null };
  if (manual) return { ...it, ex: "manual", exr: manual };
  if (P.excluded_statuses.includes(r.status) && (!r.l || r.l <= w.end)) return { ...it, ex: "status" };
  if (r.reason && r.l && r.l <= w.end && P.ignored_reasons.includes(r.reason)) return { ...it, ex: "reason" };
  const staff = r.s <= w.end && (!r.l || r.l >= w.end);
  const tEnd = daysBetween(r.s, w.end);
  const core = staff && tEnd >= P.core_days;
  let poss = 0, ach = 0, upKeep = 0, upLost = 0;
  const thr = [];
  for (const t of P.thresholds) {
    const date = addDays(r.s, t.days);
    if (date < w.d1 || date > w.d2) continue;
    const alive = !r.l || r.l >= date;
    if (date > w.end) {                                   // поточний місяць: поріг ще попереду
      if (alive) upKeep += t.weight; else upLost += t.weight;
      thr.push({ d: t.days, date, wt: t.weight, st: alive ? "up" : "lost" });
      continue;
    }
    poss += t.weight;
    if (alive) ach += t.weight;
    thr.push({ d: t.days, date, wt: t.weight, st: alive ? "ok" : "fail" });
  }
  const dep = !!r.l && r.l >= w.d1 && r.l <= w.end && r.status === P.exit_status;
  const tExit = r.l ? daysBetween(r.s, r.l) : null;
  const pen = P.penalty.enabled && dep && tExit >= P.penalty.from_days && tExit <= P.penalty.to_days ? P.penalty.amount : 0;
  const coreUp = staff && !core && addDays(r.s, P.core_days) <= w.d2;   // поточний місяць: увійде в ядро, якщо залишиться
  return { ...it, staff, core, tEnd, poss, ach, upKeep, upLost, thr, dep, tExit, pen, coreUp };
}
function sumItems(items) {
  const t = { kadr: 0, core: 0, poss: 0, ach: 0, dep: 0, pen: 0, upKeep: 0, upLost: 0, upN: 0, coreUp: 0 };
  for (const x of items) {
    if (x.ex) continue;
    if (x.staff) t.kadr++;
    if (x.core) t.core++;
    if (x.dep) t.dep++;
    if (x.coreUp) t.coreUp++;
    if (x.upKeep) t.upN++;
    t.poss += x.poss; t.ach += x.ach; t.pen += x.pen; t.upKeep += x.upKeep; t.upLost += x.upLost;
  }
  t.pen = r2(t.pen);
  return t;
}
// Блоки й премія з підсумків. sites — скільки об'єктів з кадром (0 → премії немає, як у Excel)
function blocks(t, P, kt, sites) {
  const vyp = t.poss ? t.ach / t.poss : 0;
  const share = t.kadr ? t.core / t.kadr : 0;
  const pctA = scale(P.scale_a, vyp);
  const pctB = scale(P.scale_b, share);
  const aRaw = r2(pctA * P.limit_a * kt);
  const a = r2(aRaw + t.pen);
  const b = r2(pctB * P.limit_b * kt);
  return { vyp, pct_a: pctA, a_raw: aRaw, a, share, pct_b: pctB, b, total: sites > 0 ? r2(Math.min(a + b, P.max_bonus)) : null };
}
// Поточний місяць: межі на кінець місяця — ніхто з тих, у кого поріг ще попереду, не дотримається (min)
// або всі дотримаються й увійдуть у ядро (max). Сума «на сьогодні» на початку місяця нічого не каже
// (порогів ще мало), тому панель показує премію поточного місяця як «min – max».
function outlook(t, P, kt, sites) {
  const all = t.poss + t.upKeep + t.upLost;
  const best = blocks({ ...t, poss: all, ach: t.ach + t.upKeep, core: t.core + t.coreUp }, P, kt, sites);
  const worst = blocks({ ...t, poss: all }, P, kt, sites);
  return { up_keep: t.upKeep, up_lost: t.upLost, up_n: t.upN, core_up: t.coreUp,
    vyp_min: worst.vyp, vyp_max: best.vyp, pct_a_min: worst.pct_a, pct_a_max: best.pct_a, a_min: worst.a, a_max: best.a,
    share_max: best.share, pct_b_max: best.pct_b, b_max: best.b, total_min: worst.total, total_max: best.total };
}

// Учасник → об'єкти за його основою (as — за основою того, чий результат бере; ланцюжок до 3 кроків)
function sitesOf(cfg, byCoord, owners, leadRegions, depth = 0) {
  if (cfg.basis === "region") {
    const regs = new Set(leadRegions.get(cfg.coordinator_id) || []);
    return [...owners].filter(([, o]) => o.region_id != null && regs.has(o.region_id)).map(([k]) => k);
  }
  const id = cfg.basis === "as" ? cfg.as_id : cfg.coordinator_id;
  if (cfg.basis === "as" && byCoord.has(id) && depth < 3 && id !== cfg.coordinator_id)
    return sitesOf(byCoord.get(id), byCoord, owners, leadRegions, depth + 1);
  return [...owners].filter(([, o]) => o.owner_id === id).map(([k]) => k);
}

// Місяць цілком. rows — періоди роботи; owners: Map site_key → {owner_id, owner, region_id, region};
// leads: Map coordinator_id → [region_id]; config — учасники; manual: Map worker_id → причина;
// coords: Map id → {name, active}
function computeMonth({ month, end, rows, owners, leads, config, manual, P, coords }) {
  const { d1, d2 } = monthBounds(month);
  const w = { d1, d2, end };
  const items = [];
  const skipped = { status: {}, reason: {}, manual: 0 };
  for (const r of rows) {
    if (!relevant(r, P, w)) continue;
    const x = evalRow(r, P, w, manual.get(r.worker_id));
    items.push(x);
    if (x.ex === "status") skipped.status[x.st] = (skipped.status[x.st] || 0) + 1;
    else if (x.ex === "reason") skipped.reason[x.rs] = (skipped.reason[x.rs] || 0) + 1;
    else if (x.ex === "manual") skipped.manual++;
  }
  // об'єкти: усі з людьми в місяці + усі з головним на кінець місяця
  const byKey = new Map();
  const site = (k) => {
    if (!byKey.has(k)) {
      const o = owners.get(k) || {};
      byKey.set(k, { key: k, owner_id: o.owner_id || null, owner: o.owner || null, region_id: o.region_id == null ? null : o.region_id,
        region: o.region || null, facilities: new Set(), items: [] });
    }
    return byKey.get(k);
  };
  for (const x of items) { const s = site(x.k); s.facilities.add(x.f); s.items.push(x); }
  for (const k of owners.keys()) site(k);
  const sites = [...byKey.values()].map((s) => {
    const t = sumItems(s.items);
    return { key: s.key, owner_id: s.owner_id, owner: s.owner, region_id: s.region_id, region: s.region,
      facilities: [...s.facilities].sort(), n: s.items.length, ...t,
      vyp: t.poss ? t.ach / t.poss : null, share: t.kadr ? t.core / t.kadr : null };
  }).sort((a, b) => a.key.localeCompare(b.key, "pl"));
  const siteBy = new Map(sites.map((s) => [s.key, s]));

  const byCoord = new Map(config.map((c) => [c.coordinator_id, c]));
  const covered = new Set();
  const parts = config.map((c) => {
    const keys = sitesOf(c, byCoord, owners, leads);
    if (c.basis !== "region") keys.forEach((k) => covered.add(k));
    const list = keys.map((k) => siteBy.get(k)).filter(Boolean);
    const t = sumItems(list.flatMap((s) => byKey.get(s.key).items));
    const withStaff = list.filter((s) => s.kadr > 0).length;
    const kt = Number(c.kt);
    const regs = {};
    list.forEach((s) => { if (s.region) regs[s.region] = (regs[s.region] || 0) + s.kadr + 1; });
    const co = coords.get(c.coordinator_id) || {};
    const asName = c.basis === "as" ? (coords.get(c.as_id) || {}).name || null : null;
    return {
      id: c.coordinator_id, name: co.name || `#${c.coordinator_id}`, active: co.active !== false,
      basis: c.basis, as_id: c.basis === "as" ? c.as_id : null, as_name: asName, kt, note: c.note || null,
      region: Object.keys(regs).sort((a, b) => regs[b] - regs[a])[0] || null,
      sites: keys.filter((k) => siteBy.has(k)).sort((a, b) => a.localeCompare(b, "pl")), n_sites: withStaff,
      kadr: t.kadr, dep: t.dep, poss: t.poss, ach: t.ach, core: t.core, pen: t.pen,
      ...blocks(t, P, kt, withStaff),
      live: end < d2 ? outlook(t, P, kt, withStaff) : null,
    };
  });
  const order = { region: 0, own: 1, as: 2 };
  parts.sort((a, b) => String(a.region || "~").localeCompare(String(b.region || "~"), "pl") ||
    order[a.basis] - order[b.basis] || a.name.localeCompare(b.name, "pl"));
  const uncovered = sites.filter((s) => !covered.has(s.key) && (s.kadr || s.poss || s.dep || s.upKeep))
    .map((s) => ({ key: s.key, owner_id: s.owner_id, owner: s.owner, region: s.region, kadr: s.kadr, poss: s.poss }));
  const sum = (f) => r2(parts.reduce((a, p) => a + (f(p) || 0), 0));
  const total = sum((p) => p.total);
  const range = end < d2 ? { min: sum((p) => p.live.total_min), max: sum((p) => p.live.total_max) } : null;
  return { month, d1, d2, end, live: end < d2, params: P, participants: parts, sites, items, skipped, uncovered, total, range };
}

// ── Повідомлення в Telegram після затвердження ──────────────────────
const UA_MONTHS = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];
function zl(v) {
  const n = Number(v) || 0;
  const [i, f] = Math.abs(n).toFixed(2).split(".");
  return `${n < 0 ? "−" : ""}${i.replace(/\B(?=(\d{3})+(?!\d))/g, " ")}${f === "00" ? "" : "," + f} zł`;
}
const pctTxt = (x, digits = 1) => `${(x * 100).toFixed(digits).replace(".", ",").replace(/,0$/, "")}%`;
function message(p, month, withLink) {
  const [y, m] = month.split("-");
  const lines = [
    `🏆 Премія за ${UA_MONTHS[Number(m) - 1]} ${y}: ${zl(p.total)}`,
    "",
    `Блок А — доживання: ${zl(p.a)} (виконання ${pctTxt(p.vyp)} → ${pctTxt(p.pct_a, 0)} блоку)`,
    `Блок Б — ядро: ${zl(p.b)} (ядро ${pctTxt(p.share)} → ${pctTxt(p.pct_b, 0)} блоку)`,
  ];
  if (p.pen) lines.push(`Штрафи за ранні звільнення: ${zl(p.pen)}`);
  if (p.kt !== 1) lines.push(`Коефіцієнт: ${String(p.kt).replace(".", ",")}`);
  if (withLink) lines.push("", "Деталі — у панелі: 🏆 Premie koordynatorów.");
  return lines.join("\n");
}

// ══════════════════════════════════════════════════════════════════════
//  База
// ══════════════════════════════════════════════════════════════════════
async function today() {
  return (await db.query(`SELECT to_char((now() AT TIME ZONE 'Europe/Warsaw')::date, 'YYYY-MM-DD') AS d`)).rows[0].d;
}
async function statuses() {
  try {
    const r = await db.query(`SELECT unnest(enum_range(NULL::public.worker_status))::text AS s`);
    return r.rows.map((x) => x.s);
  } catch (e) { return STATUSES; }
}
// Параметри місяця: останній набір з valid_from ≤ місяця (місяць раніше за перший набір — перший набір)
async function paramsFor(month) {
  const r = await db.query(
    `SELECT valid_from, data FROM prm.params
      ORDER BY (valid_from <= $1) DESC, CASE WHEN valid_from <= $1 THEN valid_from END DESC, valid_from
      LIMIT 1`, [month]);
  const x = r.rows[0];
  return { from: x ? x.valid_from : null, P: paramsOf(x && x.data) };
}
// Учасники місяця; немає власного списку — останній попередній (from — з якого місяця)
async function configFor(month) {
  const m = await db.query(`SELECT max(month) AS m FROM prm.month_coords WHERE month <= $1`, [month]);
  const from = m.rows[0].m;
  if (!from) return { from: null, rows: [] };
  const r = await db.query(
    `SELECT coordinator_id, basis, as_id, kt::float AS kt, note FROM prm.month_coords WHERE month = $1 ORDER BY coordinator_id`, [from]);
  return { from, rows: r.rows };
}
async function manualFor(month) {
  const r = await db.query(
    `SELECT DISTINCT ON (worker_id) worker_id, reason FROM prm.exclusions
      WHERE removed_at IS NULL AND (month IS NULL OR month = $1)
      ORDER BY worker_id, month NULLS LAST, id DESC`, [month]);
  return new Map(r.rows.map((x) => [x.worker_id, x.reason]));
}
async function loadRows(d1, end, maxDays) {
  const r = await db.query(
    `SELECT h.id, h.worker_id, w.full_name AS name, w.login, f.name AS facility,
            reg.site_key(f.group_name, f.name) AS site_key, h.status::text AS status,
            NULLIF(btrim(h.przyczyna_zwolnienia), '') AS reason,
            to_char(h.bhp_date, 'YYYY-MM-DD') AS s, to_char(h.last_work_date, 'YYYY-MM-DD') AS l
       FROM public.worker_facility_history h
       JOIN public.workers w    ON w.id = h.worker_id
       JOIN public.facilities f ON f.id = h.facility_id
      WHERE h.bhp_date IS NOT NULL AND h.bhp_date <= $2::date
        AND (h.bhp_date >= $1::date - $3::int OR h.last_work_date IS NULL OR h.last_work_date >= $1::date)
        AND COALESCE(w.login, '') !~* '^TEST_'
      ORDER BY w.full_name, h.bhp_date`, [d1, end, maxDays]);
  return r.rows;
}
// Головний і регіон кожного об'єкта на дату
async function loadOwners(day) {
  const r = await db.query(
    `SELECT DISTINCT ON (so.site_key) so.site_key, so.coordinator_id AS owner_id, c.full_name AS owner,
            so.region_id, rg.name AS region
       FROM reg.site_owner so
       LEFT JOIN public.coordinators c ON c.id = so.coordinator_id
       LEFT JOIN reg.regions rg ON rg.id = so.region_id
      WHERE so.valid_from <= $1::date AND (so.valid_to IS NULL OR so.valid_to >= $1::date)
      ORDER BY so.site_key, so.valid_from DESC`, [day]);
  return new Map(r.rows.map((x) => [x.site_key, { owner_id: x.owner_id, owner: x.owner, region_id: x.region_id, region: x.region }]));
}
async function loadLeads() {
  const r = await db.query(
    `SELECT rl.coordinator_id, rl.region_id FROM reg.region_leads rl JOIN reg.regions rg ON rg.id = rl.region_id WHERE rg.is_active`);
  const m = new Map();
  r.rows.forEach((x) => m.set(x.coordinator_id, [...(m.get(x.coordinator_id) || []), x.region_id]));
  return m;
}
async function loadCoords() {
  const r = await db.query(`SELECT id, full_name, COALESCE(is_active, true) AS active FROM public.coordinators`);
  return new Map(r.rows.map((x) => [x.id, { name: x.full_name, active: x.active }]));
}

// Розрахунок місяця з бази «зараз» (без знімка)
async function computeLive(month) {
  if (!isMonth(month)) throw new Error("Nieprawidłowy miesiąc");
  const t = await today();
  const { d1, d2 } = monthBounds(month);
  if (d1 > t) throw new Error("Miesiąc jeszcze się nie zaczął");
  const end = d2 < t ? d2 : t;
  const [{ from: paramsFrom, P }, cfg, manual, owners, leads, coords] = await Promise.all([
    paramsFor(month), configFor(month), manualFor(month), loadOwners(end), loadLeads(), loadCoords()]);
  const rows = await loadRows(d1, end, Math.max(...P.thresholds.map((x) => x.days)));
  const res = computeMonth({ month, end, rows, owners, leads, config: cfg.rows, manual, P, coords });
  res.live = d2 >= t;   // останній день місяця ще триває — теж «на сьогодні»
  res.params_from = paramsFrom;
  res.config_from = cfg.from;
  res.config = cfg.rows;
  return res;
}
async function runOf(month) {
  const r = await db.query(
    `SELECT r.month, r.status, r.result, r.total::float AS total, r.approved_at, r.paid_at, r.notified_at, r.notified_n,
            a.full_name AS approved_by_name, p.full_name AS paid_by_name
       FROM prm.runs r
       LEFT JOIN public.coordinators a ON a.id = r.approved_by
       LEFT JOIN public.coordinators p ON p.id = r.paid_by
      WHERE r.month = $1`, [month]);
  return r.rows[0] || null;
}
// Місяць для панелі: затверджений — знімок, інакше розрахунок «зараз»
async function getMonth(month) {
  const run = await runOf(month);
  if (run) {
    const { result, ...meta } = run;
    return { ...result, run: meta };
  }
  return { ...(await computeLive(month)), run: null };
}

async function log(byId, action, month, details) {
  await db.query(`INSERT INTO prm.log (by_id, action, month, details) VALUES ($1, $2, $3, $4)`,
    [byId || null, action, month || null, details ? JSON.stringify(details) : null]);
}

// Затвердити місяць: знімок розрахунку; список учасників фіксується за місяцем (наступні успадкують його)
async function approve(month, byId) {
  if (!isMonth(month)) return { ok: false, error: "Nieprawidłowy miesiąc" };
  const t = await today();
  if (monthBounds(month).d2 >= t) return { ok: false, error: "Miesiąc jeszcze trwa — zatwierdzić można od pierwszego dnia następnego" };
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [LOCK]);
    if ((await client.query(`SELECT 1 FROM prm.runs WHERE month = $1`, [month])).rows.length) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Miesiąc jest już zatwierdzony" };
    }
    const res = await computeLive(month);
    if (!res.participants.length) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Brak koordynatorów na liście miesiąca" };
    }
    if (res.config_from !== month) {
      for (const c of res.config)
        await client.query(
          `INSERT INTO prm.month_coords (month, coordinator_id, basis, as_id, kt, note, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (month, coordinator_id) DO NOTHING`,
          [month, c.coordinator_id, c.basis, c.as_id, c.kt, c.note, byId || null]);
      res.config_from = month;
    }
    await client.query(
      `INSERT INTO prm.runs (month, result, total, approved_by) VALUES ($1, $2, $3, $4)`,
      [month, JSON.stringify(res), res.total, byId || null]);
    await client.query(
      `INSERT INTO prm.log (by_id, action, month, details) VALUES ($1, 'approve', $2, $3)`,
      [byId || null, month, JSON.stringify({ total: res.total, n: res.participants.length })]);
    await client.query("COMMIT");
    return { ok: true, total: res.total, n: res.participants.length };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
async function unapprove(month, byId) {
  const r = await db.query(`DELETE FROM prm.runs WHERE month = $1 AND status = 'approved' RETURNING total::float AS total`, [month]);
  if (!r.rows.length) return { ok: false, error: "Miesiąc nie jest zatwierdzony albo jest już wypłacony" };
  await log(byId, "unapprove", month, { total: r.rows[0].total });
  return { ok: true };
}
async function setPaid(month, paid, byId) {
  const r = await db.query(
    paid
      ? `UPDATE prm.runs SET status = 'paid', paid_at = now(), paid_by = $2 WHERE month = $1 AND status = 'approved' RETURNING month`
      : `UPDATE prm.runs SET status = 'approved', paid_at = NULL, paid_by = NULL WHERE month = $1 AND status = 'paid' RETURNING month`,
    paid ? [month, byId || null] : [month]);
  if (!r.rows.length) return { ok: false, error: paid ? "Najpierw zatwierdź miesiąc" : "Miesiąc nie jest oznaczony jako wypłacony" };
  await log(byId, paid ? "paid" : "unpaid", month, null);
  return { ok: true };
}

// Учасникам затвердженого місяця — їхня премія в Telegram (один раз; force — повторно)
async function notify(bot, month, byId, force) {
  const run = await runOf(month);
  if (!run) return { ok: false, error: "Miesiąc nie jest zatwierdzony" };
  if (run.notified_at && !force) return { ok: false, error: "Powiadomienia już wysłano" };
  if (!bot) return { ok: false, error: "Bot niedostępny" };
  const parts = run.result.participants.filter((p) => p.total != null && p.kt > 0);
  const r = await db.query(
    `SELECT c.id, c.telegram_chat_id AS chat, COALESCE(c.is_active, true) AS active,
            (ca.is_admin OR c.role = 'head' OR a.coordinator_id IS NOT NULL) AS panel
       FROM public.coordinators c
       LEFT JOIN public.coordinator_auth ca ON ca.coordinator_id = c.id
       LEFT JOIN prm.access a ON a.coordinator_id = c.id
      WHERE c.id = ANY($1::int[])`, [parts.map((p) => p.id)]);
  const who = new Map(r.rows.map((x) => [x.id, x]));
  let sent = 0, failed = 0, noTg = 0;
  for (const p of parts) {
    const c = who.get(p.id);
    if (!c || !c.active || !c.chat) { noTg++; continue; }
    try {
      await bot.telegram.sendMessage(c.chat, message(p, month, !!c.panel));
      sent++;
    } catch (e) {
      console.error("[premie] telegram", p.id, e.message);
      failed++;
    }
  }
  await db.query(`UPDATE prm.runs SET notified_at = now(), notified_n = $2 WHERE month = $1`, [month, sent]);
  await log(byId, "notify", month, { sent, failed, no_tg: noTg });
  return { ok: true, sent, failed, no_tg: noTg };
}
async function settings() {
  const r = await db.query(`SELECT key, value FROM prm.settings`);
  return Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
}

module.exports = {
  DEFAULTS, STATUSES, isMonth, addMonths, monthBounds, paramsOf, checkParams, scale,
  computeMonth, computeLive, getMonth, runOf, approve, unapprove, setPaid, notify, message, settings, log,
  today, statuses, paramsFor, configFor, loadCoords,
  _test: { relevant, evalRow, sumItems, blocks, outlook, sitesOf, zl, pctTxt },
};
