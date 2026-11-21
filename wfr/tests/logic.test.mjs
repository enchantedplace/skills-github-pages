// Run: node --test wfr/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toUTM, fromUTM, formatUTM, parseUTM, parseLatLon } from '../js/utm.js';
import { parseSpeech } from '../js/voice.js';
import * as M from '../js/model.js';
import { isbar, isbarShort, soapNote, fullRecord } from '../js/export.js';
import { trendChart } from '../js/chart.js';

// Reference values from pyproj (PROJ), WGS84.
const REF = [
  [46.7865, -121.7353, 10, 596531.4, 5182215.6],
  [-33.8568, 151.2153, 56, 334900.6, 6252288.8],
  [60.39, 5.32, 32, 297230.2, 6700510.2], // Norway exception zone
  [78.22, 15.65, 33, 514813.5, 8683004.2], // Svalbard exception zone
  [-54.8, -68.3, 19, 545000.1, 3927239.4],
];

test('UTM matches PROJ to < 1 m', () => {
  for (const [lat, lon, zone, e, n] of REF) {
    const u = toUTM(lat, lon);
    assert.equal(u.zone, zone);
    assert.ok(Math.abs(u.easting - e) < 1, `E ${u.easting} vs ${e}`);
    assert.ok(Math.abs(u.northing - n) < 1, `N ${u.northing} vs ${n}`);
  }
});

test('UTM round trip and parsing', () => {
  for (const [lat, lon] of REF) {
    const u = toUTM(lat, lon);
    const b = fromUTM(u.zone, u.band, u.easting, u.northing);
    assert.ok(Math.abs(b.lat - lat) < 1e-6 && Math.abs(b.lon - lon) < 1e-6);
  }
  assert.equal(formatUTM(46.7865, -121.7353), '10T 596531E 5182216N');
  const p = parseUTM('10T 596531E 5182216N');
  assert.ok(Math.abs(p.lat - 46.7865) < 1e-4);
  assert.deepEqual(parseLatLon('46.5N 121.25W'), { lat: 46.5, lon: -121.25 });
  assert.equal(toUTM(88, 0), null);
});

const vals = (items) => Object.fromEntries(items.map((i) => [i.key || i.path, i.value]));

test('speech parsing: spec example', () => {
  const v = vals(parseSpeech('heart rate 100, resp 18, alert and oriented times three'));
  assert.deepEqual(v, { hr: '100', rr: '18', lor: 'AO3' });
});

test('speech parsing: number words, BP, units, skin', () => {
  let v = vals(parseSpeech('heart rate one hundred and ten, respirations eighteen, BP one twenty over eighty'));
  assert.equal(v.hr, '110'); assert.equal(v.rr, '18'); assert.equal(v.bp, '120/80');
  v = vals(parseSpeech('pulse ox ninety four percent, temp ninety eight point six, skin pale cool and clammy'));
  assert.equal(v.spo2, '94'); assert.equal(v.temp, '37'); // 98.6 F -> 37 C
  assert.equal(v.skinColor, 'pale'); assert.equal(v.skinTemp, 'cool'); assert.equal(v.skinMoist, 'moist');
  v = vals(parseSpeech('glucose 5.5, pupils equal and reactive, no radial pulse, responds to pain'));
  assert.equal(v.bgl, '99'); assert.equal(v.pupils, 'PERRL'); assert.equal(v.radial, 'absent'); assert.equal(v.lor, 'P');
  v = vals(parseSpeech('A&Ox4, HR 88, sats 98, BP 118/76'));
  assert.equal(v.lor, 'AO4'); assert.equal(v.hr, '88'); assert.equal(v.spo2, '98'); assert.equal(v.bp, '118/76');
});

test('speech parsing: history fields', () => {
  const v = vals(parseSpeech('34 year old male complains of left ankle pain, pain 7 out of 10, no known allergies, meds ibuprofen, urgent evac'));
  assert.equal(v.age, '34'); assert.equal(v.sex, 'M'); assert.equal(v.cc, 'left ankle pain');
  assert.equal(v['opqrst.s'], '7'); assert.equal(v['sample.a'], 'NKDA'); assert.equal(v['sample.m'], 'ibuprofen');
  assert.equal(v['evac.urgency'], 'urgent');
});

function patientWithTrend() {
  const p = M.newPatient({ now: Date.UTC(2026, 10, 21, 10, 0) });
  const a = { ...M.newVitals(1000), lor: 'AO4', hr: '88', rr: '16', bpSys: '124', bpDia: '80', radial: 'present', skinColor: 'pink', spo2: '97' };
  const b = { ...M.newVitals(1000 + 15 * 60000), lor: 'V', hr: '118', rr: '26', bpSys: '96', radial: 'absent', skinColor: 'pale', spo2: '97' };
  p.vitals = [b, a]; // unsorted on purpose
  p.cc = 'Fell 4 m'; p.problems[0].problem = 'Head injury'; p.evac = { mode: 'helicopter', urgency: 'urgent', notes: '' };
  p.location = { lat: 46.7865, lon: -121.7353, acc: 12, source: 'gps', t: 1000 };
  return p;
}

test('trend analysis flags worsening values', () => {
  const p = patientWithTrend();
  const { alerts, flags } = M.analyzeTrends(p.vitals);
  const keys = alerts.map((a) => a.key).sort();
  assert.deepEqual(keys, ['hr', 'lor', 'radial', 'rr', 'sbp', 'skinColor'].sort());
  const fb = flags[p.vitals[0].id];
  assert.equal(fb.hr.worse, true); assert.equal(fb.hr.dir, 'up');
  assert.equal(fb.spo2.worse, false);
  // improvement is not flagged
  const { alerts: a2 } = M.analyzeTrends([{ ...p.vitals[0], t: 1 }, { ...p.vitals[1], t: 2 }]);
  assert.ok(!a2.some((x) => x.key === 'hr'));
});

test('handoff text', () => {
  const p = patientWithTrend();
  const st = { tempUnit: 'C', bglUnit: 'mg', responder: 'Team 2' };
  const i = isbar(p, st);
  assert.match(i, /^I — IDENTIFY: This is Team 2\./);
  assert.match(i, /HR 118↑/);
  assert.match(i, /10T 596531E 5182216N/);
  const s = isbarShort(p, st);
  assert.ok(s.length <= 160, s);
  assert.match(s, /URG HELI/);
  assert.match(soapNote(p, st), /A — ASSESSMENT\n1\. Head injury/);
  assert.match(fullRecord(p, st), /WFR PATIENT RECORD/);
  assert.match(trendChart(p.vitals, 'hr'), /<svg[\s\S]*polygon/);
});

test('patient labels and migration', () => {
  const now = Date.UTC(2026, 10, 21, 12);
  const a = M.newPatient({ now });
  const b = M.newPatient({ now, existing: [a] });
  assert.notEqual(a.label, b.label);
  assert.match(b.label, /-02$/);
  const old = { id: 'x', label: 'P-1121-09', created: now, vitals: [{ id: 'v', t: 1, hr: '80' }] };
  const m = M.migrate(old);
  assert.equal(m.vitals[0].lor, '');
  assert.ok(m.exam.head && m.primary.airway === '');
});
