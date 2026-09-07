const { T } = require("./i18n");

function langKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "Polski", callback_data: "LANG_pl" },
        { text: "English", callback_data: "LANG_en" },
      ],
      [
        { text: "Українська", callback_data: "LANG_uk" },
        { text: "Русский", callback_data: "LANG_ru" },
      ],
    ],
  };
}

function dayKeyboard(session, settings) {
  const today = new Date();
  const rows = [];
  let row = [];
  const daysCount = settings?.days_keyboard || 3;

  // От -(daysCount-1) до 0 (прошлые + сегодня) + 1 (завтра)
  for (let shift = -(daysCount - 1); shift <= 1; shift++) {
    const d = new Date(today);
    d.setDate(today.getDate() + shift);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const label = shift === 1 ? `${dd}.${mm} →` : `${dd}.${mm}`;
    row.push({ text: label, callback_data: `DAY_${dd}${mm}` });
    if (row.length === 5) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);

  const extraRow = [];
  if (settings?.enable_wolne) {
    extraRow.push({ text: T(session, "btn_wolne"), callback_data: "CMD_WOLNE" });
  }
  if (settings?.enable_advances) {
    extraRow.push({ text: T(session, "btn_advances"), callback_data: "CMD_ADVANCES" });
  }
  if (settings?.enable_tabele) {
    extraRow.push({ text: T(session, "btn_tabele"), callback_data: "CMD_TABELE" });
  }
  if (extraRow.length) rows.push(extraRow);
  rows.push([
    { text: T(session, "month_sum_btn"), callback_data: "CMD_9999" },
    { text: T(session, "logout_btn"), callback_data: "CMD_0000" },
  ]);

    rows.push([
 { text: T(session, "btn_800plus"), callback_data: "CMD_800PLUS" },
  ]);
  return { inline_keyboard: rows };
}
function hoursKeyboard(session, settings) {
  const format = settings?.hours_format || 'whole';

  let values = [];
  if (format === 'whole') {
    values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  } else if (format === 'quarter') {
    values = [1, 2, 3, 4, 4.75, 5.75, 6.75, 7.75, 8.75, 9.75, 10.75, 11.75];
  } else if (format === 'both') {
    // цілі + .75 по черзі
    values = [];
    for (let i = 0; i <= 12; i++) {
      values.push(i);
      if (i < 12) values.push(i + 0.75);
    }
  }

  const rows = [];
  let row = [];
  values.forEach((h) => {
    // callback: H_4 або H_4.75 (крапка стає підкресленням для безпеки)
    const cb = `H_${h}`;
    row.push({ text: String(h), callback_data: cb });
    if (row.length === 4) {
      rows.push(row);
      row = [];
    }
  });
  if (row.length) rows.push(row);

  rows.push([{ text: T(session, "other_value"), callback_data: "H_OTHER" }]);
  rows.push([
    { text: T(session, "btn_wz"), callback_data: "ABS_WZ" },
    { text: T(session, "btn_dwz"), callback_data: "ABS_DWZ" },
  ]);
  rows.push([
    { text: T(session, "btn_url"), callback_data: "ABS_URL" },
    { text: T(session, "btn_l4"), callback_data: "ABS_L4" },
  ]);
  rows.push([
    { text: T(session, "btn_nn"), callback_data: "ABS_NN" },
    { text: T(session, "btn_un"), callback_data: "ABS_UN" },
  ]);
  return { inline_keyboard: rows };
}

function wolneKeyboard(session) {
  const today = new Date();
  const selected = session.wolneDays || [];
  const rows = [];
  let row = [];

  for (let i = 1; i <= 14; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const key = `${dd}.${mm}`;
    const sel = selected.includes(key);
    row.push({
      text: (sel ? "+ " : "") + key,
      callback_data: `WOLNE_DAY_${key}`,
    });
    if (row.length === 4) {
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);

  rows.push([
    { text: T(session, "wolne_confirm_btn"), callback_data: "WOLNE_CONFIRM" },
    { text: T(session, "wolne_cancel_btn"), callback_data: "WOLNE_CANCEL" },
  ]);

  return { inline_keyboard: rows };
}

function tabeleKeyboard(session) {
  return {
    inline_keyboard: [
      [
        { text: T(session, "btn_back"), callback_data: "TABELE_CANCEL" },
        { text: T(session, "logout_btn"), callback_data: "CMD_0000" },
      ],
    ],
  };
}

module.exports = { langKeyboard, dayKeyboard, hoursKeyboard, wolneKeyboard, tabeleKeyboard  };
