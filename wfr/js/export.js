// Handoff text generation: SOAP note, ISBAR (radio / satellite), full record. Pure functions.

import {
  EXAM_REGIONS, PRIMARY, PRIMARY_BAD, EVAC_MODE, urgencyInfo, lorLabel, latestVitals, vitalsSummary,
  analyzeTrends, fmtTime, fmtDateTime, displayTemp, displayBgl,
} from './model.js';
import { formatUTM, formatLatLon } from './utm.js';

const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const line = (label, v) => (has(v) ? `${label}: ${String(v).trim()}` : null);
const join = (arr, sep = '\n') => arr.filter(has).join(sep);

function ageSex(p) {
  return [p.age ? `${p.age}${/^\d+$/.test(p.age) ? 'y' : ''}` : '', p.sex].filter(Boolean).join(' ') || 'age/sex unk';
}

function locationText(p, short = false) {
  const L = p.location;
  if (!L || !Number.isFinite(L.lat)) return has(p.locationNote) ? `Location (est.): ${p.locationNote}` : 'Location: unknown';
  const src = L.source === 'gps' ? `GPS ±${Math.round(L.acc || 0)} m` : L.source === 'dragged' ? 'adjusted on map' : 'manual estimate';
  if (short) return formatUTM(L.lat, L.lon);
  return join([
    `Location: UTM ${formatUTM(L.lat, L.lon)} | ${formatLatLon(L.lat, L.lon)} (${src}, ${fmtTime(L.t)})`,
    has(p.locationNote) ? `  Note: ${p.locationNote}` : null,
  ]);
}

function primaryText(p) {
  return PRIMARY.map((q) => {
    const v = p.primary?.[q.k];
    const note = p.primary?.[q.k + 'Note'];
    if (!has(v) && !has(note)) return null;
    const bad = (PRIMARY_BAD[q.k] || []).includes(v);
    return `  ${q.label}: ${has(v) ? v : '—'}${bad ? ' (!)' : ''}${has(note) ? ` — ${note}` : ''}`;
  }).filter(Boolean);
}

function examText(p) {
  const found = [];
  const nad = [];
  for (const r of EXAM_REGIONS) {
    const e = p.exam?.[r.k];
    if (!e) continue;
    if (e.status === 'finding' || has(e.note)) found.push(`  ${r.label}: ${e.note || 'finding (no detail)'}`);
    else if (e.status === 'nad') nad.push(r.label.split(' /')[0]);
  }
  const out = [...found];
  if (nad.length) out.push(`  No abnormality: ${nad.join(', ')}`);
  return out;
}

function vitalsTable(p, units) {
  const { sorted, flags } = analyzeTrends(p.vitals);
  return sorted.map((s) => {
    const f = flags[s.id] || {};
    const w = Object.entries(f).filter(([, x]) => x && x.worse).map(([k]) => k);
    return `  ${fmtTime(s.t)}  ${vitalsSummary(s, units) || '(empty)'}${w.length ? `  [WORSE: ${w.join(', ')}]` : ''}`;
  });
}

function evacText(p) {
  const mode = EVAC_MODE.find((m) => m.v === p.evac?.mode)?.label;
  const u = urgencyInfo(p.evac?.urgency);
  return join([mode ? `Evac: ${mode}` : 'Evac: not decided', u.rank ? `Urgency: ${u.label}` : null, has(p.evac?.notes) ? `(${p.evac.notes})` : null], ' — ');
}

export function soapNote(p, settings = {}) {
  const units = { temp: settings.tempUnit, bgl: settings.bglUnit };
  const o = p.opqrst || {};
  const sm = p.sample || {};
  const S = join([
    `${ageSex(p)}${has(p.name) ? ` (${p.name})` : ''}. Found ${fmtDateTime(p.timeFound)}.`,
    line('MOI', p.scene?.moi),
    line('Chief complaint', p.cc),
    join([line('O', o.o), line('P', o.p), line('Q', o.q), line('R', o.r), has(o.s) ? `S: ${o.s}/10` : null, line('T', o.t)], '; ') ? `OPQRST: ${join([line('O', o.o), line('P', o.p), line('Q', o.q), line('R', o.r), has(o.s) ? `S: ${o.s}/10` : null, line('T', o.t)], '; ')}` : null,
    line('Symptoms', sm.s), line('Allergies', sm.a), line('Medications', sm.m),
    line('Past history', sm.p), line('Last ins/outs', sm.l), line('Events', sm.e),
  ]);
  const prim = primaryText(p);
  const exam = examText(p);
  const vt = vitalsTable(p, units);
  const O = join([
    line('Scene hazards', p.scene?.hazards),
    prim.length ? `Primary survey:\n${prim.join('\n')}` : null,
    exam.length ? `Exam:\n${exam.join('\n')}` : null,
    vt.length ? `Vitals:\n${vt.join('\n')}` : 'Vitals: none recorded',
    locationText(p),
  ]);
  const probs = (p.problems || []).filter((x) => has(x.problem) || has(x.plan));
  const A = probs.length ? probs.map((x, i) => `${i + 1}. ${x.problem || '(unspecified)'}`).join('\n') : 'No problem list recorded';
  const P = join([
    ...probs.map((x, i) => `${i + 1}. ${x.problem || '(unspecified)'}: ${x.plan || 'plan not recorded'}`),
    evacText(p),
    p.recheck?.enabled ? `Monitoring: vitals rechecks${settings.recheckMin ? ` every ${settings.recheckMin} min` : ''}` : null,
  ]);
  return `SOAP NOTE — ${p.label}\nGenerated ${fmtDateTime(Date.now())}${settings.responder ? ` by ${settings.responder}` : ''}\n\nS — SUBJECTIVE\n${S}\n\nO — OBJECTIVE\n${O}\n\nA — ASSESSMENT\n${A}\n\nP — PLAN\n${P}\n`;
}

function trendWords(p) {
  const { alerts } = analyzeTrends(p.vitals);
  return alerts.map((a) => a.text);
}

// Compact vitals for radio: "LOR V, HR 118↑, RR 24, BP 90/60"
function compactVitals(p, units) {
  const s = latestVitals(p);
  if (!s) return '';
  const { flags } = analyzeTrends(p.vitals);
  const f = flags[s.id] || {};
  const arrow = (k) => (f[k]?.worse ? (f[k].dir === 'up' ? '↑' : '↓') : '');
  const parts = [];
  if (s.lor) parts.push(`LOR ${lorLabel(s.lor)}${arrow('lor')}`);
  if (has(s.hr)) parts.push(`HR ${s.hr}${arrow('hr')}`);
  if (has(s.rr)) parts.push(`RR ${s.rr}${arrow('rr')}`);
  if (has(s.bpSys)) parts.push(`BP ${s.bpSys}${has(s.bpDia) ? '/' + s.bpDia : ''}${arrow('sbp')}`);
  else if (s.radial) parts.push(`radial ${s.radial}`);
  if (has(s.spo2)) parts.push(`SpO2 ${s.spo2}${arrow('spo2')}`);
  const skin = [s.skinColor, s.skinTemp, s.skinMoist].filter(Boolean).join('/');
  if (skin) parts.push(`skin ${skin}`);
  if (has(s.temp)) parts.push(`T ${displayTemp(s.temp, units.temp)}`);
  if (has(s.bgl)) parts.push(`BGL ${displayBgl(s.bgl, units.bgl)}`);
  return parts.join(', ');
}

export function isbar(p, settings = {}) {
  const units = { temp: settings.tempUnit, bgl: settings.bglUnit };
  const u = urgencyInfo(p.evac?.urgency);
  const mode = EVAC_MODE.find((m) => m.v === p.evac?.mode)?.label;
  const probs = (p.problems || []).map((x) => x.problem).filter(has);
  const sm = p.sample || {};
  const s = latestVitals(p);
  const tw = trendWords(p);
  return [
    `I — IDENTIFY: ${settings.responder ? `This is ${settings.responder}. ` : ''}Patient ${p.label}, ${ageSex(p)}.`,
    `S — SITUATION: ${join([p.cc, p.scene?.moi ? `MOI ${p.scene.moi}` : null], '; ') || 'see assessment'}.${u.rank ? ` ${u.label}.` : ''}`,
    `B — BACKGROUND: Found ${fmtTime(p.timeFound)}. ${join([line('Allergies', sm.a), line('Meds', sm.m), line('Hx', sm.p)], '; ') || 'SAMPLE not obtained'}.`,
    `A — ASSESSMENT: ${probs.length ? probs.join('; ') : 'no problem list'}. ${s ? `Vitals ${fmtTime(s.t)}: ${compactVitals(p, units)}.` : 'No vitals.'}${tw.length ? ` TREND: ${tw.join('; ')}.` : ''}`,
    `R — REQUEST: ${mode && p.evac.mode !== 'none' ? `${mode} evacuation` : 'Advice / evac decision pending'}${u.rank ? `, ${u.label.toLowerCase()}` : ''}. ${locationText(p, false).replace(/^Location: /, 'At ')}`,
  ].join('\n');
}

// Short form for satellite messengers (default 160 chars).
export function isbarShort(p, settings = {}, max = 160) {
  const units = { temp: settings.tempUnit, bgl: settings.bglUnit };
  const u = urgencyInfo(p.evac?.urgency);
  const modeShort = { helicopter: 'HELI', carry: 'CARRY', walk: 'WALK', none: 'NO EVAC' }[p.evac?.mode] || '';
  const prob = (p.problems || []).map((x) => x.problem).filter(has).join('/') || p.cc || '';
  const loc = p.location && Number.isFinite(p.location.lat) ? formatUTM(p.location.lat, p.location.lon).replace(/[EN](?=\s|$)/g, '') : '';
  const as = [p.age ? `${p.age}${/^\d+$/.test(p.age) ? 'y' : ''}` : '', p.sex].filter(Boolean).join('');
  const head = [p.label.replace(/^P-\d{4}-/, 'P'), as, u.rank ? u.short : '', modeShort].filter(Boolean).join(' ');
  const vit = compactVitals(p, units).replace(/, skin [^,]+/, '').replace(/ ?, ?/g, ' ');
  const pieces = [head, prob, vit, loc];
  let msg = pieces.filter(has).join('. ');
  if (msg.length > max) {
    // drop detail progressively, keeping ID/urgency and location
    const trimmedProb = prob.slice(0, Math.max(10, max - head.length - loc.length - vit.length - 8));
    msg = [head, trimmedProb, vit, loc].filter(has).join('. ');
  }
  if (msg.length > max) msg = [head, prob.slice(0, 24), loc].filter(has).join('. ');
  return msg.slice(0, max);
}

export function fullRecord(p, settings = {}) {
  const units = { temp: settings.tempUnit, bgl: settings.bglUnit };
  const o = p.opqrst || {};
  const sm = p.sample || {};
  const sec = (t, body) => (body && body.length ? `== ${t} ==\n${Array.isArray(body) ? body.filter(has).join('\n') : body}\n` : '');
  return [
    `WFR PATIENT RECORD — ${p.label}`,
    `Created ${fmtDateTime(p.created)} · Last updated ${fmtDateTime(p.updated)}${settings.responder ? ` · Responder ${settings.responder}` : ''}`,
    '',
    sec('PATIENT', [line('Name', p.name), line('Age', p.age), line('Sex', p.sex), line('Time found', fmtDateTime(p.timeFound))]),
    sec('SCENE', [line('Mechanism', p.scene?.moi), line('Hazards', p.scene?.hazards), line('No. of patients', p.scene?.numPatients)]),
    sec('PRIMARY SURVEY', primaryText(p).map((x) => x.trim())),
    sec('CHIEF COMPLAINT / OPQRST', [line('Chief complaint', p.cc), line('Onset', o.o), line('Provokes/palliates', o.p), line('Quality', o.q), line('Radiates/region', o.r), has(o.s) ? `Severity: ${o.s}/10` : null, line('Time', o.t)]),
    sec('HEAD-TO-TOE EXAM', examText(p).map((x) => x.trim())),
    sec('VITALS', vitalsTable(p, units).map((x) => x.trim())),
    sec('SAMPLE HISTORY', [line('Symptoms', sm.s), line('Allergies', sm.a), line('Medications', sm.m), line('Past history', sm.p), line('Last ins/outs', sm.l), line('Events', sm.e)]),
    sec('PROBLEMS & PLAN', (p.problems || []).filter((x) => has(x.problem) || has(x.plan)).map((x, i) => `${i + 1}. ${x.problem || '(unspecified)'} — Plan: ${x.plan || '—'}`)),
    sec('EVACUATION', [evacText(p)]),
    sec('LOCATION', [locationText(p)]),
  ].filter((x) => x !== '').join('\n');
}
