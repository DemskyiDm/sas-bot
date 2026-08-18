// // ── ANALYTICS PAGE ────────────────────────────────────────────
// let SESSION = localStorage.getItem('sas_session');
// let CURRENT_USER = JSON.parse(localStorage.getItem('sas_user') || 'null');
// let lineChartInst = null;
// let drillChartInst = null;
// let allFacilitiesData = [];
// let filteredFacilitiesData = [];
// let currentPeriod = 'week';

// const SERIES_CONFIG = [
//   { key: 'hired', label: 'Прийнято', color: '#22c55e', dash: [] },
//   { key: 'fired', label: 'Звільнено', color: '#ef4444', dash: [4, 3] },
//   { key: 'rezygnacja', label: 'Rezygnacja', color: '#f59e0b', dash: [3, 3] },
//   { key: 'moved', label: 'Перенесено', color: '#f97316', dash: [2, 3] },
//   { key: 'urlop', label: 'Відпустка', color: '#3b82f6', dash: [6, 3] },
//   { key: 'l4', label: 'Лікарняний', color: '#a855f7', dash: [2, 2] },
// ];
// const activeSeries = new Set(['hired', 'fired']);

// // ── AUTH ──────────────────────────────────────────────────────
// window.addEventListener('DOMContentLoaded', async () => {
//   if (!SESSION) { window.location = '/login.html'; return; }
//   try {
//     const res = await fetch('/admin/me', { headers: { 'x-session': SESSION } });
//     const data = await res.json();
//     if (!data.ok) { window.location = '/login.html'; return; }
//     CURRENT_USER = data.user;
//     localStorage.setItem('sas_user', JSON.stringify(CURRENT_USER));
//     document.getElementById('userName').textContent = CURRENT_USER.full_name;
//     document.getElementById('userRole').textContent = CURRENT_USER.role;
//     document.getElementById('userAvatar').textContent = CURRENT_USER.full_name.charAt(0).toUpperCase();
//     if (CURRENT_USER.is_admin) document.getElementById('adminLink').style.display = '';
//   } catch (e) {
//     window.location = '/login.html';
//     return;
//   }

//   initDates();
//   await loadFacilitiesList();
//   buildSeriesButtons();
//   await loadAnalytics();
// });

// function doLogout() {
//   fetch('/admin/logout', { method: 'POST', headers: { 'x-session': SESSION } }).catch(() => { });
//   localStorage.removeItem('sas_session');
//   localStorage.removeItem('sas_user');
//   window.location = '/login.html';
// }

// async function apiFetch(url, options) {
//   const opts = options || {};
//   opts.headers = opts.headers || {};
//   opts.headers['x-session'] = SESSION;
//   const res = await fetch(url, opts);
//   if (res.status === 401) { window.location = '/login.html'; return null; }
//   return res.json();
// }

// // ── INIT ──────────────────────────────────────────────────────
// function initDates() {
//   const now = new Date();
//   const to = now.toISOString().substring(0, 10);
//   const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().substring(0, 10);
//   document.getElementById('dateFrom').value = from;
//   document.getElementById('dateTo').value = to;
// }

// let anCurrentGroup = '';
// let anCurrentFac = '';

// async function loadFacilitiesList() {
//   const res = await apiFetch('/api/facilities');
//   if (!res) return;

//   const groups = {};
//   res.data.forEach(f => {
//     const gname = f.group_name || f.name;
//     if (!groups[gname]) groups[gname] = [];
//     groups[gname].push({ id: f.id, name: f.name });
//   });
//   window._anGroups = groups;

//   const groupList = document.getElementById('anGroupList');
//   const sortedGroups = Object.keys(groups).sort();
//   groupList.innerHTML = `
//     <div onclick="selectAnGroup('')" style="padding:7px 14px;font-size:12px;cursor:pointer;color:var(--accent);background:rgba(59,130,246,.08)">Всі групи</div>
//     ${sortedGroups.map(g => `
//       <div onclick="selectAnGroup('${g.replace(/'/g, "\\'")}');" data-gsearch="${g.toLowerCase()}" style="padding:7px 14px;font-size:12px;cursor:pointer;color:var(--text2);">📁 ${g}</div>
//     `).join('')}`;

//   buildAnFacList();
// }

// function buildAnFacList() {
//   const groups = window._anGroups || {};
//   const facList = document.getElementById('anFacList');
//   let facs = [];

//   if (anCurrentGroup) {
//     facs = (groups[anCurrentGroup] || []).sort((a, b) => a.name.localeCompare(b.name));
//   } else {
//     const all = new Map();
//     Object.values(groups).forEach(arr => arr.forEach(f => all.set(f.id, f)));
//     facs = [...all.values()].sort((a, b) => a.name.localeCompare(b.name));
//   }

//   facList.innerHTML = `
//     <div onclick="selectAnFac('','');" style="padding:7px 14px;font-size:12px;cursor:pointer;color:var(--accent);background:rgba(59,130,246,.08)">Всі об'єкти</div>
//     ${facs.map(f => `
//       <div onclick="selectAnFac(${f.id},'${f.name.replace(/'/g, "\\'")}');" data-fsearch="${f.name.toLowerCase()}" style="padding:7px 14px;font-size:12px;cursor:pointer;color:var(--text2);">${f.name}</div>
//     `).join('')}`;
// }

// function selectAnGroup(gname) {
//   anCurrentGroup = gname;
//   anCurrentFac = '';
//   document.getElementById('anGroupLabel').textContent = gname ? `📁 ${gname}` : '📁 Grupa...';
//   document.getElementById('anGroupLabel').style.color = gname ? 'var(--accent)' : 'var(--text2)';
//   document.getElementById('anFacLabel').textContent = '🏭 Obiekt...';
//   document.getElementById('anFacLabel').style.color = 'var(--text2)';
//   document.getElementById('anGroupDrop').style.display = 'none';
//   buildAnFacList();
//   loadAnalytics();
// }

// function selectAnFac(facId, facName) {
//   anCurrentFac = facId;
//   document.getElementById('anFacLabel').textContent = facName ? `🏭 ${facName}` : '🏭 Obiekt...';
//   document.getElementById('anFacLabel').style.color = facName ? 'var(--accent)' : 'var(--text2)';
//   document.getElementById('anFacDrop').style.display = 'none';
//   loadAnalytics();
// }

// function toggleAnGroupDrop() {
//   const menu = document.getElementById('anGroupDrop');
//   document.getElementById('anFacDrop').style.display = 'none';
//   menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
//   if (menu.style.display !== 'none') setTimeout(() => document.getElementById('anGroupSearch')?.focus(), 50);
// }

// function toggleAnFacDrop() {
//   const menu = document.getElementById('anFacDrop');
//   document.getElementById('anGroupDrop').style.display = 'none';
//   menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
//   if (menu.style.display !== 'none') setTimeout(() => document.getElementById('anFacSearch')?.focus(), 50);
// }

// function filterAnGroupList() {
//   const q = document.getElementById('anGroupSearch').value.toLowerCase();
//   document.querySelectorAll('#anGroupList > div[data-gsearch]').forEach(el => {
//     el.style.display = el.dataset.gsearch.includes(q) ? '' : 'none';
//   });
// }

// function filterAnFacList() {
//   const q = document.getElementById('anFacSearch').value.toLowerCase();
//   document.querySelectorAll('#anFacList > div[data-fsearch]').forEach(el => {
//     el.style.display = el.dataset.fsearch.includes(q) ? '' : 'none';
//   });
// }



// function setPeriod(btn, period) {
//   currentPeriod = period;
//   document.querySelectorAll('.period-btn').forEach(b => {
//     b.style.background = 'transparent';
//     b.style.color = 'var(--text2)';
//     b.style.fontWeight = 'normal';
//   });
//   btn.style.background = 'var(--surface2)';
//   btn.style.color = 'var(--text)';
//   btn.style.fontWeight = '500';

//   const now = new Date();
//   let from;
//   if (period === 'day') {
//     from = now.toISOString().substring(0, 10);
//   } else if (period === 'week') {
//     const d = new Date(now);
//     d.setDate(now.getDate() - 6);
//     from = d.toISOString().substring(0, 10);
//   } else {
//     from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().substring(0, 10);
//   }
//   document.getElementById('dateFrom').value = from;
//   document.getElementById('dateTo').value = now.toISOString().substring(0, 10);
//   loadAnalytics();
// }

// // ── SERIES BUTTONS ────────────────────────────────────────────
// function buildSeriesButtons() {
//   const container = document.getElementById('seriesBtns');
//   SERIES_CONFIG.forEach(s => {
//     const btn = document.createElement('button');
//     btn.style.cssText = `display:flex;align-items:center;gap:5px;padding:4px 10px;border-radius:6px;border:1px solid var(--border);background:${activeSeries.has(s.key) ? 'var(--surface2)' : 'transparent'};cursor:pointer;font-size:12px;color:var(--text${activeSeries.has(s.key) ? '' : '2'});`;
//     btn.innerHTML = `<span style="width:8px;height:8px;border-radius:2px;background:${s.color};flex-shrink:0;"></span>${s.label}`;
//     btn.dataset.key = s.key;
//     btn.onclick = () => {
//       if (activeSeries.has(s.key)) activeSeries.delete(s.key);
//       else activeSeries.add(s.key);
//       const on = activeSeries.has(s.key);
//       btn.style.background = on ? 'var(--surface2)' : 'transparent';
//       btn.style.color = on ? 'var(--text)' : 'var(--text2)';
//       updateLineChart();
//     };
//     container.appendChild(btn);
//   });
// }

// // ── LOAD DATA ─────────────────────────────────────────────────
// async function loadAnalytics() {
//   const dateFrom = document.getElementById('dateFrom').value;
//   const dateTo = document.getElementById('dateTo').value;
//   const chartUrl = `/api/analytics/chart?date_from=${dateFrom}&date_to=${dateTo}${anCurrentFac ? '&facility_id=' + anCurrentFac : ''}`;

//   const [workersRes, chartRes] = await Promise.all([
//     apiFetch('/api/workers/all'),
//     apiFetch(chartUrl),
//   ]);

//   if (!workersRes || !chartRes) return;
//   const chartData = chartRes.data;

//   // Метрики
//   const hiredTotal = Object.values(chartData.hired || {}).reduce((a, b) => a + b, 0);
//   const firedTotal = Object.values(chartData.fired || {}).reduce((a, b) => a + b, 0);
//   const balance = hiredTotal - firedTotal;

//   document.getElementById('anTotal').textContent = (chartData.total_on_date || 0).toLocaleString('pl');
//   document.getElementById('anHired').textContent = '+' + hiredTotal;
//   document.getElementById('anFired').textContent = '-' + firedTotal;
//   document.getElementById('anBalance').textContent = (balance >= 0 ? '+' : '') + balance;

//   // Будуємо facMap з workers/all
//   const facMap = {};
//   workersRes.data.forEach(w => {
//     const s = (w.status || '').toLowerCase();
//     if (s === 'zwolniony' || s === 'rezygnacja') return;

//     const fid = w.facility_id;
//     const fname = w.facility_name || '—';
//     if (!facMap[fid]) facMap[fid] = { id: fid, name: fname, total: 0, pracuje: 0, hired: 0, fired: 0, moved: 0, urlop: 0, l4: 0 };
//     facMap[fid].total++;

//     if (s === 'pracuje') facMap[fid].pracuje++;
//     if (s === 'przeniesiony') facMap[fid].moved++;
//     if (s === 'urlop') facMap[fid].urlop++;
//     if (s === 'l4') facMap[fid].l4++;

//     if (w.bhp_date) {
//       const bhp = w.bhp_date.substring(0, 10);
//       if (bhp >= dateFrom && bhp <= dateTo) facMap[fid].hired++;
//     }
//   });

//   allFacilitiesData = Object.values(facMap).sort((a, b) => b.total - a.total);

//   // Перезаписуємо total і fired з API (точні дані)
//   allFacilitiesData.forEach(f => {
//     f.total = chartData.total_by_facility?.[f.id] || f.total;
//     f.fired = chartData.fired_by_facility?.[f.id] || 0;
//     f.moved = chartData.moved_by_facility?.[f.id] || 0;
//     f.hired = chartData.hired_by_facility?.[f.id] || 0;
//     f.rezygnacja = chartData.rezygnacja_by_facility?.[f.id] || 0;  // ← ДОДАЙ
//   });

//   filteredFacilitiesData = anCurrentFac
//     ? allFacilitiesData.filter(f => String(f.id) === String(anCurrentFac))
//     : anCurrentGroup
//       ? allFacilitiesData.filter(f => {
//         const groups = window._anGroups || {};
//         const facs = (groups[anCurrentGroup] || []).map(x => x.name);
//         return facs.includes(f.name);
//       })
//       : allFacilitiesData;

//   renderSummaryTable(filteredFacilitiesData);

//   window._analyticsChartData = chartData;
//   buildLineChartData(dateFrom, dateTo);
// }

// function applyFacilityFilter() {
//   const facId = document.getElementById('anFacilityFilter').value;
//   filteredFacilitiesData = facId
//     ? allFacilitiesData.filter(f => String(f.id) === String(facId))
//     : allFacilitiesData;
//   renderSummaryTable(filteredFacilitiesData);
// }

// // ── SUMMARY TABLE ─────────────────────────────────────────────
// function renderSummaryTable(data) {
//   const tbody = document.getElementById('summaryBody');

//   // Якщо вибрана група або конкретний об'єкт — показуємо як є
//   // Якщо нічого не вибрано — групуємо по group_name
//   let displayData = data;

//   if (!anCurrentFac && !anCurrentGroup) {
//     // Групуємо по group_name
//     const groupMap = {};
//     data.forEach(f => {
//       const gname = f.name; // group_name вже є бо беремо з facilities
//       // Знаходимо group_name через _anGroups
//       const groups = window._anGroups || {};
//       let gkey = f.name;
//       Object.entries(groups).forEach(([g, facs]) => {
//         if (facs.find(x => x.name === f.name)) gkey = g;
//       });
//       if (!groupMap[gkey]) groupMap[gkey] = { name: gkey, total: 0, pracuje: 0, hired: 0, fired: 0, moved: 0, urlop: 0, l4: 0 };
//       groupMap[gkey].total += f.total;
//       groupMap[gkey].pracuje += f.pracuje;
//       groupMap[gkey].hired += f.hired;
//       groupMap[gkey].fired += f.fired;
//       groupMap[gkey].moved += f.moved;
//       groupMap[gkey].rezygnacja = (groupMap[gkey].rezygnacja || 0) + (f.rezygnacja || 0);
//       groupMap[gkey].urlop += f.urlop;
//       groupMap[gkey].l4 += f.l4;
//     });
//     displayData = Object.values(groupMap).sort((a, b) => b.total - a.total);
//   }

//   if (!displayData.length) {
//     tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--text3);padding:20px">Brak danych</td></tr>';
//     return;
//   }

//   tbody.innerHTML = displayData.map(f => `
//     <tr>
//       <td>
//         <span style="cursor:pointer;color:var(--accent);font-weight:500;" onclick="openDrill(${f.id || 0},'${f.name.replace(/'/g, "\\'")}')">
//           ${!anCurrentFac && !anCurrentGroup ? '📁 ' : ''}${f.name}
//         </span>
//       </td>
//       <td style="font-family:var(--mono);font-size:12px;">${f.total}</td>
//       <td style="font-family:var(--mono);font-size:12px;">${f.pracuje}</td>
//       <td style="font-family:var(--mono);font-size:12px;color:#4ade80">+${f.hired}</td>
//       <td style="font-family:var(--mono);font-size:12px;color:#f87171">-${f.fired}</td>
//       <td style="font-family:var(--mono);font-size:12px;color:#fb923c">${f.moved}</td>
//       <td style="font-family:var(--mono);font-size:12px;color:#f59e0b">${f.rezygnacja || 0}</td>
//       <td style="font-family:var(--mono);font-size:12px;color:#60a5fa">${f.urlop + f.l4}</td>
//     </tr>
//   `).join('');
// }

// // ── LINE CHART ────────────────────────────────────────────────
// function buildLineChartData(dateFrom, dateTo) {
//   const chartData = window._analyticsChartData;
//   if (!chartData) return;

//   const labels = [];
//   const periodKeys = [];
//   const from = new Date(dateFrom);
//   const to = new Date(dateTo);
//   const diffDays = Math.round((to - from) / 86400000);
//   const cur = new Date(from);

//   if (diffDays <= 31) {
//     while (cur <= to) {
//       const key = cur.toISOString().substring(0, 10);
//       periodKeys.push(key);
//       labels.push(`${String(cur.getDate()).padStart(2, '0')}.${String(cur.getMonth() + 1).padStart(2, '0')}`);
//       cur.setDate(cur.getDate() + 1);
//     }
//   } else {
//     cur.setDate(cur.getDate() - ((cur.getDay() + 6) % 7));
//     while (cur <= to) {
//       const key = cur.toISOString().substring(0, 10);
//       periodKeys.push(key);
//       labels.push(`${String(cur.getDate()).padStart(2, '0')}.${String(cur.getMonth() + 1).padStart(2, '0')}`);
//       cur.setDate(cur.getDate() + 7);
//     }
//   }

//   const seriesData = {};
//   SERIES_CONFIG.forEach(s => {
//     seriesData[s.key] = periodKeys.map(k => chartData[s.key]?.[k] || 0);
//   });

//   window._analyticsSeriesData = seriesData;
//   window._analyticsLabels = labels;
//   updateLineChart();
// }

// function updateLineChart() {
//   const labels = window._analyticsLabels || [];
//   const seriesData = window._analyticsSeriesData || {};
//   const isDark = matchMedia('(prefers-color-scheme: dark)').matches;
//   const gridColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
//   const tickColor = isDark ? '#666' : '#aaa';

//   const datasets = SERIES_CONFIG
//     .filter(s => activeSeries.has(s.key))
//     .map(s => ({
//       label: s.label,
//       data: seriesData[s.key] || [],
//       borderColor: s.color,
//       backgroundColor: 'transparent',
//       borderDash: s.dash,
//       tension: 0.3,
//       borderWidth: 2,
//       pointRadius: 4,
//       pointBackgroundColor: s.color,
//     }));

//   if (lineChartInst) {
//     lineChartInst.data.labels = labels;
//     lineChartInst.data.datasets = datasets;
//     lineChartInst.update();
//     return;
//   }

//   lineChartInst = new Chart(document.getElementById('lineChart'), {
//     type: 'line',
//     data: { labels, datasets },
//     options: {
//       responsive: true,
//       maintainAspectRatio: false,
//       plugins: { legend: { display: false } },
//       scales: {
//         x: { grid: { color: gridColor }, ticks: { color: tickColor, font: { size: 11 }, maxRotation: 0 } },
//         y: { grid: { color: gridColor }, ticks: { color: tickColor, font: { size: 11 } }, beginAtZero: true },
//       },
//     },
//   });
// }

// // ── DRILL DOWN ────────────────────────────────────────────────
// async function openDrill(facId, facName) {
//   document.getElementById('summaryCard').style.display = 'none';
//   document.getElementById('drillCard').style.display = '';
//   document.getElementById('drillTitle').textContent = facName;

//   // Визначаємо список об'єктів
//   const groups = window._anGroups || {};
//   const isGroup = !!groups[facName];
//   const facNames = isGroup
//     ? (groups[facName] || []).map(f => f.name)
//     : [facName];

//   const res = await apiFetch(
//     `/api/analytics/drill?facility_names=${facNames.map(encodeURIComponent).join(',')}`
//   );

//   if (!res || !res.data) return;
//   const mMap = res.data;

//   const sortedMonths = Object.keys(mMap).sort().slice(-6);
//   const monthLabels = sortedMonths.map(m =>
//     new Date(m + '-01').toLocaleString('pl', { month: 'short', year: '2-digit' })
//   );

//   const isDark = matchMedia('(prefers-color-scheme: dark)').matches;
//   const gridColor = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';
//   const tickColor = isDark ? '#666' : '#aaa';

//   if (drillChartInst) drillChartInst.destroy();
//   drillChartInst = new Chart(document.getElementById('drillChart'), {
//     type: 'bar',
//     data: {
//       labels: monthLabels.length ? monthLabels : ['Немає даних'],
//       datasets: [
//         { label: 'Прийнято', data: sortedMonths.map(m => mMap[m].hired), backgroundColor: 'rgba(34,197,94,0.7)', borderRadius: 3 },
//         { label: 'Звільнено', data: sortedMonths.map(m => -mMap[m].fired), backgroundColor: 'rgba(239,68,68,0.7)', borderRadius: 3 },
//         { label: 'Rezygnacja', data: sortedMonths.map(m => -mMap[m].rezygnacja), backgroundColor: 'rgba(245,158,11,0.7)', borderRadius: 3 },
//         { label: 'Перенесено', data: sortedMonths.map(m => mMap[m].moved), backgroundColor: 'rgba(249,115,22,0.7)', borderRadius: 3 },
//       ],
//     },
//     options: {
//       responsive: true,
//       maintainAspectRatio: false,
//       plugins: { legend: { display: false } },
//       scales: {
//         x: { grid: { color: gridColor }, ticks: { color: tickColor, font: { size: 11 } }, stacked: true },
//         y: { grid: { color: gridColor }, ticks: { color: tickColor, font: { size: 11 } }, stacked: true },
//       },
//     },
//   });

//   document.getElementById('drillBody').innerHTML = sortedMonths.length
//     ? sortedMonths.map(m => {
//       const d = new Date(m + '-01');
//       const label = d.toLocaleString('pl', { month: 'long', year: 'numeric' });
//       const row = mMap[m];
//       return `<tr>
//             <td style="font-size:13px;">${label}</td>
//             <td style="font-family:var(--mono);font-size:12px;">${row.total}</td>
//             <td style="font-family:var(--mono);font-size:12px;color:#4ade80">+${row.hired}</td>
//             <td style="font-family:var(--mono);font-size:12px;color:#f87171">-${row.fired}</td>
//             <td style="font-family:var(--mono);font-size:12px;color:#f59e0b">${row.rezygnacja}</td>
//             <td style="font-family:var(--mono);font-size:12px;color:#fb923c">${row.moved}</td>
//           </tr>`;
//     }).join('')
//     : '<tr><td colspan="5" style="text-align:center;color:var(--text3);padding:20px">Немає даних</td></tr>';
// }

// function closeDrill() {
//   document.getElementById('drillCard').style.display = 'none';
//   document.getElementById('summaryCard').style.display = '';
// }

// // ── EXCEL EXPORT ──────────────────────────────────────────────
// function exportSummaryExcel() {
//   if (!window.XLSX) { alert('XLSX не завантажено'); return; }
//   const data = filteredFacilitiesData.map(f => ({
//     "Об'єкт": f.name,
//     'Всього': f.total,
//     'Працює': f.pracuje,
//     'Прийнято': f.hired,
//     'Звільнено': f.fired,
//     'Перенесено': f.moved,
//     'Відпустка/Л4': f.urlop + f.l4,
//   }));
//   const ws = window.XLSX.utils.json_to_sheet(data);
//   ws['!cols'] = Object.keys(data[0]).map(k => ({ wch: Math.max(k.length, 15) }));
//   const wb = window.XLSX.utils.book_new();
//   window.XLSX.utils.book_append_sheet(wb, ws, 'Analityka');
//   window.XLSX.writeFile(wb, `analityka_${new Date().toISOString().substring(0, 10)}.xlsx`);
// }

// document.addEventListener('click', (e) => {
//   [
//     { wrap: 'anGroupDropWrap', drop: 'anGroupDrop' },
//     { wrap: 'anFacDropWrap', drop: 'anFacDrop' },
//   ].forEach(({ wrap, drop }) => {
//     const w = document.getElementById(wrap);
//     const d = document.getElementById(drop);
//     if (d && w && !w.contains(e.target)) d.style.display = 'none';
//   });
// });