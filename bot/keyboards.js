const { T } = require('./i18n');

function langKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: 'Polski',     callback_data: 'LANG_pl' },
        { text: 'English',    callback_data: 'LANG_en' },
      ],
      [
        { text: 'Ukrayinska', callback_data: 'LANG_uk' },
        { text: 'Russkiy',    callback_data: 'LANG_ru' },
      ],
    ],
  };
}

function dayKeyboard(session) {
  const today = new Date();
  const rows = [];
  let row = [];

  for (let shift = -1; shift <= 0; shift++) {
    const d = new Date(today);
    d.setDate(today.getDate() + shift);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    row.push({ text: `${dd}.${mm}`, callback_data: `DAY_${dd}${mm}` });
    if (row.length === 5) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);

  rows.push([{ text: T(session, 'btn_wolne'), callback_data: 'CMD_WOLNE' }]);
  rows.push([
    { text: T(session, 'month_sum_btn'), callback_data: 'CMD_9999' },
    { text: T(session, 'logout_btn'),    callback_data: 'CMD_0000' },
  ]);

  return { inline_keyboard: rows };
}

function hoursKeyboard(session) {
  const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const rows = [];
  let row = [];

  values.forEach((h) => {
    row.push({ text: String(h), callback_data: `H_${h}` });
    if (row.length === 4) { rows.push(row); row = []; }
  });
  if (row.length) rows.push(row);

  rows.push([{ text: T(session, 'other_value'), callback_data: 'H_OTHER' }]);
  rows.push([
    { text: T(session, 'btn_wz'),  callback_data: 'ABS_WZ'  },
    { text: T(session, 'btn_url'), callback_data: 'ABS_URL' },
  ]);
  rows.push([
    { text: T(session, 'btn_l4'), callback_data: 'ABS_L4' },
    { text: T(session, 'btn_nn'), callback_data: 'ABS_NN' },
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
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const key = `${dd}.${mm}`;
    const sel = selected.includes(key);
    row.push({ text: (sel ? '+ ' : '') + key, callback_data: `WOLNE_DAY_${key}` });
    if (row.length === 4) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);

  rows.push([
    { text: T(session, 'wolne_confirm_btn'), callback_data: 'WOLNE_CONFIRM' },
    { text: T(session, 'wolne_cancel_btn'),  callback_data: 'WOLNE_CANCEL'  },
  ]);

  return { inline_keyboard: rows };
}

module.exports = { langKeyboard, dayKeyboard, hoursKeyboard, wolneKeyboard };
