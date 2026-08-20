/* ---------------------------------------------------------------------------
   dashboard.js — מנוע הדשבורד.

   כל הסינון והחישוב מתבצעים כאן, בדפדפן. השרת שולח את שורות הקמפיין
   פעם אחת, וכל שינוי מסנן מחשב מחדש את המספרים, הטבלאות והגרפים
   מיידית — בלי סבב לשרת.

   הגרפים מצוירים ב-SVG שנבנה ידנית. אין ספריות חיצוניות: המערכת
   חייבת לעבוד גם במחשב מנותק רשת.
   --------------------------------------------------------------------------- */

'use strict';

/* גרסת ה-GitHub היא אתר סטטי בלי שרת, ולכן אותם נתונים נקראים שם
   מקבצי JSON. window.CC_STATIC נקבע בעמוד ההדגמה בלבד. */
function ccFetch(path) {
  if (window.CC_STATIC) {
    const map = {
      '/api/geo': 'geo',
      '/api/annual': 'annual',
      '/api/status': 'index',
    };
    let key = map[path];
    if (path.indexOf('/api/campaign') === 0) {
      const id = decodeURIComponent(path.split('id=')[1] || '');
      const entry = (window.CC_STATIC.campaigns || [])
        .find(c => c.id === id) || window.CC_STATIC.campaigns[0];
      key = entry.file.replace(/\.json$/, '');
    }
    /* הנתונים מוטמעים בקובץ סקריפט ולא נמשכים ב-fetch, כדי שהאתר
       יעבוד גם כשפותחים את התיקייה מהמחשב (file://) ולא רק משרת. */
    if (window.CC_INLINE && Object.prototype.hasOwnProperty.call(window.CC_INLINE, key)) {
      const body = window.CC_INLINE[key];
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    }
    return fetch(key ? 'data/' + key + '.json' : path);
  }
  return fetch(path);
}

const CC = {
  data: null,          // המטען מהשרת
  selected: {},        // key -> Set של אינדקסי ערכים שנבחרו
  dateFrom: null,      // מספר ימים מתחילת הטווח
  dateTo: null,
  rows: [],            // אינדקסי השורות שעוברות את הסינון
};

/* ===== עזרי פורמט ===== */

const NUM = new Intl.NumberFormat('he-IL');

function n(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return NUM.format(Math.round(value));
}
function pct(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return (value * 100).toFixed(1) + '%';
}
function money(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return NUM.format(Math.round(value)) + ' ₪';
}
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function dayToDate(day) {
  if (!CC.data || !CC.data.dateStart) return '';
  const base = new Date(CC.data.dateStart + 'T00:00:00');
  base.setDate(base.getDate() + day);
  return base.toISOString().slice(0, 10);
}
function dateToDay(iso) {
  if (!CC.data || !CC.data.dateStart || !iso) return null;
  const base = new Date(CC.data.dateStart + 'T00:00:00');
  const target = new Date(iso + 'T00:00:00');
  return Math.round((target - base) / 86400000);
}

/* ===== צבעים לסדרות ===== */

const SERIES = ['#4F8EF7', '#22c39a', '#FFC857', '#f97362', '#a78bfa',
                '#38bdf8', '#fb923c', '#34d399', '#f472b6', '#94a3b8'];
function seriesColor(index) { return SERIES[index % SERIES.length]; }

/* ===== טעינה ===== */

async function loadCampaign(campaignId) {
  const response = await ccFetch('/api/campaign?id=' + encodeURIComponent(campaignId));
  const payload = await response.json();
  CC.data = payload;

  if (payload.error || payload.empty) {
    document.querySelectorAll('[data-cc]').forEach(node => {
      node.innerHTML = '<div class="warn">' +
        (payload.message || payload.error || 'אין נתונים להצגה.') + '</div>';
    });
    return;
  }

  // ברירת מחדל: הכל נבחר, טווח התאריכים המלא
  payload.facets.forEach(facet => { CC.selected[facet.key] = new Set(); });
  CC.dateFrom = null;
  CC.dateTo = null;

  buildControls();
  buildFilters();
  recompute();
}

/* ===== סרגל הבקרה העליון: טווח תאריכים ===== */

function buildControls() {
  const host = document.getElementById('cc-ctl');
  if (!host) return;

  host.innerHTML = '';
  const box = el('div', 'ctl');

  // כפתור שלושת הפסים — פותח וסוגר את מגירת המסננים
  const drawer = document.getElementById('cc-drawer');
  const toggle = document.getElementById('cc-drawer-toggle');
  if (drawer && toggle) {
    const label = el('label', 'drawer-toggle');
    label.htmlFor = 'cc-drawer-toggle';
    const lines = el('span', 'lines');
    lines.innerHTML = '<i></i><i></i><i></i>';
    label.appendChild(lines);
    label.appendChild(el('span', null, 'מסננים וטווח תאריכים'));
    box.appendChild(label);
  }

  const reset = el('button', 'act-btn ghost', 'איפוס');
  reset.addEventListener('click', resetFilters);
  box.appendChild(reset);

  const state = el('span', 'ctl-state');
  state.id = 'cc-state';
  box.appendChild(state);

  host.appendChild(box);
}

function resetFilters() {
  Object.keys(CC.selected).forEach(key => CC.selected[key].clear());
  CC.dateFrom = null;
  CC.dateTo = null;
  buildFilters();
  recompute();
}

/* טווח התאריכים יושב בתוך המגירה, יחד עם שאר המסננים.
   ברירת המחדל היא תמיד הטווח המלא של הקמפיין. */
function dateGroup() {
  if (!CC.data.dateStart) return null;

  const group = el('div', 'fgrp');
  const head = el('div', 'ghead');
  head.appendChild(el('span', 'gname', 'טווח תאריכי הגשה'));
  const count = el('span', 'gcnt');
  count.id = 'cnt-dates';
  head.appendChild(count);
  group.appendChild(head);

  const buttons = el('div', 'gbtns');
  const all = el('button', 'mini', 'כל הטווח');
  buttons.appendChild(all);
  group.appendChild(buttons);

  const dates = el('div', 'dates');
  const from = el('input');
  from.type = 'date';
  from.min = CC.data.dateStart; from.max = CC.data.dateEnd;
  from.value = CC.dateFrom === null ? CC.data.dateStart : dayToDate(CC.dateFrom);

  const to = el('input');
  to.type = 'date';
  to.min = CC.data.dateStart; to.max = CC.data.dateEnd;
  to.value = CC.dateTo === null ? CC.data.dateEnd : dayToDate(CC.dateTo);

  const fromRow = el('label');
  fromRow.appendChild(el('span', null, 'מ־'));
  fromRow.appendChild(from);
  const toRow = el('label');
  toRow.appendChild(el('span', null, 'עד'));
  toRow.appendChild(to);
  dates.appendChild(fromRow);
  dates.appendChild(toRow);
  group.appendChild(dates);

  from.addEventListener('change', () => { CC.dateFrom = dateToDay(from.value); recompute(); });
  to.addEventListener('change', () => { CC.dateTo = dateToDay(to.value); recompute(); });
  all.addEventListener('click', () => {
    CC.dateFrom = null; CC.dateTo = null;
    from.value = CC.data.dateStart; to.value = CC.data.dateEnd;
    recompute();
  });

  return group;
}

/* ===== פאנל המסננים ===== */

function buildFilters() {
  const host = document.getElementById('cc-filters');
  if (!host) return;

  host.innerHTML = '';

  const dates = dateGroup();
  if (dates) host.appendChild(dates);

  CC.data.facets.forEach(facet => {
    const group = el('div', 'fgrp');

    const head = el('div', 'ghead');
    head.appendChild(el('span', 'gname', facet.label));
    const count = el('span', 'gcnt');
    count.id = 'cnt-' + facet.key;
    head.appendChild(count);
    group.appendChild(head);

    const buttons = el('div', 'gbtns');
    const all = el('button', 'mini', 'הכל');
    all.addEventListener('click', () => {
      CC.selected[facet.key].clear();
      buildFilters();
      recompute();
    });
    // הסט מחזיק את הערכים ה*מוחרגים*. סט ריק = הכל נבחר.
    // לכן "נקה" מחריג את כולם, ו"הכל" מרוקן את הסט.
    const none = el('button', 'mini reset', 'נקה');
    none.addEventListener('click', () => {
      CC.selected[facet.key] = new Set(facet.values.map((_, i) => i));
      buildFilters();
      recompute();
    });
    buttons.appendChild(all);
    buttons.appendChild(none);
    group.appendChild(buttons);

    const scroll = el('div', 'scroll');
    facet.values.forEach((value, index) => {
      const label = el('label', 'chk');
      const box = el('input');
      box.type = 'checkbox';
      // סט ריק = הכל נבחר. אחרת — הסט מכיל את המוחרגים.
      box.checked = !CC.selected[facet.key].has(index);
      box.addEventListener('change', () => {
        if (box.checked) CC.selected[facet.key].delete(index);
        else CC.selected[facet.key].add(index);
        recompute();
      });
      label.appendChild(box);
      label.appendChild(el('span', null, value));
      const cnt = el('span', 'cnt');
      cnt.dataset.facet = facet.key;
      cnt.dataset.index = index;
      label.appendChild(cnt);
      scroll.appendChild(label);
    });
    group.appendChild(scroll);
    host.appendChild(group);
  });
}

/* ===== חישוב הסינון ===== */

function recompute() {
  const data = CC.data;
  if (!data || data.empty) return;

  const total = data.total;
  const rows = [];

  for (let i = 0; i < total; i++) {
    let keep = true;

    if (data.dates.length) {
      const day = data.dates[i];
      if (day < 0) keep = false;
      else if (CC.dateFrom !== null && day < CC.dateFrom) keep = false;
      else if (CC.dateTo !== null && day > CC.dateTo) keep = false;
    }

    if (keep) {
      for (const facet of data.facets) {
        const excluded = CC.selected[facet.key];
        if (excluded && excluded.size && excluded.has(facet.codes[i])) {
          keep = false;
          break;
        }
      }
    }
    if (keep) rows.push(i);
  }

  CC.rows = rows;
  renderAll();
}

/* ===== ספירות ===== */

function flagBits(key) {
  const flag = CC.data.flags.find(f => f.key === key);
  return flag ? flag.bits : null;
}

function countFlag(key) {
  const bits = flagBits(key);
  if (!bits) return 0;
  let sum = 0;
  for (const i of CC.rows) sum += bits[i];
  return sum;
}

function facetCounts(facet) {
  const counts = new Array(facet.values.length).fill(0);
  for (const i of CC.rows) {
    const code = facet.codes[i];
    if (code >= 0) counts[code]++;
  }
  return counts;
}

function averageDuration(key) {
  const values = CC.data.durations[key];
  if (!values) return null;
  let sum = 0, count = 0;
  for (const i of CC.rows) {
    const value = values[i];
    if (value !== null && value >= 0) { sum += value; count++; }
  }
  return count ? sum / count : null;
}

/* ===== רינדור ===== */

function renderAll() {
  renderState();
  renderExport();
  renderKpis();
  renderFunnel();
  renderFunnelShape();
  renderConversion();
  renderStageTable();
  renderCharts();
  renderPies();
  renderTrend();
  renderPlatforms();
  renderMediaKpis();
  renderPlatformCards();
  renderMediaBars();
  renderDaily();
  renderCplCards();
  renderMaps();
  renderSettlementTable();
  renderInsights();
  renderHeadline();
  renderComparison();
  renderFacetCounts();
  fitBarLabels();
}

function renderState() {
  const node = document.getElementById('cc-state');
  if (!node) return;
  const shown = CC.rows.length;
  const total = CC.data.total;
  node.textContent = shown === total
    ? `מוצגים כל ${n(total)} המועמדים`
    : `מוצגים ${n(shown)} מתוך ${n(total)} מועמדים`;
  node.classList.toggle('filtered', shown !== total);
}

function renderFacetCounts() {
  const dateCount = document.getElementById('cnt-dates');
  if (dateCount) {
    dateCount.textContent = (CC.dateFrom === null && CC.dateTo === null)
      ? 'כל הטווח' : 'מסונן';
  }

  CC.data.facets.forEach(facet => {
    const counts = facetCounts(facet);
    const head = document.getElementById('cnt-' + facet.key);
    if (head) {
      const chosen = facet.values.length - (CC.selected[facet.key]?.size || 0);
      head.textContent = `${chosen}/${facet.values.length}`;
    }
    document.querySelectorAll(`.cnt[data-facet="${facet.key}"]`).forEach(node => {
      node.textContent = n(counts[Number(node.dataset.index)]);
    });
  });
}

function tile(value, label, foot, isTotal) {
  const node = el('div', 'tile' + (isTotal ? ' total' : ''));
  node.appendChild(el('div', 'val', value));
  node.appendChild(el('div', 'lbl', label));
  if (foot) node.appendChild(el('div', 'foot', foot));
  return node;
}

function renderKpis() {
  const host = document.getElementById('cc-kpis');
  if (!host) return;
  host.innerHTML = '';

  const leads = CC.rows.length;
  const active = countFlag('active');
  const recruited = countFlag('recruited');
  const referred = countFlag('referred');

  host.appendChild(tile(n(leads), 'מועמדים בסינון הנוכחי',
                        `מתוך ${n(CC.data.total)} בקמפיין`, true));
  host.appendChild(tile(n(active), 'מועמדים פעילים',
                        leads ? pct(active / leads) + ' מהמועמדים' : ''));
  host.appendChild(tile(n(countFlag('interview')), 'עשו ראיון התאמה',
                        avgText('רמה')));
  host.appendChild(tile(n(countFlag('dapar')), 'עשו דפ"ר', avgText('דפר')));
  host.appendChild(tile(n(countFlag('assessment')), 'עשו מרכז הערכה',
                        avgText('מרכז הערכה')));
  if (CC.data.usesReferents) {
    host.appendChild(tile(n(referred), 'הופנו למחוז',
                          leads ? pct(referred / leads) : ''));
  }
  host.appendChild(tile(n(recruited), 'גויסו',
                        leads ? 'שיעור גיוס ' + pct(recruited / leads) : ''));
}

function avgText(milestone) {
  const average = averageDuration(milestone);
  return average === null ? '' : `ממוצע ${Math.round(average)} ימים מההגשה`;
}

function renderFunnel() {
  const host = document.getElementById('cc-funnel');
  if (!host) return;
  host.innerHTML = '';

  const leads = CC.rows.length;
  const steps = CC.data.funnel.map(step => ({
    label: step.label,
    value: step.key === null ? leads : countFlag(step.key),
  }));

  const card = el('div', 'card barcard');
  card.appendChild(el('div', 'bartitle', 'משפך הגיוס'));

  const table = el('table', 'bars');
  const max = Math.max(...steps.map(s => s.value), 1);

  steps.forEach((step, index) => {
    table.appendChild(barRow(step.label, step.value / max,
                             leads ? step.value / leads : 0,
                             n(step.value), seriesColor(index)));
  });

  card.appendChild(table);
  card.appendChild(el('div', 'tnote',
    'האחוז שבתוך העמודה הוא שיעור השלב מכלל המגישים, והמספר בסופה הוא הכמות.'));
  host.appendChild(card);
}

/* --- גרפי עמודות לפי ממד --- */

const CHART_DIMENSIONS = ['platform', 'stage', 'area', 'age', 'education',
                          'religion', 'gender', 'adGroup'];

function renderCharts() {
  const host = document.getElementById('cc-charts');
  if (!host) return;
  host.innerHTML = '';

  const only = host.dataset.dims ? host.dataset.dims.split(',') : CHART_DIMENSIONS;
  only.forEach(key => {
    const facet = CC.data.facets.find(f => f.key === key);
    if (!facet) return;
    const counts = facetCounts(facet);
    const pairs = facet.values
      .map((value, index) => ({ value, count: counts[index] }))
      .filter(pair => pair.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 14);
    if (pairs.length) host.appendChild(barCard(facet.label, pairs, facet.key));
  });
}

/* --- גרף מגמה --- */

function dailySeries() {
  const byDay = new Map();
  for (const i of CC.rows) {
    const day = CC.data.dates[i];
    if (day >= 0) byDay.set(day, (byDay.get(day) || 0) + 1);
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0])
    .map(entry => ({ day: entry[0], date: dayToDate(entry[0]), value: entry[1] }));
}

function renderDaily() {
  const kpis = document.getElementById('cc-daily-kpis');
  const series = dailySeries();

  if (kpis) {
    kpis.innerHTML = '';
    if (series.length) {
      const values = series.map(p => p.value);
      const peak = series[values.indexOf(Math.max(...values))];
      const low = series[values.indexOf(Math.min(...values))];
      const sum = values.reduce((a, b) => a + b, 0);
      kpis.appendChild(tile(n(sum), 'סך ההגשות בטווח',
                            `${series.length} ימים`, true));
      kpis.appendChild(tile(n(peak.value), 'שיא יומי', peak.date));
      kpis.appendChild(tile(n(low.value), 'שפל יומי', low.date));
      kpis.appendChild(tile(n(Math.round(sum / series.length)),
                            'ממוצע לידים ליום'));
    }
  }

  const tableHost = document.getElementById('cc-daily-table');
  if (tableHost) {
    tableHost.innerHTML = '';
    if (series.length) {
      const max = Math.max(...series.map(p => p.value));
      const table = el('table', 't');
      const head = el('tr');
      ['תאריך', 'שיעור', '', 'הגשות', 'מצטבר'].forEach(
        label => head.appendChild(el('th', null, label)));
      table.appendChild(head);
      let running = 0;
      const sum = series.reduce((acc, p) => acc + p.value, 0) || 1;
      series.forEach(point => { running += point.value; point.cum = running; });
      series.forEach(point => {
        // אותו כלל כמו בכל הגרפים: אחוז בהתחלה, עמודה, מספר בסוף
        const tr = barRow(point.date, point.value / max, point.value / sum,
                          n(point.value), '#4F8EF7');
        tr.appendChild(el('td', 'bval', n(point.cum)));
        table.appendChild(tr);
      });
      const card = el('div', 'card');
      card.appendChild(table);
      tableHost.appendChild(card);
    }
  }

  // הגשות לפי שבוע קמפיין — כל 7 ימים מתחילת הקמפיין
  const weekly = document.getElementById('cc-weekly');
  if (weekly) {
    weekly.innerHTML = '';
    if (series.length) {
      const firstDay = series[0].day;
      const buckets = new Map();
      series.forEach(point => {
        const week = Math.floor((point.day - firstDay) / 7);
        buckets.set(week, (buckets.get(week) || 0) + point.value);
      });
      const pairs = [...buckets.entries()].sort((a, b) => a[0] - b[0])
        .map(entry => {
          const start = dayToDate(firstDay + entry[0] * 7);
          const end = dayToDate(firstDay + entry[0] * 7 + 6);
          return {
            value: `שבוע ${entry[0] + 1} (${start.slice(8, 10)}/${start.slice(5, 7)}` +
                   `–${end.slice(8, 10)}/${end.slice(5, 7)})`,
            count: entry[1],
          };
        });
      weekly.appendChild(barCard('הגשות לפי שבוע קמפיין', pairs));
    }
  }

  const charts = document.getElementById('cc-daily-charts');
  if (charts) {
    charts.innerHTML = '';
    // לפי יום בשבוע
    const names = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
    const weekday = new Array(7).fill(0);
    series.forEach(point => {
      weekday[new Date(point.date + 'T00:00:00').getDay()] += point.value;
    });
    charts.appendChild(barCard('הגשות לפי יום בשבוע',
      names.map((name, index) => ({ value: name, count: weekday[index] }))));

    // לפי חלק יום — מהמסנן הקיים
    const facet = CC.data.facets.find(f => f.key === 'daypart');
    if (facet) {
      const counts = facetCounts(facet);
      charts.appendChild(barCard('הגשות לפי שעה',
        facet.values.map((value, index) => ({ value, count: counts[index] }))));
    }
  }
}

/* כרטיס גרף עמודות מרשימת {value, count} */
/* כרטיס גרף עמודות — הכלל של כל הגרפים בפרויקט:
   תווית · אחוז בתחילת השורה · העמודה הצבועה · המספר בסופה.
   האחוז בעמודה משלו, כך שכל האחוזים עומדים אחד מעל השני. */
function barCard(title, pairs, facetKey, dropEmpty) {
  let shown = pairs.filter(p => p.count > 0);
  const card = el('div', 'card barcard');
  card.appendChild(el('div', 'bartitle', title));
  if (!shown.length) return card;

  // בגרפי הפרופיל הערכים הריקים יורדים, וכמותם נרשמת מתחת לגרף
  let missing = 0;
  if (dropEmpty) {
    const split = splitEmpty(shown);
    if (split.real.length) { shown = split.real; missing = split.missing; }
  }

  // בגרף הפלטפורמות הצבע נגזר מהפלטפורמה ולא מסדר השורה, כדי
  // שאותה פלטפורמה תיראה באותו צבע בכל מסך
  const byPlatform = facetKey === 'platform';
  const max = Math.max(...shown.map(p => p.count));
  const total = shown.reduce((acc, p) => acc + p.count, 0);
  const table = el('table', 'bars');
  shown.forEach((pair, index) => {
    table.appendChild(barRow(pair.value, pair.count / max,
                             pair.count / total, n(pair.count),
                             byPlatform ? platformColor(pair.value)
                                        : seriesColor(index)));
  });
  card.appendChild(table);
  if (missing) {
    card.appendChild(el('div', 'emptynote',
      `${n(missing)} ללא נתון (${pct(missing / (missing + total))}) — ` +
      'אינם מוצגים בגרף'));
  }
  return card;
}

/* שורת גרף אחת, לפי הכלל האחיד */
function barRow(label, widthRatio, share, valueText, color) {
  const tr = el('tr');
  tr.appendChild(el('td', 'blab', label));

  // עמודת הצבע לוקחת את כל הרוחב שנשאר, והאחוז יושב בתוכה בהתחלה.
  // אם העמודה צרה מכדי להכיל אותו, הוא עובר מיד אחריה — ראו fitBarLabels.
  const cell = el('td', 'bwrap');
  const track = el('div', 'btrack');
  const bar = el('div', 'bbar bbar--labelled');
  bar.style.width = Math.max(3, widthRatio * 100) + '%';
  bar.style.background = color;
  if (share !== null && share !== undefined) {
    const tag = el('span', 'bpct', pct(share));
    tag.dataset.color = color;
    bar.appendChild(tag);
  }
  track.appendChild(bar);
  cell.appendChild(track);
  tr.appendChild(cell);

  tr.appendChild(el('td', 'bval', valueText));
  return tr;
}

/* האחוז יושב בתוך הצבע. כשהעמודה צרה מכדי להכיל אותו הוא היה
   נחתך, או — גרוע מכך — רוחב מזערי היה מנפח עמודה קטנה ומשקר
   על הפרופורציה. לכן נמדד כאן הרוחב בפועל, ותווית שאינה נכנסת
   עוברת אל מחוץ לצבע, מיד אחריו, בצבעו.

   המדידה נעשית במעבר אחד על כל הגרפים שכבר בעמוד, ולכן הדפדפן
   מחשב פריסה פעם אחת בלבד: קודם נאספות כל המידות, ורק אחר כך
   מתבצעים השינויים. */
function fitBarLabels(root) {
  const scope = root || document;
  const tags = scope.querySelectorAll('.bbar > .bpct');
  if (!tags.length) return;

  const move = [];
  tags.forEach(tag => {
    const bar = tag.parentNode;
    if (tag.scrollWidth + 12 > bar.clientWidth) move.push(tag);
  });

  move.forEach(tag => {
    const bar = tag.parentNode;
    tag.classList.add('bpct--out');
    tag.style.color = tag.dataset.color || '';
    bar.parentNode.appendChild(tag);
  });
}

function renderTrend() {
  const host = document.getElementById('cc-trend');
  if (!host || !CC.data.dates.length) return;
  host.innerHTML = '';

  const byDay = new Map();
  for (const i of CC.rows) {
    const day = CC.data.dates[i];
    if (day < 0) continue;
    byDay.set(day, (byDay.get(day) || 0) + 1);
  }
  if (!byDay.size) return;

  const days = [...byDay.keys()].sort((a, b) => a - b);
  const first = days[0], last = days[days.length - 1];
  const points = [];
  for (let day = first; day <= last; day++) {
    points.push({ day, value: byDay.get(day) || 0 });
  }

  // שני מצבים: הגרף הרגיל מציג את הסך הכול בלבד, ובמסך ביצועי
  // הקמפיין מוצגות רק הפלטפורמות — בלי קו כולל שדורס אותן.
  const platformMode = host.dataset.mode === 'platforms';

  const facet = platformMode
    ? CC.data.facets.find(f => f.key === 'platform') : null;
  const series = [];
  if (facet) {
    const active = activePlatforms();
    const perPlatform = new Map();
    for (const i of CC.rows) {
      const day = CC.data.dates[i];
      if (day < 0) continue;
      const name = facet.values[facet.codes[i]];
      if (!active.has(name) || name === NO_SOURCE) continue;
      if (!perPlatform.has(name)) perPlatform.set(name, new Map());
      const bucket = perPlatform.get(name);
      bucket.set(day, (bucket.get(day) || 0) + 1);
    }
    [...perPlatform.entries()]
      .sort((a, b) => [...b[1].values()].reduce((x, y) => x + y, 0) -
                      [...a[1].values()].reduce((x, y) => x + y, 0))
      .forEach((entry, index) => {
        series.push({
          name: entry[0], color: platformColor(entry[0]),
          points: points.map(p => ({ day: p.day, value: entry[1].get(p.day) || 0 })),
        });
      });
  }

  const width = 900, height = 220;
  const padLeft = 46, padBottom = 30, padTop = 14, padRight = 14;
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;
  // במצב פלטפורמות אין קו סך הכול, ולכן הסקאלה נקבעת לפי הקו הגבוה
  // ביותר. מדידה לפי הסך הכול הייתה מועכת את כל הקווים לתחתית.
  let max = 1;
  if (platformMode && series.length) {
    series.forEach(entry => entry.points.forEach(p => {
      if (p.value > max) max = p.value;
    }));
  } else {
    max = Math.max(...points.map(p => p.value), 1);
  }

  const x = i => padLeft + (points.length === 1 ? plotW / 2
    : (i / (points.length - 1)) * plotW);
  const y = value => padTop + plotH - (value / max) * plotH;

  const parts = [];
  parts.push(`<svg class="tsvg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">`);

  for (let step = 0; step <= 4; step++) {
    const value = (max / 4) * step;
    const yy = y(value);
    parts.push(`<line class="tgrid" x1="${padLeft}" y1="${yy}" x2="${width - padRight}" y2="${yy}"/>`);
    parts.push(`<text class="tylab" x="${padLeft - 8}" y="${yy + 3}">${n(value)}</text>`);
  }

  if (!platformMode) {
    const line = points.map((p, i) =>
      `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    const area = `${line} L${x(points.length - 1).toFixed(1)},${y(0)} ` +
                 `L${x(0).toFixed(1)},${y(0)} Z`;
    parts.push(`<path d="${area}" fill="#4F8EF7" opacity="0.14"/>`);
    parts.push(`<path d="${line}" fill="none" stroke="#4F8EF7" stroke-width="2.4"/>`);
  }

  series.forEach(entry => {
    const path = entry.points.map((p, i) =>
      `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
    parts.push(`<path d="${path}" fill="none" stroke="${entry.color}" ` +
               `stroke-width="2"/>`);
  });

  // תוויות נתונים — רק על שיאים מקומיים, וכשאין תווית אחרת קרובה,
  // כדי שהמספרים לא ידרסו זה את זה
  const taken = [];
  const fits = (px, py) => !taken.some(t =>
    Math.abs(t[0] - px) < 26 && Math.abs(t[1] - py) < 12);

  series.forEach(entry => {
    entry.points.forEach((p, i) => {
      if (!p.value) return;
      const before = i > 0 ? entry.points[i - 1].value : -1;
      const after = i < entry.points.length - 1 ? entry.points[i + 1].value : -1;
      if (p.value < before || p.value < after) return;
      const px = x(i), py = y(p.value) - 6;
      if (!fits(px, py)) return;
      taken.push([px, py]);
      parts.push(`<text x="${px.toFixed(1)}" y="${py.toFixed(1)}" ` +
                 `text-anchor="middle" style="fill:${entry.color};font-size:9px;` +
                 `font-weight:700">${n(p.value)}</text>`);
    });
  });

  const labelStep = Math.max(1, Math.floor(points.length / 8));
  points.forEach((p, i) => {
    if (i % labelStep === 0 || i === points.length - 1) {
      const iso = dayToDate(p.day);
      const label = iso.slice(8, 10) + '/' + iso.slice(5, 7);
      parts.push(`<text class="txlab" x="${x(i).toFixed(1)}" y="${height - 10}">${label}</text>`);
    }
    // תווית כמות מעל כל נקודה — כשיש הרבה ימים מוצגת אחת לכמה ימים,
    // אחרת התוויות נדבקות זו לזו ואי אפשר לקרוא אף אחת.
    // במצב פלטפורמות אין קו סך הכול, ולכן גם אין תוויות סך הכול:
    // הן היו יושבות גבוה מעל הקווים, רחוק ממה שהן מתארות.
    const every = points.length > 45 ? labelStep : 1;
    if (!platformMode && (i % every === 0 || i === points.length - 1)) {
      parts.push(`<text class="tval" x="${x(i).toFixed(1)}" ` +
                 `y="${(y(p.value) - 7).toFixed(1)}">${n(p.value)}</text>`);
    }
  });

  parts.push('</svg>');

  const card = el('div', 'card trendcard');
  card.appendChild(el('div', 'bartitle', 'הגשות לפי יום'));
  const holder = el('div');
  holder.innerHTML = parts.join('');
  card.appendChild(holder);
  // מקרא צבעים — קו בצבע הסדרה לצד שמה
  if (series.length) {
    const legend = el('div', 'linelegend');
    series.forEach(entry => {
      const item = el('span', 'lineitem');
      const swatch = el('span', 'lineswatch');
      swatch.style.background = entry.color;
      item.appendChild(swatch);
      const total = entry.points.reduce((acc, p) => acc + p.value, 0);
      item.appendChild(el('span', null, `${entry.name} · ${n(total)}`));
      legend.appendChild(item);
    });
    card.appendChild(legend);
  }

  const note = el('div', 'tnote');
  note.textContent = `${n(CC.rows.length)} מועמדים · ${points.length} ימים בטווח הנבחר`;
  card.appendChild(note);
  host.appendChild(card);
}

/* --- טבלת פלטפורמות: מדיה מול תוצאות --- */

function renderPlatforms() {
  const host = document.getElementById('cc-platforms');
  if (!host) return;
  host.innerHTML = '';

  const media = performanceMedia();
  const facet = CC.data.facets.find(f => f.key === 'platform');
  const counts = facet ? facetCounts(facet) : [];

  // ספירות מסוננות לפי פלטפורמה
  const filtered = new Map();
  if (facet) {
    facet.values.forEach((value, index) => filtered.set(value, counts[index]));
  }

  const activeBits = flagBits('active');
  const recruitedBits = flagBits('recruited');
  const activeBy = new Map(), recruitedBy = new Map();
  if (facet) {
    for (const i of CC.rows) {
      const name = facet.values[facet.codes[i]];
      if (activeBits && activeBits[i]) activeBy.set(name, (activeBy.get(name) || 0) + 1);
      if (recruitedBits && recruitedBits[i]) recruitedBy.set(name, (recruitedBy.get(name) || 0) + 1);
    }
  }

  // רק פלטפורמות שיש להן מועמדים בסינון הנוכחי
  const names = new Set();
  filtered.forEach((count, name) => { if (count > 0) names.add(name); });
  const rows = [...names].filter(Boolean).map(name => {
    const m = media.find(x => x.platform === name) || {};
    const leads = filtered.get(name) || 0;
    const active = activeBy.get(name) || 0;
    const recruited = recruitedBy.get(name) || 0;
    return {
      name, leads, active, recruited,
      spent: m.spent ?? null, impressions: m.impressions ?? null,
      clicks: m.clicks ?? null, conversions: m.conversions ?? null,
      ctr: m.ctr ?? null, cpc: m.cpc ?? null, util: m.util ?? null,
      cpl: (m.spent && leads) ? m.spent / leads : null,
      cpr: (m.spent && recruited) ? m.spent / recruited : null,
    };
  }).sort((a, b) => b.leads - a.leads);

  const table = el('table', 't');
  const head = el('tr');
  ['פלטפורמה', 'תקציב שנוצל', 'ניצול', 'חשיפות', 'הקלקות', 'CTR', 'CPC',
   'המרות', 'לידים', 'פעילים', 'גויסו', 'עלות לליד', 'עלות לגיוס']
    .forEach(label => head.appendChild(el('th', null, label)));
  table.appendChild(head);

  rows.forEach(row => {
    const tr = el('tr');
    // נקודת הצבע של הפלטפורמה — אותו צבע שבגרפים ובכרטיסים
    const nameCell = el('td');
    const dot = el('span', 'cdot');
    dot.style.background = platformColor(row.name);
    nameCell.appendChild(dot);
    nameCell.appendChild(document.createTextNode(row.name));
    tr.appendChild(nameCell);
    tr.appendChild(el('td', 'num', money(row.spent)));
    tr.appendChild(el('td', 'num', pct(row.util)));
    tr.appendChild(el('td', 'num', n(row.impressions)));
    tr.appendChild(el('td', 'num', n(row.clicks)));
    tr.appendChild(el('td', 'num', pct(row.ctr)));
    tr.appendChild(el('td', 'num', money(row.cpc)));
    tr.appendChild(el('td', 'num', n(row.conversions)));
    tr.appendChild(el('td', 'num', n(row.leads)));
    tr.appendChild(el('td', 'num', n(row.active)));
    tr.appendChild(el('td', 'num', n(row.recruited)));
    tr.appendChild(el('td', 'num', money(row.cpl)));
    tr.appendChild(el('td', 'num', money(row.cpr)));
    table.appendChild(tr);
  });

  const card = el('div', 'card');
  card.appendChild(table);
  card.appendChild(el('div', 'tnote',
    'הלידים, הפעילים והגיוסים מגיבים למסננים. נתוני המדיה הם ברמת ' +
    'הפלטפורמה כולה ואינם מסוננים לפי תאריך.'));
  host.appendChild(card);
}

/* ===== משפך המיון — צורת משפך ===== */

/* השלבים כפי שסוכמו: הגשות, יום מיון מקוון (דפ"ר), רמה, גיבושון, גיוס.
   מבחני אישיות אינם חלק מהמשפך הזה. */
const FUNNEL_STAGES = [
  { key: null, label: 'הגשות' },
  { key: 'dapar', label: 'יום מיון מקוון' },
  { key: 'interview', label: 'רמה' },
  { key: 'assessment', label: 'גיבושון' },
  { key: 'recruited', label: 'גיוס' },
];

const FUNNEL_COLORS = ['#0f2f66', '#12608f', '#1191b5', '#3aa76d', '#8fc63f', '#f5c518'];

function renderFunnelShape() {
  const host = document.getElementById('cc-funnel-shape');
  if (!host) return;
  host.innerHTML = '';

  const leads = CC.rows.length;
  const steps = FUNNEL_STAGES.map(stage => ({
    label: stage.label,
    value: stage.key === null ? leads : countFlag(stage.key),
  }));

  const width = 860, bandHeight = 62, gap = 3;
  const height = steps.length * (bandHeight + gap) + 26;
  const topHalf = width * 0.40;      // חצי הרוחב בראש המשפך
  const bottomHalf = width * 0.04;   // חצי הרוחב בקצה התחתון
  const cx = width / 2;

  const halfAt = index => topHalf - (topHalf - bottomHalf) * (index / steps.length);

  const parts = [`<svg class="funnelsvg" viewBox="0 0 ${width} ${height}">`];

  steps.forEach((step, index) => {
    const top = 12 + index * (bandHeight + gap);
    const bottom = top + bandHeight;
    const halfTop = halfAt(index), halfBottom = halfAt(index + 1);
    const points = [
      [cx - halfTop, top], [cx + halfTop, top],
      [cx + halfBottom, bottom], [cx - halfBottom, bottom],
    ].map(point => point.map(v => v.toFixed(1)).join(',')).join(' ');

    parts.push(`<polygon points="${points}" fill="${FUNNEL_COLORS[index]}"/>`);

    const middle = top + bandHeight / 2;
    parts.push(`<text x="${cx}" y="${(middle - 5).toFixed(1)}" text-anchor="middle" ` +
               `style="fill:#fff;font-size:15px;font-weight:700">${step.label}</text>`);
    parts.push(`<text x="${cx}" y="${(middle + 14).toFixed(1)}" text-anchor="middle" ` +
               `style="fill:#eaf2ff;font-size:13px;font-weight:600">${n(step.value)}</text>`);

    // אחוז המעבר מהשלב הקודם, בצד המשפך
    if (index > 0) {
      const previous = steps[index - 1].value;
      const rate = previous ? step.value / previous : 0;
      const edge = cx + halfTop + 34;
      // שיעור מעל 100% אינו מעבר בין שלבים אלא סימן שהשלב אינו תת-קבוצה
      // של הקודם — למשל גיוס שהותאם דרך גשר ת"ז ולא דרך המשפך
      parts.push(`<text x="${edge.toFixed(1)}" y="${(top + 20).toFixed(1)}" ` +
                 `text-anchor="start" style="fill:#9fb3d4;` +
                 `font-size:12.5px;font-weight:600">${pct(rate)}</text>`);
    }
  });

  parts.push('</svg>');

  const card = el('div', 'card funnelcard');
  const holder = el('div');
  holder.innerHTML = parts.join('');
  card.appendChild(holder);
  card.appendChild(el('div', 'tnote',
    'האחוז שבצד כל שלב הוא שיעור המעבר מהשלב שמעליו. ' +
    'המשפך מגיב למסננים.'));
  host.appendChild(card);
}

/* ===== שיעורי המרה בין השלבים ===== */

function renderConversion() {
  const host = document.getElementById('cc-conversion');
  if (!host) return;
  host.innerHTML = '';

  const leads = CC.rows.length;
  const steps = [
    { key: 'interview',   label: 'ראיון התאמה' },
    { key: 'dapar',       label: 'דפ"ר' },
    { key: 'personality', label: 'מבחני אישיות' },
    { key: 'assessment',  label: 'מרכז הערכה' },
    { key: 'referred',    label: 'הפניה למחוז' },
    { key: 'recruited',   label: 'גיוס' },
  ];

  const table = el('table', 't');
  const head = el('tr');
  ['שלב', 'ביצעו', 'שיעור מכלל המגישים', 'שיעור מהשלב הקודם', 'זמן ממוצע מההגשה']
    .forEach(label => head.appendChild(el('th', null, label)));
  table.appendChild(head);

  const durations = { 'ראיון התאמה': 'רמה', 'דפ"ר': 'דפר',
                      'מבחני אישיות': 'אישיות', 'מרכז הערכה': 'מרכז הערכה' };
  let previous = leads;

  steps.forEach(step => {
    const value = countFlag(step.key);
    const tr = el('tr');
    tr.appendChild(el('td', null, step.label));
    tr.appendChild(el('td', 'num', n(value)));
    tr.appendChild(el('td', 'num', leads ? pct(value / leads) : '—'));
    tr.appendChild(el('td', 'num', previous ? pct(value / previous) : '—'));
    const key = durations[step.label];
    const average = key ? averageDuration(key) : null;
    tr.appendChild(el('td', 'num', average === null ? '—' : Math.round(average) + ' ימים'));
    table.appendChild(tr);
    if (value) previous = value;
  });

  const card = el('div', 'card');
  card.appendChild(table);
  card.appendChild(el('div', 'tnote',
    'שיעור מהשלב הקודם מחושב מול השלב האחרון שנספרו בו מועמדים.'));
  host.appendChild(card);
}

/* ===== טבלת שלב בהליך ===== */

function renderStageTable() {
  const host = document.getElementById('cc-stage-table');
  if (!host) return;
  host.innerHTML = '';

  const facet = CC.data.facets.find(f => f.key === 'stage');
  if (!facet) return;

  const counts = facetCounts(facet);
  const pairs = facet.values
    .map((value, index) => ({ value, count: counts[index] }))
    .filter(p => p.count > 0)
    .sort((a, b) => b.count - a.count);

  const total = pairs.reduce((acc, p) => acc + p.count, 0);
  const table = el('table', 't');
  const head = el('tr');
  ['שלב', 'כמות', 'שיעור'].forEach(label => head.appendChild(el('th', null, label)));
  table.appendChild(head);

  pairs.forEach(pair => {
    const tr = el('tr');
    tr.appendChild(el('td', null, pair.value));
    tr.appendChild(el('td', 'num', n(pair.count)));
    tr.appendChild(el('td', 'num', pct(pair.count / total)));
    table.appendChild(tr);
  });

  const totalRow = el('tr');
  const label = el('td', null, 'סה"כ');
  label.style.fontWeight = '700';
  totalRow.appendChild(label);
  totalRow.appendChild(el('td', 'num', n(total)));
  totalRow.appendChild(el('td', 'num', '100.0%'));
  table.appendChild(totalRow);

  const card = el('div', 'card');
  card.appendChild(table);
  host.appendChild(card);
}

/* ===== גרפי עוגה ===== */

function pieSvg(pairs, size) {
  const radius = size / 2 - 2;
  const cx = size / 2, cy = size / 2;
  const total = pairs.reduce((acc, p) => acc + p.count, 0);
  if (!total) return '';

  const parts = [`<svg viewBox="0 0 ${size} ${size}" style="width:${size}px;max-width:100%">`];
  let angle = -Math.PI / 2;

  pairs.forEach((pair, index) => {
    const slice = (pair.count / total) * Math.PI * 2;
    const end = angle + slice;
    const large = slice > Math.PI ? 1 : 0;
    const x1 = cx + radius * Math.cos(angle), y1 = cy + radius * Math.sin(angle);
    const x2 = cx + radius * Math.cos(end),   y2 = cy + radius * Math.sin(end);
    // פרוסה יחידה: עיגול מלא, כי קשת של 360 מעלות מתנוונת לנקודה
    const d = pairs.length === 1
      ? `M${cx},${cy - radius} A${radius},${radius} 0 1 1 ${cx - 0.01},${cy - radius} Z`
      : `M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} ` +
        `A${radius},${radius} 0 ${large} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z`;
    parts.push(`<path d="${d}" fill="${seriesColor(index)}" stroke="#0f1729" stroke-width="1.5"/>`);

    // האחוז נכתב בתוך הפרוסה עצמה, אם היא רחבה מספיק כדי להכיל אותו
    const share = pair.count / total;
    if (share >= 0.05) {
      const middle = angle + slice / 2;
      const labelRadius = radius * 0.62;
      const lx = cx + labelRadius * Math.cos(middle);
      const ly = cy + labelRadius * Math.sin(middle);
      parts.push(`<text x="${lx.toFixed(1)}" y="${(ly + 4.5).toFixed(1)}" ` +
                 `text-anchor="middle" style="fill:#fff;font-size:13px;` +
                 `font-weight:700;paint-order:stroke;stroke:rgba(15,23,41,.6);` +
                 `stroke-width:2.6px">${(share * 100).toFixed(0)}%</text>`);
    }
    angle = end;
  });

  parts.push('</svg>');
  return parts.join('');
}

function renderPies() {
  ['cc-pies', 'cc-pies-2'].forEach(hostId => {
    const host = document.getElementById(hostId);
    if (!host) return;
    host.innerHTML = '';

    const keys = host.dataset.dims ? host.dataset.dims.split(',') : [];
    keys.forEach(key => {
      const facet = CC.data.facets.find(f => f.key === key);
      if (!facet) return;

      const counts = facetCounts(facet);
      const all = facet.values
        .map((value, index) => ({ value, count: counts[index] }))
        .filter(p => p.count > 0)
        .sort((a, b) => b.count - a.count);
      if (!all.length) return;

      // הערכים הריקים יורדים מהגרף. הם אינם מאפיין דמוגרפי, והם
      // גונבים נתח מהפרוסות האמיתיות ומעוותים את האחוזים.
      const split = splitEmpty(all);
      const pairs = split.real;
      if (!pairs.length) return;

      const card = el('div', 'card piecard');
      card.appendChild(el('div', 'bartitle', facet.label));

      const holder = el('div');
      holder.innerHTML = pieSvg(pairs.slice(0, 8), 180);
      card.appendChild(holder);

      const legend = el('div', 'pielegend');
      pairs.slice(0, 8).forEach((pair, index) => {
        const row = el('div');
        const swatch = el('span', 'swatch');
        swatch.style.background = seriesColor(index);
        row.appendChild(swatch);
        row.appendChild(el('span', null, pair.value));
        // האחוז כבר בתוך הפרוסה; כאן נשארת הכמות בלבד
        row.appendChild(el('span', 'pv', n(pair.count)));
        legend.appendChild(row);
      });
      card.appendChild(legend);

      // החוסר נשאר גלוי, בקטן, מתחת לגרף
      if (split.missing) {
        const everything = split.missing + pairs.reduce((acc, p) => acc + p.count, 0);
        card.appendChild(el('div', 'emptynote',
          `${n(split.missing)} ללא נתון (${pct(split.missing / everything)}) — ` +
          'אינם מוצגים בגרף'));
      }
      host.appendChild(card);
    });
  });
}

/* ===== מפות חום ===== */

function hexToRgb(hex) {
  const clean = String(hex).replace('#', '');
  return [parseInt(clean.slice(0, 2), 16), parseInt(clean.slice(2, 4), 16),
          parseInt(clean.slice(4, 6), 16)];
}

function mixColors(from, to, t) {
  const a = hexToRgb(from), b = hexToRgb(to);
  const channel = i => Math.round(a[i] + (b[i] - a[i]) * t);
  return `rgb(${channel(0)},${channel(1)},${channel(2)})`;
}

/* צבע רציף: מהצבע הנמוך, דרך הבינוני, אל הגבוה. הספים קובעים את
   נקודות המעבר, וביניהן הצבע משתנה בהדרגה — כך אזור מרכזי מופיע
   בירוק והולך ונעשה אדום ככל שההגשות דלילות יותר. */
function heatColor(ratio) {
  const colors = CC.data.heatColors || {};
  const low = colors['צבע_נמוך'] || '#DC2626';
  const mid = colors['צבע_בינוני'] || '#EAB308';
  const high = colors['צבע_גבוה'] || '#16A34A';
  if (ratio === null || ratio === undefined) return colors['צבע_ללא_נתון'] || '#9CA3AF';

  const highAt = (colors['סף_גבוה_אחוז'] !== undefined ? colors['סף_גבוה_אחוז'] : 66) / 100;
  const midAt = (colors['סף_בינוני_אחוז'] !== undefined ? colors['סף_בינוני_אחוז'] : 33) / 100;
  const value = Math.max(0, Math.min(1, ratio));

  if (value >= highAt) return high;
  if (value >= midAt) {
    return mixColors(mid, high, (value - midAt) / Math.max(0.001, highAt - midAt));
  }
  return mixColors(low, mid, value / Math.max(0.001, midAt));
}

function heatLegend(ratioMode) {
  const colors = CC.data.heatColors || {};
  const legend = el('div', 'maplegend');
  const suffix = ratioMode ? ' ביחס לאוכלוסייה' : '';
  [['הגשות גבוהות' + suffix, colors['צבע_גבוה'] || '#16A34A'],
   ['בינוני', colors['צבע_בינוני'] || '#EAB308'],
   ['דליל' + suffix, colors['צבע_נמוך'] || '#DC2626']].forEach(([label, color]) => {
    const item = el('span');
    const swatch = el('span', 'swatch');
    swatch.style.background = color;
    item.appendChild(swatch);
    item.appendChild(el('span', null, label));
    legend.appendChild(item);
  });
  return legend;
}

/* מסננים חלים על המפות דרך ספירת האזורים; היישובים הם אגרגט של הריצה
   ולכן הם מוצגים כפי שהם, עם ציון מפורש בהערה. */
let GEO = null;

async function loadGeo() {
  if (GEO) return GEO;
  const response = await ccFetch('/api/geo');
  GEO = await response.json();
  return GEO;
}

/* מחזיר את ההבטחה, כדי שניתן יהיה להמתין לציור המפות — בדפדפן זה
   לא נדרש, בבדיקה האוטומטית כן. */
/* מידת ההגדלה של כל מפה, בין 1 ל-1.6. נשמרת בין ציורים כדי שסינון
   לא יאפס את מה שהמשתמש בחר. */
const MAP_ZOOM = {};
const MAP_ZOOM_MIN = 1, MAP_ZOOM_MAX = 1.6, MAP_ZOOM_STEP = 0.15;

/* גובה הבסיס נגזר מגובה החלון. ישראל צרה וגבוהה, ולכן הגובה הוא
   שקובע כמה גדולה המפה — מתיחה לרוחב רק הייתה מותחת אוויר. */
function mapBaseHeight() {
  const viewport = (typeof window !== 'undefined' && window.innerHeight) || 900;
  return Math.round(Math.min(760, Math.max(500, viewport * 0.74)));
}

function mapZoomBar(hostId, redraw) {
  const bar = el('div', 'mapzoom');
  const level = MAP_ZOOM[hostId] || 1;

  const make = (label, delta, title) => {
    const button = el('button', 'mapzoom-btn', label);
    button.type = 'button';
    button.title = title;
    const next = Math.round((level + delta) * 100) / 100;
    button.disabled = next < MAP_ZOOM_MIN - 0.001 || next > MAP_ZOOM_MAX + 0.001;
    button.addEventListener('click', () => {
      MAP_ZOOM[hostId] = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, next));
      redraw();
    });
    return button;
  };

  bar.appendChild(make('−', -MAP_ZOOM_STEP, 'הקטנה'));
  bar.appendChild(el('span', 'mapzoom-val', Math.round(level * 100) + '%'));
  bar.appendChild(make('+', MAP_ZOOM_STEP, 'הגדלה'));
  return bar;
}

function renderMaps() {
  if (!document.getElementById('cc-map-districts') &&
      !document.getElementById('cc-map-regions')) return Promise.resolve();
  return loadGeo().then(() => {
    renderChoropleth('cc-map-districts', 'districts', 'district', 'הגשות לפי מחוז');
    renderChoropleth('cc-map-regions', 'regions', 'region', 'הגשות לפי מרחב');
  });
}

/* צובע כל מחוז או מרחב לפי מספר ההגשות שלו. הפוליגונים מגיעים מהשרת
   ומצוירים ב-SVG — אין כאן שכבת אריחים חיצונית. */
/* גוון קבוע לכל מחוז — נשמר ההיגיון של המפה הרשמית. הגוון נושא זהות,
   לא חום: הצבע החם יושב בסיכה, כמו במפת החום. */
const DISTRICT_TINT = {
  'צפון': '#cfe6d2', 'חוף': '#cfe0ee', 'מרכז': '#f3e6cf', 'תל אביב': '#d5dcf0',
  'ש"י': '#e3d8ec', 'ירושלים': '#f5f0cd', 'דרום': '#e8e2d2',
};

function renderChoropleth(hostId, layerKey, field, title) {
  const host = document.getElementById(hostId);
  if (!host || !GEO || !GEO[layerKey]) return;
  host.innerHTML = '';

  // הגשות ואוכלוסייה לכל מחוז או מרחב, מתוך אגרגט היישובים
  const counts = new Map(), people = new Map();
  (CC.data.settlements || []).forEach(place => {
    const key = place[field];
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + place.count);
    if (place.population) people.set(key, (people.get(key) || 0) + place.population);
  });

  // אוכלוסיית המחוזות מגיעה כנתון ישיר; היא מדויקת יותר מסכום היישובים
  if (field === 'district') {
    Object.entries(CC.data.districtPopulation || {}).forEach(entry => {
      if (counts.has(entry[0])) people.set(entry[0], entry[1]);
    });
  }

  const totalCount = [...counts.values()].reduce((a, b) => a + b, 0);
  const totalPeople = [...people.values()].reduce((a, b) => a + b, 0);
  // מצב היחס דורש אוכלוסייה לרוב האזורים; אחרת נופלים לכמות מוחלטת
  const ratioMode = people.size >= Math.max(2, counts.size * 0.6) && totalPeople > 0;

  // הערך שמצויר: הגשות לכל 1,000 תושבים, או הכמות עצמה
  // מדד הייצוג: שיעור ההגשות מהאזור חלקי שיעורו באוכלוסייה.
  // 1.00 = בדיוק כמצופה לגודלו; מעל — ייצוג יתר; מתחת — תת ייצוג.
  const totalForMetric = [...counts.values()].reduce((a, b) => a + b, 0);
  const peopleForMetric = [...people.values()].reduce((a, b) => a + b, 0);
  const metric = new Map();
  counts.forEach((value, key) => {
    const residents = people.get(key);
    if (ratioMode && residents && peopleForMetric && totalForMetric) {
      metric.set(key, (value / totalForMetric) / (residents / peopleForMetric));
    } else {
      metric.set(key, value);
    }
  });
  const maxMetric = Math.max(...metric.values(), 0.000001);

  const bounds = geoBounds([GEO[layerKey]]);
  const margin = 0.05;
  const latPad = (bounds.maxLat - bounds.minLat) * margin;
  const lonPad = (bounds.maxLon - bounds.minLon) * margin;
  bounds.minLat -= latPad; bounds.maxLat += latPad;
  bounds.minLon -= lonPad; bounds.maxLon += lonPad;

  // הגובה נגזר מגובה החלון וממידת ההגדלה שהמשתמש בחר. ישראל צרה
  // וגבוהה, ולכן הרוחב נגזר קטן ממנו.
  // המידות נכתבות כתכונות על ה-SVG עצמו — CSS לבדו אינו מספיק כאן.
  const zoom = MAP_ZOOM[hostId] || 1;
  const height = Math.round(mapBaseHeight() * zoom), pad = 8;
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const lonScale = Math.cos(midLat * Math.PI / 180);
  const spanLat = bounds.maxLat - bounds.minLat || 1;
  const spanLon = (bounds.maxLon - bounds.minLon) * lonScale || 1;
  const width = Math.round((height - pad * 2) * (spanLon / spanLat)) + pad * 2;
  const x = lon => pad + ((bounds.maxLon - lon) * lonScale / spanLon) * (width - pad * 2);
  const y = lat => pad + ((bounds.maxLat - lat) / spanLat) * (height - pad * 2);

  // מידות מפורשות על האלמנט עצמו. SVG עם viewBox בלבד מתנהג כרוחב
  // מלא של המכל ברוב הדפדפנים, ו-CSS width:auto אינו דורס את זה —
  // שם היה מקור הניפוח.
  const parts = ['<svg class="mapsvg" width="' + width + '" height="' + height +
                 '" viewBox="0 0 ' + width + ' ' + height +
                 '" preserveAspectRatio="xMidYMid meet">'];

  // רקע בהיר — ים, יבשה, גופי מים ונהר, כמו במפת החום
  const BACKGROUND = { sea: '#c3e0f2', water: '#c3e0f2', land: '#eef2f7' };
  (GEO.israel.features || []).forEach(feature => {
    if (feature.geometry.type === 'LineString') {
      const line = feature.geometry.coordinates.map((point, index) =>
        (index ? 'L' : 'M') + x(point[0]).toFixed(1) + ',' + y(point[1]).toFixed(1)
      ).join(' ');
      parts.push('<path d="' + line + '" fill="none" stroke="#9ec9e6" stroke-width="1.6"/>');
      return;
    }
    const fill = BACKGROUND[feature.properties.kind] || '#eef2f7';
    pathsOf(feature.geometry).forEach(ring => {
      parts.push('<path d="' + ringPath(ring, x, y) + '" fill="' + fill + '"/>');
    });
  });

  // מצולעי השכבה — גוון רך וגבול מקווקו. הגבול נושא את החלוקה, לא המילוי.
  const pins = [];
  (GEO[layerKey].features || []).forEach(feature => {
    const name = feature.properties.name;
    const district = feature.properties.district || name;
    const tint = DISTRICT_TINT[district] || '#dfe5ee';
    pathsOf(feature.geometry).forEach(ring => {
      parts.push('<path d="' + ringPath(ring, x, y) + '" fill="' + tint +
                 '" fill-opacity="0.72" stroke="#8794a8" stroke-width="1" ' +
                 'stroke-dasharray="5 4"/>');
    });
    if (feature.properties.label && counts.has(name)) {
      pins.push({ name, lon: feature.properties.label[0],
                  lat: feature.properties.label[1],
                  count: counts.get(name) || 0,
                  people: people.get(name) || 0,
                  metric: metric.get(name) || 0 });
    }
  });

  // הסיכות — הן שנושאות את החום, בדיוק כמו במפת החום.
  // במרכז הארץ נקודות התווית צפופות והסיכות היו נדרסות זו על זו, ולכן
  // הן מורחקות זו מזו לפני הציור.
  // גודל הסיכה נגזר ממספר הסיכות: 7 מחוזות יכולים להיות גדולים,
  // 22 מרחבים חייבים להיות קטנים אחרת המפה נעלמת מתחתיהם.
  const radius = pins.length > 12 ? 10 : 14;
  const fontMain = pins.length > 12 ? 8.5 : 11;
  const fontName = pins.length > 12 ? 7.5 : 8.5;

  const placed = pins.map(pin => ({ pin, px: x(pin.lon), py: y(pin.lat) }));
  spreadPins(placed, radius * 2.1);
  const positionOf = new Map(placed.map(item => [item.pin, item]));

  pins.sort((a, b) => a.metric - b.metric).forEach(pin => {
    const spot = positionOf.get(pin);
    const px = spot.px, py = spot.py;
    const color = heatColor(pin.metric / maxMetric);
    const big = ratioMode ? pin.metric.toFixed(2) : n(pin.count);
    const share = totalCount ? pin.count / totalCount : 0;

    parts.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${radius}" ` +
               `fill="${color}" stroke="#fff" stroke-width="1.8" ` +
               `style="filter:drop-shadow(0 1px 3px rgba(0,0,0,.35))">` +
               `<title>${pin.name} — ${n(pin.count)} הגשות` +
               (pin.people ? ` · ${n(pin.people)} תושבים` : '') + `</title></circle>`);
    parts.push(`<text x="${px.toFixed(1)}" y="${(py + 3.5).toFixed(1)}" ` +
               `text-anchor="middle" style="fill:#fff;font-size:${fontMain}px;` +
               `font-weight:700;pointer-events:none">${big}</text>`);
    parts.push(`<text x="${px.toFixed(1)}" y="${(py + radius + 9).toFixed(1)}" ` +
               `text-anchor="middle" style="fill:#1f2937;font-size:${fontName}px;` +
               `font-weight:700;paint-order:stroke;stroke:rgba(255,255,255,.92);` +
               `stroke-width:2px">${pin.name}</text>`);
    if (pins.length <= 12) {
      parts.push(`<text x="${px.toFixed(1)}" y="${(py + radius + 18).toFixed(1)}" ` +
                 `text-anchor="middle" style="fill:#41506a;font-size:7px;` +
                 `font-weight:600;paint-order:stroke;stroke:rgba(255,255,255,.92);` +
                 `stroke-width:1.8px">${n(pin.count)} · ${pct(share)}</text>`);
    }
  });

  parts.push('</svg>');

  const card = el('div', 'card mapcard');
  const head = el('div', 'maphead');
  head.appendChild(el('div', 'bartitle', title));
  head.appendChild(mapZoomBar(hostId,
    () => renderChoropleth(hostId, layerKey, field, title)));
  card.appendChild(head);

  if (!ratioMode) {
    const notice = el('div', 'warn');
    notice.innerHTML = 'המפה מציגה <b>כמות הגשות</b>. כדי לראות את היחס בין ' +
      'ההגשות לגודל האוכלוסייה, יש למלא את קובץ העזר ' +
      '<b>"אוכלוסיית ישובים"</b> בהגדרות הכלליות.';
    card.appendChild(notice);
  }

  const holder = el('div');
  holder.innerHTML = parts.join('');
  card.appendChild(holder);
  card.appendChild(heatLegend(ratioMode));

  card.appendChild(el('div', 'tnote',
    (ratioMode
      ? 'המספר בסיכה הוא מדד הייצוג — שיעור ההגשות מהאזור חלקי שיעורו באוכלוסייה. '
      : 'המספר בסיכה הוא כמות ההגשות. ') +
    'המפה מגיבה למסננים.'));
  host.appendChild(card);

  renderAreaTable(field === 'district' ? 'cc-district-table' : 'cc-region-table',
                  field, counts, people, metric, ratioMode);
}

/* טבלת האזורים — מתחת למפות, עם צביעת מפת חום לפי מדד הייצוג */
function renderAreaTable(hostId, field, counts, people, metric, ratioMode) {
  const host = document.getElementById(hostId);
  if (!host) return;
  host.innerHTML = '';

  const totalCount = [...counts.values()].reduce((a, b) => a + b, 0);
  const totalPeople = [...people.values()].reduce((a, b) => a + b, 0);
  const rows = [...counts.entries()]
    .sort((a, b) => (metric.get(b[0]) || 0) - (metric.get(a[0]) || 0));

  const table = el('table', 't');
  const head = el('tr');
  const headers = [field === 'district' ? 'מחוז' : 'מרחב', 'הגשות', 'שיעור מההגשות'];
  if (ratioMode) {
    headers.push('תושבים', 'שיעור מהאוכלוסייה', 'הגשות ל-100 אלף תושבים',
                 'מדד ייצוג');
  }
  headers.forEach(label => head.appendChild(el('th', null, label)));
  table.appendChild(head);

  const indexes = rows.map(entry => {
    const residents = people.get(entry[0]) || 0;
    const shareCount = totalCount ? entry[1] / totalCount : 0;
    const sharePeople = totalPeople ? residents / totalPeople : 0;
    return sharePeople ? shareCount / sharePeople : null;
  });
  const valid = indexes.filter(v => v !== null);
  const maxIndex = valid.length ? Math.max(...valid) : 1;
  const minIndex = valid.length ? Math.min(...valid) : 0;

  rows.forEach((entry, position) => {
    const name = entry[0], value = entry[1];
    const residents = people.get(name) || 0;
    const shareCount = totalCount ? value / totalCount : 0;
    const sharePeople = totalPeople ? residents / totalPeople : 0;

    const tr = el('tr');
    tr.appendChild(el('td', null, name));
    tr.appendChild(el('td', 'num', n(value)));
    tr.appendChild(el('td', 'num', pct(shareCount)));

    if (ratioMode) {
      tr.appendChild(el('td', 'num', n(residents)));
      tr.appendChild(el('td', 'num', pct(sharePeople)));
      tr.appendChild(el('td', 'num',
        residents ? ((value / residents) * 100000).toFixed(1) : '—'));

      const index = indexes[position];
      const cell = el('td', 'num', index === null ? '—' : index.toFixed(2));
      if (index !== null && maxIndex > minIndex) {
        // כחול = מגישים הרבה ביחס לאוכלוסייה, אדום = מעט
        const t = (index - minIndex) / (maxIndex - minIndex);
        cell.style.background = mixColors('#5a2230', '#12456e', t);
        cell.style.color = t > 0.55 ? '#9ecbf0' : '#f0a9a9';
        cell.style.fontWeight = '700';
      }
      tr.appendChild(cell);
    }
    table.appendChild(tr);
  });

  const card = el('div', 'card');
  card.appendChild(table);
  card.appendChild(el('div', 'tnote', ratioMode
    ? 'מדד ייצוג = שיעור ההגשות מהאזור חלקי שיעורו באוכלוסייה. ' +
      'מעל 1 — מגישים יותר מהמצופה לגודלם; מתחת ל-1 — פחות. ' +
      'כחול = ייצוג גבוה, אדום = ייצוג נמוך.'
    : 'ללא נתוני אוכלוסייה מוצגת כמות בלבד.'));
  host.appendChild(card);
}

/* דוחף סיכות שנמצאות קרוב מדי זו לזו, עד שכולן קריאות.
   ההזזה קטנה ומוגבלת — מיקום מדויק פחות חשוב מכך שכל מספר נראה. */
function spreadPins(items, minDistance) {
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        let dx = b.px - a.px, dy = b.py - a.py;
        let distance = Math.sqrt(dx * dx + dy * dy);
        if (distance >= minDistance) continue;
        if (distance < 0.01) { dx = 0.6; dy = 0.8; distance = 1; }
        const push = (minDistance - distance) / 2;
        const ux = (dx / distance) * push, uy = (dy / distance) * push;
        a.px -= ux; a.py -= uy;
        b.px += ux; b.py += uy;
        moved = true;
      }
    }
    if (!moved) break;
  }
}

function pathsOf(geometry) {
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.flat();
  return [];
}

function ringPath(ring, x, y) {
  return ring.map((point, index) =>
    (index ? 'L' : 'M') + x(point[0]).toFixed(1) + ',' + y(point[1]).toFixed(1)
  ).join(' ') + ' Z';
}

function geoBounds(collections) {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  collections.forEach(collection => {
    (collection.features || []).forEach(feature => {
      pathsOf(feature.geometry).forEach(ring => ring.forEach(point => {
        const lon = point[0], lat = point[1];
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      }));
    });
  });
  return { minLat, maxLat, minLon, maxLon };
}

function renderSettlementTable() {
  const host = document.getElementById('cc-settlement-table');
  if (!host) return;
  host.innerHTML = '';

  const settlements = [...(CC.data.settlements || [])]
    .sort((a, b) => b.count - a.count).slice(0, 25);
  if (!settlements.length) return;

  const table = el('table', 't');
  const head = el('tr');
  ['יישוב', 'אזור', 'מועמדים', 'פעילים', 'גויסו'].forEach(
    label => head.appendChild(el('th', null, label)));
  table.appendChild(head);

  settlements.forEach(place => {
    const tr = el('tr');
    tr.appendChild(el('td', null, place.name));
    tr.appendChild(el('td', null, place.area || '—'));
    tr.appendChild(el('td', 'num', n(place.count)));
    tr.appendChild(el('td', 'num', n(place.active)));
    tr.appendChild(el('td', 'num', n(place.recruited)));
    table.appendChild(tr);
  });

  const card = el('div', 'card');
  card.appendChild(table);
  card.appendChild(el('div', 'tnote', '25 היישובים המובילים בכלל הקמפיין.'));
  host.appendChild(card);
}

/* ===== תובנות ===== */

function topShare(facetKey) {
  const facet = CC.data.facets.find(f => f.key === facetKey);
  if (!facet) return null;
  const counts = facetCounts(facet);
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let best = 0;
  counts.forEach((value, index) => { if (value > counts[best]) best = index; });
  return { value: facet.values[best], count: counts[best], share: counts[best] / total };
}

function groupShare(facetKey, values) {
  const facet = CC.data.facets.find(f => f.key === facetKey);
  if (!facet) return null;
  const counts = facetCounts(facet);
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let sum = 0;
  facet.values.forEach((value, index) => {
    if (values.includes(value)) sum += counts[index];
  });
  return sum / total;
}

function insightCard(text) {
  const node = el('div', 'insight');
  node.innerHTML = text;
  return node;
}

/* שורת אחוזים ראשית — המשפטים מהמצגת, גדולים ובשורה אחת */
function headlineItem(value, text) {
  const item = el('div', 'hitem');
  item.appendChild(el('div', 'hval', value));
  item.appendChild(el('div', 'htxt', text));
  return item;
}

function renderHeadline() {
  const demo = document.getElementById('cc-headline-demo');
  if (demo) {
    demo.innerHTML = '';
    const religion = topShare('religion');
    const gender = topShare('gender');
    const age = groupShare('age', ['21-23', '24-26', '27-30', '31-40']);
    const education = groupShare('education', ['בגרות', 'דיפלומה', 'תואר']);
    const rovai = groupShare('rovai', ['02', '03', '05']);

    if (religion) demo.appendChild(headlineItem(pct(religion.share),
      `מהמועמדים הם ${religion.value}`));
    if (gender) demo.appendChild(headlineItem(pct(gender.share),
      `מהמועמדים הם ${gender.value === 'זכר' ? 'גברים' : gender.value}`));
    if (age !== null) demo.appendChild(headlineItem(pct(age),
      'מהמועמדים בגיל 21-40'));
    if (education !== null) demo.appendChild(headlineItem(pct(education),
      'עם בגרות או השכלה מתקדמת יותר'));
    if (rovai !== null) demo.appendChild(headlineItem(pct(rovai),
      'עם פרופיל קרבי'));
  }

  const submit = document.getElementById('cc-headline-submit');
  if (submit) {
    submit.innerHTML = '';
    const area = topShare('area');
    const daypart = topShare('daypart');
    const source = topShare('source');
    if (area) submit.appendChild(headlineItem(pct(area.share),
      `מההגשות מאזור ${area.value}`));
    if (daypart) submit.appendChild(headlineItem(pct(daypart.share),
      `מההגשות מתקבלות ב${daypart.value}`));
    if (source) submit.appendChild(headlineItem(pct(source.share),
      `מההגשות ממקור ${source.value}`));
  }
}

function renderInsights() {
  const demo = document.getElementById('cc-insights-demo');
  if (demo) {
    demo.innerHTML = '';
    const religion = topShare('religion');
    const gender = topShare('gender');
    const age = groupShare('age', ['21-23', '24-26', '27-30', '31-40']);
    const education = groupShare('education', ['בגרות', 'דיפלומה', 'תואר']);
    const rovai = topShare('rovai');

    if (religion) demo.appendChild(insightCard(
      `<b>${pct(religion.share)}</b> מהמועמדים הם ${religion.value}`));
    if (gender) demo.appendChild(insightCard(
      `<b>${pct(gender.share)}</b> מהמועמדים הם ${gender.value === 'זכר' ? 'גברים' : gender.value}`));
    if (age !== null) demo.appendChild(insightCard(
      `<b>${pct(age)}</b> מהמועמדים בגיל 21-40`));
    if (education !== null) demo.appendChild(insightCard(
      `<b>${pct(education)}</b> עם בגרות או השכלה מתקדמת יותר`));
    if (rovai) demo.appendChild(insightCard(
      `קבוצת הרובאי הנפוצה: <b>${rovai.value}</b> (${pct(rovai.share)})`));
  }

  const submit = document.getElementById('cc-insights-submit');
  if (submit) {
    submit.innerHTML = '';
    const area = topShare('area');
    const daypart = topShare('daypart');
    const source = topShare('source');
    if (area) submit.appendChild(insightCard(
      `אזור ההגשה המרכזי הוא <b>${area.value}</b> עם ${pct(area.share)} מכלל ההגשות`));
    if (daypart) submit.appendChild(insightCard(
      `רוב ההגשות מתקבלות ב<b>${daypart.value}</b> (${pct(daypart.share)})`));
    if (source) submit.appendChild(insightCard(
      `מקור המועמדות הנפוץ: <b>${source.value}</b> (${pct(source.share)})`));
  }

  const funnel = document.getElementById('cc-insights-funnel');
  if (funnel) {
    funnel.innerHTML = '';
    const leads = CC.rows.length;
    const active = countFlag('active');
    const recruited = countFlag('recruited');
    const started = countFlag('interview') + countFlag('dapar');
    funnel.appendChild(insightCard(`הגשות: <b>${n(leads)}</b>`));
    funnel.appendChild(insightCard(
      `פעילים בהליך: <b>${n(active)}</b> (${leads ? pct(active / leads) : '—'})`));
    funnel.appendChild(insightCard(
      `החלו הליך מיון: <b>${n(started ? Math.max(countFlag('interview'), countFlag('dapar')) : 0)}</b>`));
    funnel.appendChild(insightCard(
      `גיוסים: <b>${n(recruited)}</b> (${leads ? pct(recruited / leads) : '—'})`));
  }
}

/* ===== ביצועי מדיה ===== */

/* נתוני המדיה של הפלטפורמות שנשארו בסינון בלבד.
   כשמסננים לגוגל בלבד, אסור שיישארו קליקים ותקציב של מטא — לא במסך
   ולא בייצוא. */
function activePlatforms() {
  const facet = CC.data.facets.find(f => f.key === 'platform');
  if (!facet) return null;
  const counts = facetCounts(facet);
  const names = new Set();
  facet.values.forEach((value, index) => {
    if (counts[index] > 0) names.add(value);
  });
  return names;
}

const NO_SOURCE = 'ללא מקור';
const OTHER_PLATFORM = 'אחר';

/* ערכים שאינם נתון אלא היעדרו. בגרף הפרופיל הם אינם מוצגים —
   "לא ידוע" אינו מאפיין דמוגרפי, והוא רק גונב נתח מהפרוסות
   האמיתיות ומעוות את התמונה. כמותם נרשמת מתחת לגרף, כדי שהחוסר
   יישאר גלוי ולא ייעלם בשקט. */
const EMPTY_VALUES = ['(ריק)', 'לא ידוע', 'נתון חסר', ''];

function isEmptyValue(name) {
  return EMPTY_VALUES.indexOf(String(name == null ? '' : name).trim()) >= 0;
}

/* מפריד רשימת זוגות לערכים אמיתיים ולריקים */
function splitEmpty(pairs) {
  const real = [], empty = [];
  pairs.forEach(pair => (isEmptyValue(pair.value) ? empty : real).push(pair));
  return { real, empty, missing: empty.reduce((acc, p) => acc + p.count, 0) };
}

/* לכל פלטפורמה צבע קבוע משלה, זהה בכל המסכים — בכרטיס הגדול,
   בגרפים ובטבלאות. הצבע נקבע לפי סדר הפלטפורמה ברשימת הערכים
   של הפילוח, ולכן הוא יציב בין מסך למסך ובין סינון לסינון. */
const PLATFORM_COLORS = ['#4F8EF7', '#22c39a', '#FFC857', '#f97362', '#a78bfa',
                         '#38bdf8', '#f472b6', '#8fc63f', '#fb923c', '#2dd4bf'];

function platformColor(name) {
  const facet = CC.data && CC.data.facets
    ? CC.data.facets.find(f => f.key === 'platform') : null;
  const index = facet ? facet.values.indexOf(name) : -1;
  if (index < 0) return PLATFORM_COLORS[0];
  return PLATFORM_COLORS[index % PLATFORM_COLORS.length];
}

function filteredMedia() {
  const names = activePlatforms();
  const media = CC.data.media || [];
  if (!names) return media;
  return media.filter(row => names.has(row.platform));
}

/* שורות המדיה של מסך הביצועים.

   "ללא מקור" אינו פלטפורמה — אלו הגשות שלא נקשרו לערוץ. אין לו
   תקציב, אין לו עלות לליד, והצגתו לצד הפלטפורמות מעוותת כל השוואת
   עלויות. לכן הוא אינו מופיע במסך הביצועים כלל. הוא נשאר, כמובן,
   בפילוחי ההגשות עצמם. */
function performanceMedia() {
  return filteredMedia().filter(row => row.platform !== NO_SOURCE);
}

/* הפירוט לפי פלטפורמה מציג פלטפורמות אמיתיות בלבד. "אחר" הוא סל
   של מקורות שאינם ערוץ מדיה — אין לו תקציב ואין לו עלות לליד,
   והצגתו לצד גוגל וטיקטוק מעוותת את ההשוואה. הוא נשאר, כמובן,
   בגרף ההגשות היומי ובפילוחי ההגשות. */
function realPlatformMedia() {
  return performanceMedia().filter(row => row.platform !== OTHER_PLATFORM);
}

function mediaTotals() {
  const media = performanceMedia();
  return media.reduce((acc, row) => ({
    spent: acc.spent + (row.spent || 0),
    impressions: acc.impressions + (row.impressions || 0),
    clicks: acc.clicks + (row.clicks || 0),
    conversions: acc.conversions + (row.conversions || 0),
  }), { spent: 0, impressions: 0, clicks: 0, conversions: 0 });
}

function renderMediaKpis() {
  const host = document.getElementById('cc-media-kpis');
  if (!host) return;
  host.innerHTML = '';

  const totals = mediaTotals();
  const leads = CC.rows.length;

  host.appendChild(tile(money(totals.spent), 'עלות כוללת', '', true));
  host.appendChild(tile(n(totals.impressions), 'חשיפות'));
  host.appendChild(tile(n(totals.clicks), 'קליקים'));
  host.appendChild(tile(n(totals.conversions), 'המרות במדיה'));
  host.appendChild(tile(n(leads), 'הגשות מועמדות'));
  host.appendChild(tile(totals.spent && leads ? money(totals.spent / leads) : '—',
                        'עלות ממוצעת לליד'));

  const gap = document.getElementById('cc-media-gap');
  if (gap) {
    const diff = totals.conversions - leads;
    gap.innerHTML = diff === 0
      ? 'מספר ההמרות במדיה תואם את מספר ההגשות במערכת.'
      : `הפער בין ההמרות במדיה (<b>${n(totals.conversions)}</b>) לבין ההגשות ` +
        `במערכת (<b>${n(leads)}</b>) הוא <b>${n(Math.abs(diff))}</b>. ` +
        'פער כזה מוכר מראש — הוא נובע מהמרות שלא הבשילו להגשה, וממועמדים ' +
        'שהגישו ולא נקלטו.';
  }
}

function renderCplCards() {
  const host = document.getElementById('cc-cpl-cards');
  if (!host) return;
  host.innerHTML = '';

  const facet = CC.data.facets.find(f => f.key === 'platform');
  const counts = facet ? facetCounts(facet) : [];
  const leadsBy = new Map();
  if (facet) facet.values.forEach((value, index) => leadsBy.set(value, counts[index]));

  // "ללא מקור" אינו פלטפורמה — אין לו תקציב ואין לו עלות לליד
  const media = performanceMedia();
  const totals = media.reduce((acc, row) => ({
    spent: acc.spent + (row.spent || 0),
    leads: acc.leads + (leadsBy.get(row.platform) || 0),
  }), { spent: 0, leads: 0 });

  const row = el('div', 'cpl-row');
  row.appendChild(cplCard('כלל הקמפיין',
    totals.leads ? money(totals.spent / totals.leads) : '—',
    `${n(totals.leads)} לידים · ${money(totals.spent)}`, true));

  media.forEach(item => {
    const leads = leadsBy.get(item.platform) || 0;
    const card = cplCard(item.platform,
      leads && item.spent ? money(item.spent / leads) : '—',
      `${n(leads)} לידים · ${money(item.spent)}`, false);
    card.style.borderTopColor = platformColor(item.platform);
    card.classList.add('cpl-card--tinted');
    row.appendChild(card);
  });

  host.appendChild(row);
}

function cplCard(name, value, foot, primary) {
  const card = el('div', 'cpl-card' + (primary ? ' cpl-card--main' : ''));
  card.appendChild(el('div', 'cpl-name', name));
  card.appendChild(el('div', 'cpl-value', value));
  card.appendChild(el('div', 'cpl-foot', foot));
  return card;
}

function renderPlatformCards() {
  const host = document.getElementById('cc-platform-cards');
  if (!host) return;
  host.innerHTML = '';

  const facet = CC.data.facets.find(f => f.key === 'platform');
  const counts = facet ? facetCounts(facet) : [];
  const leadsBy = new Map();
  if (facet) facet.values.forEach((value, index) => leadsBy.set(value, counts[index]));

  realPlatformMedia().forEach(row => {
    const leads = leadsBy.get(row.platform) || 0;
    const color = platformColor(row.platform);
    const card = el('div', 'card barcard platcard');
    card.style.borderInlineStartColor = color;
    const title = el('div', 'bartitle', row.platform);
    title.style.borderRightColor = color;
    card.appendChild(title);

    const kpis = el('div', 'kpis');
    kpis.appendChild(tile(n(leads), 'לידים',
      row.spent && leads ? 'עלות ממוצעת ' + money(row.spent / leads) + ' לליד' : ''));
    kpis.appendChild(tile(n(row.impressions), 'חשיפות'));
    kpis.appendChild(tile(n(row.clicks), 'הקלקות'));
    kpis.appendChild(tile(money(row.spent), 'עלות כוללת'));
    card.appendChild(kpis);
    host.appendChild(card);
  });
}

function renderMediaBars() {
  const host = document.getElementById('cc-media-bars');
  if (!host) return;
  host.innerHTML = '';

  const media = performanceMedia();
  if (!media.length) return;

  /* שני סוגי מדדים, ולכן שתי שורות.

     בשורה הראשונה מדדים מצטברים — חשיפות, הקלקות והמרות. סכומם
     הוא הסך הכול של הקמפיין, ולכן לאחוז יש משמעות: זהו חלקה של
     הפלטפורמה מהמדד.

     בשורה השנייה מדדי יחס ועלות — CTR, עלות לקליק ותקציב. חלוקת
     CTR של פלטפורמה בסכום ה-CTR של כולן אינה אומרת דבר, ולכן שם
     מוצג הערך בלבד בלי אחוז. */
  const shareMetrics = [
    { key: 'impressions', label: 'חשיפות', format: n },
    { key: 'clicks', label: 'הקלקות', format: n },
    { key: 'conversions', label: 'המרות', format: n },
  ];
  const plainMetrics = [
    { key: 'spent', label: 'תקציב שנוצל', format: money },
    { key: 'ctr', label: 'יחס צפייה להקלקה', format: pct },
    { key: 'cpc', label: 'עלות לקליק', format: money },
  ];

  function metricCard(metric, withShare) {
    const rows = media
      .map(row => ({ name: row.platform, value: row[metric.key] }))
      .filter(row => row.value !== null && row.value !== undefined);
    if (!rows.length) return null;

    const max = Math.max(...rows.map(r => r.value), 0.000001);
    const total = rows.reduce((acc, row) => acc + row.value, 0);
    const card = el('div', 'card barcard');
    card.appendChild(el('div', 'bartitle', metric.label));

    const table = el('table', 'bars');
    rows.forEach(row => {
      table.appendChild(barRow(row.name, row.value / max,
                               withShare && total ? row.value / total : null,
                               metric.format(row.value),
                               platformColor(row.name)));
    });
    card.appendChild(table);
    return card;
  }

  function metricRow(metrics, withShare) {
    const strip = el('div', 'barstack');
    let filled = 0;
    metrics.forEach(metric => {
      const card = metricCard(metric, withShare);
      if (card) { strip.appendChild(card); filled += 1; }
    });
    if (filled) host.appendChild(strip);
  }

  metricRow(shareMetrics, true);
  metricRow(plainMetrics, false);
}

/* ===== השוואה לקמפיינים קודמים ===== */

/* בסיסי ההשוואה שנבחרו. הקמפיין הנוכחי תמיד ראשון ובצבע קבוע. */
let BASELINE_KEYS = ['2025'];

const CURRENT_COLOR = '#4F8EF7';
const BASELINE_COLORS = ['#f59e0b', '#22c39a', '#a78bfa', '#f472b6', '#38bdf8'];

function baselineColor(index) {
  return BASELINE_COLORS[index % BASELINE_COLORS.length];
}

function renderComparison() {
  const host = document.getElementById('cc-comparison');
  const picker = document.getElementById('cc-baseline-pick');
  if (!host && !picker) return;

  const comparison = CC.data.comparison || {};
  const sets = comparison.sets || {};

  // בורר מרובה — אפשר לסמן כמה קמפיינים ולראות את כולם יחד
  if (picker) {
    picker.innerHTML = '';
    const box = el('div', 'ctl');
    box.appendChild(el('span', 'ctl-label', 'משווים מול'));

    const chips = el('div', 'chips');
    const fixed = el('span', 'chip on');
    const mark = el('span', 'mark');
    mark.style.background = CURRENT_COLOR;
    mark.style.borderColor = CURRENT_COLOR;
    fixed.appendChild(mark);
    fixed.appendChild(el('span', 'cname', comparison.currentName || 'קמפיין נוכחי'));
    fixed.appendChild(el('span', 'cnum', 'נוכחי'));
    fixed.style.cursor = 'default';
    chips.appendChild(fixed);

    (comparison.baselines || []).forEach(option => {
      const active = BASELINE_KEYS.indexOf(option.key);
      const chip = el('button', 'chip' + (active >= 0 ? ' on' : ''));
      const dot = el('span', 'mark');
      if (active >= 0) {
        dot.style.background = baselineColor(active);
        dot.style.borderColor = baselineColor(active);
      }
      chip.appendChild(dot);
      chip.appendChild(el('span', 'cname', option.name));
      chip.addEventListener('click', () => {
        const at = BASELINE_KEYS.indexOf(option.key);
        if (at >= 0) BASELINE_KEYS.splice(at, 1);
        else BASELINE_KEYS.push(option.key);
        renderComparison();
      });
      chips.appendChild(chip);
    });

    box.appendChild(chips);
    picker.appendChild(box);
  }

  const chosen = BASELINE_KEYS.map(key => sets[key]).filter(Boolean);

  renderComparisonBars(comparison, chosen);
  renderComparisonCosts(comparison, chosen);

  if (!host) return;
  host.innerHTML = '';
  if (!chosen.length) {
    host.innerHTML = '<div class="warn">יש לבחור לפחות בסיס השוואה אחד.</div>';
    return;
  }

  // טבלה מלאה, עם צביעת מפת חום לפי מי מוביל בכל שורה
  const table = el('table', 't');
  const head = el('tr');
  // שם המדד יושב בשורת הכותרת של הגוש, ולכן אינו חוזר בכל שורה
  const headers = ['ערך', comparison.currentName || 'קמפיין נוכחי'];
  chosen.forEach(set => headers.push(set.name));
  headers.push('שינוי מול הראשון');
  headers.forEach(label => head.appendChild(el('th', null, label)));
  table.appendChild(head);

  const current = comparison.current || {};
  const columns = headers.length;

  /* כל מדד הוא גוש בפני עצמו: שורת כותרת נושאת את שמו, כל שורותיו
     נושאות רקע משלו, וקו מפריד סוגר אותו. בלי זה כל המדדים נשפכו
     לטבלה אחת ארוכה, ולא היה ברור איפה נגמרת הדת ומתחיל המין. */
  let group = 0;
  Object.keys(current).forEach(dimension => {
    const keys = new Set(Object.keys(current[dimension] || {}));
    chosen.forEach(set => Object.keys(set.profile[dimension] || {})
      .forEach(key => keys.add(key)));

    const rows = [...keys].filter(key => {
      const mine = (current[dimension] || {})[key] || 0;
      const others = chosen.map(set => (set.profile[dimension] || {})[key] || 0);
      return !(mine < 0.02 && others.every(v => v < 0.02));
    });
    if (!rows.length) return;

    const band = group % 2 === 0 ? 'grp grp--a' : 'grp grp--b';
    group += 1;

    const title = el('tr', 'grp-head ' + band);
    const cell = el('td', null, dimension);
    cell.colSpan = columns;
    title.appendChild(cell);
    table.appendChild(title);

    rows.forEach((key, position) => {
      const mine = (current[dimension] || {})[key] || 0;
      const others = chosen.map(set => (set.profile[dimension] || {})[key] || 0);

      const values = [mine, ...others];
      const best = Math.max(...values);
      const worst = Math.min(...values);

      const tr = el('tr', band + (position === rows.length - 1 ? ' grp-last' : ''));
      tr.appendChild(el('td', 'grp-key', key));
      values.forEach(value => {
        const cell = el('td', 'num', pct(value));
        // צביעת מפת חום: המוביל ירוק, הנמוך אדום, והשאר ביניהם
        if (best > worst) {
          const t = (value - worst) / (best - worst);
          cell.style.background = mixColors('#3a2b2b', '#1e4634', t);
          cell.style.color = t > 0.6 ? '#8fe3b8' : '#e8b4b4';
          cell.style.fontWeight = value === best ? '700' : '500';
        }
        tr.appendChild(cell);
      });

      const change = mine - others[0];
      const delta = el('td', 'num',
        (change > 0 ? '+' : '') + (change * 100).toFixed(1) + '%');
      delta.className = 'num ' + (Math.abs(change) < 0.01 ? 'delta-flat'
        : change > 0 ? 'delta-up' : 'delta-down');
      tr.appendChild(delta);
      table.appendChild(tr);
    });
  });

  const card = el('div', 'card');
  card.appendChild(table);
  card.appendChild(el('div', 'tnote',
    'כל מדד מופרד לגוש משלו. הצבע בכל שורה מסמן מי מוביל: ירוק ' +
    'לגבוה, אדום לנמוך. מוצגים ערכים שמשקלם 2% ומעלה באחד הצדדים.'));
  host.appendChild(card);
}

/* גרפי ההשוואה: המספר בסוף השורה, האחוז בתוך העמודה הצבועה */
function renderComparisonBars(comparison, chosen) {
  const host = document.getElementById('cc-comparison-bars');
  if (!host) return;
  host.innerHTML = '';
  if (!chosen.length) return;

  const currentCounts = comparison.currentCounts || {};
  const current = comparison.current || {};

  Object.keys(current).forEach(dimension => {
    const keys = new Set(Object.keys(current[dimension] || {}));
    chosen.forEach(set => Object.keys(set.profile[dimension] || {})
      .forEach(key => keys.add(key)));

    const rows = [...keys]
      .map(key => ({
        key,
        current: (current[dimension] || {})[key] || 0,
        currentCount: (currentCounts[dimension] || {})[key] || 0,
        others: chosen.map(set => ({
          share: (set.profile[dimension] || {})[key] || 0,
          count: ((set.counts || {})[dimension] || {})[key] || 0,
          name: set.name,
        })),
      }))
      .filter(row => row.current >= 0.02 || row.others.some(o => o.share >= 0.02))
      .sort((a, b) => b.current - a.current);
    if (!rows.length) return;

    const card = el('div', 'card barcard');
    card.appendChild(el('div', 'bartitle', dimension));
    const table = el('table', 'bars');

    rows.forEach(row => {
      const series = [{ share: row.current, count: row.currentCount,
                        color: CURRENT_COLOR }]
        .concat(row.others.map((other, index) => ({
          share: other.share, count: other.count, color: baselineColor(index) })));

      series.forEach((item, index) => {
        table.appendChild(barRow(index === 0 ? row.key : '', item.share,
                                 item.share, n(item.count), item.color));
      });
    });

    card.appendChild(table);
    const legend = el('div', 'tnote');
    legend.textContent = [comparison.currentName || 'נוכחי']
      .concat(chosen.map(set => set.name)).join(' · ');
    card.appendChild(legend);
    host.appendChild(card);
  });
}

/* השוואת עלויות: עלות לליד כוללת, ולפי פלטפורמה */
function renderComparisonCosts(comparison, chosen) {
  const host = document.getElementById('cc-comparison-costs');
  if (!host) return;
  host.innerHTML = '';

  const currentCosts = comparison.currentCosts || {};
  const sources = [{ name: comparison.currentName || 'קמפיין נוכחי',
                     costs: currentCosts, color: CURRENT_COLOR }]
    .concat(chosen.map((set, index) => ({
      name: set.name, costs: set.costs || {}, color: baselineColor(index) })));

  const withData = sources.filter(source => source.costs.available);
  if (!withData.length) {
    host.innerHTML = '<div class="warn">אין נתוני עלות זמינים להשוואה.</div>';
    return;
  }

  const table = el('table', 't');
  const head = el('tr');
  ['קמפיין', 'תקציב', 'לידים', 'עלות לליד']
    .forEach(label => head.appendChild(el('th', null, label)));
  table.appendChild(head);
  withData.forEach(source => {
    const tr = el('tr');
    const name = el('td', null, source.name);
    name.style.borderInlineStart = '3px solid ' + source.color;
    tr.appendChild(name);
    tr.appendChild(el('td', 'num', money(source.costs.spent)));
    tr.appendChild(el('td', 'num', n(source.costs.leads)));
    tr.appendChild(el('td', 'num', money(source.costs.cpl)));
    table.appendChild(tr);
  });

  const card = el('div', 'card');
  card.appendChild(el('div', 'bartitle', 'עלות לליד — כלל הקמפיין'));
  card.appendChild(table);
  host.appendChild(card);

  // עלות לליד לפי פלטפורמה
  const platforms = new Set();
  withData.forEach(source => (source.costs.platforms || [])
    .forEach(row => platforms.add(row.platform)));
  if (!platforms.size) return;

  const byPlatform = el('table', 't');
  const head2 = el('tr');
  const headers = ['פלטפורמה'].concat(withData.map(source => source.name));
  headers.forEach(label => head2.appendChild(el('th', null, label)));
  byPlatform.appendChild(head2);

  [...platforms].forEach(platform => {
    const tr = el('tr');
    tr.appendChild(el('td', null, platform));
    withData.forEach(source => {
      const row = (source.costs.platforms || [])
        .find(item => item.platform === platform);
      tr.appendChild(el('td', 'num', row ? money(row.cpl) : '—'));
    });
    byPlatform.appendChild(tr);
  });

  const card2 = el('div', 'card');
  card2.appendChild(el('div', 'bartitle', 'עלות לליד — לפי פלטפורמה'));
  card2.appendChild(byPlatform);
  host.appendChild(card2);
}

/* ===== ייצוא לאקסל ===== */

/* מרכיב את קישור הייצוא מהסינון שפעיל ברגע זה, כדי שהקובץ יכיל
   בדיוק את מה שמוצג — אותו טווח תאריכים ואותם מסננים. */
function exportUrl(campaignId, screen) {
  const params = ['id=' + encodeURIComponent(campaignId),
                  'screen=' + encodeURIComponent(screen)];

  if (CC.data && CC.data.dateStart) {
    params.push('from=' + (CC.dateFrom === null ? CC.data.dateStart : dayToDate(CC.dateFrom)));
    params.push('to=' + (CC.dateTo === null ? CC.data.dateEnd : dayToDate(CC.dateTo)));
  }

  // לכל מסנן נשלחים הערכים שהוצאו, לפי שם העמודה באיחוד
  (CC.data.facets || []).forEach(facet => {
    const excluded = CC.selected[facet.key];
    if (!excluded || !excluded.size) return;
    const values = [...excluded].map(index => facet.values[index]);
    params.push('x_' + encodeURIComponent(facet.column || facet.label) +
                '=' + encodeURIComponent(values.join('|')));
  });

  return '/export?' + params.join('&');
}

function renderExport() {
  document.querySelectorAll('.export-bar').forEach(host => {
    const screen = host.dataset.export;
    const campaignId = host.dataset.campaign;
    if (!screen || !campaignId) return;

    host.innerHTML = '';
    if (window.CC_STATIC) {
      const disabled = el('span', 'act-btn ghost', '⭳ ייצוא לאקסל');
      disabled.style.opacity = '.5';
      disabled.title = 'זמין בגרסת השרת המלאה';
      host.appendChild(disabled);
      const why = el('span', 'note');
      why.style.marginInlineStart = '12px';
      why.style.alignSelf = 'center';
      why.textContent = 'הייצוא זמין בגרסת השרת המלאה. זהו אתר הדגמה לקריאה בלבד.';
      host.appendChild(why);
      return;
    }
    const link = el('a', 'act-btn ghost', '⭳ ייצוא לאקסל');
    link.href = exportUrl(campaignId, screen);
    host.appendChild(link);

    const note = el('span', 'note');
    note.style.marginInlineStart = '12px';
    note.style.alignSelf = 'center';
    note.textContent = 'הקובץ ייכלול את הנתונים בסינון הנוכחי — טבלה שמית ' +
      'לפי מספר מועמד, טבלה לכל פילוח, ולשונית גרפים.';
    host.appendChild(note);
  });
}

/* ===== סטטוס קמפיינים ===== */

async function loadStatus() {
  const host = document.getElementById('cc-status');
  if (!host) return;

  const response = await ccFetch('/api/status');
  const rows = await response.json();

  host.innerHTML = '';
  if (!rows.length) {
    host.innerHTML = '<div class="warn">עדיין לא הוגדר אף קמפיין.</div>';
    return;
  }

  const totals = rows.reduce((acc, r) => ({
    leads: acc.leads + (r.leads || 0),
    active: acc.active + (r.active || 0),
    recruited: acc.recruited + (r.recruited || 0),
  }), { leads: 0, active: 0, recruited: 0 });

  const kpis = el('div', 'kpis');
  kpis.appendChild(tile(n(rows.length), 'קמפיינים במערכת', '', true));
  kpis.appendChild(tile(n(totals.leads), 'סך הלידים בכל הקמפיינים'));
  kpis.appendChild(tile(n(totals.active), 'מועמדים פעילים'));
  kpis.appendChild(tile(n(totals.recruited), 'גיוסים'));
  host.appendChild(kpis);

  const STATE_CLASS = {
    'תקין': 'ok', 'אזהרות': 'warn', 'שגיאות': 'err',
    'ממתין להרצה': 'pend', 'ריק': 'idle',
  };

  const table = el('table', 't');
  const head = el('tr');
  ['קמפיין', 'מצב', 'ריצה אחרונה', 'קבצים', 'ריצות', 'לידים', 'פעילים',
   'גויסו', 'אזהרות', 'שגיאות', 'רפרנטים', '']
    .forEach(label => head.appendChild(el('th', null, label)));
  table.appendChild(head);

  rows.forEach(row => {
    const tr = el('tr');
    tr.appendChild(el('td', null, row.name));

    const stateCell = el('td');
    const badge = el('span', 'badge ' + (STATE_CLASS[row.state] || 'idle'), row.state);
    stateCell.appendChild(badge);
    tr.appendChild(stateCell);

    tr.appendChild(el('td', null, row.lastRun || '—'));
    tr.appendChild(el('td', 'num', n(row.files)));
    tr.appendChild(el('td', 'num', n(row.runs)));
    tr.appendChild(el('td', 'num', row.leads === null ? '—' : n(row.leads)));
    tr.appendChild(el('td', 'num', row.active === null ? '—' : n(row.active)));
    tr.appendChild(el('td', 'num', row.recruited === null ? '—' : n(row.recruited)));
    tr.appendChild(el('td', 'num', n(row.warnings)));
    tr.appendChild(el('td', 'num', n(row.errors)));
    tr.appendChild(el('td', null, row.usesReferents ? 'עובד' : 'לא עובד'));

    const link = el('td');
    const anchor = el('a', 'act-btn', 'פתיחה');
    anchor.href = '/dashboard?id=' + encodeURIComponent(row.id);
    link.appendChild(anchor);
    tr.appendChild(link);

    table.appendChild(tr);
  });

  const card = el('div', 'card');
  card.appendChild(table);
  host.appendChild(card);
}

/* ===== לוח בקרה שנתי ===== */

const ANNUAL = { data: null, campaigns: new Set(), from: 0, to: 0, days: [] };

/* לכל קמפיין צבע משלו, קבוע לאורך כל הלוח השנתי — הצ'יפ, הטבלה
   והגרף מציגים את אותו הצבע, כך שאפשר לעקוב אחרי קמפיין במבט אחד. */
const ANNUAL_COLORS = ['#4F8EF7', '#22c39a', '#FFC857', '#f97362', '#a78bfa',
                       '#38bdf8', '#f472b6', '#8fc63f', '#fb923c', '#2dd4bf',
                       '#c084fc', '#facc15'];

function annualColor(campaignId) {
  const list = (ANNUAL.data && ANNUAL.data.campaigns) || [];
  const index = list.findIndex(c => c.id === campaignId);
  return ANNUAL_COLORS[(index < 0 ? 0 : index) % ANNUAL_COLORS.length];
}

async function loadAnnual() {
  const host = document.getElementById('cc-annual');
  if (!host) return;

  const response = await ccFetch('/api/annual');
  ANNUAL.data = await response.json();

  if (!ANNUAL.data.campaigns.length) {
    const chips = document.getElementById('cc-annual-chips');
    if (chips) chips.innerHTML =
      '<div class="warn">אין קמפיין עם ריצה. יש להעלות נתונים ולהריץ ניתוח.</div>';
    return;
  }

  // ברירת המחדל: כל הקמפיינים מסומנים, וכל הטווח הקיים במערכת
  ANNUAL.data.campaigns.forEach(c => ANNUAL.campaigns.add(c.id));
  const all = new Set();
  ANNUAL.data.campaigns.forEach(c => c.daily.forEach(d => all.add(d.date)));
  ANNUAL.days = [...all].sort();
  ANNUAL.from = 0;
  ANNUAL.to = Math.max(0, ANNUAL.days.length - 1);

  buildAnnualChips();
  buildAnnualRange();
  renderAnnual();
}

/* צ'יפ לכל קמפיין — מודגש כשנבחר, עמום כשלא. בלי סימני וי. */
function buildAnnualChips() {
  const host = document.getElementById('cc-annual-chips');
  if (!host) return;
  host.innerHTML = '';

  const box = el('div', 'chips');
  ANNUAL.data.campaigns.forEach(campaign => {
    const on = ANNUAL.campaigns.has(campaign.id);
    const chip = el('button', 'chip chip--plain' + (on ? ' on' : ''));
    const color = annualColor(campaign.id);
    const dot = el('span', 'cdot');
    dot.style.background = color;
    chip.appendChild(dot);
    if (on) chip.style.borderColor = color;
    chip.appendChild(el('span', 'cname', campaign.name));
    chip.appendChild(el('span', 'cnum', n(campaign.total) + ' לידים'));
    chip.addEventListener('click', () => {
      if (on) ANNUAL.campaigns.delete(campaign.id);
      else ANNUAL.campaigns.add(campaign.id);
      buildAnnualChips();
      renderAnnual();
    });
    box.appendChild(chip);
  });
  host.appendChild(box);
}

/* מחוון טווח: קו אחד, עיגול בכל קצה, והתאריך המילולי מעליו.
   מתחתיו צ'יפים של כל החודשים בטווח — לחיצה בוחרת חודש שלם. */
function buildAnnualRange() {
  const host = document.getElementById('cc-annual-range');
  if (!host || !ANNUAL.days.length) return;
  host.innerHTML = '';

  const last = ANNUAL.days.length - 1;
  const box = el('div', 'rangebox');

  const header = el('div', 'range-head');
  const fromLabel = el('span', 'range-date');
  const toLabel = el('span', 'range-date');
  header.appendChild(fromLabel);
  const spacer = el('span', 'range-line-label', 'טווח תאריכים');
  header.appendChild(spacer);
  header.appendChild(toLabel);
  box.appendChild(header);

  const track = el('div', 'range-track');
  const fill = el('div', 'range-fill');
  track.appendChild(fill);

  const fromInput = el('input', 'range-input range-from');
  const toInput = el('input', 'range-input range-to');
  [fromInput, toInput].forEach(input => {
    input.type = 'range';
    input.min = '0';
    input.max = String(last);
  });
  fromInput.value = String(ANNUAL.from);
  toInput.value = String(ANNUAL.to);
  track.appendChild(fromInput);
  track.appendChild(toInput);
  box.appendChild(track);

  function paint() {
    const left = last ? (ANNUAL.from / last) * 100 : 0;
    const right = last ? (ANNUAL.to / last) * 100 : 100;
    // RTL: ההתחלה בצד ימין
    fill.style.right = left + '%';
    fill.style.width = Math.max(0, right - left) + '%';
    fromLabel.textContent = hebrewDate(ANNUAL.days[ANNUAL.from]);
    toLabel.textContent = hebrewDate(ANNUAL.days[ANNUAL.to]);
  }

  fromInput.addEventListener('input', () => {
    ANNUAL.from = Math.min(Number(fromInput.value), ANNUAL.to);
    fromInput.value = String(ANNUAL.from);
    paint(); markMonths(); renderAnnual();
  });
  toInput.addEventListener('input', () => {
    ANNUAL.to = Math.max(Number(toInput.value), ANNUAL.from);
    toInput.value = String(ANNUAL.to);
    paint(); markMonths(); renderAnnual();
  });

  // חודשים
  const months = [];
  ANNUAL.days.forEach(day => {
    const key = day.slice(0, 7);
    if (!months.length || months[months.length - 1] !== key) {
      if (months.indexOf(key) < 0) months.push(key);
    }
  });

  const monthBox = el('div', 'months');
  const monthButtons = new Map();
  months.forEach(month => {
    const button = el('button', 'month', hebrewMonth(month));
    button.addEventListener('click', () => {
      const first = ANNUAL.days.findIndex(day => day.slice(0, 7) === month);
      let lastIndex = first;
      ANNUAL.days.forEach((day, index) => {
        if (day.slice(0, 7) === month) lastIndex = index;
      });
      ANNUAL.from = first;
      ANNUAL.to = lastIndex;
      fromInput.value = String(first);
      toInput.value = String(lastIndex);
      paint(); markMonths(); renderAnnual();
    });
    monthButtons.set(month, button);
    monthBox.appendChild(button);
  });

  const allButton = el('button', 'month month--all', 'כל הטווח');
  allButton.addEventListener('click', () => {
    ANNUAL.from = 0; ANNUAL.to = last;
    fromInput.value = '0'; toInput.value = String(last);
    paint(); markMonths(); renderAnnual();
  });
  monthBox.appendChild(allButton);
  box.appendChild(monthBox);

  function markMonths() {
    const from = ANNUAL.days[ANNUAL.from], to = ANNUAL.days[ANNUAL.to];
    monthButtons.forEach((button, month) => {
      const inside = ANNUAL.days.some(day =>
        day.slice(0, 7) === month && day >= from && day <= to);
      button.classList.toggle('on', inside);
    });
    allButton.classList.toggle('on', ANNUAL.from === 0 && ANNUAL.to === last);
  }

  const state = el('span', 'ctl-state');
  state.id = 'cc-annual-count';
  box.appendChild(state);

  host.appendChild(box);
  paint();
  markMonths();
}

const HEB_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי',
                    'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];

function hebrewDate(iso) {
  if (!iso) return '';
  return `${iso.slice(8, 10)} ${HEB_MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}

function hebrewMonth(key) {
  return `${HEB_MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(2, 4)}`;
}

/* רק קמפיינים שיש להם הגשות בתוך הטווח נכנסים להשוואה */
function annualSelection() {
  const from = ANNUAL.days[ANNUAL.from];
  const to = ANNUAL.days[ANNUAL.to];
  return ANNUAL.data.campaigns
    .filter(c => ANNUAL.campaigns.has(c.id))
    .map(campaign => {
      const daily = campaign.daily.filter(d => d.date >= from && d.date <= to);
      const inRange = daily.reduce((acc, d) => acc + d.count, 0);
      // המספרים המצטברים אינם מפולחים לפי יום, ולכן הם משוקללים לפי
      // חלק ההגשות שנכנס לטווח — קירוב מוצהר ולא ספירה מדויקת
      const ratio = campaign.total ? inRange / campaign.total : 0;
      const scale = value => (value === null || value === undefined)
        ? null : Math.round(value * ratio);
      return {
        ...campaign, daily, inRange, ratio,
        activeInRange: scale(campaign.active),
        recruitedInRange: scale(campaign.recruited),
        interviewInRange: scale(campaign.interview),
        daparInRange: scale(campaign.dapar),
        gibushonInRange: scale(campaign.gibushon),
        spentInRange: campaign.spent === null ? null : campaign.spent * ratio,
        orderedInRange: scale(campaign.ordered),
      };
    })
    .filter(campaign => campaign.inRange > 0);
}

function renderAnnual() {
  if (!ANNUAL.data) return;
  const selected = annualSelection();

  const count = document.getElementById('cc-annual-count');
  if (count) {
    const total = selected.reduce((acc, c) => acc + c.inRange, 0);
    count.textContent = `${n(selected.length)} קמפיינים בטווח · ${n(total)} הגשות`;
    count.classList.toggle('filtered',
      ANNUAL.from !== 0 || ANNUAL.to !== ANNUAL.days.length - 1 ||
      selected.length !== ANNUAL.data.campaigns.length);
  }

  renderAnnualKpis(selected);
  renderAnnualTable(selected);
  renderAnnualTrend(selected);
  renderAnnualCharts(selected);
  fitBarLabels();
}

function renderAnnualKpis(selected) {
  const host = document.getElementById('cc-annual-kpis');
  if (!host) return;
  host.innerHTML = '';

  const totals = selected.reduce((acc, c) => ({
    leads: acc.leads + c.inRange,
    ordered: acc.ordered + (c.orderedInRange || 0),
    recruited: acc.recruited + (c.recruitedInRange || 0),
    gibushon: acc.gibushon + (c.gibushonInRange || 0),
    spent: acc.spent + (c.spentInRange || 0),
  }), { leads: 0, ordered: 0, recruited: 0, gibushon: 0, spent: 0 });

  host.appendChild(tile(n(totals.leads), 'לידים במערכת',
                        `${selected.length} קמפיינים בטווח`, true));
  host.appendChild(tile(n(totals.ordered), 'לידים שהוזמנו'));
  host.appendChild(tile(money(totals.spent), 'תקציב'));
  host.appendChild(tile(totals.leads ? money(totals.spent / totals.leads) : '—',
                        'עלות לליד'));
  host.appendChild(tile(totals.gibushon ? money(totals.spent / totals.gibushon) : '—',
                        'עלות לגיבושון'));
  host.appendChild(tile(totals.recruited ? money(totals.spent / totals.recruited) : '—',
                        'עלות לגיוס'));
}

function renderAnnualTable(selected) {
  const host = document.getElementById('cc-annual-table');
  if (!host) return;
  host.innerHTML = '';

  const table = el('table', 't');
  const head = el('tr');
  ['שם קמפיין', 'תקציב', 'לידים שהוזמנו', 'לידים במערכת',
   'דפ"ר', 'רמה', 'גיבושון', 'גיוס',
   'עלות לליד', 'עלות לגיבושון', 'עלות לגיוס']
    .forEach(label => head.appendChild(el('th', null, label)));
  table.appendChild(head);

  const sorted = [...selected].sort((a, b) => b.inRange - a.inRange);
  sorted.forEach(campaign => {
    const spent = campaign.spentInRange;
    const tr = el('tr');
    const nameCell = el('td');
    const swatch = el('span', 'cdot');
    swatch.style.background = annualColor(campaign.id);
    nameCell.appendChild(swatch);
    nameCell.appendChild(document.createTextNode(campaign.name));
    tr.appendChild(nameCell);
    tr.appendChild(el('td', 'num', money(spent)));
    tr.appendChild(el('td', 'num', n(campaign.orderedInRange)));
    tr.appendChild(el('td', 'num', n(campaign.inRange)));
    tr.appendChild(el('td', 'num', n(campaign.daparInRange)));
    tr.appendChild(el('td', 'num', n(campaign.interviewInRange)));
    tr.appendChild(el('td', 'num', n(campaign.gibushonInRange)));
    tr.appendChild(el('td', 'num', n(campaign.recruitedInRange)));
    tr.appendChild(el('td', 'num',
      spent && campaign.inRange ? money(spent / campaign.inRange) : '—'));
    tr.appendChild(el('td', 'num',
      spent && campaign.gibushonInRange ? money(spent / campaign.gibushonInRange) : '—'));
    tr.appendChild(el('td', 'num',
      spent && campaign.recruitedInRange ? money(spent / campaign.recruitedInRange) : '—'));
    table.appendChild(tr);
  });

  // שורת סיכום
  if (sorted.length > 1) {
    const totals = sorted.reduce((acc, c) => ({
      spent: acc.spent + (c.spentInRange || 0),
      ordered: acc.ordered + (c.orderedInRange || 0),
      leads: acc.leads + c.inRange,
      dapar: acc.dapar + (c.daparInRange || 0),
      interview: acc.interview + (c.interviewInRange || 0),
      gibushon: acc.gibushon + (c.gibushonInRange || 0),
      recruited: acc.recruited + (c.recruitedInRange || 0),
    }), { spent: 0, ordered: 0, leads: 0, dapar: 0, interview: 0,
          gibushon: 0, recruited: 0 });

    const tr = el('tr');
    const label = el('td', null, 'סה"כ');
    label.style.fontWeight = '700';
    tr.appendChild(label);
    [money(totals.spent), n(totals.ordered), n(totals.leads), n(totals.dapar),
     n(totals.interview), n(totals.gibushon), n(totals.recruited),
     totals.leads ? money(totals.spent / totals.leads) : '—',
     totals.gibushon ? money(totals.spent / totals.gibushon) : '—',
     totals.recruited ? money(totals.spent / totals.recruited) : '—']
      .forEach(value => tr.appendChild(el('td', 'num', value)));
    table.appendChild(tr);
  }

  const card = el('div', 'card');
  card.appendChild(table);
  card.appendChild(el('div', 'tnote',
    'שלושת העמודות האחרונות הן עלות מהתקציב לכל יחידה. ' +
    '"גיבושון" הוא מרכז ההערכה. המספרים בטווח מחושבים לפי חלק ההגשות ' +
    'שנכנס אליו — הדוחות אינם מפולחים לפי יום, ולכן זהו קירוב מוצהר.'));
  host.appendChild(card);
}

function renderAnnualTrend(selected) {
  const host = document.getElementById('cc-annual-trend');
  if (!host) return;
  host.innerHTML = '';
  if (!selected.length) return;

  /* קו לכל קמפיין בצבע שלו, על אותו ציר זמן — כך רואים מי פעל מתי
     ומי הביא יותר, בלי לאחד את כולם לקו אחד חסר משמעות. */
  const days = new Set();
  selected.forEach(c => c.daily.forEach(d => days.add(d.date)));
  if (!days.size) return;
  const axis = [...days].sort();
  const at = new Map(axis.map((day, i) => [day, i]));

  const series = selected.map(campaign => {
    const values = new Array(axis.length).fill(null);
    campaign.daily.forEach(day => {
      const i = at.get(day.date);
      if (i !== undefined) values[i] = (values[i] || 0) + day.count;
    });
    return { name: campaign.name, color: annualColor(campaign.id), values };
  });

  const width = 960, height = 250;
  const padLeft = 50, padBottom = 32, padTop = 14, padRight = 14;
  const plotW = width - padLeft - padRight, plotH = height - padTop - padBottom;
  let max = 0;
  series.forEach(line => line.values.forEach(v => { if (v > max) max = v; }));
  max = max || 1;
  const x = i => padLeft + (axis.length === 1 ? plotW / 2
    : (i / (axis.length - 1)) * plotW);
  const y = value => padTop + plotH - (value / max) * plotH;

  const parts = [`<svg class="tsvg" viewBox="0 0 ${width} ${height}">`];
  for (let step = 0; step <= 4; step++) {
    const value = (max / 4) * step, yy = y(value);
    parts.push(`<line class="tgrid" x1="${padLeft}" y1="${yy}" x2="${width - padRight}" y2="${yy}"/>`);
    parts.push(`<text class="tylab" x="${padLeft - 8}" y="${yy + 3}">${n(value)}</text>`);
  }

  series.forEach(line => {
    let path = '', open = false;
    line.values.forEach((value, i) => {
      if (value === null) { open = false; return; }
      path += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(value).toFixed(1)} `;
      open = true;
    });
    if (path) {
      parts.push(`<path d="${path.trim()}" fill="none" stroke="${line.color}" ` +
                 `stroke-width="2.2" stroke-linejoin="round"/>`);
    }
  });

  const step = Math.max(1, Math.floor(axis.length / 9));
  axis.forEach((day, i) => {
    if (i % step === 0 || i === axis.length - 1) {
      parts.push(`<text class="txlab" x="${x(i).toFixed(1)}" y="${height - 10}">` +
                 `${day.slice(8, 10)}/${day.slice(5, 7)}</text>`);
    }
  });
  parts.push('</svg>');

  const card = el('div', 'card trendcard');
  card.appendChild(el('div', 'bartitle', 'הגשות יומיות — לפי קמפיין'));
  const holder = el('div');
  holder.innerHTML = parts.join('');
  card.appendChild(holder);

  const legend = el('div', 'linelegend');
  series.forEach(line => {
    const item = el('span', 'lineitem');
    const swatch = el('i', 'lineswatch');
    swatch.style.background = line.color;
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(line.name));
    legend.appendChild(item);
  });
  card.appendChild(legend);
  card.appendChild(el('div', 'tnote', `${axis.length} ימים בטווח`));
  host.appendChild(card);
}

function renderAnnualCharts(selected) {
  const host = document.getElementById('cc-annual-charts');
  if (!host) return;
  host.innerHTML = '';

  ANNUAL.data.dimensions.forEach(dimension => {
    const merged = new Map();
    selected.forEach(campaign => {
      const dim = campaign.dims[dimension.key];
      if (!dim) return;
      Object.entries(dim.values).forEach(entry => {
        merged.set(entry[0],
          (merged.get(entry[0]) || 0) + Math.round(entry[1] * campaign.ratio));
      });
    });
    const pairs = [...merged.entries()]
      .map(entry => ({ value: entry[0], count: entry[1] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12);
    if (pairs.some(p => p.count > 0)) {
      // אותם פילוחים דמוגרפיים — ולכן אותו כלל לגבי ערכים ריקים
      host.appendChild(barCard(dimension.label, pairs, dimension.key, true));
    }
  });
}

/* ===== התנעה ===== */

document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('cc-root');
  if (root && root.dataset.campaign) {
    loadCampaign(root.dataset.campaign);
  }
  loadAnnual();
  loadStatus();
});
