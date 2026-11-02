// ══════════════════════════════════════════════════════════════════════
//  «Poleć znajomego» — нарахування премій за місяць (db/migration_referral_payouts.sql)
//
//  Хто привів працівник:   йому pay_friend_1 (400) за 30 днів і pay_friend_2 (200) за 60 днів;
//                          координатору того, хто привів, — pay_coord_month (100) за кожен із цих місяців.
//  Хто привів координатор: йому pay_coord_ref (200) за 30 днів, за другий місяць — нічого.
//
//  Дні календарні від BHP включно (BHP 02.10 → 30-й день 31.10), переведення і перерва ≤ 14 днів
//  стаж не переривають. Список місяця P ('YYYY-MM') — стан на 1-ше число P: етапи, у яких 30-й / 60-й
//  день ≤ останнього дня попереднього місяця, ≥ pay_from і ще не нараховані. Новий звільнився
//  після 30-го дня — премія є, у примітці «zwolniony». Полецаючий звільнився — премія теж є.
//  Нараховане не змінюється; підтвердили зіставлення пізніше — етап потрапить у наступний список.
//
//  Запуск: автоматично pay_day (4) числа — tick у bot/referral.js; кнопка — POST /api/ref/payouts/run.
// ══════════════════════════════════════════════════════════════════════
const db = require("../db");

const STAGE_DAYS = 30;
const LOCK = 7_420_377;   // pg_advisory_xact_lock — два запуски одночасно не нараховують

function addDays(s, n) {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const ddy = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const isPeriod = (p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(p || ""));
// останній день місяця перед P: '2026-11' → '2026-10-31'
const cutoffOf = (period) => addDays(`${period}-01`, -1);
// N-й день етапу (BHP — день 1)
const dueOf = (bhp, stage) => addDays(bhp, STAGE_DAYS * stage - 1);
// перший список: місяць після місяця pay_from ('2026-10-01' → '2026-11')
const firstPeriod = (st) => addDays(`${String(st.pay_from || "2026-10-01").slice(0, 7)}-28`, 7).slice(0, 7);
const stagesOf = (kind) => (kind === "friend" ? [1, 2] : [1]);
const num = (v) => { const n = parseFloat(String(v == null ? "" : v).replace(",", ".")); return Number.isFinite(n) ? n : 0; };

// ── Стаж нового: кінець безперервної роботи від BHP (перерви ≤ 14 днів) ─
// periods: [{bhp, lwd}] (lwd = null — працює). undefined — періоду з таким BHP немає.
function employmentEnd(periods, bhp) {
  const ps = periods.filter((p) => p.bhp >= bhp).sort((a, b) => a.bhp.localeCompare(b.bhp));
  let end; let started = false;
  for (const p of ps) {
    if (!started) { if (p.bhp !== bhp) continue; started = true; end = p.lwd; continue; }
    if (end === null) break;
    if (p.bhp <= addDays(end, 14)) end = p.lwd === null ? null : (p.lwd > end ? p.lwd : end);
    else break;
  }
  return started ? end : undefined;
}
// останній період працівника: об'єкт і останній день (null — працює)
function lastPeriod(ps) {
  if (!ps || !ps.length) return null;
  return ps.slice().sort((a, b) => (a.lwd === null ? 1 : 0) - (b.lwd === null ? 1 : 0)
    || String(a.lwd).localeCompare(String(b.lwd)) || a.bhp.localeCompare(b.bhp)).pop();
}

// Премії одного етапу (чисте обчислення — для тестів і для compute)
// a: {kind, bhp, emp_end, referrer_last, coordinator_id}; st — ref.settings
function stagePay(a, stage, st) {
  if (a.kind === "coord") return stage === 1 ? { worker_amount: null, coord_amount: num(st.pay_coord_ref) } : null;
  return {
    worker_amount: num(stage === 1 ? st.pay_friend_1 : st.pay_friend_2),
    coord_amount: a.coordinator_id ? num(st.pay_coord_month) : null,
  };
}
// Етапи, що входять у список із цим cutoff (без перевірки «вже нараховано»)
function dueStages(a, cutoff, payFrom) {
  if (a.emp_end === undefined) return [];               // періоду вже немає в графіку
  return stagesOf(a.kind).filter((s) => {
    const due = dueOf(a.bhp, s);
    return due >= payFrom && due <= cutoff && (a.emp_end === null || a.emp_end >= due);
  });
}

async function settings() {
  const r = await db.query(`SELECT key, value FROM ref.settings`);
  return Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
}
async function today() {
  return (await db.query(`SELECT to_char(ref.today(), 'YYYY-MM-DD') AS d`)).rows[0].d;
}

// ── Кандидати списку P (ще не нараховані) ────────────────────────────
async function compute(period, st) {
  st = st || (await settings());
  const cutoff = cutoffOf(period);
  const payFrom = st.pay_from || "2026-10-01";
  if (cutoff < payFrom) return [];
  const r = await db.query(
    `SELECT a.id AS answer_id, a.source AS kind, a.worker_id, to_char(a.bhp_date, 'YYYY-MM-DD') AS bhp,
            a.match_worker_id, a.match_coordinator_id, h.site_key, w.full_name AS worker_name,
            rw.full_name AS referrer_name, mc.full_name AS match_coordinator_name,
            COALESCE((SELECT array_agg(p.stage) FROM ref.payouts p WHERE p.answer_id = a.id), '{}') AS done
       FROM ref.answers a
       JOIN ref.v_hires h ON h.worker_id = a.worker_id AND h.bhp_date = a.bhp_date
       JOIN public.workers w ON w.id = a.worker_id
       LEFT JOIN public.workers rw ON rw.id = a.match_worker_id
       LEFT JOIN public.coordinators mc ON mc.id = a.match_coordinator_id
      WHERE a.status = 'answered' AND a.match_state = 'confirmed'
        AND ((a.source = 'friend' AND a.match_worker_id IS NOT NULL) OR (a.source = 'coord' AND a.match_coordinator_id IS NOT NULL))
        AND a.bhp_date + ${STAGE_DAYS - 1} <= $1::date
        AND a.bhp_date + ${STAGE_DAYS * 2 - 1} >= $2::date`, [cutoff, payFrom]);
  if (!r.rows.length) return [];
  const ids = [...new Set(r.rows.flatMap((x) => [x.worker_id, x.match_worker_id].filter(Boolean)))];
  const per = new Map();
  const p = await db.query(
    `SELECT h.worker_id, to_char(h.bhp_date, 'YYYY-MM-DD') AS bhp, to_char(h.last_work_date, 'YYYY-MM-DD') AS lwd,
            COALESCE(NULLIF(btrim(f.group_name), ''), btrim(f.name)) AS site_key
       FROM public.worker_facility_history h JOIN public.facilities f ON f.id = h.facility_id
      WHERE h.worker_id = ANY($1::int[]) AND h.status::text <> 'rezygnacja' AND h.bhp_date IS NOT NULL`, [ids]);
  p.rows.forEach((x) => { (per.get(x.worker_id) || per.set(x.worker_id, []).get(x.worker_id)).push(x); });
  const so = await db.query(
    `SELECT so.site_key, so.coordinator_id, c.full_name AS coordinator_name, rg.name AS region_name
       FROM reg.site_owner so
       LEFT JOIN public.coordinators c ON c.id = so.coordinator_id
       LEFT JOIN reg.regions rg ON rg.id = so.region_id
      WHERE so.valid_to IS NULL`);
  const sites = new Map(so.rows.map((x) => [x.site_key, x]));

  const out = [];
  for (const x of r.rows) {
    const done = new Set((x.done || []).map(Number));
    const a = { kind: x.kind, bhp: x.bhp, emp_end: employmentEnd(per.get(x.worker_id) || [], x.bhp) };
    const notes = [];
    let refSite = null, refLast = null;
    if (x.kind === "friend") {
      refLast = lastPeriod(per.get(x.match_worker_id));
      refSite = refLast ? refLast.site_key : null;
      const s = refSite ? sites.get(refSite) : null;
      a.coordinator_id = s && s.coordinator_id ? s.coordinator_id : null;
      a.coordinator_name = s ? s.coordinator_name : null;
      a.region_name = s ? s.region_name : null;
      if (!a.coordinator_id) notes.push(refSite ? `brak koordynatora obiektu ${refSite}` : "polecający bez obiektu w grafiku — brak koordynatora");
    } else {
      const s = sites.get(x.site_key);
      a.coordinator_id = x.match_coordinator_id;
      a.coordinator_name = x.match_coordinator_name;
      a.region_name = s ? s.region_name : null;
    }
    const stages = dueStages(a, cutoff, payFrom).filter((s) => !done.has(s));
    if (!stages.length) continue;
    if (a.emp_end !== null && a.emp_end <= cutoff) notes.push(`zwolniony ${ddy(a.emp_end)}`);
    if (refLast && refLast.lwd !== null && refLast.lwd <= cutoff) notes.push(`polecający nie pracuje od ${ddy(addDays(refLast.lwd, 1))}`);
    for (const stage of stages) {
      out.push({
        answer_id: x.answer_id, stage, kind: x.kind, due_date: dueOf(x.bhp, stage),
        worker_id: x.worker_id, worker_name: x.worker_name, worker_site: x.site_key, bhp_date: x.bhp,
        referrer_worker_id: x.kind === "friend" ? x.match_worker_id : null,
        referrer_name: x.kind === "friend" ? x.referrer_name : null,
        referrer_site: refSite,
        coordinator_id: a.coordinator_id, coordinator_name: a.coordinator_name, region_name: a.region_name,
        ...stagePay(a, stage, st),
        note: notes.join("; ") || null,
      });
    }
  }
  return out;
}

// ── Запуск: фіксує список P. Повторний запуск того ж місяця — відмова ─
async function run(period, by) {
  if (!isPeriod(period)) throw new Error("period");
  const st = await settings();
  if (cutoffOf(period) < (st.pay_from || "2026-10-01")) throw new Error(`Pierwsza lista premii — ${firstPeriod(st)}`);
  const rows = await compute(period, st);
  const client = await db.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [LOCK]);
    const ins = await client.query(
      `INSERT INTO ref.payout_runs (period, cutoff, run_by, n) VALUES ($1, $2::date, $3, 0)
       ON CONFLICT (period) DO NOTHING RETURNING period`, [period, cutoffOf(period), by || null]);
    if (!ins.rows.length) { await client.query("ROLLBACK"); return { ok: false, error: "already" }; }
    let n = 0;
    for (const x of rows) {
      const q = await client.query(
        `INSERT INTO ref.payouts (period, answer_id, stage, kind, due_date, worker_id, worker_name, worker_site, bhp_date,
                                  referrer_worker_id, referrer_name, referrer_site, coordinator_id, coordinator_name, region_name,
                                  worker_amount, coord_amount, note)
         VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9::date, $10, $11, $12, $13, $14, $15, $16, $17, $18)
         ON CONFLICT (answer_id, stage) DO NOTHING`,
        [period, x.answer_id, x.stage, x.kind, x.due_date, x.worker_id, x.worker_name, x.worker_site, x.bhp_date,
          x.referrer_worker_id, x.referrer_name, x.referrer_site, x.coordinator_id, x.coordinator_name, x.region_name,
          x.worker_amount, x.coord_amount, x.note]);
      n += q.rowCount;
    }
    await client.query(`UPDATE ref.payout_runs SET n = $2 WHERE period = $1`, [period, n]);
    await client.query("COMMIT");
    return { ok: true, period, n };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// ── Авто: pay_day числа і пізніше, якщо список місяця ще не створено ─
async function autoRun() {
  const st = await settings();
  const td = await today();
  const day = Number(td.slice(8, 10));
  if (day < (Number(st.pay_day) || 4)) return null;
  const period = td.slice(0, 7);
  if (cutoffOf(period) < (st.pay_from || "2026-10-01")) return null;
  const ex = await db.query(`SELECT 1 FROM ref.payout_runs WHERE period = $1`, [period]);
  if (ex.rows.length) return null;
  const r = await run(period, null);
  if (r.ok) console.log(`[ref] premie ${period}: naliczono ${r.n}`);
  return r;
}

module.exports = { compute, run, autoRun, employmentEnd, lastPeriod, cutoffOf, dueOf, stagesOf, firstPeriod, isPeriod, STAGE_DAYS,
  _test: { stagePay, dueStages, isPeriod } };
