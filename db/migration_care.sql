-- ══════════════════════════════════════════════════════════════════════
--  Розділ «Rozmowy» — оцінка людей, завдання на розмову, анкети.
--  Окрема схема care. Потрібна вже встановлена схема reg (розділ Region):
--  звідти береться, хто відповідає за об'єкт і чи об'єкт червоний.
--
--  Запуск: psql -d sasdb -f db/migration_care.sql   (можна повторно)
-- ══════════════════════════════════════════════════════════════════════
BEGIN;

CREATE SCHEMA IF NOT EXISTS care;

-- ── Налаштування ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS care.settings (
  key        TEXT PRIMARY KEY,
  value      NUMERIC NOT NULL,
  note       TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INT
);
INSERT INTO care.settings (key, value, note) VALUES
  -- вмикачі
  ('tasks_enabled',          1,   '1 = щоранку формувати і розсилати завдання координаторам'),
  ('surveys_enabled',        1,   '1 = надсилати анкети працівникам'),
  -- завдання
  ('tasks_per_day',          5,   'Скільки відкритих завдань максимум у координатора'),
  ('task_hour',              8,   'О котрій годині розсилати ранковий список'),
  ('task_saturday',          0,   '1 = розсилати завдання і в суботу (інакше пн–пт)'),
  ('escalate_bdays',         2,   'Не закрито за стільки робочих днів — повідомити регіональному'),
  ('expire_bdays',           4,   'Не закрито за стільки робочих днів — завдання пропущене'),
  ('cooldown_days',          14,  'Після розмови «залишається» не ставити людину знову стільки днів'),
  ('cooldown_problem_days',  7,   'Після «є проблема» — повторна розмова через стільки днів'),
  ('cooldown_no_answer_days',2,   'Після «не додзвонився» — повторити через стільки днів'),
  ('risk_min',               25,  'Мінімальний бал ризику, щоб потрапити в список'),
  ('spot_check_share',       0.10,'Частка закритих розмов, які бот перевіряє в працівника'),
  ('spot_check_delay_hours', 24,  'Через скільки годин після розмови питати працівника'),
  -- бал ризику
  ('window_days',            14,  'Вікно для NN, днів без годин і падіння годин'),
  ('new_days',               30,  'Новачок: стаж до стількох днів'),
  ('w_new',                  15,  'Бал: новачок'),
  ('pre_from',               60,  'Перед порогом: стаж від'),
  ('pre_to',                 80,  'Перед порогом: стаж до'),
  ('w_pre',                  15,  'Бал: перед порогом 80 днів'),
  ('w_nn',                   10,  'Бал за кожен NN у вікні'),
  ('w_nn_streak',            15,  'Бал: 2+ NN поспіль'),
  ('w_gap',                  4,   'Бал за кожен день без годин (від 2 днів)'),
  ('gap_cap',                7,   'Максимум днів без годин, що рахуються'),
  ('w_drop',                 10,  'Бал: годин за тиждень на 40%+ менше, ніж тижнем раніше'),
  ('w_survey',               15,  'Бал: тривожна відповідь в анкеті за 21 день'),
  ('w_assess_bad',           25,  'Бал: оцінка координатора 👎'),
  ('w_assess_mid',           10,  'Бал: оцінка координатора 😐'),
  ('w_site_red',             5,   'Бал: об''єкт червоний у Region'),
  -- оцінки новачків
  ('assess_day_1',           7,   'Перша оцінка «як вливається» — на який день'),
  ('assess_day_2',           30,  'Друга оцінка — на який день'),
  -- анкети
  ('survey_hour',            18,  'О котрій годині надсилати анкети працівникам'),
  ('survey_catchup_days',    2,   'Скільки днів після потрібного дня ще можна надіслати анкету'),
  ('survey_remind_hours',    24,  'Нагадування, якщо не відповів'),
  ('survey_expire_days',     5,   'Після стількох днів анкета вважається без відповіді'),
  ('coord_min_answers',      5,   'Питання про координатора показувати від стількох відповідей')
ON CONFLICT (key) DO NOTHING;

CREATE OR REPLACE FUNCTION care.setting(p_key TEXT)
RETURNS NUMERIC LANGUAGE sql STABLE AS $$ SELECT value FROM care.settings WHERE key = p_key $$;

-- ── Кому з координаторів увімкнено модуль ─────────────────────────────
-- За замовчуванням — нікому: адмін вмикає в панелі (Rozmowy → Ustawienia → Koordynatorzy).
-- Вимкнений координатор не отримує завдань і оцінок, працівники його об'єктів — анкет.
CREATE TABLE IF NOT EXISTS care.coordinators (
  coordinator_id INT PRIMARY KEY REFERENCES public.coordinators(id) ON DELETE CASCADE,
  enabled        BOOLEAN NOT NULL DEFAULT false,
  enabled_at     TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by     INT
);
CREATE OR REPLACE FUNCTION care.is_on(p_coord INT)
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT enabled FROM care.coordinators WHERE coordinator_id = p_coord), false)
$$;

-- Дата за польським часом — не залежить від часового поясу сервера бази
CREATE OR REPLACE FUNCTION care.today()
RETURNS DATE LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Europe/Warsaw')::date $$;
CREATE OR REPLACE FUNCTION care.ldate(p TIMESTAMPTZ)
RETURNS DATE LANGUAGE sql STABLE AS $$ SELECT (p AT TIME ZONE 'Europe/Warsaw')::date $$;

-- Робочі дні між датами: (p_from, p_to], пн–пт (+ субота, якщо task_saturday = 1)
CREATE OR REPLACE FUNCTION care.bdays(p_from DATE, p_to DATE)
RETURNS INT LANGUAGE sql STABLE AS $$
  SELECT COUNT(*)::int FROM generate_series(p_from + 1, p_to, INTERVAL '1 day') d
   WHERE EXTRACT(ISODOW FROM d) < CASE WHEN care.setting('task_saturday') = 1 THEN 7 ELSE 6 END
$$;

-- Які щоденні задачі вже виконані (щоб після перезапуску не повторювати і не пропускати)
CREATE TABLE IF NOT EXISTS care.job_runs (
  job         TEXT NOT NULL,
  day         DATE NOT NULL,
  ran_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  PRIMARY KEY (job, day)
);
ALTER TABLE care.job_runs ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

-- ── Бал ризику: знімок на кожен день ─────────────────────────────────
CREATE TABLE IF NOT EXISTS care.risk_daily (
  day            DATE NOT NULL,
  worker_id      INT  NOT NULL,
  facility_id    INT,
  site_key       TEXT,
  coordinator_id INT,
  region_id      INT,
  bhp_date       DATE,
  tenure         INT,
  score          INT  NOT NULL,
  reasons        TEXT[] NOT NULL DEFAULT '{}',
  computed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (day, worker_id)
);
CREATE INDEX IF NOT EXISTS risk_daily_coord_idx ON care.risk_daily(day, coordinator_id, score DESC);

-- ── Завдання на розмову ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS care.tasks (
  id             SERIAL PRIMARY KEY,
  worker_id      INT NOT NULL REFERENCES public.workers(id),
  facility_id    INT,
  site_key       TEXT,
  coordinator_id INT REFERENCES public.coordinators(id),
  region_id      INT,
  kind           TEXT NOT NULL DEFAULT 'risk' CHECK (kind IN ('risk','survey','manual')),
  priority       INT  NOT NULL DEFAULT 5,      -- 0 = найвищий (анкета з тривогою)
  score          INT,
  reasons        TEXT[] NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     INT,
  sent_at        TIMESTAMPTZ,
  tg_chat_id     BIGINT,
  tg_message_id  BIGINT,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','missed','cancelled')),
  outcome        TEXT CHECK (outcome IN ('stays','problem','leaving','no_answer')),
  problem_code   TEXT,
  comment        TEXT,
  done_at        TIMESTAMPTZ,
  done_by        INT,
  done_via       TEXT,
  escalated_at   TIMESTAMPTZ,
  leaving_sent_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_one_open ON care.tasks(worker_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS tasks_coord_idx ON care.tasks(coordinator_id, status, created_at);

-- ── Оцінка новачка координатором: 👍 / 😐 / 👎 ─────────────────────
CREATE TABLE IF NOT EXISTS care.assessments (
  id             SERIAL PRIMARY KEY,
  worker_id      INT NOT NULL REFERENCES public.workers(id),
  bhp_date       DATE NOT NULL,
  day_mark       INT NOT NULL,
  coordinator_id INT,
  site_key       TEXT,
  requested_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at        TIMESTAMPTZ,
  tg_chat_id     BIGINT,
  tg_message_id  BIGINT,
  value          INT CHECK (value IN (1,2,3)),   -- 1 👎, 2 😐, 3 👍
  answered_at    TIMESTAMPTZ,
  answered_by    INT,
  UNIQUE (worker_id, bhp_date, day_mark)
);

-- ── Анкети ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS care.surveys (
  code       TEXT PRIMARY KEY,
  day_offset INT,                  -- NULL = при звільненні
  name       TEXT NOT NULL,
  intro      JSONB NOT NULL,       -- {uk,ru,pl,en}
  is_active  BOOLEAN NOT NULL DEFAULT true,
  sort       INT NOT NULL DEFAULT 0
);

-- kind: choice = варіанти; opt.f = 'high' (одразу завдання) | 'low' (+ до балу ризику)
-- visibility: coordinator = бачить координатор; manager = тільки регіональний/керівник, у сумі
CREATE TABLE IF NOT EXISTS care.questions (
  id          SERIAL PRIMARY KEY,
  survey_code TEXT NOT NULL REFERENCES care.surveys(code) ON DELETE CASCADE,
  sort        INT NOT NULL,
  code        TEXT NOT NULL,
  text        JSONB NOT NULL,
  options     JSONB NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'coordinator' CHECK (visibility IN ('coordinator','manager')),
  UNIQUE (survey_code, code),
  UNIQUE (survey_code, sort)
);

CREATE TABLE IF NOT EXISTS care.survey_sends (
  id             SERIAL PRIMARY KEY,
  survey_code    TEXT NOT NULL REFERENCES care.surveys(code),
  worker_id      INT NOT NULL REFERENCES public.workers(id),
  bhp_date       DATE NOT NULL,
  facility_id    INT,
  site_key       TEXT,
  coordinator_id INT,
  region_id      INT,
  planned_for    DATE NOT NULL,
  status         TEXT NOT NULL DEFAULT 'planned'
                 CHECK (status IN ('planned','sent','done','expired','no_telegram','failed')),
  lang           TEXT,
  current_q      INT NOT NULL DEFAULT 1,
  sent_at        TIMESTAMPTZ,
  reminded_at    TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  flag           TEXT,               -- найгірший прапорець у відповідях: high / low
  task_id        INT,                -- завдання, створене через тривожну відповідь
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (worker_id, survey_code, bhp_date)
);
ALTER TABLE care.survey_sends ADD COLUMN IF NOT EXISTS task_id INT;
CREATE INDEX IF NOT EXISTS survey_sends_status_idx ON care.survey_sends(status, planned_for);

CREATE TABLE IF NOT EXISTS care.answers (
  send_id     INT NOT NULL REFERENCES care.survey_sends(id) ON DELETE CASCADE,
  question_id INT NOT NULL REFERENCES care.questions(id),
  option_code TEXT NOT NULL,
  flag        TEXT,
  answered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (send_id, question_id)
);

-- ── Перевірка в працівника: чи була розмова ──────────────────────────
CREATE TABLE IF NOT EXISTS care.spot_checks (
  id            SERIAL PRIMARY KEY,
  task_id       INT NOT NULL UNIQUE REFERENCES care.tasks(id) ON DELETE CASCADE,
  worker_id     INT NOT NULL,
  coordinator_id INT,
  ask_after     TIMESTAMPTZ NOT NULL,
  asked_at      TIMESTAMPTZ,
  answer        TEXT CHECK (answer IN ('yes','no')),
  answered_at   TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','asked','answered','skipped'))
);

-- ── Тестові повідомлення (Rozmowy → Test): нічого не пишуть у робочі таблиці ──
CREATE TABLE IF NOT EXISTS care.test_msgs (
  id             SERIAL PRIMARY KEY,
  chat_id        BIGINT NOT NULL,
  coordinator_id INT,
  kind           TEXT NOT NULL,
  lang           TEXT,
  message_id     BIGINT,
  payload        JSONB NOT NULL DEFAULT '{}',
  sent_by        INT,
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ══════════════════════════════════════════════════════════════════════
--  Функції
-- ══════════════════════════════════════════════════════════════════════

-- Хто працює на дату: період зі статусом pracuje/urlop, що покриває дату
CREATE OR REPLACE FUNCTION care.active_on(p_day DATE)
RETURNS TABLE (worker_id INT, facility_id INT, bhp_date DATE, last_work_date DATE, site_key TEXT)
LANGUAGE sql STABLE AS $$
SELECT DISTINCT ON (h.worker_id)
       h.worker_id, h.facility_id, h.bhp_date, h.last_work_date,
       reg.site_key(f.group_name, f.name)
FROM public.worker_facility_history h
JOIN public.facilities f ON f.id = h.facility_id
JOIN public.workers w    ON w.id = h.worker_id
WHERE h.status::text IN ('pracuje','urlop')
  AND h.bhp_date IS NOT NULL AND h.bhp_date <= p_day
  AND (h.last_work_date IS NULL OR h.last_work_date >= p_day)
  AND COALESCE(w.login, '') NOT LIKE 'TEST_%'
ORDER BY h.worker_id, h.bhp_date DESC
$$;

CREATE OR REPLACE VIEW care.v_active AS SELECT * FROM care.active_on(care.today());

-- Бал ризику кожного працівника на дату. Параметризовано датою,
-- щоб можна було перевірити на історії.
CREATE OR REPLACE FUNCTION care.risk_scores(p_asof DATE)
RETURNS TABLE (worker_id INT, facility_id INT, site_key TEXT, coordinator_id INT, region_id INT,
               bhp_date DATE, tenure INT, score INT, reasons TEXT[])
LANGUAGE sql STABLE AS $$
WITH prm AS (
  SELECT care.setting('window_days')::int AS win,
         care.setting('new_days')::int AS new_days, care.setting('w_new') AS w_new,
         care.setting('pre_from')::int AS pre_from, care.setting('pre_to')::int AS pre_to,
         care.setting('w_pre') AS w_pre, care.setting('w_nn') AS w_nn,
         care.setting('w_nn_streak') AS w_streak, care.setting('w_gap') AS w_gap,
         care.setting('gap_cap')::int AS gap_cap, care.setting('w_drop') AS w_drop,
         care.setting('w_survey') AS w_survey, care.setting('w_assess_bad') AS w_ab,
         care.setting('w_assess_mid') AS w_am, care.setting('w_site_red') AS w_red
),
act AS (
  SELECT worker_id, facility_id, bhp_date, site_key FROM care.active_on(p_asof)
),
days AS (
  SELECT a.worker_id, a.site_key, gs::date AS d
  FROM act a CROSS JOIN prm
  CROSS JOIN LATERAL generate_series(GREATEST(a.bhp_date, p_asof - prm.win), p_asof - 1, INTERVAL '1 day') gs
),
hl AS (
  SELECT d.worker_id, d.site_key, d.d, l.hours, l.absence_type::text AS abs, (l.worker_id IS NOT NULL) AS has
  FROM days d
  LEFT JOIN public.hours_log l ON l.worker_id = d.worker_id AND l.work_date = d.d
),
-- об'єкти, де години взагалі ведуться (інакше «днів без годин» — шум)
tracked AS (SELECT site_key FROM hl GROUP BY site_key HAVING COUNT(*) FILTER (WHERE has) > 0),
agg AS (
  SELECT worker_id,
         COUNT(*) FILTER (WHERE abs = 'NN')::int AS nn,
         COUNT(*) FILTER (WHERE NOT has)::int AS gap,
         COALESCE(SUM(hours) FILTER (WHERE d >  p_asof - 8), 0) AS h7,
         COALESCE(SUM(hours) FILTER (WHERE d <= p_asof - 8), 0) AS h7p
  FROM hl GROUP BY worker_id
),
streak AS (
  SELECT worker_id, MAX(n)::int AS streak FROM (
    SELECT worker_id, COUNT(*) AS n FROM (
      SELECT worker_id, d, d - (ROW_NUMBER() OVER (PARTITION BY worker_id ORDER BY d))::int AS g
      FROM hl WHERE abs = 'NN') x
    GROUP BY worker_id, g) y
  GROUP BY worker_id
),
surv AS (
  SELECT s.worker_id, BOOL_OR(a.flag IS NOT NULL) AS flagged
  FROM care.survey_sends s JOIN care.answers a ON a.send_id = s.id
  WHERE a.answered_at >= p_asof - 21 AND a.answered_at < p_asof + 1
  GROUP BY s.worker_id
),
assess AS (
  SELECT DISTINCT ON (x.worker_id, x.bhp_date) x.worker_id, x.bhp_date, x.value
  FROM care.assessments x
  WHERE x.value IS NOT NULL AND x.answered_at < p_asof + 1
  ORDER BY x.worker_id, x.bhp_date, x.day_mark DESC
),
red AS (
  SELECT s.site_key FROM reg.v_snap s
  WHERE s.status = 'R' AND s.week_end = (SELECT MAX(week_end) FROM reg.rag_snapshots WHERE week_end <= p_asof)
),
base AS (
  SELECT a.worker_id, a.facility_id, a.site_key, a.bhp_date,
         (p_asof - a.bhp_date)::int AS tenure,
         (t.site_key IS NOT NULL) AS tracked,
         COALESCE(g.nn, 0) AS nn, COALESCE(st.streak, 0) AS streak,
         COALESCE(g.gap, 0) AS gap, COALESCE(g.h7, 0) AS h7, COALESCE(g.h7p, 0) AS h7p,
         COALESCE(sv.flagged, false) AS survey,
         asx.value AS assess, (r.site_key IS NOT NULL) AS site_red
  FROM act a
  LEFT JOIN tracked t ON t.site_key = a.site_key
  LEFT JOIN agg g     ON g.worker_id = a.worker_id
  LEFT JOIN streak st ON st.worker_id = a.worker_id
  LEFT JOIN surv sv   ON sv.worker_id = a.worker_id
  LEFT JOIN assess asx ON asx.worker_id = a.worker_id AND asx.bhp_date = a.bhp_date
  LEFT JOIN red r     ON r.site_key = a.site_key
),
parts AS (
  SELECT b.*,
    CASE WHEN b.tenure <= p.new_days THEN p.w_new ELSE 0 END AS s_new,
    CASE WHEN b.tenure BETWEEN p.pre_from AND p.pre_to THEN p.w_pre ELSE 0 END AS s_pre,
    CASE WHEN b.tracked THEN b.nn * p.w_nn ELSE 0 END AS s_nn,
    CASE WHEN b.tracked AND b.streak >= 2 THEN p.w_streak ELSE 0 END AS s_streak,
    CASE WHEN b.tracked AND b.gap >= 2 THEN LEAST(b.gap, p.gap_cap) * p.w_gap ELSE 0 END AS s_gap,
    CASE WHEN b.tracked AND b.h7p >= 20 AND b.h7 < b.h7p * 0.6 THEN p.w_drop ELSE 0 END AS s_drop,
    CASE WHEN b.survey THEN p.w_survey ELSE 0 END AS s_survey,
    CASE b.assess WHEN 1 THEN p.w_ab WHEN 2 THEN p.w_am ELSE 0 END AS s_assess,
    CASE WHEN b.site_red THEN p.w_red ELSE 0 END AS s_red,
    p.new_days, p.pre_from, p.pre_to
  FROM base b CROSS JOIN prm p
)
SELECT x.worker_id, x.facility_id, x.site_key, o.coordinator_id, o.region_id, x.bhp_date, x.tenure,
       (x.s_new + x.s_pre + x.s_nn + x.s_streak + x.s_gap + x.s_drop + x.s_survey + x.s_assess + x.s_red)::int,
       array_remove(ARRAY[
         CASE WHEN x.s_assess > 0 THEN CASE x.assess WHEN 1 THEN 'assess_bad' ELSE 'assess_mid' END END,
         CASE WHEN x.s_survey > 0 THEN 'survey' END,
         CASE WHEN x.s_streak > 0 THEN 'streak:' || x.streak END,
         CASE WHEN x.s_nn     > 0 THEN 'nn:' || x.nn END,
         CASE WHEN x.s_gap    > 0 THEN 'gap:' || x.gap END,
         CASE WHEN x.s_drop   > 0 THEN 'drop:' || round(x.h7) || '/' || round(x.h7p) END,
         CASE WHEN x.s_pre    > 0 THEN 'pre80:' || x.tenure END,
         CASE WHEN x.s_new    > 0 THEN 'new:' || x.tenure END,
         CASE WHEN x.s_red    > 0 THEN 'site_red' END
       ], NULL)
FROM parts x
LEFT JOIN reg.site_owner o ON o.site_key = x.site_key AND o.valid_to IS NULL
$$;

CREATE OR REPLACE FUNCTION care.take_risk(p_day DATE)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE n INT;
BEGIN
  DELETE FROM care.risk_daily WHERE day = p_day;
  INSERT INTO care.risk_daily (day, worker_id, facility_id, site_key, coordinator_id, region_id,
                               bhp_date, tenure, score, reasons)
  SELECT p_day, r.worker_id, r.facility_id, r.site_key, r.coordinator_id, r.region_id,
         r.bhp_date, r.tenure, r.score, r.reasons
  FROM care.risk_scores(p_day) r;
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM care.risk_daily WHERE day < p_day - 120;   -- історія за 4 місяці
  RETURN n;
END $$;

-- Ранкове формування завдань: пропущені закриваються, вільні місця
-- (до tasks_per_day відкритих) заповнюються людьми з найвищим балом.
CREATE OR REPLACE FUNCTION care.build_tasks(p_day DATE)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE n INT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM care.risk_daily WHERE day = p_day) THEN
    PERFORM care.take_risk(p_day);
  END IF;

  UPDATE care.tasks SET status = 'missed'
   WHERE status = 'open' AND care.bdays(care.ldate(created_at), p_day) >= care.setting('expire_bdays')::int;

  -- людина вже не працює — завдання знімаємо
  UPDATE care.tasks t SET status = 'cancelled'
   WHERE t.status = 'open' AND NOT EXISTS (SELECT 1 FROM care.active_on(p_day) a WHERE a.worker_id = t.worker_id);
  -- координатору вимкнули модуль — теж
  UPDATE care.tasks t SET status = 'cancelled'
   WHERE t.status = 'open' AND t.coordinator_id IS NOT NULL AND NOT care.is_on(t.coordinator_id);

  WITH cap AS (
    SELECT c.id AS coordinator_id,
           care.setting('tasks_per_day')::int
             - (SELECT COUNT(*) FROM care.tasks t WHERE t.coordinator_id = c.id AND t.status = 'open') AS free
    FROM public.coordinators c WHERE c.is_active AND care.is_on(c.id)
  ),
  cand AS (
    SELECT r.*, ROW_NUMBER() OVER (PARTITION BY r.coordinator_id ORDER BY r.score DESC, r.tenure) AS rn
    FROM care.risk_daily r
    WHERE r.day = p_day AND r.coordinator_id IS NOT NULL
      AND r.score >= care.setting('risk_min')
      AND NOT EXISTS (SELECT 1 FROM care.tasks t WHERE t.worker_id = r.worker_id AND t.status = 'open')
      AND NOT EXISTS (
        SELECT 1 FROM care.tasks t
         WHERE t.worker_id = r.worker_id AND t.status IN ('done','missed')
           AND care.ldate(COALESCE(t.done_at, t.created_at)) > p_day - (
                 CASE t.outcome WHEN 'no_answer' THEN care.setting('cooldown_no_answer_days')
                                WHEN 'problem'   THEN care.setting('cooldown_problem_days')
                                ELSE care.setting('cooldown_days') END)::int)
  )
  INSERT INTO care.tasks (worker_id, facility_id, site_key, coordinator_id, region_id, kind, priority, score, reasons)
  SELECT c.worker_id, c.facility_id, c.site_key, c.coordinator_id, c.region_id, 'risk', 5, c.score, c.reasons
  FROM cand c JOIN cap ON cap.coordinator_id = c.coordinator_id
  WHERE c.rn <= GREATEST(cap.free, 0)
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- Планування анкет і оцінок на день (відправляє вже JS)
CREATE OR REPLACE FUNCTION care.plan_day(p_day DATE)
RETURNS TABLE (surveys INT, exits INT, assessments INT) LANGUAGE plpgsql AS $$
DECLARE v_s INT; v_e INT; v_a INT;
BEGIN
  -- анкети за стажем: день d_offset, з запасом survey_catchup_days
  INSERT INTO care.survey_sends (survey_code, worker_id, bhp_date, facility_id, site_key, coordinator_id,
                                 region_id, planned_for, status, lang)
  SELECT sv.code, a.worker_id, a.bhp_date, a.facility_id, a.site_key, o.coordinator_id, o.region_id, p_day,
         CASE WHEN w.telegram_chat_id IS NULL THEN 'no_telegram' ELSE 'planned' END, w.lang::text
  FROM care.active_on(p_day) a
  JOIN public.workers w ON w.id = a.worker_id
  JOIN care.surveys sv ON sv.is_active AND sv.day_offset IS NOT NULL
  LEFT JOIN reg.site_owner o ON o.site_key = a.site_key AND o.valid_to IS NULL
  WHERE (p_day - a.bhp_date) BETWEEN sv.day_offset AND sv.day_offset + care.setting('survey_catchup_days')::int
    AND care.is_on(o.coordinator_id)
  ON CONFLICT (worker_id, survey_code, bhp_date) DO NOTHING;
  GET DIAGNOSTICS v_s = ROW_COUNT;

  -- анкета при звільненні: останній день за 3 дні, звільнений або rezygnacja (не переведений)
  INSERT INTO care.survey_sends (survey_code, worker_id, bhp_date, facility_id, site_key, coordinator_id,
                                 region_id, planned_for, status, lang)
  SELECT sv.code, h.worker_id, h.bhp_date, h.facility_id, reg.site_key(f.group_name, f.name),
         o.coordinator_id, o.region_id, p_day,
         CASE WHEN w.telegram_chat_id IS NULL THEN 'no_telegram' ELSE 'planned' END, w.lang::text
  FROM public.worker_facility_history h
  JOIN public.facilities f ON f.id = h.facility_id
  JOIN public.workers w ON w.id = h.worker_id
  JOIN care.surveys sv ON sv.is_active AND sv.day_offset IS NULL
  LEFT JOIN reg.site_owner o ON o.site_key = reg.site_key(f.group_name, f.name) AND o.valid_to IS NULL
  WHERE h.status::text IN ('zwolniony','rezygnacja') AND h.bhp_date IS NOT NULL
    AND h.last_work_date BETWEEN p_day - 3 AND p_day
    AND COALESCE(w.login, '') NOT LIKE 'TEST_%'
    AND NOT EXISTS (SELECT 1 FROM care.active_on(p_day) x WHERE x.worker_id = h.worker_id)
    AND care.is_on(o.coordinator_id)
  ON CONFLICT (worker_id, survey_code, bhp_date) DO NOTHING;
  GET DIAGNOSTICS v_e = ROW_COUNT;

  -- оцінки «як вливається»
  INSERT INTO care.assessments (worker_id, bhp_date, day_mark, coordinator_id, site_key)
  SELECT a.worker_id, a.bhp_date, m.d, o.coordinator_id, a.site_key
  FROM care.active_on(p_day) a
  CROSS JOIN (VALUES (care.setting('assess_day_1')::int), (care.setting('assess_day_2')::int)) m(d)
  LEFT JOIN reg.site_owner o ON o.site_key = a.site_key AND o.valid_to IS NULL
  WHERE (p_day - a.bhp_date) BETWEEN m.d AND m.d + 2
    AND care.is_on(o.coordinator_id)
  ON CONFLICT (worker_id, bhp_date, day_mark) DO NOTHING;
  GET DIAGNOSTICS v_a = ROW_COUNT;

  -- анкети без відповіді закриваються
  UPDATE care.survey_sends SET status = 'expired'
   WHERE status = 'sent' AND sent_at < now() - make_interval(days => care.setting('survey_expire_days')::int);
  UPDATE care.survey_sends SET status = 'expired'
   WHERE status = 'planned' AND planned_for < p_day - 1;

  RETURN QUERY SELECT v_s, v_e, v_a;
END $$;

-- ── Анкети: стартовий набір (ON CONFLICT DO NOTHING — зміни в базі не перезаписуються) ──
INSERT INTO care.surveys (code, day_offset, name, intro, sort) VALUES ('d3', 3, 'Перші дні (3 день)', '{"uk": "👋 Ви з нами вже кілька днів! 4 коротких питання — менше хвилини.\n\nВідповіді бачить тільки команда координації SAS Logistic — щоб швидше вирішувати проблеми. Відповідати не обовʼязково.", "ru": "👋 Вы с нами уже несколько дней! 4 коротких вопроса — меньше минуты.\n\nОтветы видит только команда координации SAS Logistic — чтобы быстрее решать проблемы. Отвечать не обязательно.", "pl": "👋 Jesteś z nami od kilku dni! 4 krótkie pytania — mniej niż minuta.\n\nOdpowiedzi widzi tylko zespół koordynacji SAS Logistic — żeby szybciej rozwiązywać problemy. Odpowiedź jest dobrowolna.", "en": "👋 You have been with us for a few days! 4 short questions — less than a minute.\n\nOnly the SAS Logistic coordination team sees your answers — so we can fix problems faster. Answering is voluntary."}'::jsonb, 1) ON CONFLICT (code) DO NOTHING;
INSERT INTO care.surveys (code, day_offset, name, intro, sort) VALUES ('d14', 14, 'Два тижні', '{"uk": "👋 Два тижні з нами! 4 коротких питання — менше хвилини.\n\nВідповіді бачить тільки команда координації SAS Logistic — щоб швидше вирішувати проблеми. Відповідати не обовʼязково.", "ru": "👋 Две недели с нами! 4 коротких вопроса — меньше минуты.\n\nОтветы видит только команда координации SAS Logistic — чтобы быстрее решать проблемы. Отвечать не обязательно.", "pl": "👋 Dwa tygodnie z nami! 4 krótkie pytania — mniej niż minuta.\n\nOdpowiedzi widzi tylko zespół koordynacji SAS Logistic — żeby szybciej rozwiązywać problemy. Odpowiedź jest dobrowolna.", "en": "👋 Two weeks with us! 4 short questions — less than a minute.\n\nOnly the SAS Logistic coordination team sees your answers — so we can fix problems faster. Answering is voluntary."}'::jsonb, 2) ON CONFLICT (code) DO NOTHING;
INSERT INTO care.surveys (code, day_offset, name, intro, sort) VALUES ('d30', 30, 'Місяць', '{"uk": "👋 Місяць з нами! 5 коротких питань — менше хвилини.\n\nВідповіді бачить тільки команда координації SAS Logistic — щоб швидше вирішувати проблеми. Відповідати не обовʼязково.", "ru": "👋 Месяц с нами! 5 коротких вопросов — меньше минуты.\n\nОтветы видит только команда координации SAS Logistic — чтобы быстрее решать проблемы. Отвечать не обязательно.", "pl": "👋 Miesiąc z nami! 5 krótkich pytań — mniej niż minuta.\n\nOdpowiedzi widzi tylko zespół koordynacji SAS Logistic — żeby szybciej rozwiązywać problemy. Odpowiedź jest dobrowolna.", "en": "👋 One month with us! 5 short questions — less than a minute.\n\nOnly the SAS Logistic coordination team sees your answers — so we can fix problems faster. Answering is voluntary."}'::jsonb, 3) ON CONFLICT (code) DO NOTHING;
INSERT INTO care.surveys (code, day_offset, name, intro, sort) VALUES ('d60', 60, 'Два місяці', '{"uk": "👋 Два місяці з нами! 4 коротких питання — менше хвилини.\n\nВідповіді бачить тільки команда координації SAS Logistic — щоб швидше вирішувати проблеми. Відповідати не обовʼязково.", "ru": "👋 Два месяца с нами! 4 коротких вопроса — меньше минуты.\n\nОтветы видит только команда координации SAS Logistic — чтобы быстрее решать проблемы. Отвечать не обязательно.", "pl": "👋 Dwa miesiące z nami! 4 krótkie pytania — mniej niż minuta.\n\nOdpowiedzi widzi tylko zespół koordynacji SAS Logistic — żeby szybciej rozwiązywać problemy. Odpowiedź jest dobrowolna.", "en": "👋 Two months with us! 4 short questions — less than a minute.\n\nOnly the SAS Logistic coordination team sees your answers — so we can fix problems faster. Answering is voluntary."}'::jsonb, 4) ON CONFLICT (code) DO NOTHING;
INSERT INTO care.surveys (code, day_offset, name, intro, sort) VALUES ('exit', NULL, 'Після звільнення', '{"uk": "🙏 Дякуємо за роботу з нами! 3 коротких питання допоможуть нам стати кращими.\n\nВідповіді бачить тільки команда координації SAS Logistic — щоб швидше вирішувати проблеми. Відповідати не обовʼязково.", "ru": "🙏 Спасибо за работу с нами! 3 коротких вопроса помогут нам стать лучше.\n\nОтветы видит только команда координации SAS Logistic — чтобы быстрее решать проблемы. Отвечать не обязательно.", "pl": "🙏 Dziękujemy za pracę z nami! 3 krótkie pytania pomogą nam być lepszymi.\n\nOdpowiedzi widzi tylko zespół koordynacji SAS Logistic — żeby szybciej rozwiązywać problemy. Odpowiedź jest dobrowolna.", "en": "🙏 Thank you for working with us! 3 short questions will help us improve.\n\nOnly the SAS Logistic coordination team sees your answers — so we can fix problems faster. Answering is voluntary."}'::jsonb, 5) ON CONFLICT (code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('d3', 1, 'housing3', '{"uk": "🏠 Чи все гаразд із житлом?", "ru": "🏠 Всё ли в порядке с жильём?", "pl": "🏠 Czy z zakwaterowaniem wszystko w porządku?", "en": "🏠 Is everything OK with your accommodation?"}'::jsonb, '[{"c": "yes", "t": {"uk": "✅ Так", "ru": "✅ Да", "pl": "✅ Tak", "en": "✅ Yes"}, "f": null}, {"c": "partly", "t": {"uk": "🤔 Не зовсім", "ru": "🤔 Не совсем", "pl": "🤔 Nie do końca", "en": "🤔 Not quite"}, "f": "low"}, {"c": "no", "t": {"uk": "❌ Ні", "ru": "❌ Нет", "pl": "❌ Nie", "en": "❌ No"}, "f": "high"}, {"c": "own", "t": {"uk": "🏡 Житло своє", "ru": "🏡 Жильё своё", "pl": "🏡 Mieszkam u siebie", "en": "🏡 Own housing"}, "f": null}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('d3', 2, 'transport3', '{"uk": "🚌 Чи зручно добиратися на роботу?", "ru": "🚌 Удобно ли добираться на работу?", "pl": "🚌 Czy dojazd do pracy jest w porządku?", "en": "🚌 Is getting to work OK?"}'::jsonb, '[{"c": "yes", "t": {"uk": "✅ Так", "ru": "✅ Да", "pl": "✅ Tak", "en": "✅ Yes"}, "f": null}, {"c": "partly", "t": {"uk": "🤔 Не зовсім", "ru": "🤔 Не совсем", "pl": "🤔 Nie do końca", "en": "🤔 Not quite"}, "f": "low"}, {"c": "no", "t": {"uk": "❌ Ні", "ru": "❌ Нет", "pl": "❌ Nie", "en": "❌ No"}, "f": "high"}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('d3', 3, 'onboard3', '{"uk": "🏭 Чи пояснили вам на місці, що і як робити?", "ru": "🏭 Объяснили ли вам на месте, что и как делать?", "pl": "🏭 Czy na miejscu wyjaśniono Ci, co i jak robić?", "en": "🏭 Were you shown at work what to do and how?"}'::jsonb, '[{"c": "yes", "t": {"uk": "✅ Так", "ru": "✅ Да", "pl": "✅ Tak", "en": "✅ Yes"}, "f": null}, {"c": "partly", "t": {"uk": "🤔 Не зовсім", "ru": "🤔 Не совсем", "pl": "🤔 Nie do końca", "en": "🤔 Not quite"}, "f": "low"}, {"c": "no", "t": {"uk": "❌ Ні", "ru": "❌ Нет", "pl": "❌ Nie", "en": "❌ No"}, "f": "high"}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('d3', 4, 'coord3', '{"uk": "📞 Чи координатор на звʼязку, коли він потрібен?", "ru": "📞 Координатор на связи, когда он нужен?", "pl": "📞 Czy koordynator jest dostępny, kiedy go potrzebujesz?", "en": "📞 Is your coordinator reachable when you need them?"}'::jsonb, '[{"c": "yes", "t": {"uk": "✅ Так", "ru": "✅ Да", "pl": "✅ Tak", "en": "✅ Yes"}, "f": null}, {"c": "sometimes", "t": {"uk": "🤔 Не завжди", "ru": "🤔 Не всегда", "pl": "🤔 Nie zawsze", "en": "🤔 Not always"}, "f": null}, {"c": "no", "t": {"uk": "❌ Ні", "ru": "❌ Нет", "pl": "❌ Nie", "en": "❌ No"}, "f": null}]'::jsonb, 'manager') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('d14', 1, 'work5', '{"uk": "💼 Як вам робота? Оцініть від 1 до 5", "ru": "💼 Как вам работа? Оцените от 1 до 5", "pl": "💼 Jak oceniasz pracę? Od 1 do 5", "en": "💼 How do you like the job? Rate 1 to 5"}'::jsonb, '[{"c": "1", "t": {"uk": "1 😞", "ru": "1 😞", "pl": "1 😞", "en": "1 😞"}, "f": "high"}, {"c": "2", "t": {"uk": "2", "ru": "2", "pl": "2", "en": "2"}, "f": "high"}, {"c": "3", "t": {"uk": "3", "ru": "3", "pl": "3", "en": "3"}, "f": "low"}, {"c": "4", "t": {"uk": "4", "ru": "4", "pl": "4", "en": "4"}, "f": null}, {"c": "5", "t": {"uk": "5 😀", "ru": "5 😀", "pl": "5 😀", "en": "5 😀"}, "f": null}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('d14', 2, 'housing5', '{"uk": "🏠 Як оцінюєте житло? Від 1 до 5", "ru": "🏠 Как оцениваете жильё? От 1 до 5", "pl": "🏠 Jak oceniasz zakwaterowanie? Od 1 do 5", "en": "🏠 How do you rate your accommodation? 1 to 5"}'::jsonb, '[{"c": "1", "t": {"uk": "1 😞", "ru": "1 😞", "pl": "1 😞", "en": "1 😞"}, "f": "high"}, {"c": "2", "t": {"uk": "2", "ru": "2", "pl": "2", "en": "2"}, "f": "high"}, {"c": "3", "t": {"uk": "3", "ru": "3", "pl": "3", "en": "3"}, "f": "low"}, {"c": "4", "t": {"uk": "4", "ru": "4", "pl": "4", "en": "4"}, "f": null}, {"c": "5", "t": {"uk": "5 😀", "ru": "5 😀", "pl": "5 😀", "en": "5 😀"}, "f": null}, {"c": "own", "t": {"uk": "🏡 Житло своє", "ru": "🏡 Жильё своё", "pl": "🏡 Mieszkam u siebie", "en": "🏡 Own housing"}, "f": null}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('d14', 3, 'stay', '{"uk": "📅 Плануєте працювати з нами далі?", "ru": "📅 Планируете работать с нами дальше?", "pl": "📅 Planujesz dalej z nami pracować?", "en": "📅 Do you plan to keep working with us?"}'::jsonb, '[{"c": "yes", "t": {"uk": "✅ Так", "ru": "✅ Да", "pl": "✅ Tak", "en": "✅ Yes"}, "f": null}, {"c": "unsure", "t": {"uk": "🤔 Ще не знаю", "ru": "🤔 Пока не знаю", "pl": "🤔 Jeszcze nie wiem", "en": "🤔 Not sure yet"}, "f": "low"}, {"c": "no", "t": {"uk": "❌ Ні, хочу піти", "ru": "❌ Нет, хочу уйти", "pl": "❌ Nie, chcę odejść", "en": "❌ No, I want to leave"}, "f": "high"}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('d14', 4, 'problem', '{"uk": "❓ Що зараз заважає найбільше?", "ru": "❓ Что сейчас мешает больше всего?", "pl": "❓ Co teraz przeszkadza najbardziej?", "en": "❓ What bothers you most right now?"}'::jsonb, '[{"c": "nothing", "t": {"uk": "👍 Все добре", "ru": "👍 Всё хорошо", "pl": "👍 Wszystko OK", "en": "👍 All good"}, "f": null}, {"c": "housing", "t": {"uk": "🏠 Житло", "ru": "🏠 Жильё", "pl": "🏠 Zakwaterowanie", "en": "🏠 Housing"}, "f": "low"}, {"c": "money", "t": {"uk": "💰 Оплата", "ru": "💰 Оплата", "pl": "💰 Wypłata", "en": "💰 Pay"}, "f": "low"}, {"c": "schedule", "t": {"uk": "🕐 Години / графік", "ru": "🕐 Часы / график", "pl": "🕐 Godziny / grafik", "en": "🕐 Hours / schedule"}, "f": "low"}, {"c": "team", "t": {"uk": "👥 Колектив / бригадир", "ru": "👥 Коллектив / бригадир", "pl": "👥 Zespół / brygadzista", "en": "👥 Team / supervisor"}, "f": "low"}, {"c": "transport", "t": {"uk": "🚌 Дорога", "ru": "🚌 Дорога", "pl": "🚌 Dojazd", "en": "🚌 Commute"}, "f": "low"}, {"c": "other", "t": {"uk": "✏️ Інше", "ru": "✏️ Другое", "pl": "✏️ Inne", "en": "✏️ Other"}, "f": "low"}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('d30', 1, 'work5', '{"uk": "💼 Як вам робота? Оцініть від 1 до 5", "ru": "💼 Как вам работа? Оцените от 1 до 5", "pl": "💼 Jak oceniasz pracę? Od 1 do 5", "en": "💼 How do you like the job? Rate 1 to 5"}'::jsonb, '[{"c": "1", "t": {"uk": "1 😞", "ru": "1 😞", "pl": "1 😞", "en": "1 😞"}, "f": "high"}, {"c": "2", "t": {"uk": "2", "ru": "2", "pl": "2", "en": "2"}, "f": "high"}, {"c": "3", "t": {"uk": "3", "ru": "3", "pl": "3", "en": "3"}, "f": "low"}, {"c": "4", "t": {"uk": "4", "ru": "4", "pl": "4", "en": "4"}, "f": null}, {"c": "5", "t": {"uk": "5 😀", "ru": "5 😀", "pl": "5 😀", "en": "5 😀"}, "f": null}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('d30', 2, 'housing5', '{"uk": "🏠 Як оцінюєте житло? Від 1 до 5", "ru": "🏠 Как оцениваете жильё? От 1 до 5", "pl": "🏠 Jak oceniasz zakwaterowanie? Od 1 do 5", "en": "🏠 How do you rate your accommodation? 1 to 5"}'::jsonb, '[{"c": "1", "t": {"uk": "1 😞", "ru": "1 😞", "pl": "1 😞", "en": "1 😞"}, "f": "high"}, {"c": "2", "t": {"uk": "2", "ru": "2", "pl": "2", "en": "2"}, "f": "high"}, {"c": "3", "t": {"uk": "3", "ru": "3", "pl": "3", "en": "3"}, "f": "low"}, {"c": "4", "t": {"uk": "4", "ru": "4", "pl": "4", "en": "4"}, "f": null}, {"c": "5", "t": {"uk": "5 😀", "ru": "5 😀", "pl": "5 😀", "en": "5 😀"}, "f": null}, {"c": "own", "t": {"uk": "🏡 Житло своє", "ru": "🏡 Жильё своё", "pl": "🏡 Mieszkam u siebie", "en": "🏡 Own housing"}, "f": null}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('d30', 3, 'stay', '{"uk": "📅 Плануєте працювати з нами далі?", "ru": "📅 Планируете работать с нами дальше?", "pl": "📅 Planujesz dalej z nami pracować?", "en": "📅 Do you plan to keep working with us?"}'::jsonb, '[{"c": "yes", "t": {"uk": "✅ Так", "ru": "✅ Да", "pl": "✅ Tak", "en": "✅ Yes"}, "f": null}, {"c": "unsure", "t": {"uk": "🤔 Ще не знаю", "ru": "🤔 Пока не знаю", "pl": "🤔 Jeszcze nie wiem", "en": "🤔 Not sure yet"}, "f": "low"}, {"c": "no", "t": {"uk": "❌ Ні, хочу піти", "ru": "❌ Нет, хочу уйти", "pl": "❌ Nie, chcę odejść", "en": "❌ No, I want to leave"}, "f": "high"}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('d30', 4, 'problem', '{"uk": "❓ Що зараз заважає найбільше?", "ru": "❓ Что сейчас мешает больше всего?", "pl": "❓ Co teraz przeszkadza najbardziej?", "en": "❓ What bothers you most right now?"}'::jsonb, '[{"c": "nothing", "t": {"uk": "👍 Все добре", "ru": "👍 Всё хорошо", "pl": "👍 Wszystko OK", "en": "👍 All good"}, "f": null}, {"c": "housing", "t": {"uk": "🏠 Житло", "ru": "🏠 Жильё", "pl": "🏠 Zakwaterowanie", "en": "🏠 Housing"}, "f": "low"}, {"c": "money", "t": {"uk": "💰 Оплата", "ru": "💰 Оплата", "pl": "💰 Wypłata", "en": "💰 Pay"}, "f": "low"}, {"c": "schedule", "t": {"uk": "🕐 Години / графік", "ru": "🕐 Часы / график", "pl": "🕐 Godziny / grafik", "en": "🕐 Hours / schedule"}, "f": "low"}, {"c": "team", "t": {"uk": "👥 Колектив / бригадир", "ru": "👥 Коллектив / бригадир", "pl": "👥 Zespół / brygadzista", "en": "👥 Team / supervisor"}, "f": "low"}, {"c": "transport", "t": {"uk": "🚌 Дорога", "ru": "🚌 Дорога", "pl": "🚌 Dojazd", "en": "🚌 Commute"}, "f": "low"}, {"c": "other", "t": {"uk": "✏️ Інше", "ru": "✏️ Другое", "pl": "✏️ Inne", "en": "✏️ Other"}, "f": "low"}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('d30', 5, 'coord5', '{"uk": "📞 Оцініть допомогу координатора від 1 до 5", "ru": "📞 Оцените помощь координатора от 1 до 5", "pl": "📞 Oceń pomoc koordynatora od 1 do 5", "en": "📞 Rate your coordinator’s help, 1 to 5"}'::jsonb, '[{"c": "1", "t": {"uk": "1 😞", "ru": "1 😞", "pl": "1 😞", "en": "1 😞"}, "f": null}, {"c": "2", "t": {"uk": "2", "ru": "2", "pl": "2", "en": "2"}, "f": null}, {"c": "3", "t": {"uk": "3", "ru": "3", "pl": "3", "en": "3"}, "f": null}, {"c": "4", "t": {"uk": "4", "ru": "4", "pl": "4", "en": "4"}, "f": null}, {"c": "5", "t": {"uk": "5 😀", "ru": "5 😀", "pl": "5 😀", "en": "5 😀"}, "f": null}]'::jsonb, 'manager') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('d60', 1, 'work5', '{"uk": "💼 Як вам робота? Оцініть від 1 до 5", "ru": "💼 Как вам работа? Оцените от 1 до 5", "pl": "💼 Jak oceniasz pracę? Od 1 do 5", "en": "💼 How do you like the job? Rate 1 to 5"}'::jsonb, '[{"c": "1", "t": {"uk": "1 😞", "ru": "1 😞", "pl": "1 😞", "en": "1 😞"}, "f": "high"}, {"c": "2", "t": {"uk": "2", "ru": "2", "pl": "2", "en": "2"}, "f": "high"}, {"c": "3", "t": {"uk": "3", "ru": "3", "pl": "3", "en": "3"}, "f": "low"}, {"c": "4", "t": {"uk": "4", "ru": "4", "pl": "4", "en": "4"}, "f": null}, {"c": "5", "t": {"uk": "5 😀", "ru": "5 😀", "pl": "5 😀", "en": "5 😀"}, "f": null}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('d60', 2, 'housing5', '{"uk": "🏠 Як оцінюєте житло? Від 1 до 5", "ru": "🏠 Как оцениваете жильё? От 1 до 5", "pl": "🏠 Jak oceniasz zakwaterowanie? Od 1 do 5", "en": "🏠 How do you rate your accommodation? 1 to 5"}'::jsonb, '[{"c": "1", "t": {"uk": "1 😞", "ru": "1 😞", "pl": "1 😞", "en": "1 😞"}, "f": "high"}, {"c": "2", "t": {"uk": "2", "ru": "2", "pl": "2", "en": "2"}, "f": "high"}, {"c": "3", "t": {"uk": "3", "ru": "3", "pl": "3", "en": "3"}, "f": "low"}, {"c": "4", "t": {"uk": "4", "ru": "4", "pl": "4", "en": "4"}, "f": null}, {"c": "5", "t": {"uk": "5 😀", "ru": "5 😀", "pl": "5 😀", "en": "5 😀"}, "f": null}, {"c": "own", "t": {"uk": "🏡 Житло своє", "ru": "🏡 Жильё своё", "pl": "🏡 Mieszkam u siebie", "en": "🏡 Own housing"}, "f": null}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('d60', 3, 'stay', '{"uk": "📅 Плануєте працювати з нами далі?", "ru": "📅 Планируете работать с нами дальше?", "pl": "📅 Planujesz dalej z nami pracować?", "en": "📅 Do you plan to keep working with us?"}'::jsonb, '[{"c": "yes", "t": {"uk": "✅ Так", "ru": "✅ Да", "pl": "✅ Tak", "en": "✅ Yes"}, "f": null}, {"c": "unsure", "t": {"uk": "🤔 Ще не знаю", "ru": "🤔 Пока не знаю", "pl": "🤔 Jeszcze nie wiem", "en": "🤔 Not sure yet"}, "f": "low"}, {"c": "no", "t": {"uk": "❌ Ні, хочу піти", "ru": "❌ Нет, хочу уйти", "pl": "❌ Nie, chcę odejść", "en": "❌ No, I want to leave"}, "f": "high"}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('d60', 4, 'problem', '{"uk": "❓ Що зараз заважає найбільше?", "ru": "❓ Что сейчас мешает больше всего?", "pl": "❓ Co teraz przeszkadza najbardziej?", "en": "❓ What bothers you most right now?"}'::jsonb, '[{"c": "nothing", "t": {"uk": "👍 Все добре", "ru": "👍 Всё хорошо", "pl": "👍 Wszystko OK", "en": "👍 All good"}, "f": null}, {"c": "housing", "t": {"uk": "🏠 Житло", "ru": "🏠 Жильё", "pl": "🏠 Zakwaterowanie", "en": "🏠 Housing"}, "f": "low"}, {"c": "money", "t": {"uk": "💰 Оплата", "ru": "💰 Оплата", "pl": "💰 Wypłata", "en": "💰 Pay"}, "f": "low"}, {"c": "schedule", "t": {"uk": "🕐 Години / графік", "ru": "🕐 Часы / график", "pl": "🕐 Godziny / grafik", "en": "🕐 Hours / schedule"}, "f": "low"}, {"c": "team", "t": {"uk": "👥 Колектив / бригадир", "ru": "👥 Коллектив / бригадир", "pl": "👥 Zespół / brygadzista", "en": "👥 Team / supervisor"}, "f": "low"}, {"c": "transport", "t": {"uk": "🚌 Дорога", "ru": "🚌 Дорога", "pl": "🚌 Dojazd", "en": "🚌 Commute"}, "f": "low"}, {"c": "other", "t": {"uk": "✏️ Інше", "ru": "✏️ Другое", "pl": "✏️ Inne", "en": "✏️ Other"}, "f": "low"}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('exit', 1, 'reason', '{"uk": "🚪 Чому ви вирішили піти?", "ru": "🚪 Почему вы решили уйти?", "pl": "🚪 Dlaczego zdecydowałeś(-aś) się odejść?", "en": "🚪 Why did you decide to leave?"}'::jsonb, '[{"c": "pay", "t": {"uk": "💰 Оплата", "ru": "💰 Оплата", "pl": "💰 Wypłata", "en": "💰 Pay"}, "f": null}, {"c": "housing", "t": {"uk": "🏠 Житло", "ru": "🏠 Жильё", "pl": "🏠 Zakwaterowanie", "en": "🏠 Housing"}, "f": null}, {"c": "transport", "t": {"uk": "🚌 Дорога", "ru": "🚌 Дорога", "pl": "🚌 Dojazd", "en": "🚌 Commute"}, "f": null}, {"c": "work", "t": {"uk": "💼 Сама робота", "ru": "💼 Сама работа", "pl": "💼 Charakter pracy", "en": "💼 The work itself"}, "f": null}, {"c": "schedule", "t": {"uk": "🕐 Години / графік", "ru": "🕐 Часы / график", "pl": "🕐 Godziny / grafik", "en": "🕐 Hours / schedule"}, "f": null}, {"c": "team", "t": {"uk": "👥 Колектив / бригадир", "ru": "👥 Коллектив / бригадир", "pl": "👥 Zespół / brygadzista", "en": "👥 Team / supervisor"}, "f": null}, {"c": "other_job", "t": {"uk": "🔄 Знайшов іншу роботу", "ru": "🔄 Нашёл другую работу", "pl": "🔄 Znalazłem(-am) inną pracę", "en": "🔄 Found another job"}, "f": null}, {"c": "family", "t": {"uk": "👨‍👩‍👧 Сімейні причини", "ru": "👨‍👩‍👧 Семейные причины", "pl": "👨‍👩‍👧 Sprawy rodzinne", "en": "👨‍👩‍👧 Family reasons"}, "f": null}, {"c": "documents", "t": {"uk": "📄 Документи", "ru": "📄 Документы", "pl": "📄 Dokumenty", "en": "📄 Documents"}, "f": null}, {"c": "other", "t": {"uk": "✏️ Інше", "ru": "✏️ Другое", "pl": "✏️ Inne", "en": "✏️ Other"}, "f": null}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('exit', 2, 'coordx', '{"uk": "📞 Чи допомагав вам координатор, коли було потрібно?", "ru": "📞 Помогал ли вам координатор, когда было нужно?", "pl": "📞 Czy koordynator pomagał, kiedy było trzeba?", "en": "📞 Did your coordinator help when you needed it?"}'::jsonb, '[{"c": "yes", "t": {"uk": "✅ Так", "ru": "✅ Да", "pl": "✅ Tak", "en": "✅ Yes"}, "f": null}, {"c": "partly", "t": {"uk": "🤔 Частково", "ru": "🤔 Частично", "pl": "🤔 Częściowo", "en": "🤔 Partly"}, "f": null}, {"c": "no", "t": {"uk": "❌ Ні", "ru": "❌ Нет", "pl": "❌ Nie", "en": "❌ No"}, "f": null}]'::jsonb, 'manager') ON CONFLICT (survey_code, code) DO NOTHING;
INSERT INTO care.questions (survey_code, sort, code, text, options, visibility) VALUES ('exit', 3, 'back', '{"uk": "🔁 Чи повернулися б ви до нас на роботу?", "ru": "🔁 Вернулись бы вы к нам на работу?", "pl": "🔁 Czy wrócił(a)byś do nas do pracy?", "en": "🔁 Would you come back to work with us?"}'::jsonb, '[{"c": "yes", "t": {"uk": "✅ Так", "ru": "✅ Да", "pl": "✅ Tak", "en": "✅ Yes"}, "f": null}, {"c": "maybe", "t": {"uk": "🤔 Можливо", "ru": "🤔 Возможно", "pl": "🤔 Może", "en": "🤔 Maybe"}, "f": null}, {"c": "no", "t": {"uk": "❌ Ні", "ru": "❌ Нет", "pl": "❌ Nie", "en": "❌ No"}, "f": null}]'::jsonb, 'coordinator') ON CONFLICT (survey_code, code) DO NOTHING;

COMMIT;
