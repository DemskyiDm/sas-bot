// bot/campaign.js — акція для працівників визначених об'єктів.
// Налаштування в .env:
//   CAMPAIGN_ENABLED=1
//   CAMPAIGN_CODE=akcja_15_12
//   CAMPAIGN_DEADLINE=15.12
//   CAMPAIGN_FACILITY_IDS=12,15,33
// Після зміни .env потрібен рестарт: pm2 restart sas-bot

const db = require("../db");
const { T } = require("./i18n");

const ENABLED = String(process.env.CAMPAIGN_ENABLED || "0").trim() === "1";
const CODE = (process.env.CAMPAIGN_CODE || "akcja_15_12").trim();
const DEADLINE = (process.env.CAMPAIGN_DEADLINE || "15.12").trim();

const FACILITY_IDS = String(process.env.CAMPAIGN_FACILITY_IDS || "")
  .split(",")
  .map((s) => parseInt(String(s).trim(), 10))
  .filter((n) => Number.isInteger(n));

function isActive() {
  return ENABLED && FACILITY_IDS.length > 0;
}

// Чи треба показувати кнопки цьому працівнику:
// акція увімкнена + його об'єкт у списку + він ще не відповів + не звільнений
async function isEligible(workerId) {
  if (!isActive() || !workerId) return false;
  try {
    const r = await db.query(
      `SELECT 1
         FROM v_worker_current vc
        WHERE vc.id = $1
          AND vc.facility_id = ANY($2::int[])
          AND vc.status::text NOT IN ('zwolniony', 'rezygnacja')
          AND NOT EXISTS (
                SELECT 1 FROM campaign_responses cr
                 WHERE cr.worker_id = $1
                   AND cr.campaign_code = $3
              )
        LIMIT 1`,
      [workerId, FACILITY_IDS, CODE],
    );
    return r.rows.length > 0;
  } catch (e) {
    console.error("campaign isEligible error:", e.message);
    return false;
  }
}

async function hasAnswered(workerId) {
  try {
    const r = await db.query(
      `SELECT answer FROM campaign_responses
        WHERE worker_id = $1 AND campaign_code = $2`,
      [workerId, CODE],
    );
    return r.rows[0]?.answer || null;
  } catch (e) {
    console.error("campaign hasAnswered error:", e.message);
    return null;
  }
}

// Рядки кнопок, які вклеюються в головне меню (dayKeyboard)
function campaignRows(session) {
  return [
    [
      {
        text: T(session, "akc_btn_yes", DEADLINE),
        callback_data: "AKC_PICK_yes",
      },
    ],
    [{ text: T(session, "akc_btn_no"), callback_data: "AKC_PICK_no" }],
  ];
}

// Клавіатура уточнюючого питання: підтвердити / назад
function confirmKeyboard(session, answer) {
  return {
    inline_keyboard: [
      [
        {
          text: T(session, "akc_btn_confirm"),
          callback_data: `AKC_OK_${answer}`,
        },
        { text: T(session, "btn_back"), callback_data: "AKC_BACK" },
      ],
    ],
  };
}

// Окреме повідомлення з вибором (для кнопки «Назад»)
function promptKeyboard(session) {
  return { inline_keyboard: campaignRows(session) };
}

async function saveResponse(workerId, answer, lang) {
  const wq = await db.query(
    `SELECT w.id, w.full_name, w.login, w.pesel,
            vc.facility_id, f.name AS facility_name
       FROM workers w
       LEFT JOIN v_worker_current vc ON vc.id = w.id
       LEFT JOIN facilities f ON f.id = vc.facility_id
      WHERE w.id = $1`,
    [workerId],
  );
  const w = wq.rows[0];
  if (!w) return false;

  await db.query(
    `INSERT INTO campaign_responses
       (worker_id, campaign_code, answer, full_name, login, pesel,
        facility_id, facility_name, lang)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (worker_id, campaign_code) DO NOTHING`,
    [
      w.id,
      CODE,
      answer,
      w.full_name,
      w.login,
      w.pesel,
      w.facility_id,
      w.facility_name,
      lang || null,
    ],
  );
  return true;
}

module.exports = {
  CODE,
  DEADLINE,
  FACILITY_IDS,
  isActive,
  isEligible,
  hasAnswered,
  campaignRows,
  confirmKeyboard,
  promptKeyboard,
  saveResponse,
};
