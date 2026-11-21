// Standardized WFR patient record: schema, option lists, vitals trend logic.
// Pure module (no DOM) so it can be unit-tested in Node.

export const SCHEMA_VERSION = 1;

// Level of responsiveness, best -> worst. rank is used for trending.
export const LOR = [
  { v: 'AO4', label: 'A+O×4', rank: 8, long: 'Alert, oriented ×4 (person, place, time, event)' },
  { v: 'AO3', label: 'A+O×3', rank: 7, long: 'Alert, oriented ×3' },
  { v: 'AO2', label: 'A+O×2', rank: 6, long: 'Alert, oriented ×2' },
  { v: 'AO1', label: 'A+O×1', rank: 5, long: 'Alert, oriented ×1' },
  { v: 'AO0', label: 'A+O×0', rank: 4, long: 'Alert, disoriented' },
  { v: 'V', label: 'V', rank: 3, long: 'Responds to verbal stimulus' },
  { v: 'P', label: 'P', rank: 2, long: 'Responds to painful stimulus' },
  { v: 'U', label: 'U', rank: 1, long: 'Unresponsive' },
];
export const lorRank = (v) => (LOR.find((l) => l.v === v) || {}).rank ?? null;
export const lorLabel = (v) => (LOR.find((l) => l.v === v) || {}).label ?? '';

export const AVPU = [
  { v: 'A', label: 'A' }, { v: 'V', label: 'V' }, { v: 'P', label: 'P' }, { v: 'U', label: 'U' },
];

export const SKIN_COLOR = ['pink', 'pale', 'flushed', 'cyanotic', 'grey', 'jaundiced'];
export const SKIN_TEMP = ['warm', 'cool', 'cold', 'hot'];
export const SKIN_MOIST = ['dry', 'moist', 'wet'];
export const PUPILS = ['PERRL', 'unequal', 'dilated', 'constricted', 'sluggish', 'non-reactive'];
export const RADIAL = ['present', 'absent'];
export const HR_QUAL = ['strong', 'weak', 'regular', 'irregular'];
export const RR_QUAL = ['easy', 'labored', 'shallow', 'noisy'];

export const URGENCY = [
  { v: 'immediate', label: 'IMMEDIATE', short: 'IMM', rank: 3 },
  { v: 'urgent', label: 'URGENT', short: 'URG', rank: 2 },
  { v: 'nonurgent', label: 'NON-URGENT', short: 'NON', rank: 1 },
];
export const urgencyInfo = (v) => URGENCY.find((u) => u.v === v) || { v: '', label: 'NOT SET', short: '—', rank: 0 };

export const EVAC_MODE = [
  { v: 'none', label: 'None' },
  { v: 'walk', label: 'Walk out' },
  { v: 'carry', label: 'Carry out' },
  { v: 'helicopter', label: 'Helicopter' },
];

export const EXAM_REGIONS = [
  { k: 'head', label: 'Head / scalp' },
  { k: 'face', label: 'Face / eyes / ears / nose / mouth' },
  { k: 'neck', label: 'Neck / C-spine' },
  { k: 'chest', label: 'Chest' },
  { k: 'abdomen', label: 'Abdomen' },
  { k: 'pelvis', label: 'Pelvis' },
  { k: 'back', label: 'Back / spine' },
  { k: 'rarm', label: 'Right arm' },
  { k: 'larm', label: 'Left arm' },
  { k: 'rleg', label: 'Right leg' },
  { k: 'lleg', label: 'Left leg' },
  { k: 'csm', label: 'CSM (circulation, sensation, motion)' },
];

export const PRIMARY = [
  { k: 'airway', label: 'A — Airway', opts: ['open', 'compromised', 'managed'], note: true },
  { k: 'breathing', label: 'B — Breathing', opts: ['adequate', 'inadequate', 'absent'], note: true },
  { k: 'circulation', label: 'C — Circulation (pulse)', opts: ['present', 'weak', 'absent'], note: true },
  { k: 'bleeding', label: 'C — Severe bleeding', opts: ['none', 'controlled', 'UNCONTROLLED'], note: true },
  { k: 'avpu', label: 'D — Disability (AVPU)', opts: ['A', 'V', 'P', 'U'] },
  { k: 'spine', label: 'D — Spine concern', opts: ['no', 'YES'], note: true },
  { k: 'environment', label: 'E — Environment', opts: ['ok', 'cold', 'hot', 'wet', 'exposed'], note: true },
];

// Which primary-survey answers count as a problem (shown flagged).
export const PRIMARY_BAD = {
  airway: ['compromised'], breathing: ['inadequate', 'absent'], circulation: ['weak', 'absent'],
  bleeding: ['UNCONTROLLED'], avpu: ['V', 'P', 'U'], spine: ['YES'], environment: ['cold', 'hot', 'wet', 'exposed'],
};

export const VITAL_FIELDS = [
  { k: 'lor', label: 'LOR', fmt: (v) => lorLabel(v) },
  { k: 'hr', label: 'HR', unit: '/min' },
  { k: 'rr', label: 'RR', unit: '/min' },
  { k: 'bp', label: 'BP' },
  { k: 'radial', label: 'Radial' },
  { k: 'spo2', label: 'SpO₂', unit: '%' },
  { k: 'skin', label: 'Skin' },
  { k: 'pupils', label: 'Pupils' },
  { k: 'temp', label: 'Temp' },
  { k: 'bgl', label: 'BGL' },
];

function pad(n) { return String(n).padStart(2, '0'); }

export function uuid() {
  if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// Short radio-friendly label, e.g. "P-1121-03". seq is 1-based per day.
export function patientLabel(date, seq) {
  const d = new Date(date);
  return `P-${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(seq)}`;
}

export function nextSeq(existing, date) {
  const prefix = patientLabel(date, 0).slice(0, 7); // "P-MMDD-"
  let max = 0;
  for (const p of existing) {
    if (p.label && p.label.startsWith(prefix)) max = Math.max(max, parseInt(p.label.slice(7), 10) || 0);
  }
  return max + 1;
}

export function newPatient({ now = Date.now(), existing = [] } = {}) {
  const exam = {};
  for (const r of EXAM_REGIONS) exam[r.k] = { status: '', note: '' };
  const primary = {};
  for (const p of PRIMARY) { primary[p.k] = ''; if (p.note) primary[p.k + 'Note'] = ''; }
  return {
    v: SCHEMA_VERSION,
    id: uuid(),
    label: patientLabel(now, nextSeq(existing, now)),
    created: now,
    updated: now,
    name: '', age: '', sex: '',
    timeFound: now,
    scene: { moi: '', hazards: '', numPatients: String(Math.max(1, existing.length + 1)) },
    primary,
    cc: '',
    opqrst: { o: '', p: '', q: '', r: '', s: '', t: '' },
    exam,
    sample: { s: '', a: '', m: '', p: '', l: '', e: '' },
    problems: [{ id: uuid(), problem: '', plan: '' }],
    evac: { mode: '', urgency: '', notes: '' },
    vitals: [],
    recheck: { enabled: true, dueAt: null },
    location: null, // {lat, lon, acc, source: 'gps'|'manual'|'dragged', t, note}
    locationNote: '',
    gpsStatus: 'pending',
    synced: null,
  };
}

export function newVitals(now = Date.now()) {
  return {
    id: uuid(), t: now,
    lor: '', hr: '', hrQual: [], rr: '', rrQual: [],
    skinColor: '', skinTemp: '', skinMoist: '',
    bpSys: '', bpDia: '', radial: '',
    pupils: '', temp: '', spo2: '', bgl: '', notes: '',
  };
}

// ---- units: stored canonically as °C and mg/dL ----
export const cToF = (c) => (c * 9) / 5 + 32;
export const fToC = (f) => ((f - 32) * 5) / 9;
export const mgToMmol = (mg) => mg / 18.016;
export const mmolToMg = (mm) => mm * 18.016;
const num = (v) => (v === '' || v === null || v === undefined ? null : Number(v));
const round1 = (v) => Math.round(v * 10) / 10;

export function displayTemp(c, unit = 'C') {
  const n = num(c);
  if (n === null || Number.isNaN(n)) return '';
  return unit === 'F' ? `${round1(cToF(n))}°F` : `${round1(n)}°C`;
}
export function displayBgl(mg, unit = 'mg') {
  const n = num(mg);
  if (n === null || Number.isNaN(n)) return '';
  return unit === 'mmol' ? `${round1(mgToMmol(n))} mmol/L` : `${Math.round(n)} mg/dL`;
}

// Get a numeric/comparable series value for a vitals set.
export function metric(set, key) {
  switch (key) {
    case 'lor': return lorRank(set.lor);
    case 'sbp': return num(set.bpSys);
    case 'radial': return set.radial === 'present' ? 1 : set.radial === 'absent' ? 0 : null;
    default: { const n = num(set[key]); return Number.isNaN(n) ? null : n; }
  }
}

// Chartable metrics. dir: which direction is worse when it changes by >= delta.
export const TREND_METRICS = [
  { k: 'lor', label: 'LOR', worse: 'down', delta: 1, abnormal: (v) => v < 8 },
  { k: 'hr', label: 'HR', worse: 'up', delta: 10, abnormal: (v) => v > 120 || v < 50 },
  { k: 'rr', label: 'RR', worse: 'up', delta: 4, abnormal: (v) => v > 30 || v < 10 },
  { k: 'sbp', label: 'Systolic BP', worse: 'down', delta: 15, abnormal: (v) => v < 90 },
  { k: 'spo2', label: 'SpO₂', worse: 'down', delta: 3, abnormal: (v) => v < 92 },
  { k: 'temp', label: 'Temp', worse: 'away', center: 37, delta: 0.5, abnormal: (v) => v < 35 || v > 39 },
  { k: 'bgl', label: 'BGL', worse: 'down', delta: 30, abnormal: (v) => v < 70 || v > 250 },
];

const SKIN_BAD = { skinColor: ['pale', 'cyanotic', 'grey'], skinTemp: ['cool', 'cold', 'hot'], skinMoist: ['moist', 'wet'] };

// Compare each set with the previous set that has a value for the metric.
// Returns { flags: {setId: {key: 'worse'|'better'|'abnormal'...}}, alerts: [{key, text, t}] }
export function analyzeTrends(vitals) {
  const sets = [...(vitals || [])].sort((x, y) => x.t - y.t);
  const flags = {};
  const alerts = [];
  const last = {};
  for (const s of sets) {
    const f = (flags[s.id] = {});
    for (const m of TREND_METRICS) {
      const v = metric(s, m.k);
      if (v === null) continue;
      const fl = { abnormal: m.abnormal(v), dir: null };
      const prev = last[m.k];
      if (prev) {
        const d = v - prev.v;
        let worse = false, better = false;
        if (m.worse === 'up') { worse = d >= m.delta; better = d <= -m.delta; }
        else if (m.worse === 'down') { worse = d <= -m.delta; better = d >= m.delta; }
        else if (m.worse === 'away') {
          const dd = Math.abs(v - m.center) - Math.abs(prev.v - m.center);
          worse = dd >= m.delta; better = dd <= -m.delta;
        }
        fl.dir = d > 0 ? 'up' : d < 0 ? 'down' : 'same';
        fl.worse = worse;
        fl.better = better;
      }
      f[m.k] = fl;
      last[m.k] = { v, t: s.t, set: s };
    }
    // radial pulse lost
    if (s.radial) {
      const prev = last.radial;
      f.radial = { abnormal: s.radial === 'absent', worse: !!(prev && prev.v === 'present' && s.radial === 'absent') };
      last.radial = { v: s.radial, t: s.t };
    }
    // categorical: skin & pupils
    for (const k of ['skinColor', 'skinTemp', 'skinMoist']) {
      if (!s[k]) continue;
      const prev = last[k];
      const bad = SKIN_BAD[k].includes(s[k]);
      f[k] = { abnormal: bad, worse: !!(prev && !SKIN_BAD[k].includes(prev.v) && bad) };
      last[k] = { v: s[k], t: s.t };
    }
    if (s.pupils) {
      const prev = last.pupils;
      const bad = s.pupils !== 'PERRL';
      f.pupils = { abnormal: bad, worse: !!(prev && prev.v === 'PERRL' && bad) };
      last.pupils = { v: s.pupils, t: s.t };
    }
  }
  // Alerts: only report worsening in the most recent value of each metric.
  const latestSet = sets[sets.length - 1];
  for (const m of TREND_METRICS) {
    const cur = last[m.k];
    if (!cur) continue;
    const fl = flags[cur.set.id][m.k];
    if (fl.worse) {
      const prevSet = [...sets].reverse().find((s) => s.t < cur.t && metric(s, m.k) !== null);
      const fmt = (st) => (m.k === 'lor' ? lorLabel(st.lor) : m.k === 'sbp' ? st.bpSys : st[m.k]);
      const verb = m.worse === 'up' ? 'rising' : m.worse === 'down' ? 'falling' : 'worsening';
      alerts.push({ key: m.k, t: cur.t, text: `${m.label} ${verb}: ${fmt(prevSet)} → ${fmt(cur.set)}` });
    }
  }
  if (latestSet) {
    const lf = flags[latestSet.id];
    if (lf.radial && lf.radial.worse) alerts.push({ key: 'radial', t: latestSet.t, text: 'Radial pulse LOST' });
    if (lf.pupils && lf.pupils.worse) alerts.push({ key: 'pupils', t: latestSet.t, text: `Pupils changed: ${latestSet.pupils}` });
    for (const k of ['skinColor', 'skinTemp', 'skinMoist']) {
      if (lf[k] && lf[k].worse) alerts.push({ key: k, t: latestSet.t, text: `Skin now ${latestSet[k]}` });
    }
  }
  return { flags, alerts, sorted: sets };
}

export function latestVitals(p) {
  if (!p.vitals || !p.vitals.length) return null;
  return p.vitals.reduce((a, b) => (b.t > a.t ? b : a));
}

export function chiefProblem(p) {
  const prob = (p.problems || []).map((x) => x.problem).filter(Boolean)[0];
  return prob || p.cc || p.scene?.moi || '';
}

export function vitalsSummary(s, units = {}) {
  if (!s) return '';
  const parts = [];
  if (s.lor) parts.push(`LOR ${lorLabel(s.lor)}`);
  if (s.hr !== '') parts.push(`HR ${s.hr}${s.hrQual?.length ? ' ' + s.hrQual.join('/') : ''}`);
  if (s.rr !== '') parts.push(`RR ${s.rr}${s.rrQual?.length ? ' ' + s.rrQual.join('/') : ''}`);
  if (s.bpSys !== '') parts.push(`BP ${s.bpSys}${s.bpDia !== '' ? '/' + s.bpDia : ''}`);
  if (s.radial) parts.push(`radial ${s.radial}`);
  if (s.spo2 !== '') parts.push(`SpO2 ${s.spo2}%`);
  const skin = [s.skinColor, s.skinTemp, s.skinMoist].filter(Boolean).join('/');
  if (skin) parts.push(`skin ${skin}`);
  if (s.pupils) parts.push(`pupils ${s.pupils}`);
  if (s.temp !== '') parts.push(`T ${displayTemp(s.temp, units.temp)}`);
  if (s.bgl !== '') parts.push(`BGL ${displayBgl(s.bgl, units.bgl)}`);
  return parts.join(', ');
}

// Path helpers for generic form binding: "opqrst.o", "exam.head.note", "problems.0.plan"
export function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
export function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null) o[keys[i]] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = value;
}

// Forward-compatible migration for records saved by older versions.
export function migrate(p) {
  const base = newPatient({ now: p.created || Date.now() });
  const out = { ...base, ...p };
  for (const k of ['scene', 'primary', 'opqrst', 'sample', 'evac', 'recheck']) out[k] = { ...base[k], ...(p[k] || {}) };
  out.exam = { ...base.exam };
  for (const k of Object.keys(p.exam || {})) out.exam[k] = { ...base.exam[k], ...p.exam[k] };
  out.vitals = (p.vitals || []).map((s) => ({ ...newVitals(s.t), ...s }));
  if (!Array.isArray(out.problems) || !out.problems.length) out.problems = base.problems;
  out.v = SCHEMA_VERSION;
  return out;
}

export function fmtTime(t) {
  if (!t) return '';
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtDateTime(t) {
  if (!t) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmtTime(t)}`;
}
export function ago(t, now = Date.now()) {
  if (!t) return '';
  const m = Math.round((now - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min ago`;
}
