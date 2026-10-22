require('dotenv').config();
const axios = require('axios');
const nodemailer = require('nodemailer');
const db = require('./db'); // Використовуємо твоє робоче підключення до БД

const IGNORE_FACILITIES = ['PERLIK', 'JÓZEF PERLIK'];

const BASE = process.env.HRAPPKA_BASE_URL || 'https://app.hrappka.pl';
const APP_TOKEN = process.env.HRAPPKA_APP_TOKEN;
const EMAIL_TO = [
    'd.demskyi@saslogistic.pl',
    'm.rosliakova@saslogistic.pl',
    'o.kapkan@saslogistic.pl',
    'd.ivanova@saslogistic.pl'
];
// Словник компаній
const COMPANIES = {
    8561: 'SAS LOGISTIC',
    8964: 'MP SERVICE',
    8961: 'WELL DONE',
    8960: 'Інша 8960',
    8959: 'Інша 8959'
};

function isIgnored(facilityName) {
    if (!facilityName) return false;
    const name = facilityName.toUpperCase().trim();
    return IGNORE_FACILITIES.some(ignore => name.includes(ignore));
}

// ── 1. Отримуємо дані з HRappka (Pracuje, Dotarł) ─────────────
async function fetchHrappka() {
    console.log('⏳ Логін в HRappka...');
    const auth = await axios.post(`${BASE}/api/v1/auth/login`, {
        email: process.env.HRAPPKA_EMAIL,
        password: process.env.HRAPPKA_PASSWORD,
        companyId: Number(process.env.HRAPPKA_COMPANY_ID),
        authenticateOldApi: true,
    });
    const token = auth.data.data.token;

    const companyIdsStr = process.env.HRAPPKA_COMPANY_IDS || '8561,8964,8961,8960,8959';
    const companyIds = companyIdsStr.split(',').map(id => Number(id.trim()));

    console.log('⏳ Завантаження даних з HRappka...');
    const body = {
        id: 'EMPLOYEE',
        offset: 0,
        limit: 5000,
        columns: [
            { id: 'id', isLocked: false, width: null },
            { id: 'name', isLocked: false, width: null },
            { id: 'state', isLocked: false, width: null },
            { id: 'companyId', isLocked: false, width: null },
            { id: 'idsNumberValuePESEL', isLocked: false, width: null },
            { id: 'idsNumberValuePASSPORT', isLocked: false, width: null },
            { id: 'currentUserContract_USER_CONTRACT_userContract_contractor_CONTRACTOR_DEPARTMENT_name', isLocked: false, width: null }
        ],
        filter: {
            logicOperator: 'AND',
            conditions: [
                { key: { columnId: 'state' }, operator: 'IN', value: ['Pracuje', 'Dotarł'] },
                { key: { columnId: 'companyId' }, operator: 'IN', value: companyIds }
            ],
            subFilters: [],
        },
        customFilters: {},
        order: { name: 'ASC' },
        additionalParameters: { fullConfig: false },
    };

    const res = await axios.post(`${BASE}/api/v1/table`, body, {
        headers: { Authorization: `Bearer ${token}`, 'x-app-token': APP_TOKEN, 'Content-Type': 'application/json' },
    });

    const allRows = res.data.data?.data || [];

    // Фільтруємо ігноровані об'єкти
    const filteredRows = allRows.filter(r => {
        const facName = r.currentUserContract_USER_CONTRACT_userContract_contractor_CONTRACTOR_DEPARTMENT_name;
        return !isIgnored(facName);
    });

    return filteredRows.map(r => ({
        hrId: r.id,
        name: r.name.trim().toUpperCase(),
        state: r.state,
        companyId: r.companyId,
        passport: (r.idsNumberValuePASSPORT || '').replace(/\s+/g, '').toUpperCase(),
        facility: r.currentUserContract_USER_CONTRACT_userContract_contractor_CONTRACTOR_DEPARTMENT_name || '—'
    }));
}

// ── 2. Отримуємо дані з нашої БД (pracuje, unknown) ──────────
async function fetchDb() {
    console.log('⏳ Завантаження даних з PostgreSQL...');

    const res = await db.query(`
        SELECT 
            w.id AS db_id, 
            w.login, 
            w.full_name, 
            w.status::text AS status,
            f.name AS facility_name, 
            f.group_name AS facility_group
        FROM public.workers w
        LEFT JOIN LATERAL (
            SELECT facility_id 
            FROM public.worker_facility_history 
            WHERE worker_id = w.id 
            ORDER BY bhp_date DESC NULLS LAST, imported_at DESC 
            LIMIT 1
        ) h ON true
        LEFT JOIN public.facilities f ON f.id = COALESCE(w.facility_id, h.facility_id)
        WHERE w.login NOT LIKE 'TEST_%'
          AND w.status::text IN ('pracuje', 'unknown')
    `);

    const rows = res.rows.map(r => ({
        dbId: r.db_id,
        login: (r.login || '').replace(/\s+/g, '').toUpperCase(),
        name: r.full_name.trim().toUpperCase(),
        status: r.status,
        facility: r.facility_name || '—',
        group: r.facility_group || '—'
    }));

    // Фільтруємо ігноровані об'єкти і в базі теж
    return rows.filter(r => !isIgnored(r.facility) && !isIgnored(r.group));
}

// Допоміжна функція для нормалізації статусів
function normalizeStatus(status, source) {
    if (!status) return '';
    const s = status.trim().toLowerCase();

    if (source === 'hr') {
        if (['pracuje', 'dotarł'].includes(s)) return 'active';
    }
    if (source === 'db') {
        if (['pracuje', 'unknown'].includes(s)) return 'active';
    }
    return s; 
}

function compareData(hrList, dbList) {
    const diffs = [];
    const matchedDbIds = new Set();
    const dbByPassport = new Map();
    const dbByName = new Map();

    dbList.forEach(w => {
        if (w.login) dbByPassport.set(w.login, w);
        if (!dbByName.has(w.name)) dbByName.set(w.name, w);
    });

    for (const hr of hrList) {
        let dbW = null;
        if (hr.passport) {
            dbW = dbByPassport.get(hr.passport);
            if (!dbW) dbW = dbByName.get(hr.name);
        } else {
            dbW = dbByName.get(hr.name);
        }

        const hrComp = `ID: ${hr.companyId}`;

        if (!dbW) {
            diffs.push({
                type: 'Немає в базі',
                name: hr.name,
                passport: hr.passport || '—',
                compHr: hrComp,
                compDb: '—',
                facHr: hr.facility,
                facDb: '—',
                hrStatus: hr.state,
                dbStatus: '—'
            });
        } else {
            matchedDbIds.add(dbW.dbId);
            const hrStatusNorm = normalizeStatus(hr.state, 'hr');
            const dbStatusNorm = normalizeStatus(dbW.status, 'db');

            if (hrStatusNorm !== dbStatusNorm) {
                diffs.push({
                    type: 'Різний статус',
                    name: hr.name,
                    passport: dbW.login || hr.passport || '—',
                    compHr: hrComp,
                    compDb: dbW.group,
                    facHr: hr.facility,
                    facDb: dbW.facility,
                    hrStatus: hr.state,
                    dbStatus: dbW.status
                });
            }
        }
    }

    // Ті, хто є в базі, але не знайшлися в HRappka
    for (const dbW of dbList) {
        if (!matchedDbIds.has(dbW.dbId)) {
            diffs.push({
                type: 'Немає в HRappka',
                name: dbW.name,
                passport: dbW.login || '—',
                compHr: '—',
                compDb: dbW.group,
                facHr: '—',
                facDb: dbW.facility,
                hrStatus: '—',
                dbStatus: dbW.status
            });
        }
    }

    return diffs;
}

// ── 4. Формування CSV ────────────────────────────────────────
function generateCsv(diffs) {
    const header = [
        'Тип розбіжності',
        'Прізвище імя',
        'Паспорт (логін)',
        'Обєкт (HRappka)',
        'Обєкт (База)',
        'Статус (HRappka)',
        'Статус (База)'
    ];
    const escape = (val) => `"${String(val || '').replace(/"/g, '""')}"`;
    const lines = [header.map(escape).join(';')];

    for (const d of diffs) {
        lines.push([
            d.type,
            d.name,
            d.passport,
            d.facHr,
            d.facDb,
            d.hrStatus,
            d.dbStatus
        ].map(escape).join(';'));
    }
    return '\uFEFF' + lines.join('\n');
}

// ── 5. Відправка Email ───────────────────────────────────────
async function sendEmail(csvContent, count) {
    console.log('⏳ Відправка Email...');
    const transporter = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 465,
        secure: true,
        auth: {
            user: process.env.GMAIL_USER,
            pass: process.env.GMAIL_APP_PASSWORD,
        },
    });

    const date = new Date().toISOString().slice(0, 10);
    const info = await transporter.sendMail({
        from: `"SAS Bot Audit" <${process.env.GMAIL_USER}>`,
        to: EMAIL_TO,
        subject: `Аудит HRappka vs БД (${date}) — Розбіжностей: ${count}`,
        text: `Доброго дня!\n\nУ вкладенні CSV-файл з розбіжностями.\nЗнайдено записів: ${count}`,
        attachments: [{ filename: `diff_report_${date}.csv`, content: csvContent }],
    });

    console.log(`✅ Лист успішно надіслано! ID: ${info.messageId}`);
}

// ── 6. Головна функція ──────────────────────────────────────
async function main() {
    try {
        const hrList = await fetchHrappka();
        console.log(`Отримано з HRappka (Pracuje/Dotarł): ${hrList.length}`);

        const dbList = await fetchDb();
        console.log(`Отримано з бази (pracuje/unknown): ${dbList.length}`);

        const diffs = compareData(hrList, dbList);
        console.log(`Знайдено розбіжностей: ${diffs.length}`);

        if (diffs.length === 0) {
            console.log('✅ Розбіжностей немає.');
            return;
        }

        const csv = generateCsv(diffs);
        await sendEmail(csv, diffs.length);

    } catch (err) {
        console.error('❌ Помилка:', err.response?.data || err.message);
    }
}

if (require.main === module) {
    main().then(() => process.exit(0));
}

module.exports = { main };