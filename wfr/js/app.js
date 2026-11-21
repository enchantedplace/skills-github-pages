// WFR Field Log — main application: routing, views, form binding, timers.

import * as store from './store.js';
import * as M from './model.js';
import { formatUTM, formatLatLon, formatDMS, toUTM, fromUTM } from './utm.js';
import { parseSpeech, recognizerSupport, startListening } from './voice.js';
import { soapNote, isbar, isbarShort, fullRecord } from './export.js';
import { chartsFor } from './chart.js';
import * as MAP from './map.js';
import { esc, $, $$, openSheet, sheetOpen, toast, confirmSheet, openKeypad, unlockAudio, beep } from './ui.js';

const VERSION = '1.0.0';
const DEFAULTS = {
  theme: 'auto', textSize: 'L', battery: false, tempUnit: 'C', bglUnit: 'mg', recheckMin: 15,
  responder: '', autoLockMin: 5, tileSource: 'osm', customTileUrl: '', syncUrl: '', lang: 'en-US',
};

const S = {
  settings: { ...DEFAULTS },
  patients: new Map(),
  route: { name: 'list' },
  routeKey: '',
  saveState: 'saved',
  lastSaved: null,
  savePromise: null,
  trendView: 'table',
  editingSet: null,
  handoffView: 'isbar',
  alerted: new Set(),
  hiddenAt: null,
  lastFix: null,
  maps: {},
  dirty: null,
};

const TABS = [
  ['info', 'Info'], ['abcde', 'ABCDE'], ['vitals', 'Vitals'], ['exam', 'Exam'],
  ['hx', 'History'], ['plan', 'Plan'], ['loc', 'Location'], ['handoff', 'Handoff'],
];

const view = () => document.getElementById('view');
const cur = () => (S.route.id ? S.patients.get(S.route.id) : null);
const units = () => ({ temp: S.settings.tempUnit, bgl: S.settings.bglUnit });

// ---------- path helpers ('#id' selects an array item by id) ----------
function pget(obj, path) {
  let o = obj;
  for (const k of path.split('.')) {
    if (o == null) return undefined;
    o = k[0] === '#' ? (Array.isArray(o) ? o.find((x) => x.id === k.slice(1)) : undefined) : o[k];
  }
  return o;
}
function pset(obj, path, v) {
  const ks = path.split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    const k = ks[i];
    let n = k[0] === '#' ? o.find((x) => x.id === k.slice(1)) : o[k];
    if (n == null) { n = {}; o[k] = n; }
    o = n;
  }
  o[ks[ks.length - 1]] = v;
}
function getVal(path) {
  if (path.startsWith('settings.')) return S.settings[path.slice(9)];
  const p = cur();
  return p ? pget(p, path) : undefined;
}

// ---------- saving ----------
const saver = store.createSaver((st, err) => {
  S.saveState = st;
  if (st === 'saved') S.lastSaved = Date.now();
  if (st === 'error') toast(`⚠ SAVE FAILED: ${err?.message || err}`, { ms: 8000 });
  renderStatus();
});
function touch(p, { sync = true } = {}) {
  p.updated = Date.now();
  S.savePromise = saver(p);
  if (sync) scheduleSync();
  return S.savePromise;
}
let textTimer;
function flushText() {
  clearTimeout(textTimer);
  if (S.dirty) { const p = S.dirty; S.dirty = null; touch(p); }
}

function setVal(path, v, { render = true } = {}) {
  if (path.startsWith('settings.')) {
    S.settings[path.slice(9)] = v;
    saveSettings();
    applySettings();
    if (render) rerender();
    return;
  }
  const p = cur();
  if (!p) return;
  pset(p, path, v);
  sideEffects(p, path, v);
  touch(p);
  if (render) rerender();
}

function sideEffects(p, path, v) {
  if (path === 'recheck.min') {
    const lv = M.latestVitals(p);
    p.recheck.enabled = v !== 'off';
    p.recheck.dueAt = p.recheck.enabled ? (lv ? lv.t : Date.now()) + Number(v) * 60000 : null;
    if (p.recheck.enabled && p.recheck.dueAt < Date.now()) p.recheck.dueAt = Date.now() + Number(v) * 60000;
  }
}

// ---------- settings ----------
async function loadSettings() {
  try { S.settings = { ...DEFAULTS, ...((await store.metaGet('settings')) || {}) }; } catch { /* defaults */ }
}
function saveSettings() { store.metaSet('settings', S.settings).catch(console.error); }

const darkMQ = window.matchMedia('(prefers-color-scheme: dark)');
function applySettings() {
  const st = S.settings;
  const html = document.documentElement;
  const dark = st.battery || st.theme === 'dark' || (st.theme === 'auto' && darkMQ.matches);
  html.dataset.theme = dark ? 'dark' : 'light';
  html.dataset.dark = dark ? '1' : '0';
  html.dataset.battery = st.battery ? '1' : '0';
  html.dataset.size = st.textSize;
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = dark ? '#000000' : '#ffffff';
  startTicker();
}
darkMQ.addEventListener && darkMQ.addEventListener('change', applySettings);

// ---------- small render helpers ----------
const ageSex = (p) => [p.age ? `${p.age}${/^\d+$/.test(p.age) ? 'y' : ''}` : '', p.sex].filter(Boolean).join(' ');
function badge(p, big = false) {
  const u = M.urgencyInfo(p.evac?.urgency);
  return `<span class="ubadge u-${u.v || 'none'}${big ? ' big' : ''}" title="${esc(u.label)}"><span>${esc(big ? u.label : u.short)}</span></span>`;
}
const opt = (x) => (typeof x === 'string' ? { v: x, label: x } : x);

function seg(path, label, opts, o = {}) {
  const v = getVal(path) ?? '';
  return `<div class="field ${o.cls || ''}">${label ? `<div class="flabel">${esc(label)}</div>` : ''}
    <div class="seg ${o.segCls || ''}" data-seg="${esc(path)}" role="group" aria-label="${esc(label || path)}">${opts.map(opt).map((it) => {
    const on = String(v) === String(it.v);
    return `<button type="button" data-val="${esc(it.v)}" class="${on ? 'on' : ''} ${(o.bad || []).includes(it.v) ? 'bad' : ''}" aria-pressed="${on}">${esc(it.label)}</button>`;
  }).join('')}</div></div>`;
}
function multi(path, label, opts) {
  const v = getVal(path) || [];
  return `<div class="field">${label ? `<div class="flabel">${esc(label)}</div>` : ''}
    <div class="seg multi" data-multi="${esc(path)}">${opts.map(opt).map((it) => {
    const on = v.includes(it.v);
    return `<button type="button" data-val="${esc(it.v)}" class="${on ? 'on' : ''}" aria-pressed="${on}">${esc(it.label)}</button>`;
  }).join('')}</div></div>`;
}
function text(path, label, o = {}) {
  const v = getVal(path) ?? '';
  const quick = o.quick && o.quick.length
    ? `<div class="quick">${o.quick.map((q) => `<button type="button" data-append="${esc(path)}" data-text="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : '';
  return `<div class="field">${label ? `<label class="flabel">${esc(label)}</label>` : ''}
    <textarea data-path="${esc(path)}" rows="${o.rows || 1}" placeholder="${esc(o.ph || '')}" autocapitalize="sentences" enterkeyhint="done">${esc(v)}</textarea>${quick}</div>`;
}
function numDisplay(v, conv) {
  if (v === '' || v == null) return '';
  if (conv === 'temp') return S.settings.tempUnit === 'F' ? String(Math.round(M.cToF(+v) * 10) / 10) : String(v);
  if (conv === 'bgl') return S.settings.bglUnit === 'mmol' ? String(Math.round(M.mgToMmol(+v) * 10) / 10) : String(v);
  return String(v);
}
function convUnit(conv, unit) {
  if (conv === 'temp') return S.settings.tempUnit === 'F' ? '°F' : '°C';
  if (conv === 'bgl') return S.settings.bglUnit === 'mmol' ? 'mmol/L' : 'mg/dL';
  return unit || '';
}
function num(path, label, o = {}) {
  const v = getVal(path);
  const d = numDisplay(v, o.conv);
  const unit = convUnit(o.conv, o.unit);
  const fl = o.flag || {};
  const mark = fl.worse ? (fl.dir === 'up' ? ' ▲' : ' ▼') : '';
  return `<button type="button" class="numbtn ${fl.worse ? 'worse' : fl.abnormal ? 'abn' : ''}" data-num="${esc(path)}" data-label="${esc(label)}"
    data-unit="${esc(unit)}" data-dec="${o.dec || o.conv === 'temp' || (o.conv === 'bgl' && S.settings.bglUnit === 'mmol') ? 1 : ''}" data-conv="${o.conv || ''}"
    data-next="${esc(o.next || '')}" data-hint="${esc(o.hint || '')}">
    <span class="nl">${esc(label)}</span><span class="nv">${d === '' ? '<span class="muted">tap</span>' : esc(d)}<small> ${esc(d === '' ? '' : unit)}</small>${mark}</span></button>`;
}
const pad2 = (n) => String(n).padStart(2, '0');
function timeF(path, label) {
  const v = getVal(path);
  const d = v ? new Date(v) : null;
  const hhmm = d ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : '';
  return `<div class="field">${label ? `<label class="flabel">${esc(label)}</label>` : ''}<div class="timerow">
    <input type="time" data-time="${esc(path)}" value="${hhmm}"><button type="button" class="btn" data-action="setNow" data-path="${esc(path)}">Now</button></div></div>`;
}

// ---------- routing ----------
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  if (parts[0] === 'p' && parts[1]) return { name: 'patient', id: parts[1], tab: TABS.some((t) => t[0] === parts[2]) ? parts[2] : 'abcde' };
  if (parts[0] === 'map') return { name: 'map' };
  if (parts[0] === 'settings') return { name: 'settings' };
  return { name: 'list' };
}

function destroyMaps() {
  for (const k of Object.keys(S.maps)) { try { S.maps[k].map.remove(); } catch { /* ignore */ } delete S.maps[k]; }
}

function render() {
  if (!store.isUnlocked()) return;
  flushText();
  destroyMaps();
  S.route = parseRoute();
  const key = JSON.stringify(S.route);
  const changed = key !== S.routeKey;
  if (S.route.name === 'patient' && !cur()) { location.hash = '#/'; return; }
  if (changed && S.route.name === 'patient' && S.route.id !== JSON.parse(S.routeKey || '{}').id) S.editingSet = null;
  S.routeKey = key;
  renderHeader();
  const v = view();
  const r = S.route;
  if (r.name === 'list') v.innerHTML = listHTML();
  else if (r.name === 'patient') { v.innerHTML = patientHTML(cur(), r.tab); if (r.tab === 'loc') initLocMap(); }
  else if (r.name === 'map') { v.innerHTML = mapViewHTML(); initAllMap(); }
  else if (r.name === 'settings') { v.innerHTML = settingsHTML(); refreshStorageInfo(); }
  if (changed) window.scrollTo(0, 0);
  if (r.name === 'patient') { const t = $('#tabs .on'); t && t.scrollIntoView({ block: 'nearest', inline: 'center' }); }
  renderStatus();
  autoGrowAll();
}

function rerender() {
  const r = S.route;
  const y = window.scrollY;
  if (r.name === 'patient') {
    const p = cur();
    if (!p) return;
    if (r.tab === 'loc') updateLocPanel();
    else $('#pbody').innerHTML = tabHTML(p, r.tab);
    $('#strip').innerHTML = stripHTML(p);
    $('#tabs').innerHTML = tabsHTML(p, r.tab);
    renderHeader();
  } else if (r.name === 'list') view().innerHTML = listHTML();
  else if (r.name === 'settings') { view().innerHTML = settingsHTML(); refreshStorageInfo(); }
  else if (r.name === 'map') refreshAllMap();
  window.scrollTo(0, y);
  renderStatus();
  autoGrowAll();
}

// ---------- header & status ----------
function renderHeader() {
  const r = S.route;
  const p = cur();
  const left = r.name === 'list' ? '<div class="brand">WFR Field Log</div>' : '<a class="btn hbtn" href="#/" aria-label="Patient list">‹ List</a>';
  let mid = '';
  if (r.name === 'patient' && p) mid = `${badge(p)}<span class="pid">${esc(p.label)}</span><span class="hdr-sub">${esc(ageSex(p))}</span>`;
  else if (r.name === 'map') mid = '<span class="pid">Patient map</span>';
  else if (r.name === 'settings') mid = '<span class="pid">Settings</span>';
  $('#top').innerHTML = `<div class="hdr-row">${left}<div class="hdr-mid">${mid}</div><div id="status" class="status" aria-live="polite"></div></div>`;
}

function renderStatus() {
  const el = $('#status');
  if (!el) return;
  const p = cur();
  const online = navigator.onLine;
  let txt, cls = '';
  if (S.saveState === 'saving') txt = 'Saving…';
  else if (S.saveState === 'error') { txt = '⚠ NOT SAVED'; cls = 'err'; }
  else if (p && S.settings.syncUrl && p.syncedVersion && p.syncedVersion >= p.updated) txt = `✓ Synced ${M.fmtTime(p.syncedAt)}`;
  else txt = '✓ Saved';
  el.className = `status ${cls}`;
  el.innerHTML = `<span>${esc(txt)}</span><span class="net">${online ? 'Online' : 'Offline'}${S.settings.battery ? ' · 🔋' : ''}</span>`;
}

// ---------- list view ----------
function sortedPatients() {
  return [...S.patients.values()].sort((a, b) => M.urgencyInfo(b.evac?.urgency).rank - M.urgencyInfo(a.evac?.urgency).rank || b.created - a.created);
}
function countdownText(p) {
  if (!p.recheck?.enabled || !p.recheck.dueAt) return '';
  const ms = p.recheck.dueAt - Date.now();
  if (ms <= 0) return 'RECHECK DUE';
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  return `Recheck in ${m}:${pad2(s)}`;
}
function countdownHTML(p) {
  const t = countdownText(p);
  if (!t) return '';
  return `<span class="cd ${t === 'RECHECK DUE' ? 'due' : ''}" data-countdown="${esc(p.id)}">${t}</span>`;
}
function listHTML() {
  const ps = sortedPatients();
  return `<button type="button" class="btn huge primary" data-action="newPatient">＋ NEW PATIENT</button>
    <div class="list">${ps.length ? ps.map(cardHTML).join('') : `<p class="muted center pad">No patients yet.<br>Tap <b>NEW PATIENT</b> to start a record. Time and GPS location are captured automatically; fill in details later.</p>`}</div>
    <div class="row2"><a class="btn" href="#/map">🗺 Map</a><a class="btn" href="#/settings">⚙ Settings</a></div>
    <p class="muted center small">All data stays encrypted on this device. Works with no signal.</p>`;
}
function cardHTML(p) {
  const lv = M.latestVitals(p);
  const { alerts } = M.analyzeTrends(p.vitals);
  return `<a class="pcard" href="#/p/${encodeURIComponent(p.id)}/${lv ? 'vitals' : 'abcde'}">
    ${badge(p, true)}
    <div class="pc-main">
      <div class="pc-top"><strong>${esc(p.label)}</strong> <span>${esc(ageSex(p))}</span>${p.name ? ` · ${esc(p.name)}` : ''}</div>
      <div class="pc-prob">${esc(M.chiefProblem(p) || 'No problem recorded')}</div>
      <div class="pc-vit">${lv ? `Vitals ${M.fmtTime(lv.t)} (${M.ago(lv.t)})` : 'No vitals yet'} ${countdownHTML(p)}</div>
      ${alerts.length ? `<div class="pc-alert">▼ ${esc(alerts[0].text)}${alerts.length > 1 ? ` +${alerts.length - 1}` : ''}</div>` : ''}
    </div></a>`;
}

// ---------- patient view ----------
function stripHTML(p) {
  const ps = sortedPatients();
  if (ps.length < 2) return '';
  return ps.map((q) => `<a href="#/p/${encodeURIComponent(q.id)}/${S.route.tab || 'abcde'}" class="chip ${q.id === p.id ? 'on' : ''}">${badge(q)} ${esc(q.label.replace(/^P-\d{4}-/, 'P'))}</a>`).join('')
    + '<button type="button" class="chip" data-action="newPatient" aria-label="New patient">＋</button>';
}
function tabFlag(p, k) {
  if (k === 'abcde' && Object.entries(M.PRIMARY_BAD).some(([f, bad]) => bad.includes(p.primary?.[f]))) return '<i class="dot">!</i>';
  if (k === 'vitals') {
    if (countdownText(p) === 'RECHECK DUE' || M.analyzeTrends(p.vitals).alerts.length) return '<i class="dot">!</i>';
  }
  if (k === 'loc' && !p.location) return '<i class="dot">?</i>';
  return '';
}
function tabsHTML(p, tab) {
  return TABS.map(([k, l]) => `<a href="#/p/${encodeURIComponent(p.id)}/${k}" class="${k === tab ? 'on' : ''}" ${k === tab ? 'aria-current="page"' : ''}>${l}${tabFlag(p, k)}</a>`).join('');
}
function patientHTML(p, tab) {
  return `<div id="strip" class="strip">${stripHTML(p)}</div>
    <nav class="tabs" id="tabs">${tabsHTML(p, tab)}</nav>
    <div id="pbody">${tabHTML(p, tab)}</div>`;
}
function tabHTML(p, tab) {
  switch (tab) {
    case 'info': return infoHTML(p);
    case 'abcde': return abcdeHTML(p);
    case 'vitals': return vitalsHTML(p);
    case 'exam': return examHTML(p);
    case 'hx': return historyHTML(p);
    case 'plan': return planHTML(p);
    case 'loc': return locHTML(p);
    case 'handoff': return handoffHTML(p);
    default: return '';
  }
}
const nextTab = (p, k, label) => `<a class="btn wide next" href="#/p/${encodeURIComponent(p.id)}/${k}">${label} →</a>`;

function infoHTML(p) {
  return `<h2>Patient</h2>
    <div class="idline">ID <b>${esc(p.label)}</b> · created ${esc(M.fmtDateTime(p.created))}</div>
    ${text('name', 'Name (optional)', { ph: 'Name' })}
    <div class="numrow">${num('age', 'Age', { unit: 'yrs', hint: 'Estimate if unknown' })}${timeF('timeFound', 'Time found')}</div>
    ${seg('sex', 'Sex', ['M', 'F', 'X'])}
    <h2>Scene</h2>
    ${text('scene.moi', 'Mechanism of injury', { rows: 2, quick: ['Fall', 'Slip/trip', 'Struck by object', 'Rockfall', 'Avalanche', 'Immersion', 'Lightning', 'Animal', 'Illness / medical', 'Unknown'] })}
    ${text('scene.hazards', 'Hazards', { quick: ['None', 'Rockfall', 'Weather', 'Water', 'Steep terrain', 'Darkness', 'Cold', 'Heat', 'Wildlife'] })}
    ${num('scene.numPatients', 'Number of patients')}
    ${nextTab(p, 'abcde', 'Primary survey')}`;
}

function abcdeHTML(p) {
  const flags = M.PRIMARY.filter((q) => (M.PRIMARY_BAD[q.k] || []).includes(p.primary?.[q.k]));
  return `<h2>Primary survey</h2>
    ${flags.length ? `<div class="alertbox">⚠ ${flags.map((q) => `${esc(q.label.split(' — ')[1])}: ${esc(p.primary[q.k])}`).join(' · ')}</div>` : ''}
    ${M.PRIMARY.map((q) => `<div class="card pq">${seg(`primary.${q.k}`, q.label, q.opts, { bad: M.PRIMARY_BAD[q.k] })}
      ${q.note ? text(`primary.${q.k}Note`, '', { ph: 'Note (optional)' }) : ''}</div>`).join('')}
    ${nextTab(p, 'vitals', 'Vitals')}`;
}

// ----- vitals -----
const VITAL_NEXT = ['hr', 'rr', 'bpSys', 'bpDia', 'spo2', 'temp', 'bgl'];
function vitalsEditor(p, s, idx, flags) {
  const b = `vitals.#${s.id}`;
  const f = flags[s.id] || {};
  const nx = (k) => { const i = VITAL_NEXT.indexOf(k); return i >= 0 && i < VITAL_NEXT.length - 1 ? `${b}.${VITAL_NEXT[i + 1]}` : ''; };
  return `<div class="card vedit" id="vedit">
    <div class="vhead"><strong>Set ${idx} · ${M.fmtTime(s.t)}</strong>${timeF(`${b}.t`, '')}</div>
    ${seg(`${b}.lor`, 'LOR (level of responsiveness)', M.LOR.map((l) => ({ v: l.v, label: l.label })), { segCls: 'grid4', bad: ['AO0', 'V', 'P', 'U'] })}
    <div class="numrow">${num(`${b}.hr`, 'Heart rate', { unit: '/min', next: nx('hr'), flag: f.hr })}${num(`${b}.rr`, 'Resp rate', { unit: '/min', next: nx('rr'), flag: f.rr })}</div>
    ${multi(`${b}.hrQual`, 'Pulse', M.HR_QUAL)}
    ${multi(`${b}.rrQual`, 'Breathing', M.RR_QUAL)}
    <div class="numrow">${num(`${b}.bpSys`, 'BP systolic', { unit: 'mmHg', next: nx('bpSys'), flag: f.sbp })}${num(`${b}.bpDia`, 'BP diastolic', { unit: 'mmHg', next: nx('bpDia') })}</div>
    ${seg(`${b}.radial`, 'Radial pulse (no BP cuff)', M.RADIAL, { bad: ['absent'] })}
    ${seg(`${b}.skinColor`, 'Skin colour', M.SKIN_COLOR, { bad: ['pale', 'cyanotic', 'grey'] })}
    ${seg(`${b}.skinTemp`, 'Skin temperature', M.SKIN_TEMP, { bad: ['cool', 'cold', 'hot'] })}
    ${seg(`${b}.skinMoist`, 'Skin moisture', M.SKIN_MOIST, { bad: ['moist', 'wet'] })}
    ${seg(`${b}.pupils`, 'Pupils', M.PUPILS, { bad: M.PUPILS.slice(1) })}
    <div class="numrow three">${num(`${b}.spo2`, 'SpO₂', { unit: '%', next: nx('spo2'), flag: f.spo2 })}${num(`${b}.temp`, 'Temp', { conv: 'temp', next: nx('temp'), flag: f.temp })}${num(`${b}.bgl`, 'Glucose', { conv: 'bgl', flag: f.bgl })}</div>
    ${text(`${b}.notes`, 'Notes', { ph: 'Optional' })}
    <button type="button" class="btn small danger-outline" data-action="delSet" data-id="${esc(s.id)}">Delete this set</button>
  </div>`;
}

function trendTable(p, sorted, flags) {
  const u = units();
  const rows = [
    ['LOR', (s) => M.lorLabel(s.lor), ['lor']],
    ['HR', (s) => s.hr, ['hr']],
    ['RR', (s) => s.rr, ['rr']],
    ['BP', (s) => (s.bpSys !== '' ? `${s.bpSys}${s.bpDia !== '' ? '/' + s.bpDia : ''}` : ''), ['sbp']],
    ['Radial', (s) => s.radial, ['radial']],
    ['SpO₂', (s) => (s.spo2 !== '' ? s.spo2 + '%' : ''), ['spo2']],
    ['Skin', (s) => [s.skinColor, s.skinTemp, s.skinMoist].filter(Boolean).join(' / '), ['skinColor', 'skinTemp', 'skinMoist']],
    ['Pupils', (s) => s.pupils, ['pupils']],
    ['Temp', (s) => M.displayTemp(s.temp, u.temp), ['temp']],
    ['BGL', (s) => M.displayBgl(s.bgl, u.bgl).replace(' mg/dL', '').replace(' mmol/L', ''), ['bgl']],
  ];
  return `<div class="tablewrap"><table class="trend"><thead><tr><th>Time</th>${sorted.map((s) => `<th>${M.fmtTime(s.t)}</th>`).join('')}</tr></thead><tbody>
    ${rows.map(([lab, fn, keys]) => {
    const vals = sorted.map((s) => fn(s));
    if (vals.every((v) => v === '' || v == null)) return '';
    return `<tr><th>${lab}</th>${sorted.map((s, i) => {
      const f = flags[s.id] || {};
      const worse = keys.some((k) => f[k]?.worse);
      const abn = keys.some((k) => f[k]?.abnormal);
      const dir = keys.map((k) => f[k]?.dir).find((d) => d === 'up' || d === 'down');
      const arrow = worse ? (dir === 'up' ? '▲' : '▼') : '';
      return `<td class="${worse ? 'worse' : abn ? 'abn' : ''}">${esc(vals[i] ?? '')}${arrow ? ` ${arrow}` : ''}</td>`;
    }).join('')}</tr>`;
  }).join('')}</tbody></table></div>
  <p class="legend small"><span class="lg worse">▲▼</span> worsening vs previous &nbsp; <span class="lg abn">bold box</span> outside normal range</p>`;
}

function vitalsHTML(p) {
  const { alerts, flags, sorted } = M.analyzeTrends(p.vitals);
  const latest = sorted[sorted.length - 1];
  const editId = S.editingSet && p.vitals.some((v) => v.id === S.editingSet) ? S.editingSet : latest?.id;
  const editSet = p.vitals.find((v) => v.id === editId);
    const cd = countdownText(p);
  return `${alerts.length ? `<div class="alertbox" role="alert"><b>WORSENING</b><br>${alerts.map((a) => `▼ ${esc(a.text)} (${M.fmtTime(a.t)})`).join('<br>')}</div>` : ''}
    <button type="button" class="btn huge primary" data-action="newSet">＋ NEW VITALS SET</button>
    <div class="card recheck">
      ${seg('recheck.min', 'Recheck reminder (minutes)', [{ v: 'off', label: 'Off' }, '5', '10', '15', '30'])}
      ${cd ? `<div class="cdline">${countdownHTML(p)}${p.recheck.dueAt ? ` <span class="muted">(due ${M.fmtTime(p.recheck.dueAt)})</span>` : ''}</div>` : ''}
    </div>
    ${editSet ? vitalsEditor(p, editSet, sorted.indexOf(editSet) + 1, flags) : '<p class="muted center pad">No vitals yet. Tap NEW VITALS SET; each set is time-stamped automatically.</p>'}
    ${sorted.length ? `<h2>Trend</h2>
      ${seg('ui.trendView', '', [{ v: 'table', label: 'Table' }, { v: 'chart', label: 'Chart' }])}
      ${S.trendView === 'chart'
    ? `<div class="charts">${chartsFor(p.vitals, units()).join('') || '<p class="muted">Enter numeric vitals to chart.</p>'}</div>
         <p class="legend small">▲▼ filled triangle = worsening &nbsp; ■ square = outside normal range &nbsp; ● = in range &nbsp; dashed line = worsening change</p>`
    : trendTable(p, sorted, flags)}
      <h2>All sets</h2>
      <div class="sets">${[...sorted].reverse().map((s, i) => `<button type="button" class="setrow ${s.id === editId ? 'on' : ''}" data-action="editSet" data-id="${esc(s.id)}">
        <b>#${sorted.length - i} ${M.fmtTime(s.t)}</b> <span>${esc(M.vitalsSummary(s, units()) || '(empty)')}</span></button>`).join('')}</div>` : ''}`;
}

// ----- exam -----
const DCAP = ['Deformity', 'Contusion', 'Abrasion', 'Puncture', 'Burn', 'Tenderness', 'Laceration', 'Swelling', 'Pain on movement', 'CSM intact', 'CSM impaired'];
function examHTML(p) {
  return `<h2>Head-to-toe exam</h2>
    <button type="button" class="btn wide" data-action="examNAD">Mark all unchecked regions NAD</button>
    ${M.EXAM_REGIONS.map((r) => {
    const e = p.exam?.[r.k] || {};
    const show = e.status === 'finding' || e.note;
    return `<div class="card exam ${e.status === 'finding' ? 'finding' : ''}">
        ${seg(`exam.${r.k}.status`, r.label, [{ v: 'nad', label: 'NAD ✓' }, { v: 'finding', label: 'Finding ⚠' }])}
        ${show ? text(`exam.${r.k}.note`, '', { ph: 'Describe finding', rows: 2, quick: DCAP }) : ''}</div>`;
  }).join('')}
    <p class="muted small">NAD = no abnormality detected.</p>
    ${nextTab(p, 'hx', 'History')}`;
}

// ----- history -----
function historyHTML(p) {
  return `<h2>Chief complaint</h2>
    ${text('cc', '', { rows: 2, ph: 'In the patient’s words' })}
    <h2>OPQRST</h2>
    ${text('opqrst.o', 'Onset', { quick: ['Sudden', 'Gradual', 'At rest', 'With exertion'] })}
    ${text('opqrst.p', 'Provokes / palliates', { quick: ['Movement', 'Breathing', 'Pressure', 'Rest helps', 'Nothing helps'] })}
    ${text('opqrst.q', 'Quality', { quick: ['Sharp', 'Dull', 'Aching', 'Burning', 'Crushing', 'Throbbing', 'Cramping'] })}
    ${text('opqrst.r', 'Region / radiates', { quick: ['Localized', 'Radiates'] })}
    ${seg('opqrst.s', 'Severity (0–10)', ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'], { segCls: 'sev' })}
    ${text('opqrst.t', 'Time / duration', { quick: ['Constant', 'Comes and goes', 'Getting worse', 'Getting better'] })}
    <h2>SAMPLE</h2>
    ${text('sample.s', 'Symptoms', { quick: ['Nausea', 'Dizzy', 'Short of breath', 'Headache', 'Numbness', 'Cold', 'Thirsty'] })}
    ${text('sample.a', 'Allergies', { quick: ['NKDA', 'Penicillin', 'Bees/wasps', 'Nuts', 'Latex'] })}
    ${text('sample.m', 'Medications', { quick: ['None', 'Ibuprofen', 'Acetaminophen', 'Inhaler', 'Insulin', 'Epi auto-injector'] })}
    ${text('sample.p', 'Past history', { quick: ['None', 'Asthma', 'Diabetes', 'Heart', 'Seizures', 'Prior injury here'] })}
    ${text('sample.l', 'Last ins and outs', { quick: ['Ate', 'Drank', 'Urinated', 'BM', 'Normal', 'hours ago'] })}
    ${text('sample.e', 'Events leading up', { rows: 2 })}
    ${nextTab(p, 'plan', 'Problems & plan')}`;
}

// ----- plan -----
const PROBLEMS = ['Head injury', 'Possible spine injury', 'Fracture', 'Sprain/strain', 'Dislocation', 'Wound', 'Burn', 'Hypothermia', 'Heat illness', 'Shock', 'Anaphylaxis', 'Respiratory distress', 'Chest pain', 'Altitude illness', 'Dehydration'];
const PLANS = ['Monitor vitals', 'Splint', 'Clean & dress wound', 'Pressure dressing', 'Tourniquet', 'Insulate / warm', 'Cool', 'Spinal motion restriction', 'Epinephrine', 'Position of comfort', 'Food & fluids', 'Rest', 'Evacuate'];
function planHTML(p) {
  return `<h2>Problem list & plan</h2>
    ${p.problems.map((x, i) => `<div class="card prob">
      ${text(`problems.#${x.id}.problem`, `Problem ${i + 1}`, { ph: 'Problem', quick: x.problem ? [] : PROBLEMS })}
      ${text(`problems.#${x.id}.plan`, 'Plan / treatment', { rows: 2, ph: 'Treatment', quick: PLANS })}
      ${p.problems.length > 1 ? `<button type="button" class="btn small danger-outline" data-action="delProblem" data-id="${esc(x.id)}">Remove problem</button>` : ''}</div>`).join('')}
    <button type="button" class="btn wide" data-action="addProblem">＋ Add problem</button>
    <h2>Evacuation</h2>
    ${seg('evac.urgency', 'Urgency', M.URGENCY.map((u) => ({ v: u.v, label: u.label })), { segCls: 'urg' })}
    ${seg('evac.mode', 'Evacuation', M.EVAC_MODE)}
    ${text('evac.notes', 'Evac notes', { ph: 'e.g. LZ, team size, timing' })}
    ${nextTab(p, 'handoff', 'Handoff')}`;
}

// ----- location -----
function locInfoHTML(p) {
  const L0 = p.location;
  if (!L0 || !Number.isFinite(L0.lat)) {
    const msg = p.gpsStatus === 'pending' ? '⌛ Acquiring GPS…' : '⚠ No GPS fix. Drag the map and tap “Pin at map centre”, enter coordinates, or describe the location below.';
    return `<div class="coords none">${msg}</div>`;
  }
  const u = toUTM(L0.lat, L0.lon);
  const src = L0.source === 'gps' ? `GPS ±${Math.round(L0.acc || 0)} m` : L0.source === 'dragged' ? 'Adjusted on map' : 'Manual entry';
  return `<div class="coords">
    <div><span class="k">UTM</span> <b class="mono">${esc(formatUTM(L0.lat, L0.lon))}</b>${u ? ` <span class="muted small">zone ${u.zone}${u.band}</span>` : ''}</div>
    <div><span class="k">Lat/Long</span> <b class="mono">${esc(formatLatLon(L0.lat, L0.lon))}</b></div>
    <div><span class="k">DMS</span> <span class="mono">${esc(formatDMS(L0.lat, L0.lon))}</span></div>
    <div><span class="k">Source</span> ${esc(src)} · ${esc(M.fmtTime(L0.t))}</div></div>`;
}
function locHTML(p) {
  return `<div id="locmap" class="locmap"></div>
    <div id="locinfo">${locInfoHTML(p)}</div>
    <div class="row2"><button type="button" class="btn" data-action="retryGps">📍 Use GPS now</button><button type="button" class="btn" data-action="enterCoords">⌨ Enter coords</button></div>
    <button type="button" class="btn wide" data-action="pinCentre">⊕ Pin at map centre</button>
    ${text('locationNote', 'Location note / estimate', { rows: 2, ph: 'e.g. approx. 200 m north of trail junction', quick: ['approx.', '200 m', 'north of', 'south of', 'east of', 'west of', 'trail junction', 'on trail', 'off trail', 'near creek', 'below ridge', 'campsite'] })}
    <p class="muted small">Drag the pin to correct the position. Download map tiles before your trip on the Map screen.</p>`;
}

function defaultCenter(except) {
  if (S.lastFix) return [S.lastFix.lat, S.lastFix.lon];
  const withLoc = [...S.patients.values()].filter((q) => q !== except && q.location && Number.isFinite(q.location.lat));
  if (withLoc.length) return [withLoc[0].location.lat, withLoc[0].location.lon];
  return null;
}

function initLocMap() {
  const p = cur();
  const el = $('#locmap');
  if (!el || !p) return;
  if (typeof L === 'undefined') { el.innerHTML = '<p class="pad">Map library failed to load.</p>'; return; }
  const has = p.location && Number.isFinite(p.location.lat);
  const center = has ? [p.location.lat, p.location.lon] : defaultCenter(p);
  const map = MAP.createMap(el, { settings: S.settings, center, zoom: has ? 15 : center ? 13 : 3 });
  const entry = { map, marker: null, others: [] };
  S.maps.loc = entry;
  for (const q of S.patients.values()) {
    if (q.id === p.id || !q.location || !Number.isFinite(q.location.lat)) continue;
    entry.others.push(L.marker([q.location.lat, q.location.lon], { icon: MAP.patientIcon(q), opacity: 0.6, interactive: false }).addTo(map));
  }
  placeLocMarker();
}
function placeLocMarker() {
  const p = cur();
  const entry = S.maps.loc;
  if (!entry || !p) return;
  const has = p.location && Number.isFinite(p.location.lat);
  if (!has) { if (entry.marker) { entry.marker.remove(); entry.marker = null; } return; }
  const ll = [p.location.lat, p.location.lon];
  if (!entry.marker) {
    entry.marker = L.marker(ll, { icon: MAP.patientIcon(p, { selected: true }), draggable: true, autoPan: true }).addTo(entry.map);
    entry.marker.on('dragend', () => {
      const q = cur();
      const pos = entry.marker.getLatLng();
      q.location = { lat: pos.lat, lon: pos.lng, acc: null, source: 'dragged', t: Date.now() };
      touch(q);
      updateLocPanel(false);
    });
  } else {
    entry.marker.setLatLng(ll);
    entry.marker.setIcon(MAP.patientIcon(p, { selected: true }));
  }
}
function updateLocPanel(recentre = true) {
  const p = cur();
  const el = $('#locinfo');
  if (el && p) el.innerHTML = locInfoHTML(p);
  placeLocMarker();
  if (recentre && S.maps.loc && p.location && Number.isFinite(p.location.lat)) S.maps.loc.map.setView([p.location.lat, p.location.lon], Math.max(S.maps.loc.map.getZoom(), 14));
  const t = $('#tabs');
  if (t && p) t.innerHTML = tabsHTML(p, S.route.tab);
}

function acquireGPS(p, { force = false } = {}) {
  if (!navigator.geolocation) {
    p.gpsStatus = 'unavailable';
    touch(p);
    return;
  }
  p.gpsStatus = 'pending';
  const id = p.id;
  navigator.geolocation.getCurrentPosition((pos) => {
    const q = S.patients.get(id);
    S.lastFix = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, t: Date.now() };
    if (!q) return;
    q.gpsStatus = 'ok';
    // don't silently overwrite a manual / dragged position unless the user asked for GPS
    if (force || !q.location || q.location.source === 'gps') {
      q.location = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, source: 'gps', t: Date.now() };
    }
    touch(q);
    afterLocation(q);
  }, (err) => {
    const q = S.patients.get(id);
    if (!q) return;
    q.gpsStatus = 'unavailable';
    touch(q);
    toast(`${q.label}: no GPS fix (${err.message || 'unavailable'}). Add an estimate.`, { ms: 7000, action: 'Location', onAction: () => { location.hash = `#/p/${encodeURIComponent(q.id)}/loc`; } });
    afterLocation(q);
  }, { enableHighAccuracy: !S.settings.battery, timeout: S.settings.battery ? 20000 : 45000, maximumAge: S.settings.battery ? 600000 : 15000 });
}
function afterLocation(q) {
  if (S.route.name === 'patient' && S.route.id === q.id && S.route.tab === 'loc') updateLocPanel();
  if (S.route.name === 'map') refreshAllMap();
}

function coordsSheet() {
  const p = cur();
  const L0 = p.location && Number.isFinite(p.location.lat) ? p.location : null;
  const u = L0 ? toUTM(L0.lat, L0.lon) : null;
  const s = openSheet(`<h2>Enter coordinates</h2>
    <div class="seg" id="cmode"><button type="button" class="on" data-m="ll">Lat / Long</button><button type="button" data-m="utm">UTM</button></div>
    <div id="c-ll"><label class="flabel">Latitude (decimal, − for S)</label><input id="c-lat" inputmode="decimal" value="${L0 ? L0.lat.toFixed(6) : ''}">
      <label class="flabel">Longitude (decimal, − for W)</label><input id="c-lon" inputmode="decimal" value="${L0 ? L0.lon.toFixed(6) : ''}"></div>
    <div id="c-utm" hidden><div class="numrow"><div><label class="flabel">Zone</label><input id="c-z" inputmode="numeric" value="${u ? u.zone : ''}"></div>
      <div><label class="flabel">Band / N or S</label><input id="c-b" value="${u ? u.band : ''}" maxlength="1" autocapitalize="characters"></div></div>
      <label class="flabel">Easting (m)</label><input id="c-e" inputmode="numeric" value="${u ? Math.round(u.easting) : ''}">
      <label class="flabel">Northing (m)</label><input id="c-n" inputmode="numeric" value="${u ? Math.round(u.northing) : ''}"></div>
    <div id="c-err" class="err"></div>
    <div class="row2"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="c-save">Save</button></div>`);
  let mode = 'll';
  s.el.querySelectorAll('#cmode button').forEach((b) => b.addEventListener('click', () => {
    mode = b.dataset.m;
    s.el.querySelectorAll('#cmode button').forEach((x) => x.classList.toggle('on', x === b));
    s.el.querySelector('#c-ll').hidden = mode !== 'll';
    s.el.querySelector('#c-utm').hidden = mode !== 'utm';
  }));
  s.el.querySelector('#c-save').onclick = () => {
    let ll;
    if (mode === 'll') {
      const lat = parseFloat(s.el.querySelector('#c-lat').value), lon = parseFloat(s.el.querySelector('#c-lon').value);
      if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) ll = { lat, lon };
    } else {
      ll = fromUTM(s.el.querySelector('#c-z').value, s.el.querySelector('#c-b').value || 'N', s.el.querySelector('#c-e').value, s.el.querySelector('#c-n').value);
    }
    if (!ll || !Number.isFinite(ll.lat)) { s.el.querySelector('#c-err').textContent = 'Check the coordinates.'; return; }
    p.location = { lat: ll.lat, lon: ll.lon, acc: null, source: 'manual', t: Date.now() };
    touch(p);
    s.close();
    updateLocPanel();
  };
}

// ----- handoff -----
function handoffText(p) {
  const st = S.settings;
  switch (S.handoffView) {
    case 'sat': return isbarShort(p, st);
    case 'soap': return soapNote(p, st);
    case 'full': return fullRecord(p, st);
    default: return isbar(p, st);
  }
}
function handoffHTML(p) {
  const t = handoffText(p);
  return `<h2>Handoff</h2>
    ${seg('ui.handoffView', '', [{ v: 'isbar', label: 'ISBAR radio' }, { v: 'sat', label: 'Sat msg' }, { v: 'soap', label: 'SOAP' }, { v: 'full', label: 'Full record' }], { segCls: 'grid4' })}
    <pre class="handoff" id="handoff-text">${esc(t)}</pre>
    ${S.handoffView === 'sat' ? `<p class="small muted">${t.length}/160 characters (fits a satellite messenger).</p>` : ''}
    <div class="row2"><button type="button" class="btn" data-action="copy">Copy</button><button type="button" class="btn" data-action="share">Share…</button></div>
    <div class="row2"><button type="button" class="btn" data-action="download">Save .txt</button><button type="button" class="btn" data-action="print">PDF / Print</button></div>
    <div class="card">
      <div><b>Status:</b> ${S.settings.syncUrl ? (p.syncedVersion >= p.updated ? `Synced ${esc(M.fmtTime(p.syncedAt))}` : 'Saved on device — will sync when online') : 'Saved on device (cloud sync off)'}</div>
      ${S.settings.syncUrl ? '<button type="button" class="btn wide" data-action="syncNow">Sync now</button>' : ''}
    </div>
    <button type="button" class="btn wide danger-outline" data-action="delPatient">Delete this patient…</button>`;
}

// ---------- all-patient map ----------
function mapViewHTML() {
  return `<div class="maptools"><button type="button" class="btn" data-action="locateMe">📍 Me</button><button type="button" class="btn" data-action="fitAll">All pts</button><button type="button" class="btn" data-action="dlTiles">⬇ Offline</button></div>
    <div id="allmap" class="fullmap"></div>
    <div class="legend-row"><span class="pin u-immediate mini"><b>IMM</b></span> immediate <span class="pin u-urgent mini"><b>URG</b></span> urgent <span class="pin u-nonurgent mini"><b>NON</b></span> non-urgent <span class="pin u-none mini"><b>—</b></span> not set</div>
    <p class="small muted" id="tileinfo"></p>`;
}
function initAllMap() {
  const el = $('#allmap');
  if (!el) return;
  if (typeof L === 'undefined') { el.innerHTML = '<p class="pad">Map library failed to load.</p>'; return; }
  const map = MAP.createMap(el, { settings: S.settings, center: defaultCenter(), zoom: defaultCenter() ? 13 : 3 });
  S.maps.all = { map, layer: L.layerGroup().addTo(map), me: null };
  refreshAllMap(true);
  MAP.cachedTileCount().then((n) => { const ti = $('#tileinfo'); if (ti) ti.textContent = `${n} map tiles saved for offline use · ${MAP.tileSource(S.settings).name}`; });
}
function refreshAllMap(fit = false) {
  const e = S.maps.all;
  if (!e) return;
  e.layer.clearLayers();
  const pts = [];
  for (const p of S.patients.values()) {
    if (!p.location || !Number.isFinite(p.location.lat)) continue;
    pts.push([p.location.lat, p.location.lon]);
    L.marker([p.location.lat, p.location.lon], { icon: MAP.patientIcon(p) }).bindPopup(MAP.popupHtml(p)).addTo(e.layer);
  }
  if (fit && pts.length) e.map.fitBounds(pts, { padding: [60, 60], maxZoom: 15 });
}

function tilesSheet() {
  const e = S.maps.all;
  if (!e) return;
  const b = e.map.getBounds();
  const bounds = { north: b.getNorth(), south: b.getSouth(), east: b.getEast(), west: b.getWest() };
  const src = MAP.tileSource(S.settings);
  const z0 = Math.max(1, Math.floor(e.map.getZoom()) - 1);
  const options = [2, 3, 4, 5].map((d) => Math.min(src.maxZoom, z0 + d)).filter((v, i, a) => a.indexOf(v) === i);
  const s = openSheet(`<h2>Download map for offline</h2>
    <p>Saves the area currently on screen (${MAP.countTiles(bounds, z0, z0)} tiles at zoom ${z0}) so it works without signal.</p>
    <div class="flabel">Detail up to zoom</div>
    <div class="seg" id="zsel">${options.map((z, i) => {
    const n = MAP.countTiles(bounds, z0, z);
    return `<button type="button" data-z="${z}" class="${i === 1 || options.length === 1 ? 'on' : ''}" ${n > MAP.MAX_DOWNLOAD_TILES ? 'disabled' : ''}>z${z}<br><small>${n} tiles${n > MAP.MAX_DOWNLOAD_TILES ? ' (too many)' : ''}</small></button>`;
  }).join('')}</div>
    <p class="small muted">Source: ${esc(src.name)}. Public tile servers allow only light use — download just your trip area, or set your own tile provider in Settings. Zoom in for a smaller area if the count is too high.</p>
    <div id="dlprog" class="prog" hidden><div></div></div><div id="dltxt" class="small"></div>
    <div class="row2"><button type="button" class="btn" data-close id="dlcancel">Close</button><button type="button" class="btn primary" id="dlgo">Download</button></div>
    <button type="button" class="btn wide danger-outline" id="dlclear">Delete saved tiles</button>`);
  let zmax = +(s.el.querySelector('#zsel .on') || s.el.querySelector('#zsel button')).dataset.z;
  s.el.querySelectorAll('#zsel button').forEach((btn) => btn.addEventListener('click', () => {
    if (btn.disabled) return;
    zmax = +btn.dataset.z;
    s.el.querySelectorAll('#zsel button').forEach((x) => x.classList.toggle('on', x === btn));
  }));
  let ctrl = null;
  s.el.querySelector('#dlcancel').addEventListener('click', () => ctrl && ctrl.abort());
  s.el.querySelector('#dlclear').onclick = async () => { await MAP.clearTiles(); s.el.querySelector('#dltxt').textContent = 'Saved tiles deleted.'; };
  s.el.querySelector('#dlgo').onclick = async () => {
    if (!navigator.onLine) { s.el.querySelector('#dltxt').textContent = 'No connection — connect to download.'; return; }
    const urls = MAP.tileList(bounds, z0, zmax, src.url);
    if (urls.length > MAP.MAX_DOWNLOAD_TILES) return;
    ctrl = new AbortController();
    const bar = s.el.querySelector('#dlprog');
    bar.hidden = false;
    s.el.querySelector('#dlgo').disabled = true;
    const r = await MAP.downloadTiles(urls, {
      signal: ctrl.signal,
      onProgress: ({ done, total, failed }) => {
        bar.firstElementChild.style.width = `${(done / total) * 100}%`;
        s.el.querySelector('#dltxt').textContent = `${done} / ${total} tiles${failed ? ` (${failed} failed)` : ''}`;
      },
    });
    s.el.querySelector('#dltxt').textContent = `Done: ${r.done - r.failed} tiles available offline${r.failed ? `, ${r.failed} failed` : ''}.`;
    s.el.querySelector('#dlgo').disabled = false;
    MAP.cachedTileCount().then((n) => { const ti = $('#tileinfo'); if (ti) ti.textContent = `${n} map tiles saved for offline use · ${src.name}`; });
  };
}

// ---------- settings ----------
function settingsHTML() {
  const pinMode = S.pinMode;
  return `<h2>Display</h2>
    ${seg('settings.theme', 'Theme', [{ v: 'auto', label: 'Auto' }, { v: 'light', label: 'Day' }, { v: 'dark', label: 'Night' }])}
    ${seg('settings.textSize', 'Text size', [{ v: 'L', label: 'Large' }, { v: 'XL', label: 'Extra large' }])}
    ${seg('settings.battery', 'Battery saver (dim, low GPS use, fewer updates)', [{ v: false, label: 'Off' }, { v: true, label: 'On' }])}
    <h2>Units</h2>
    ${seg('settings.tempUnit', 'Temperature', [{ v: 'C', label: '°C' }, { v: 'F', label: '°F' }])}
    ${seg('settings.bglUnit', 'Blood glucose', [{ v: 'mg', label: 'mg/dL' }, { v: 'mmol', label: 'mmol/L' }])}
    <h2>Vitals</h2>
    ${seg('settings.recheckMin', 'Default recheck interval (min)', [5, 10, 15, 20, 30].map((n) => ({ v: n, label: String(n) })))}
    <h2>Responder</h2>
    ${text('settings.responder', 'Name / call sign (used in handoffs)', { ph: 'e.g. Team 2 — J. Doe' })}
    <h2>Security</h2>
    <p>Records are encrypted on this device (AES-256). PIN lock: <b>${pinMode ? 'ON' : 'OFF'}</b></p>
    <div class="row2"><button type="button" class="btn" data-action="setPin">${pinMode ? 'Change PIN' : 'Set PIN'}</button>
      ${pinMode ? '<button type="button" class="btn" data-action="lockNow">Lock now</button>' : ''}</div>
    ${pinMode ? `${seg('settings.autoLockMin', 'Auto-lock after app is hidden for (min)', [1, 5, 15, 60].map((n) => ({ v: n, label: String(n) })))}
      <button type="button" class="btn wide danger-outline" data-action="removePin">Remove PIN</button>` : ''}
    <h2>Maps</h2>
    ${seg('settings.tileSource', 'Map tiles', [{ v: 'osm', label: 'Street' }, { v: 'topo', label: 'Topo' }, { v: 'custom', label: 'Custom' }])}
    ${S.settings.tileSource === 'custom' ? text('settings.customTileUrl', 'Tile URL template', { ph: 'https://…/{z}/{x}/{y}.png' }) : ''}
    <p class="small muted">Download an area for offline use from the Map screen before your trip.</p>
    <h2>Voice</h2>
    ${seg('settings.lang', 'Speech language', ['en-US', 'en-GB', 'en-CA', 'en-AU'])}
    <p class="small muted">${voiceSupportText()}</p>
    <h2>Cloud sync (optional)</h2>
    ${text('settings.syncUrl', 'Sync endpoint URL', { ph: 'https://your-server.example/wfr' })}
    <p class="small muted">When set and online, each record is sent with HTTP PUT to &lt;URL&gt;/&lt;id&gt;.json. Leave blank to keep everything on this device only.</p>
    <h2>Storage</h2>
    <div id="storinfo" class="small">Checking…</div>
    <button type="button" class="btn wide" data-action="persist">Protect data from browser clean-up</button>
    <button type="button" class="btn wide danger-outline" data-action="wipe">Delete ALL patient data…</button>
    <p class="small muted center">WFR Field Log v${VERSION}. Documentation aid only — follow your training and protocols.</p>`;
}
function voiceSupportText() {
  const sup = recognizerSupport();
  if (!sup) return 'This browser has no built-in speech recognition. The mic button opens a text box — use your keyboard’s dictation key (works offline on most phones).';
  return sup.local ? 'On-device speech recognition is available (works offline once the language is downloaded).'
    : 'Speech recognition available, but this browser may need a connection for it. Keyboard dictation is the offline fallback.';
}
async function refreshStorageInfo() {
  const el = $('#storinfo');
  if (!el) return;
  const i = await store.storageInfo();
  const mb = (b) => (b == null ? '?' : (b / 1048576).toFixed(1) + ' MB');
  el.innerHTML = `${S.patients.size} patient record(s). Using ${mb(i.usage)} of ${mb(i.quota)}. Protected from clean-up: <b>${i.persisted ? 'YES' : 'NO'}</b>`;
}

// ---------- actions ----------
async function createPatient({ navigate = true } = {}) {
  const p = M.newPatient({ existing: [...S.patients.values()] });
  p.recheck.min = S.settings.recheckMin;
  S.patients.set(p.id, p);
  touch(p);
  acquireGPS(p);
  if (navigate) location.hash = `#/p/${encodeURIComponent(p.id)}/abcde`;
  return p;
}

function openNum(btn) {
  const path = btn.dataset.num;
  const conv = btn.dataset.conv;
  const raw = getVal(path);
  openKeypad({
    label: btn.dataset.label,
    value: numDisplay(raw, conv),
    unit: btn.dataset.unit,
    decimal: !!btn.dataset.dec,
    hint: btn.dataset.hint,
    onDone: (v) => {
      let out = v;
      if (v !== '' && conv === 'temp') out = String(Math.round((S.settings.tempUnit === 'F' ? M.fToC(+v) : +v) * 10) / 10);
      if (v !== '' && conv === 'bgl') out = String(Math.round(S.settings.bglUnit === 'mmol' ? M.mmolToMg(+v) : +v));
      if (out !== String(raw ?? '')) setVal(path, out);
    },
    onNext: btn.dataset.next ? () => {
      const nb = document.querySelector(`[data-num="${CSS.escape(btn.dataset.next)}"]`);
      if (nb) { nb.scrollIntoView({ block: 'center' }); openNum(nb); }
    } : null,
  });
}

function pinFlow() {
  openKeypad({
    label: 'New PIN (4–8 digits)', mask: true, maxLen: 8,
    onDone: (a) => {
      if (a.length < 4) { toast('PIN must be at least 4 digits'); return; }
      openKeypad({
        label: 'Repeat PIN', mask: true, maxLen: 8,
        onDone: async (b) => {
          if (a !== b) { toast('PINs did not match — not changed'); return; }
          await store.setPin(a);
          S.pinMode = true;
          toast('PIN set. App will lock when hidden.');
          rerender();
        },
      });
    },
  });
}

async function doLock() {
  flushText();
  try { await S.savePromise; } catch { /* ignore */ }
  store.lock();
  destroyMaps();
  S.patients.clear();
  view().innerHTML = '';
  showLock();
}

const actions = {
  newPatient: () => createPatient(),
  setNow: (el) => setVal(el.dataset.path, Date.now()),
  newSet: () => {
    const p = cur();
    const s = M.newVitals();
    p.vitals.push(s);
    S.editingSet = s.id;
    if (p.recheck.enabled !== false) {
      p.recheck.enabled = true;
      p.recheck.dueAt = s.t + Number(p.recheck.min || S.settings.recheckMin) * 60000;
    }
    touch(p);
    rerender();
    const ed = $('#vedit');
    ed && ed.scrollIntoView({ block: 'start' });
  },
  editSet: (el) => { S.editingSet = el.dataset.id; rerender(); const ed = $('#vedit'); ed && ed.scrollIntoView({ block: 'start' }); },
  delSet: async (el) => {
    if (!(await confirmSheet('Delete this vitals set?', { ok: 'Delete', danger: true }))) return;
    const p = cur();
    p.vitals = p.vitals.filter((v) => v.id !== el.dataset.id);
    S.editingSet = null;
    touch(p);
    rerender();
  },
  examNAD: () => {
    const p = cur();
    for (const r of M.EXAM_REGIONS) if (!p.exam[r.k].status && !p.exam[r.k].note) p.exam[r.k].status = 'nad';
    touch(p);
    rerender();
  },
  addProblem: () => { const p = cur(); p.problems.push({ id: M.uuid(), problem: '', plan: '' }); touch(p); rerender(); },
  delProblem: async (el) => {
    if (!(await confirmSheet('Remove this problem?', { ok: 'Remove', danger: true }))) return;
    const p = cur();
    p.problems = p.problems.filter((x) => x.id !== el.dataset.id);
    touch(p);
    rerender();
  },
  retryGps: () => { const p = cur(); toast('Getting GPS fix…'); acquireGPS(p, { force: true }); updateLocPanel(false); },
  enterCoords: () => coordsSheet(),
  pinCentre: () => {
    const p = cur();
    const m = S.maps.loc && S.maps.loc.map;
    if (!m) return;
    const c = m.getCenter();
    p.location = { lat: c.lat, lon: c.lng, acc: null, source: 'manual', t: Date.now() };
    touch(p);
    updateLocPanel(false);
  },
  copy: async () => {
    const t = handoffText(cur());
    try { await navigator.clipboard.writeText(t); toast('Copied'); } catch {
      const r = document.createRange(); r.selectNodeContents($('#handoff-text'));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      toast('Text selected — use Copy');
    }
  },
  share: async () => {
    const p = cur();
    const t = handoffText(p);
    if (navigator.share) { try { await navigator.share({ title: `${p.label} handoff`, text: t }); } catch { /* cancelled */ } }
    else toast('Sharing not supported here — use Copy or Save .txt');
  },
  download: () => {
    const p = cur();
    const body = `${fullRecord(p, S.settings)}\n\n${soapNote(p, S.settings)}\n\nISBAR\n${isbar(p, S.settings)}\n`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    a.download = `${p.label}.txt`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  print: () => {
    const p = cur();
    $('#print').innerHTML = `<h1>${esc(p.label)} — WFR patient record</h1><pre>${esc(fullRecord(p, S.settings))}</pre>
      <h1>SOAP</h1><pre>${esc(soapNote(p, S.settings))}</pre><h1>ISBAR</h1><pre>${esc(isbar(p, S.settings))}</pre>`;
    window.print();
  },
  syncNow: () => syncAll(true),
  delPatient: async () => {
    const p = cur();
    if (!(await confirmSheet(`Permanently delete ${p.label}? This cannot be undone.`, { ok: 'Delete', danger: true }))) return;
    await store.deletePatient(p.id);
    S.patients.delete(p.id);
    location.hash = '#/';
  },
  locateMe: () => {
    if (!navigator.geolocation) return toast('No GPS on this device');
    toast('Getting GPS fix…');
    navigator.geolocation.getCurrentPosition((pos) => {
      const e = S.maps.all;
      S.lastFix = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, t: Date.now() };
      if (!e) return;
      if (e.me) e.me.remove();
      e.me = MAP.locateMarker(S.lastFix.lat, S.lastFix.lon, S.lastFix.acc).addTo(e.map);
      e.map.setView([S.lastFix.lat, S.lastFix.lon], Math.max(e.map.getZoom(), 14));
      toast(`You: ${formatUTM(S.lastFix.lat, S.lastFix.lon)} (±${Math.round(S.lastFix.acc)} m)`, { ms: 8000 });
    }, (err) => toast(`No GPS fix: ${err.message}`), { enableHighAccuracy: !S.settings.battery, timeout: 30000, maximumAge: 15000 });
  },
  fitAll: () => refreshAllMap(true),
  dlTiles: () => tilesSheet(),
  setPin: () => pinFlow(),
  lockNow: () => doLock(),
  removePin: async () => {
    if (!(await confirmSheet('Remove PIN lock? Data stays encrypted but opens without a PIN.', { ok: 'Remove PIN', danger: true }))) return;
    await store.removePin();
    S.pinMode = false;
    rerender();
  },
  persist: async () => { const ok = await store.requestPersistence(); toast(ok ? 'Storage protected' : 'Browser declined — install the app to home screen and try again'); refreshStorageInfo(); },
  wipe: async () => {
    if (!(await confirmSheet('Delete ALL patient records on this device?', { ok: 'Delete all', danger: true }))) return;
    if (!(await confirmSheet('Are you sure? This cannot be undone.', { ok: 'Yes, delete everything', danger: true }))) return;
    await store.deleteAllPatients();
    S.patients.clear();
    toast('All patient data deleted');
    rerender();
  },
};

// ---------- event delegation ----------
document.addEventListener('click', (e) => {
  unlockAudio();
  const segB = e.target.closest('[data-seg] > button');
  if (segB) {
    const path = segB.parentElement.dataset.seg;
    let v = segB.dataset.val;
    const curV = getVal(path);
    if (path.startsWith('settings.')) {
      const d = DEFAULTS[path.slice(9)];
      if (typeof d === 'boolean') v = v === 'true';
      else if (typeof d === 'number') v = Number(v);
      setVal(path, v);
    } else if (path.startsWith('ui.')) {
      S[path.slice(3)] = v;
      rerender();
    } else {
      // tap a selected option again to clear it
      setVal(path, String(curV) === v && path !== 'recheck.min' ? '' : v);
    }
    return;
  }
  const mB = e.target.closest('[data-multi] > button');
  if (mB) {
    const path = mB.parentElement.dataset.multi;
    const arr = [...(getVal(path) || [])];
    const i = arr.indexOf(mB.dataset.val);
    if (i >= 0) arr.splice(i, 1); else arr.push(mB.dataset.val);
    setVal(path, arr);
    return;
  }
  const ap = e.target.closest('[data-append]');
  if (ap) {
    const path = ap.dataset.append;
    const prev = String(getVal(path) || '').trim();
    const add = ap.dataset.text;
    const v = prev ? `${prev}${/[,;.]$/.test(prev) ? '' : ','} ${add}` : add;
    const ta = document.querySelector(`textarea[data-path="${CSS.escape(path)}"]`);
    if (ta) { ta.value = v; autoGrow(ta); }
    setVal(path, v, { render: path.endsWith('.problem') && !prev });
    return;
  }
  const nb = e.target.closest('[data-num]');
  if (nb) { openNum(nb); return; }
  const act = e.target.closest('[data-action]');
  if (act && actions[act.dataset.action]) { e.preventDefault(); actions[act.dataset.action](act, e); }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (!t.dataset || !t.dataset.path) return;
  autoGrow(t);
  const path = t.dataset.path;
  if (path.startsWith('settings.')) { S.settings[path.slice(9)] = t.value.trim(); saveSettings(); return; }
  const p = cur();
  if (!p) return;
  pset(p, path, t.value);
  S.dirty = p;
  S.saveState = 'saving';
  renderStatus();
  clearTimeout(textTimer);
  textTimer = setTimeout(flushText, 400);
});
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset && t.dataset.path) {
    flushText();
    if (t.dataset.path.startsWith('settings.')) applySettings();
    if (t.dataset.path === 'settings.customTileUrl' || t.dataset.path === 'settings.syncUrl') rerender();
    return;
  }
  if (t.dataset && t.dataset.time) {
    const path = t.dataset.time;
    if (!t.value) return;
    const [hh, mm] = t.value.split(':').map(Number);
    const base = new Date(getVal(path) || Date.now());
    base.setHours(hh, mm, 0, 0);
    // a time more than 12 h in the future most likely belongs to yesterday
    if (base.getTime() - Date.now() > 12 * 3600000) base.setDate(base.getDate() - 1);
    setVal(path, base.getTime());
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.tagName === 'TEXTAREA' && e.target.rows === 1) { e.preventDefault(); e.target.blur(); }
});
function autoGrow(t) {
  if (t.tagName !== 'TEXTAREA') return;
  t.style.height = 'auto';
  t.style.height = `${t.scrollHeight + 4}px`;
}
function autoGrowAll() { $$('textarea[data-path]').forEach((t) => { if (t.value) autoGrow(t); }); }

window.addEventListener('hashchange', render);
window.addEventListener('online', () => { renderStatus(); syncAll(); });
window.addEventListener('offline', renderStatus);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { flushText(); S.hiddenAt = Date.now(); return; }
  if (S.pinMode && store.isUnlocked() && S.hiddenAt && Date.now() - S.hiddenAt >= S.settings.autoLockMin * 60000) doLock();
  else if (store.isUnlocked()) tick();
});
window.addEventListener('pagehide', flushText);

// ---------- recheck timer ----------
let ticker;
function startTicker() {
  clearInterval(ticker);
  ticker = setInterval(tick, S.settings.battery ? 15000 : 1000);
}
function tick() {
  if (!store.isUnlocked()) return;
  const now = Date.now();
  let changed = false;
  for (const p of S.patients.values()) {
    const due = p.recheck?.enabled && p.recheck.dueAt && now >= p.recheck.dueAt;
    const key = `${p.id}:${p.recheck?.dueAt}`;
    if (due && !S.alerted.has(key)) {
      S.alerted.add(key);
      changed = true;
      beep();
      toast(`⏰ ${p.label}: VITALS RECHECK DUE`, { ms: 20000, action: 'Take vitals', onAction: () => { location.hash = `#/p/${encodeURIComponent(p.id)}/vitals`; } });
      notify(`${p.label}: vitals recheck due`);
    }
  }
  $$('[data-countdown]').forEach((el) => {
    const p = S.patients.get(el.dataset.countdown);
    if (!p) return;
    const t = countdownText(p);
    el.textContent = t;
    el.classList.toggle('due', t === 'RECHECK DUE');
  });
  if (changed && !sheetOpen()) {
    if (S.route.name === 'list') rerender();
    else if (S.route.name === 'patient') { const p = cur(); $('#tabs').innerHTML = tabsHTML(p, S.route.tab); }
  }
}
async function notify(body) {
  try {
    if (!document.hidden || !('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) reg.showNotification('WFR Field Log', { body, tag: body, renotify: true });
  } catch { /* ignore */ }
}

// ---------- cloud sync (optional) ----------
let syncTimer;
function scheduleSync() {
  if (!S.settings.syncUrl) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncAll, 5000);
}
async function syncAll(manual = false) {
  const base = (S.settings.syncUrl || '').replace(/\/+$/, '');
  if (!base || !store.isUnlocked()) return;
  if (!navigator.onLine) { if (manual) toast('Offline — will sync when signal returns'); return; }
  let ok = 0, fail = 0;
  for (const p of S.patients.values()) {
    if (p.syncedVersion && p.syncedVersion >= p.updated) continue;
    const version = p.updated;
    try {
      const r = await fetch(`${base}/${encodeURIComponent(p.id)}.json`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
      if (!r.ok) throw new Error(r.status);
      p.syncedVersion = version;
      p.syncedAt = Date.now();
      S.savePromise = saver(p);
      ok++;
    } catch { fail++; }
  }
  if (manual) toast(fail ? `Sync: ${ok} sent, ${fail} failed` : `Synced ${ok} record(s)`);
  renderStatus();
  if (S.route.name === 'patient' && S.route.tab === 'handoff') rerender();
}

// ---------- voice ----------
let listening = null;
let pressStart = 0;
function setupMic() {
  const mic = $('#mic');
  const sup = recognizerSupport();
  mic.addEventListener('pointerdown', (e) => {
    unlockAudio();
    if (!sup) return;
    e.preventDefault();
    if (listening) { listening.stop(); return; } // second tap ends toggle mode
    pressStart = Date.now();
    try { mic.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    startVoice();
  });
  const release = () => { if (listening && sup && Date.now() - pressStart > 450) listening.stop(); };
  mic.addEventListener('pointerup', release);
  mic.addEventListener('pointercancel', release);
  mic.addEventListener('click', () => { if (!sup) voiceConfirm(''); });
  mic.addEventListener('contextmenu', (e) => e.preventDefault());
}
function startVoice() {
  const mic = $('#mic');
  mic.classList.add('live');
  const s = openSheet(`<h2>🎙 Listening…</h2><p class="muted">Hold the mic and speak, release to finish (or tap again).<br>e.g. “heart rate 100, resp 18, alert and oriented times three”</p>
    <div class="transcript" id="interim">…</div><div class="row2"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="vstop">Done</button></div>`,
  { onClose: () => { if (listening) { cancelled = true; listening.stop(); } } });
  let cancelled = false;
  s.el.querySelector('#vstop').onclick = () => listening && listening.stop();
  listening = startListening({
    lang: S.settings.lang,
    onInterim: (t) => { const el = $('#interim'); if (el) el.textContent = t; },
    onResult: (t) => {
      listening = null; mic.classList.remove('live');
      if (cancelled) return;
      s.close();
      voiceConfirm(t);
    },
    onError: (err) => {
      listening = null; mic.classList.remove('live');
      s.close();
      if (err === 'no-speech' || err === 'aborted') return;
      toast(`Speech unavailable (${err}). Type or use keyboard dictation instead.`, { ms: 6000 });
      voiceConfirm('');
    },
  });
  if (!listening) mic.classList.remove('live');
}

function voiceConfirm(transcript) {
  const p0 = cur();
  const s = openSheet(`<h2>Voice entry${p0 ? ` → ${esc(p0.label)}` : ' → new patient'}</h2>
    <label class="flabel">What was heard (edit if needed)</label>
    <textarea id="vtext" rows="3" placeholder="e.g. heart rate 100, resp 18, alert and oriented times three">${esc(transcript)}</textarea>
    <button type="button" class="btn wide" id="vparse">Read fields from text</button>
    <div id="vitems"></div>
    <div class="row2"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn primary" id="vsave" disabled>Save</button></div>`, { cls: 'tall' });
  let items = [];
  let target = 'new';
  const draw = () => {
    const p = cur();
    const lv = p && M.latestVitals(p);
    const hasVitals = items.some((i) => i.group === 'vitals');
    if (lv && Date.now() - lv.t < 10 * 60000 && target === 'new' && !draw.chosen) target = 'latest';
    s.el.querySelector('#vitems').innerHTML = !items.length
      ? (s.el.querySelector('#vtext').value.trim() ? '<p class="err">No fields recognised. Try “heart rate 100, BP 120 over 80”.</p>' : '')
      : `${hasVitals && lv ? `<div class="seg" id="vtarget"><button type="button" data-t="new" class="${target === 'new' ? 'on' : ''}">New vitals set</button><button type="button" data-t="latest" class="${target === 'latest' ? 'on' : ''}">Update set ${M.fmtTime(lv.t)}</button></div>` : ''}
        ${items.map((it, i) => `<div class="vitem ${it.on ? 'on' : ''}"><button type="button" class="vchk" data-i="${i}" aria-pressed="${it.on}">${it.on ? '✓' : ''}</button>
          <span class="vlab">${esc(it.label)}</span><input data-vi="${i}" value="${esc(it.edit)}"><span class="vunit">${esc(it.unit || '')}</span></div>`).join('')}`;
    s.el.querySelector('#vsave').disabled = !items.some((i) => i.on);
    s.el.querySelector('#vsave').textContent = `Save ${items.filter((i) => i.on).length} field(s)`;
    s.el.querySelectorAll('.vchk').forEach((b) => b.addEventListener('click', () => { items[+b.dataset.i].on = !items[+b.dataset.i].on; draw(); }));
    s.el.querySelectorAll('[data-vi]').forEach((inp) => inp.addEventListener('input', () => { items[+inp.dataset.vi].edit = inp.value; }));
    s.el.querySelectorAll('#vtarget button').forEach((b) => b.addEventListener('click', () => { target = b.dataset.t; draw.chosen = true; draw(); }));
  };
  const parse = () => {
    items = parseSpeech(s.el.querySelector('#vtext').value).map((it) => {
      let edit = it.value, unit = '';
      if (it.key === 'temp') { unit = S.settings.tempUnit === 'F' ? '°F' : '°C'; edit = numDisplay(it.value, 'temp'); }
      else if (it.key === 'bgl') { unit = S.settings.bglUnit === 'mmol' ? 'mmol/L' : 'mg/dL'; edit = numDisplay(it.value, 'bgl'); }
      else if (it.key === 'hr' || it.key === 'rr') unit = '/min';
      else if (it.key === 'spo2') unit = '%';
      return { ...it, edit, unit, on: true };
    });
    draw();
  };
  s.el.querySelector('#vparse').onclick = parse;
  s.el.querySelector('#vsave').onclick = async () => {
    let p = cur();
    if (!p) p = await createPatient({ navigate: false });
    const chosen = items.filter((i) => i.on);
    let set = null;
    if (chosen.some((i) => i.group === 'vitals')) {
      const lv = M.latestVitals(p);
      if (target === 'latest' && lv) set = lv;
      else {
        set = M.newVitals();
        p.vitals.push(set);
        if (p.recheck.enabled !== false) { p.recheck.enabled = true; p.recheck.dueAt = set.t + Number(p.recheck.min || S.settings.recheckMin) * 60000; }
      }
    }
    for (const it of chosen) {
      const v = String(it.edit).trim();
      if (it.group === 'vitals') {
        if (it.key === 'bp') { const [a, b] = v.split('/'); set.bpSys = (a || '').trim(); set.bpDia = (b || '').trim(); }
        else if (it.key === 'temp') set.temp = v === '' ? '' : String(Math.round((S.settings.tempUnit === 'F' ? M.fToC(+v) : +v) * 10) / 10);
        else if (it.key === 'bgl') set.bgl = v === '' ? '' : String(Math.round(S.settings.bglUnit === 'mmol' ? M.mmolToMg(+v) : +v));
        else set[it.key] = v;
      } else pset(p, it.path, v);
    }
    touch(p);
    s.close();
    toast(`Saved ${chosen.length} field(s) to ${p.label}`);
    if (set) S.editingSet = set.id;
    if (S.route.name === 'patient' && S.route.id === p.id) rerender();
    else location.hash = `#/p/${encodeURIComponent(p.id)}/${set ? 'vitals' : 'abcde'}`;
  };
  if (transcript) parse();
  else setTimeout(() => s.el.querySelector('#vtext').focus(), 50);
}

// ---------- lock screen ----------
let failed = 0, lockedUntil = 0;
function showLock() {
  const el = $('#lock');
  el.hidden = false;
  document.body.classList.add('locked');
  let v = '';
  el.innerHTML = `<div class="lockbox"><h1>WFR Field Log</h1><p>Enter PIN</p><div class="kp-display"><span class="kp-val" id="lockval">—</span></div>
    <div class="err" id="lockerr"></div>
    <div class="kp-grid">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k) => (k ? `<button type="button" class="kp-key" data-k="${k}">${k}</button>` : '<span></span>')).join('')}</div>
    <button type="button" class="btn huge primary" id="lockgo">Unlock</button></div>`;
  const show = () => { $('#lockval').textContent = v ? '•'.repeat(v.length) : '—'; };
  el.querySelectorAll('.kp-key').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.k === '⌫') v = v.slice(0, -1); else if (v.length < 8) v += b.dataset.k;
    show();
  }));
  const go = async () => {
    if (Date.now() < lockedUntil) { $('#lockerr').textContent = `Too many attempts. Wait ${Math.ceil((lockedUntil - Date.now()) / 1000)} s.`; return; }
    $('#lockerr').textContent = 'Checking…';
    if (await store.unlock(v)) {
      failed = 0;
      el.hidden = true;
      el.innerHTML = '';
      document.body.classList.remove('locked');
      await afterUnlock();
    } else {
      failed++;
      v = ''; show();
      if (failed >= 5) lockedUntil = Date.now() + 30000 * (failed - 4);
      $('#lockerr').textContent = `Wrong PIN (${failed})`;
    }
  };
  $('#lockgo').onclick = go;
  el.onkeydown = (e) => { if (/^\d$/.test(e.key) && v.length < 8) { v += e.key; show(); } else if (e.key === 'Backspace') { v = v.slice(0, -1); show(); } else if (e.key === 'Enter') go(); };
  el.tabIndex = -1;
  el.focus();
}

async function afterUnlock() {
  const list = await store.getAllPatients();
  S.patients.clear();
  for (const raw of list) { const p = M.migrate(raw); S.patients.set(p.id, p); }
  S.routeKey = '';
  render();
  tick();
  syncAll();
}

// ---------- boot ----------
async function boot() {
  await loadSettings();
  applySettings();
  setupMic();
  if (!window.crypto || !crypto.subtle) {
    view().innerHTML = '<p class="pad err">This browser cannot encrypt data (needs HTTPS). Open the app from its https:// address.</p>';
    return;
  }
  S.pinMode = await store.needsPin();
  if (S.pinMode) showLock();
  else { await store.unlock(); await afterUnlock(); }
  store.requestPersistence();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then((reg) => {
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w && w.addEventListener('statechange', () => {
          if (w.state === 'activated' && !navigator.serviceWorker.controller) toast('✓ Ready to work offline');
        });
      });
    }).catch((e) => console.warn('SW registration failed', e));
  }
  if ('Notification' in window && Notification.permission === 'default') {
    // ask once, on first user interaction, so recheck reminders can alert while the screen is off
    document.addEventListener('pointerdown', () => { Notification.requestPermission().catch(() => {}); }, { once: true });
  }
}

boot();

// exposed for debugging / tests
window.__wfr = { S, store, voiceConfirm };
