// // ── HOURS PAGE ────────────────────────────────────────────────
// let pageHours = 1;

// async function loadWorkers() {
//   const month = document.getElementById("monthSelect").value;
//   const url = `/api/workers?month=${month}`;
//   try {
//     const res = await apiFetch(url);
//     if (!res) return;
//     allWorkers = res.data;
//     renderTabs(res.data);
//     if (currentFacility) {
//       renderTable(allWorkers.filter((w) => w.facility_id == currentFacility));
//     } else {
//       renderTable(res.data);
//     }
//   } catch (e) {
//     document.getElementById("workerTable").innerHTML =
//       `<tr><td colspan="4" style="color:var(--red);padding:20px">Blad: ${e.message}</td></tr>`;
//   }
// }

// function renderTabs(workers) {
//   const facs = {};
//   const groups = {};

//   workers.forEach((w) => {
//     const fid = w.facility_id;
//     const fname = w.facility_name;
//     const gname = w.group_name || fname;
//     if (!facs[fid]) facs[fid] = { name: fname, count: 0, group: gname };
//     facs[fid].count++;
//     if (!groups[gname]) groups[gname] = { count: 0, facilities: [] };
//     groups[gname].count++;
//     if (!groups[gname].facilities.find(f => f.id == fid)) {
//       groups[gname].facilities.push({ id: fid, name: fname, count: facs[fid].count });
//     }
//   });

//   // Зберігаємо для використання в filterByGroup
//   window._allGroups = groups;
//   window._allFacs = facs;

//   const tabs = document.getElementById("facilityTabs");
//   const groupList = Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));

//   // Визначаємо поточну групу і об'єкт
//   const currentGroup = window._currentGroup || '';
//   const currentFac = currentFacility || '';

//   // Фільтруємо об'єкти по групі
//   const filteredFacs = currentGroup
//     ? Object.entries(facs).filter(([, f]) => f.group === currentGroup).sort((a, b) => a[1].name.localeCompare(b[1].name))
//     : Object.entries(facs).sort((a, b) => a[1].name.localeCompare(b[1].name));

//   const groupLabel = currentGroup || 'Grupa...';
//   const facLabel = currentFac && facs[currentFac] ? facs[currentFac].name : 'Obiekt...';

//   tabs.innerHTML = `
//     <div style="display:flex;align-items:center;gap:8px;padding:6px 16px;width:100%;">

//       <!-- DROPDOWN ГРУП -->
//       <div style="position:relative;" id="groupDropWrap">
//         <button onclick="toggleGroupDrop()" style="height:32px;padding:0 12px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:${currentGroup ? 'var(--surface2)' : 'var(--surface)'};color:${currentGroup ? 'var(--accent)' : 'var(--text2)'};cursor:pointer;display:flex;align-items:center;gap:6px;white-space:nowrap;">
//           📁 ${groupLabel} <span style="font-size:9px">▼</span>
//         </button>
//         <div id="groupDropMenu" style="display:none;position:absolute;top:36px;left:0;background:var(--surface2);border:1px solid var(--border);border-radius:8px;min-width:260px;max-height:400px;overflow-y:auto;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.4);padding:6px 0;">
//           <div style="padding:6px 8px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--surface2);">
//             <input id="groupSearch" type="text" placeholder="Szukaj grupy..." style="width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:5px;font-size:12px;" oninput="filterGroupList()"/>
//           </div>
//           <div id="groupList">
//             <div onclick="selectGroup('');toggleGroupDrop()" style="padding:7px 14px;font-size:12px;cursor:pointer;display:flex;justify-content:space-between;color:${!currentGroup ? 'var(--accent)' : 'var(--text2)'};background:${!currentGroup ? 'rgba(59,130,246,.08)' : 'transparent'}">
//               <span>Wszystkie grupy</span>
//               <span style="font-family:var(--mono);font-size:10px;color:var(--text3)">${workers.length}</span>
//             </div>
//             ${groupList.map(([gname, g]) => `
//               <div onclick="selectGroup('${gname.replace(/'/g, "\\'")}');toggleGroupDrop()" data-gsearch="${gname.toLowerCase()}" style="padding:7px 14px;font-size:12px;cursor:pointer;display:flex;justify-content:space-between;color:${currentGroup === gname ? 'var(--accent)' : 'var(--text2)'};background:${currentGroup === gname ? 'rgba(59,130,246,.08)' : 'transparent'}">
//                 <span>📁 ${gname}</span>
//                 <span style="font-family:var(--mono);font-size:10px;color:var(--text3);background:var(--surface);padding:1px 6px;border-radius:10px">${g.count}</span>
//               </div>`).join('')}
//           </div>
//         </div>
//       </div>

//       <!-- DROPDOWN ОБ'ЄКТІВ -->
//       <div style="position:relative;" id="facDropWrap">
//         <button onclick="toggleFacDrop()" style="height:32px;padding:0 12px;font-size:12px;border:1px solid var(--border);border-radius:6px;background:${currentFac ? 'var(--surface2)' : 'var(--surface)'};color:${currentFac ? 'var(--accent)' : 'var(--text2)'};cursor:pointer;display:flex;align-items:center;gap:6px;white-space:nowrap;">
//           🏭 ${facLabel} <span style="font-size:9px">▼</span>
//         </button>
//         <div id="facDropMenu" style="display:none;position:absolute;top:36px;left:0;background:var(--surface2);border:1px solid var(--border);border-radius:8px;min-width:260px;max-height:400px;overflow-y:auto;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.4);padding:6px 0;">
//           <div style="padding:6px 8px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--surface2);">
//             <input id="facSearch" type="text" placeholder="Szukaj obiektu..." style="width:100%;background:var(--surface);border:1px solid var(--border);color:var(--text);padding:5px 8px;border-radius:5px;font-size:12px;" oninput="filterFacilitiesList()"/>
//           </div>
//           <div id="facList">
//             <div onclick="filterFacility('');toggleFacDrop()" style="padding:7px 14px;font-size:12px;cursor:pointer;display:flex;justify-content:space-between;color:${!currentFac ? 'var(--accent)' : 'var(--text2)'};background:${!currentFac ? 'rgba(59,130,246,.08)' : 'transparent'}">
//               <span>Wszystkie obiekty</span>
//               <span style="font-family:var(--mono);font-size:10px;color:var(--text3)">${filteredFacs.reduce((s, [, f]) => s + f.count, 0)}</span>
//             </div>
//             ${filteredFacs.map(([fid, f]) => `
//               <div onclick="filterFacility(${fid});toggleFacDrop()" data-fsearch="${f.name.toLowerCase()}" style="padding:7px 14px;font-size:12px;cursor:pointer;display:flex;justify-content:space-between;color:${currentFacility == fid ? 'var(--accent)' : 'var(--text2)'};background:${currentFacility == fid ? 'rgba(59,130,246,.08)' : 'transparent'}">
//                 <span>${f.name}</span>
//                 <span style="font-family:var(--mono);font-size:10px;color:var(--text3);background:var(--surface);padding:1px 6px;border-radius:10px">${f.count}</span>
//               </div>`).join('')}
//           </div>
//         </div>
//       </div>

//     </div>`;
// }

// function toggleGroupDrop() {
//   const menu = document.getElementById("groupDropMenu");
//   const facMenu = document.getElementById("facDropMenu");
//   if (facMenu) facMenu.style.display = 'none';
//   if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
//   if (menu && menu.style.display !== 'none') setTimeout(() => document.getElementById("groupSearch")?.focus(), 50);
// }

// function toggleFacDrop() {
//   const menu = document.getElementById("facDropMenu");
//   const groupMenu = document.getElementById("groupDropMenu");
//   if (groupMenu) groupMenu.style.display = 'none';
//   if (menu) menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
//   if (menu && menu.style.display !== 'none') setTimeout(() => document.getElementById("facSearch")?.focus(), 50);
// }

// function filterGroupList() {
//   const q = document.getElementById("groupSearch").value.toLowerCase();
//   document.querySelectorAll("#groupList > div[data-gsearch]").forEach(el => {
//     el.style.display = el.dataset.gsearch.includes(q) ? "flex" : "none";
//   });
// }

// function selectGroup(gname) {
//   window._currentGroup = gname;
//   currentFacility = '';
//   renderTabs(allWorkers);
//   const filtered = gname
//     ? allWorkers.filter(w => (w.group_name || w.facility_name) === gname)
//     : allWorkers;
//   renderTable(filtered);
//   loadStatsByFacility(null);
// }



// function filterTable() {
//   pageHours = 1;
//   const q = document.getElementById("searchInput").value.toLowerCase();
//   const filtered = allWorkers.filter((w) =>
//     (currentFacility ? w.facility_id == currentFacility : true) &&
//     (w.full_name.toLowerCase().includes(q) || w.login.includes(q))
//   );
//   renderTable(filtered);
// }

// function filterFacility(id) {
//   currentFacility = id;
//   renderTabs(allWorkers);
//   const filtered = id ? allWorkers.filter((w) => w.facility_id == id) : allWorkers;
//   renderTable(filtered);
//   loadStatsByFacility(id);
// }

// function filterFacilitiesList() {
//   const q = document.getElementById("facSearch").value.toLowerCase();
//   document.querySelectorAll("#facList > div[data-fsearch]").forEach((el) => {
//     el.style.display = el.dataset.fsearch.includes(q) ? "flex" : "none";
//   });
// }

// function renderSummaryTable(workers) {
//   renderBackButton('facilities');
//   const month = document.getElementById("monthSelect").value;
//   const [year, mm] = month.split("-");
//   const daysInMonth = new Date(parseInt(year), parseInt(mm), 0).getDate();
//   const today = new Date();
//   const todayDay = today.getFullYear() === parseInt(year) && today.getMonth() + 1 === parseInt(mm)
//     ? today.getDate() : daysInMonth;

//   const thead = document.querySelector("#workerTable").closest("table").querySelector("thead");
//   if (thead) thead.style.display = "none";

//   const facMap = {};
//   workers.forEach((w) => {
//     const fid = w.facility_id;
//     const fname = w.facility_name || "—";
//     if (!facMap[fid]) facMap[fid] = { name: fname, days: {}, total: 0, workers: 0 };
//     facMap[fid].workers++;
//     (w.hours || []).forEach((h) => {
//       const d = new Date(h.work_date).getDate();
//       if (!facMap[fid].days[d]) facMap[fid].days[d] = 0;
//       if (h.hours) { facMap[fid].days[d] += parseFloat(h.hours); facMap[fid].total += parseFloat(h.hours); }
//     });
//   });

//   const facList = Object.entries(facMap);
//   const totalDays = {};
//   let grandTotal = 0;
//   facList.forEach(([fid, f]) => {
//     Object.entries(f.days).forEach(([d, val]) => {
//       if (!totalDays[d]) totalDays[d] = 0;
//       totalDays[d] += val; grandTotal += val;
//     });
//   });

//   const dayHeaders = Array.from({ length: daysInMonth }, (_, i) => {
//     const d = i + 1;
//     const isFuture = d > todayDay;
//     return `<th style="font-family:var(--mono);font-size:9px;padding:8px 3px;text-align:center;min-width:26px;color:${isFuture ? "var(--text3)" : "var(--text2)"};background:var(--surface2);border-bottom:1px solid var(--border)">${String(d).padStart(2, "0")}</th>`;
//   }).join("");

//   const rows = facList.map(([fid, f]) => {
//     const cells = Array.from({ length: daysInMonth }, (_, i) => {
//       const d = i + 1;
//       const isFuture = d > todayDay;
//       const val = f.days[d] || 0;
//       let bg = "transparent", text = "transparent", content = "";
//       if (!isFuture && val > 0) { bg = "rgba(34,197,94,.15)"; text = "var(--green)"; content = val % 1 === 0 ? val : val.toFixed(2); }
//       else if (!isFuture) { bg = "rgba(239,68,68,.1)"; text = "var(--red)"; content = "·"; }
//       return `<td style="padding:4px 3px;text-align:center"><div style="background:${bg};color:${text};border-radius:3px;font-family:var(--mono);font-size:10px;font-weight:600;padding:3px 2px;line-height:1">${content}</div></td>`;
//     }).join("");
//     return `<tr onclick="filterFacility(${fid})" style="cursor:pointer;border-bottom:1px solid rgba(42,51,71,.4)" onmouseover="this.style.background='rgba(255,255,255,.02)'" onmouseout="this.style.background=''">
//       <td style="padding:10px 14px;white-space:nowrap;min-width:200px">
//         <span style="font-weight:600;font-size:13px">${f.name}</span>
//         <span style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-left:8px">${f.workers} os.</span>
//       </td>
//       ${cells}
//       <td style="padding:10px 14px;font-family:var(--mono);font-weight:700;font-size:13px;color:var(--accent2);white-space:nowrap;text-align:right">${f.total > 0 ? f.total.toFixed(2) + "h" : "—"}</td>
//     </tr>`;
//   }).join("");

//   document.getElementById("workerCount").textContent = facList.length + " obj.";
//   document.getElementById("paginationHours").innerHTML = "";
//   document.getElementById("workerTable").innerHTML = `
//     <tr>
//       <th style="font-family:var(--mono);font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;padding:9px 14px;text-align:left;border-bottom:1px solid var(--border);background:var(--surface2)">Obiekt</th>
//       ${dayHeaders}
//       <th style="font-family:var(--mono);font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;padding:9px 14px;text-align:right;border-bottom:1px solid var(--border);background:var(--surface2)">Suma</th>
//     </tr>
//     <tr style="border-bottom:2px solid var(--border);background:rgba(59,130,246,.06)">
//       <td style="padding:8px 14px;font-family:var(--mono);font-size:10px;font-weight:700;color:var(--accent);letter-spacing:1px;text-transform:uppercase">RAZEM</td>
//       ${Array.from({ length: daysInMonth }, (_, i) => {
//     const d = i + 1; const isFuture = d > todayDay; const val = totalDays[d] || 0;
//     return `<td style="padding:4px 3px;text-align:center"><div style="background:${val > 0 ? "rgba(59,130,246,.15)" : "transparent"};color:${val > 0 ? "var(--blue)" : "transparent"};border-radius:3px;font-family:var(--mono);font-size:10px;font-weight:700;padding:3px 2px;line-height:1">${val > 0 && !isFuture ? (val % 1 === 0 ? val : val.toFixed(2)) : ""}</div></td>`;
//   }).join("")}
//       <td style="padding:8px 14px;font-family:var(--mono);font-weight:700;font-size:13px;color:var(--blue);text-align:right">${grandTotal > 0 ? grandTotal.toFixed(2) + "h" : "—"}</td>
//     </tr>
//     ${rows || '<tr><td colspan="33" style="text-align:center;color:var(--text3);padding:30px">Brak danych</td></tr>'}`;
// }

// function renderTable(workers) {
//   document.getElementById("workerCount").textContent = workers.length + " os.";

//   // Рівень 1: нічого не вибрано → групи
//   if (!window._currentGroup && !currentFacility) {
//     renderGroupsTable(workers);
//     return;
//   }
//   // Рівень 2: вибрана група, не вибраний об'єкт → об'єкти групи
//   if (window._currentGroup && !currentFacility) {
//     renderSummaryTable(workers);
//     return;
//   }
//   // Рівень 3: вибраний об'єкт → працівники
//   renderWorkersTable(workers);
// }

// function renderGroupsTable(workers) {
//   hideBackButton();
//   const month = document.getElementById("monthSelect").value;
//   const [year, mm] = month.split("-");
//   const daysInMonth = new Date(parseInt(year), parseInt(mm), 0).getDate();
//   const today = new Date();
//   const todayDay = today.getFullYear() === parseInt(year) && today.getMonth() + 1 === parseInt(mm)
//     ? today.getDate() : daysInMonth;

//   const thead = document.querySelector("#workerTable").closest("table").querySelector("thead");
//   if (thead) thead.style.display = "none";

//   // Групуємо по group_name
//   const groupMap = {};
//   workers.forEach((w) => {
//     const gname = w.group_name || w.facility_name || "—";
//     if (!groupMap[gname]) groupMap[gname] = { name: gname, days: {}, total: 0, workers: new Set() };
//     groupMap[gname].workers.add(w.id);
//     (w.hours || []).forEach((h) => {
//       const d = new Date(h.work_date).getDate();
//       if (!groupMap[gname].days[d]) groupMap[gname].days[d] = 0;
//       if (h.hours) { groupMap[gname].days[d] += parseFloat(h.hours); groupMap[gname].total += parseFloat(h.hours); }
//     });
//   });

//   const groupList = Object.entries(groupMap).sort((a, b) => a[0].localeCompare(b[0]));
//   const totalDays = {};
//   let grandTotal = 0;
//   groupList.forEach(([, g]) => {
//     Object.entries(g.days).forEach(([d, val]) => {
//       if (!totalDays[d]) totalDays[d] = 0;
//       totalDays[d] += val; grandTotal += val;
//     });
//   });

//   const dayHeaders = Array.from({ length: daysInMonth }, (_, i) => {
//     const d = i + 1;
//     const isFuture = d > todayDay;
//     return `<th style="font-family:var(--mono);font-size:9px;padding:8px 3px;text-align:center;min-width:26px;color:${isFuture ? "var(--text3)" : "var(--text2)"};background:var(--surface2);border-bottom:1px solid var(--border)">${String(d).padStart(2, "0")}</th>`;
//   }).join("");

//   const rows = groupList.map(([gname, g]) => {
//     const cells = Array.from({ length: daysInMonth }, (_, i) => {
//       const d = i + 1;
//       const isFuture = d > todayDay;
//       const val = g.days[d] || 0;
//       let bg = "transparent", text = "transparent", content = "";
//       if (!isFuture && val > 0) { bg = "rgba(34,197,94,.15)"; text = "var(--green)"; content = val % 1 === 0 ? val : val.toFixed(2); }
//       else if (!isFuture) { bg = "rgba(239,68,68,.1)"; text = "var(--red)"; content = "·"; }
//       return `<td style="padding:4px 3px;text-align:center"><div style="background:${bg};color:${text};border-radius:3px;font-family:var(--mono);font-size:10px;font-weight:600;padding:3px 2px;line-height:1">${content}</div></td>`;
//     }).join("");
//     return `<tr onclick="selectGroup('${gname.replace(/'/g, "\\'")}')" style="cursor:pointer;border-bottom:1px solid rgba(42,51,71,.4)" onmouseover="this.style.background='rgba(255,255,255,.02)'" onmouseout="this.style.background=''">
//       <td style="padding:10px 14px;white-space:nowrap;min-width:200px">
//         <span style="font-weight:600;font-size:13px">📁 ${gname}</span>
//         <span style="font-size:10px;color:var(--text3);font-family:var(--mono);margin-left:8px">${g.workers.size} os.</span>
//       </td>
//       ${cells}
//       <td style="padding:10px 14px;font-family:var(--mono);font-weight:700;font-size:13px;color:var(--accent2);white-space:nowrap;text-align:right">${g.total > 0 ? g.total.toFixed(2) + "h" : "—"}</td>
//     </tr>`;
//   }).join("");

//   document.getElementById("workerCount").textContent = groupList.length + " grup";
//   document.getElementById("paginationHours").innerHTML = "";
//   document.getElementById("workerTable").innerHTML = `
//     <tr>
//       <th style="font-family:var(--mono);font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;padding:9px 14px;text-align:left;border-bottom:1px solid var(--border);background:var(--surface2)">Grupa</th>
//       ${dayHeaders}
//       <th style="font-family:var(--mono);font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:1px;padding:9px 14px;text-align:right;border-bottom:1px solid var(--border);background:var(--surface2)">Suma</th>
//     </tr>
//     <tr style="border-bottom:2px solid var(--border);background:rgba(59,130,246,.06)">
//       <td style="padding:8px 14px;font-family:var(--mono);font-size:10px;font-weight:700;color:var(--accent);letter-spacing:1px;text-transform:uppercase">RAZEM</td>
//       ${Array.from({ length: daysInMonth }, (_, i) => {
//     const d = i + 1; const isFuture = d > todayDay; const val = totalDays[d] || 0;
//     return `<td style="padding:4px 3px;text-align:center"><div style="background:${val > 0 ? "rgba(59,130,246,.15)" : "transparent"};color:${val > 0 ? "var(--blue)" : "transparent"};border-radius:3px;font-family:var(--mono);font-size:10px;font-weight:700;padding:3px 2px;line-height:1">${val > 0 && !isFuture ? (val % 1 === 0 ? val : val.toFixed(2)) : ""}</div></td>`;
//   }).join("")}
//       <td style="padding:8px 14px;font-family:var(--mono);font-weight:700;font-size:13px;color:var(--blue);text-align:right">${grandTotal > 0 ? grandTotal.toFixed(2) + "h" : "—"}</td>
//     </tr>
//     ${rows || '<tr><td colspan="33" style="text-align:center;color:var(--text3);padding:30px">Brak danych</td></tr>'}`;
// }

// function renderWorkersTable(workers) {
//   // Кнопка "Назад" над таблицею
//   renderBackButton('workers');

//   const { slice, pages } = paginate(workers, pageHours, pageSizeHours);
//   const month = document.getElementById("monthSelect").value;
//   const [year, mm] = month.split("-");
//   const daysInMonth = new Date(parseInt(year), parseInt(mm), 0).getDate();
//   const today = new Date();
//   const todayDay = today.getFullYear() === parseInt(year) && today.getMonth() + 1 === parseInt(mm)
//     ? today.getDate() : daysInMonth;

//   const tbody = document.getElementById("workerTable");
//   if (!slice.length) {
//     tbody.innerHTML = `<tr><td colspan="4" style="color:var(--text3);padding:20px;text-align:center">Brak pracownikow</td></tr>`;
//     document.getElementById("paginationHours").innerHTML = "";
//     return;
//   }

//   tbody.innerHTML = slice.map((w) => {
//     const dayMap = {};
//     (w.hours || []).forEach((h) => { const d = new Date(h.work_date); dayMap[d.getDate()] = h; });

//     const bhpDay = w.bhp_date ? new Date(w.bhp_date).getDate() : 1;
//     const bhpMm = w.bhp_date ? new Date(w.bhp_date).getMonth() + 1 : 0;
//     const bhpYr = w.bhp_date ? new Date(w.bhp_date).getFullYear() : 0;
//     const lastDay = w.last_work_date ? new Date(w.last_work_date).getDate() : 0;
//     const lastMm = w.last_work_date ? new Date(w.last_work_date).getMonth() + 1 : 0;
//     const lastYr = w.last_work_date ? new Date(w.last_work_date).getFullYear() : 0;
//     let totalHours = 0, missingCount = 0;

//     const cells = Array.from({ length: daysInMonth }, (_, i) => {
//       const day = i + 1;
//       const isBeforeBhp = w.bhp_date && (parseInt(year) < bhpYr || (parseInt(year) === bhpYr && parseInt(mm) < bhpMm) || (parseInt(year) === bhpYr && parseInt(mm) === bhpMm && day < bhpDay));
//       const isAfterLast = w.last_work_date && (parseInt(year) > lastYr || (parseInt(year) === lastYr && parseInt(mm) > lastMm) || (parseInt(year) === lastYr && parseInt(mm) === lastMm && day > lastDay));
//       const isOutside = isBeforeBhp || isAfterLast;
//       const isFuture = day > todayDay;
//       const h = dayMap[day];
//       const fmt = (v) => parseFloat(v) % 1 === 0 ? parseInt(v) : parseFloat(v).toFixed(2);

//       if (isOutside) return `<div class="day-cell black" title="${String(day).padStart(2, "0")}.${mm}">${String(day).padStart(2, "0")}</div>`;
//       if (isFuture) return `<div class="day-cell future">${String(day).padStart(2, "0")}</div>`;
//       if (h) {
//         if (h.hours !== null) {
//           totalHours += parseFloat(h.hours);
//           return `<div class="day-cell filled" title="${String(day).padStart(2, "0")}.${mm}: ${fmt(h.hours)}h" onclick="openEdit(${w.id},'${year}-${mm}-${String(day).padStart(2, "0")}',${h.hours || 0},'${h.absence_type || ""}')">${fmt(h.hours)}</div>`;
//         } else {
//           return `<div class="day-cell ${h.absence_type.toLowerCase()}" title="${h.absence_type}" onclick="openEdit(${w.id},'${year}-${mm}-${String(day).padStart(2, "0")}',null,'${h.absence_type}')">${h.absence_type}</div>`;
//         }
//       } else {
//         missingCount++;
//         return `<div class="day-cell empty" title="${String(day).padStart(2, "0")}.${mm} — brak" onclick="openEdit(${w.id},'${year}-${mm}-${String(day).padStart(2, "0")}',null,'')">${String(day).padStart(2, "0")}</div>`;
//       }
//     }).join("");

//     const badge = missingCount > 3
//       ? `<span class="badge badge-red"><span class="badge-dot"></span>brak ${missingCount}d</span>`
//       : missingCount > 0
//         ? `<span class="badge badge-orange"><span class="badge-dot"></span>brak ${missingCount}d</span>`
//         : `<span class="badge badge-green"><span class="badge-dot"></span>OK</span>`;

//     return `<tr>
//       <td><div class="worker-name">${w.full_name}</div><div class="worker-id">#${w.login}</div></td>
//       <td>${badge}</td>
//       <td><div class="day-cells">${cells}</div></td>
//       <td><span class="hours-sum">${totalHours.toFixed(2)}h</span></td>
//     </tr>`;
//   }).join("");

//   renderPagination("paginationHours", pageHours, pages, "goPageHours");
// }

// function renderBackButton(level) {
//   let bar = document.getElementById("hoursBackBar");
//   if (!bar) {
//     bar = document.createElement("div");
//     bar.id = "hoursBackBar";
//     bar.style.cssText = "padding:8px 16px;";
//     const tabs = document.getElementById("facilityTabs");
//     tabs.parentNode.insertBefore(bar, tabs.nextSibling);
//   }

//   if (level === 'workers') {
//     const facName = window._allFacs && window._allFacs[currentFacility]
//       ? window._allFacs[currentFacility].name : "";
//     bar.innerHTML = `<button onclick="goBack()" class="btn btn-ghost btn-sm">← Назад</button>
//       <span style="margin-left:10px;font-size:13px;font-weight:600;color:var(--accent)">🏭 ${facName}</span>`;
//   } else if (level === 'facilities') {
//     bar.innerHTML = `<button onclick="goBack()" class="btn btn-ghost btn-sm">← Назад</button>
//       <span style="margin-left:10px;font-size:13px;font-weight:600;color:var(--accent)">📁 ${window._currentGroup}</span>`;
//   }
//   bar.style.display = "";
// }

// function hideBackButton() {
//   const bar = document.getElementById("hoursBackBar");
//   if (bar) bar.style.display = "none";
// }

// function goBack() {
//   if (currentFacility) {
//     // З працівників → назад до об'єктів групи
//     currentFacility = '';
//     hideBackButton();
//     renderTabs(allWorkers);
//     const filtered = window._currentGroup
//       ? allWorkers.filter(w => (w.group_name || w.facility_name) === window._currentGroup)
//       : allWorkers;
//     renderTable(filtered);
//   } else if (window._currentGroup) {
//     // З об'єктів → назад до груп
//     window._currentGroup = '';
//     renderTabs(allWorkers);
//     renderTable(allWorkers);
//   }
// }

// function changeHoursPageSize() {
//   pageSizeHours = parseInt(document.getElementById("hoursPageSize").value);
//   pageHours = 1;
//   filterTable();
// }

// function goPageHours(p) {
//   pageHours = p;
//   const q = document.getElementById("searchInput").value.toLowerCase();
//   const filtered = allWorkers.filter((w) =>
//     (currentFacility ? w.facility_id == currentFacility : true) &&
//     (w.full_name.toLowerCase().includes(q) || w.login.includes(q))
//   );
//   renderTable(filtered);
// }

// // ── EDIT MODAL ────────────────────────────────────────────────
// function openEdit(workerId, date, hours, absence) {
//   editState = { workerId, date, hours, absence };
//   document.getElementById("modalDate").value = date;
//   document.getElementById("modalHours").value = hours || "";
//   document.getElementById("modalTitle").textContent = `Edytuj: ${date}`;
//   document.getElementById("editModal").classList.add("open");
// }
// function closeModal() {
//   document.getElementById("editModal").classList.remove("open");
//   editState = {};
// }
// function setAbs(code, e) {
//   editState.absence = code;
//   editState.hours = null;
//   document.getElementById("modalHours").value = "";
//   document.querySelectorAll(".abs-btn").forEach((b) => (b.style.borderColor = ""));
//   if (e) e.target.style.borderColor = "var(--accent)";
// }
// async function saveHours() {
//   const hours = document.getElementById("modalHours").value;
//   const body = {
//     worker_id: editState.workerId, work_date: editState.date,
//     hours: hours ? parseFloat(hours) : null,
//     absence_type: hours ? null : editState.absence || null,
//   };
//   try {
//     await apiFetch("/api/hours", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
//     closeModal();
//     await loadWorkers();
//     if (currentFacility) filterFacility(currentFacility);
//     loadStats();
//   } catch (e) { alert("Blad: " + e.message); }
// }

// function filterGroup(groupName) {
//   currentFacility = 'g_' + groupName;
//   renderTabs(allWorkers);
//   const filtered = allWorkers.filter(w => (w.group_name || w.facility_name) === groupName);
//   renderTable(filtered);
//   loadStatsByFacility(null);
// }