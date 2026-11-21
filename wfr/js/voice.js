// Speech -> structured fields. Pure parsing (no DOM) plus a thin recognizer wrapper.
//
// parseSpeech("heart rate 100, resp 18, alert and oriented times three")
//   -> [{group:'vitals', key:'hr', ...}, {group:'vitals', key:'rr', ...}, {group:'vitals', key:'lor', value:'AO3'}]

import { lorLabel } from './model.js';

const ONES = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const HOMOPHONES = { won: 'one', to: null, too: 'two', for: null, ate: 'eight' };

// Convert spoken number words into digits. "ninety eight point six" -> "98.6",
// "one twenty over eighty" -> "120 over 80", "a hundred and ten" -> "110".
export function wordsToNumbers(text) {
  const toks = text.split(/(\s+|[,;:]|(?<=\d)(?=[a-z])|(?<=[a-z])(?=\d))/).filter((t) => t !== undefined && t !== '');
  const out = [];
  let i = 0;
  const isNumWord = (w) => w in ONES || w in TENS || w === 'hundred' || (w === 'won' || w === 'too' || w === 'ate');
  const norm = (w) => (HOMOPHONES[w] ? HOMOPHONES[w] : w);
  while (i < toks.length) {
    const w = norm(toks[i]);
    const prevWord = (out.length && out[out.length - 1].trim()) || '';
    if (isNumWord(toks[i]) && !(w === 'oh' && !/\d$/.test(prevWord))) {
      // collect a run of number words (with spaces / "and" between)
      let total = 0, cur = 0, j = i, last = null, consumed = i;
      while (j < toks.length) {
        const t = toks[j];
        if (/^\s+$/.test(t)) { j++; continue; }
        const n = norm(t);
        if (n in ONES) {
          const v = ONES[n];
          if (last === 'ones' || last === 'teen') break; // "three four" -> separate numbers
          if (last === 'tens' && v >= 10) break;
          cur += v; last = v >= 10 ? 'teen' : 'ones';
        } else if (n in TENS) {
          if (last === 'tens' || last === 'teen') break;
          if (last === 'ones' && cur < 10 && total === 0) { cur = cur * 100 + TENS[n]; last = 'tens'; } // "one twenty"
          else { if (last === 'ones') break; cur += TENS[n]; last = 'tens'; }
        } else if (n === 'hundred') {
          cur = (cur || 1) * 100; last = 'hundred';
        } else if (n === 'and' && last === 'hundred') {
          j++; continue;
        } else if (n === 'a' && toks.slice(j + 1).find((x) => !/^\s+$/.test(x)) === 'hundred') {
          j++; continue;
        } else break;
        j++; consumed = j;
      }
      let value = String(total + cur);
      // decimal: "point six" / "point five"
      let k = consumed;
      const skipWs = (idx) => { while (idx < toks.length && /^\s+$/.test(toks[idx])) idx++; return idx; };
      let p = skipWs(k);
      if (toks[p] === 'point') {
        let q = skipWs(p + 1);
        let dec = '';
        while (q < toks.length && (norm(toks[q]) in ONES && ONES[norm(toks[q])] < 10 || /^\d$/.test(toks[q]))) {
          dec += /^\d$/.test(toks[q]) ? toks[q] : ONES[norm(toks[q])];
          k = q + 1; q = skipWs(q + 1);
        }
        if (dec) { value += '.' + dec; consumed = k; }
      }
      out.push(value);
      i = consumed;
    } else if (/^\d+$/.test(toks[i]) && toks[i + 1] === ' ' && toks[i + 2] === 'point') {
      // "98 point 6"
      let q = i + 3;
      while (toks[q] === ' ') q++;
      const d = toks[q] && (/^\d+$/.test(toks[q]) ? toks[q] : (norm(toks[q]) in ONES ? String(ONES[norm(toks[q])]) : null));
      if (d !== null && d !== undefined) { out.push(toks[i] + '.' + d); i = q + 1; } else { out.push(toks[i]); i++; }
    } else {
      out.push(toks[i]);
      i++;
    }
  }
  return out.join('');
}

export function normalize(text) {
  let s = ' ' + String(text || '').toLowerCase().replace(/[“”"]/g, '') + ' ';
  s = s.replace(/\bper cent\b|%/g, ' percent ');
  s = s.replace(/\b(\d+)\s*\/\s*(\d+)\b/g, '$1 over $2');
  s = s.replace(/[×*]/g, ' x ');
  s = s.replace(/a\s*&\s*o|a\s*\+\s*o|\ba and o\b|\baox?\b(?=\s*\d|\s*x|\s*times)/g, ' a and o ');
  s = wordsToNumbers(s);
  s = s.replace(/\s+/g, ' ');
  return s;
}

// Phrases that begin a new field; free-text captures stop before these.
const KEYWORDS = [
  'heart rate', 'pulse', 'hr', 'resp', 'respirations', 'respiratory', 'rr', 'breathing', 'blood pressure', 'bp',
  'sats?', 'spo2', 'saturation', 'oxygen', 'temp', 'temperature', 'glucose', 'sugar', 'bgl', 'skin', 'pupils?',
  'alert', 'a and o', 'oriented', 'allerg\\w*', 'no known', 'medications?', 'meds', 'history', 'chief complaint',
  'complain\\w*', 'mechanism', 'moi', 'severity', 'age', 'radial', 'last (?:oral|meal|ate)', 'events?',
  'urgen\\w*', 'evac\\w*', 'onset', 'provok\\w*', 'quality', 'radiat\\w*',
].join('|');
const FREE = `([^,.;]+?)(?=\\s+(?:${KEYWORDS})\\b|\\s*[,.;]|\\s*$)`;

const LABELS = {
  lor: 'LOR', hr: 'Heart rate', rr: 'Resp rate', bp: 'Blood pressure', radial: 'Radial pulse', spo2: 'SpO₂',
  temp: 'Temperature', bgl: 'Blood glucose', skinColor: 'Skin colour', skinTemp: 'Skin temp', skinMoist: 'Skin moisture',
  pupils: 'Pupils',
};

export function parseSpeech(text) {
  let s = normalize(text);
  const items = [];
  const vit = (key, value, display) => items.push({ group: 'vitals', key, label: LABELS[key], value: String(value), display: display ?? String(value) });
  const pat = (path, label, value) => items.push({ group: 'patient', path, label, value: String(value).trim(), display: String(value).trim() });
  // consume: run regex, call fn with match, blank out the match so later rules don't re-read it
  const take = (re, fn) => {
    const m = s.match(re);
    if (!m) return false;
    if (fn(m) === false) return false;
    s = s.slice(0, m.index) + ' , ' + s.slice(m.index + m[0].length);
    return true;
  };

  // --- vitals (order matters: specific before generic) ---
  take(/\b(?:spo2|sp o2|sp02|o2 sat\w*|sats?|saturation|oxygen sat\w*|oxygen|pulse ox\w*)\s*(?:is|of|at|are)?\s*(\d{2,3})\s*(?:percent)?/, (m) => vit('spo2', m[1], m[1] + '%'));
  take(/\b(?:blood pressure|bp|pressure)\s*(?:is|of)?\s*(\d{2,3})\s*(?:over|on|by)\s*(\d{2,3})/, (m) => vit('bp', `${m[1]}/${m[2]}`));
  take(/\b(?:blood pressure|bp)\s*(?:is|of)?\s*(\d{2,3})\s*(?:palp\w*|systolic)?/, (m) => vit('bp', `${m[1]}/`, `${m[1]} systolic`));
  take(/\bno radial(?: pulse)?\b|\bradial(?: pulses?)? (?:is |are )?(absent|negative|not present|present|positive|strong|weak)/, (m) => {
    const v = !m[1] || /absent|negative|not/.test(m[1]) ? 'absent' : 'present';
    vit('radial', v);
  });
  take(/\b(?:heart rate|pulse rate|pulse|hr|heart)\s*(?:is|of|at)?\s*(\d{2,3})/, (m) => vit('hr', m[1], m[1] + ' /min'));
  take(/\b(?:respiratory rate|respirations?|resps?|resp rate|breathing rate|breaths|rr)\s*(?:is|of|at|rate)?\s*(\d{1,2})\b/, (m) => vit('rr', m[1], m[1] + ' /min'));
  take(/\b(?:temperature|temp)\s*(?:is|of)?\s*(\d{2,3}(?:\.\d+)?)\s*(?:degrees)?\s*(fahrenheit|f|celsius|c)?\b/, (m) => {
    let v = parseFloat(m[1]);
    const isF = (m[2] && m[2][0] === 'f') || (!m[2] && v > 45);
    if (isF) v = ((v - 32) * 5) / 9;
    v = Math.round(v * 10) / 10;
    vit('temp', v, `${v}°C${isF ? ` (from ${m[1]}°F)` : ''}`);
  });
  take(/\b(?:blood glucose|blood sugar|glucose|sugar|bgl|bg)\s*(?:is|of|at)?\s*(\d{1,3}(?:\.\d+)?)\s*(mmol\w*|mg\w*)?/, (m) => {
    let v = parseFloat(m[1]);
    const mmol = (m[2] && m[2].startsWith('mmol')) || (!m[2] && v < 35);
    if (mmol) v = Math.round(v * 18.016);
    vit('bgl', v, `${v} mg/dL${mmol ? ` (from ${m[1]} mmol/L)` : ''}`);
  });

  // LOR
  take(/\b(?:alert and oriented|a and o|alert oriented|oriented)\s*(?:times|x|by|to)?\s*([0-4])\b/, (m) => vit('lor', 'AO' + m[1], lorLabel('AO' + m[1])));
  take(/\balert (?:and|but) disoriented\b|\bdisoriented\b/, () => vit('lor', 'AO0', lorLabel('AO0')));
  take(/\b(?:respon\w* to (?:voice|verbal\w*)|verbal stimul\w*|lor v)\b/, () => vit('lor', 'V', 'V (verbal)'));
  take(/\b(?:respon\w* to pain\w*|painful stimul\w*|lor p)\b/, () => vit('lor', 'P', 'P (pain)'));
  take(/\b(?:unresponsive|unconscious|lor u)\b/, () => vit('lor', 'U', 'U (unresponsive)'));

  // Pupils
  take(/\bpupils?\s*(?:are\s+)?(perrla?|equal(?: round)?(?: and)? reactive(?: to light)?|equal|unequal|dilated|constricted|pinpoint|sluggish|fixed(?: and dilated)?|non ?reactive)/, (m) => {
    const t = m[1];
    const v = /^perrl|equal.*reactive|^equal$/.test(t) && !/unequal/.test(t) ? 'PERRL'
      : /unequal/.test(t) ? 'unequal' : /dilated/.test(t) && !/fixed/.test(t) ? 'dilated'
        : /constricted|pinpoint/.test(t) ? 'constricted' : /sluggish/.test(t) ? 'sluggish' : 'non-reactive';
    vit('pupils', v);
  }) || take(/\bperrla?\b/, () => vit('pupils', 'PERRL'));

  // Skin: words in the "skin ..." window, or the classic colour/temp/moisture triad.
  const skinRe = /\bskin\s*(?:is|was)?\s*((?:(?:and|is|,)?\s*(?:pink|pale|flushed|red|cyanotic|blue|grey|gray|ashen|jaundiced|yellow|warm|cool|cold|hot|dry|moist|wet|clammy|sweaty|diaphoretic)\b\s*){1,4})/;
  const triadRe = /\b((?:pink|pale|flushed|cyanotic|grey|gray|ashen)[\s,]+(?:and\s+)?(?:warm|cool|cold|hot)[\s,]+(?:and\s+)?(?:dry|moist|wet|clammy|sweaty|diaphoretic))\b/;
  const skinWords = (str) => {
    const w = str.split(/[\s,]+/);
    const color = w.find((x) => /^(pink|pale|flushed|red|cyanotic|blue|grey|gray|ashen|jaundiced|yellow)$/.test(x));
    const temp = w.find((x) => /^(warm|cool|cold|hot)$/.test(x));
    const moist = w.find((x) => /^(dry|moist|wet|clammy|sweaty|diaphoretic)$/.test(x));
    const cmap = { red: 'flushed', blue: 'cyanotic', gray: 'grey', ashen: 'grey', yellow: 'jaundiced' };
    const mmap = { clammy: 'moist', sweaty: 'moist', diaphoretic: 'wet' };
    if (color) vit('skinColor', cmap[color] || color);
    if (temp) vit('skinTemp', temp);
    if (moist) vit('skinMoist', mmap[moist] || moist);
  };
  take(skinRe, (m) => skinWords(m[1])) || take(triadRe, (m) => skinWords(m[1]));

  // --- patient fields ---
  take(/\b(\d{1,3})\s*(?:years?|yrs?|y\/o|yo)(?:[ -]old)?\b(?:\s+(male|female|man|woman|boy|girl))?/, (m) => {
    pat('age', 'Age', m[1]);
    if (m[2]) pat('sex', 'Sex', /^(female|woman|girl)$/.test(m[2]) ? 'F' : 'M');
  });
  take(/\bage\s*(?:is|of)?\s*(\d{1,3})\b/, (m) => pat('age', 'Age', m[1]));
  if (!items.some((x) => x.path === 'sex')) take(/\b(female|male)\b/, (m) => pat('sex', 'Sex', m[1] === 'female' ? 'F' : 'M'));
  take(/\b(?:pain|severity)\s*(?:is|of|at|level)?\s*(\d{1,2})\s*(?:out of|over|on a scale of)\s*10\b/, (m) => {
    if (+m[1] <= 10) pat('opqrst.s', 'Severity (0–10)', m[1]); else return false;
  });
  take(new RegExp(`\\b(?:chief complaint|complains of|complaining of|c/o)\\s*(?:is|of)?\\s*${FREE}`), (m) => pat('cc', 'Chief complaint', m[1]));
  take(new RegExp(`\\b(?:mechanism(?: of injury)?|moi)\\s*(?:is|was)?\\s*${FREE}`), (m) => pat('scene.moi', 'Mechanism of injury', m[1]));
  take(/\b(?:no known (?:drug )?allergies|nkda|nka|no allergies)\b/, () => pat('sample.a', 'Allergies', 'NKDA'))
    || take(new RegExp(`\\ballerg\\w*\\s*(?:to|are|is|include)?\\s*${FREE}`), (m) => pat('sample.a', 'Allergies', m[1]));
  take(/\b(?:no (?:medications|meds)|takes no (?:medications|meds))\b/, () => pat('sample.m', 'Medications', 'None'))
    || take(new RegExp(`\\b(?:medications?|meds)\\s*(?:are|is|include|includes)?\\s*${FREE}`), (m) => pat('sample.m', 'Medications', m[1]));
  take(new RegExp(`\\b(?:past (?:medical )?history|medical history|history of|hx of|pmh)\\s*(?:is|of|includes)?\\s*${FREE}`), (m) => pat('sample.p', 'Past history', m[1]));
  take(new RegExp(`\\b(?:last (?:oral intake|ate|meal|ins? and outs?|intake))\\s*(?:was|at)?\\s*${FREE}`), (m) => pat('sample.l', 'Last ins/outs', m[1]));
  take(/\b(?:(non[- ]?urgent|urgent|immediate)\s+(?:evac\w*|priority|urgency)|(?:urgency|priority)\s*(?:is)?\s*(non[- ]?urgent|urgent|immediate))\b/, (m) => {
    const u = (m[1] || m[2]).replace(/[- ]/, '');
    pat('evac.urgency', 'Urgency', u === 'nonurgent' ? 'nonurgent' : u);
  });
  take(/\b(helicopter|heli|air)\s*(?:evac\w*)?\b|\b(carry[- ]out|walk[- ]out)\b/, (m) => {
    if (m[1] === 'air' && !/evac/.test(m[0])) return false;
    pat('evac.mode', 'Evac mode', m[1] ? 'helicopter' : m[2].startsWith('carry') ? 'carry' : 'walk');
  });

  // de-duplicate: last mention wins
  const seen = new Map();
  for (const it of items) seen.set(it.group + ':' + (it.key || it.path), it);
  return [...seen.values()];
}

// ---- recognizer wrapper (browser only) ----
export function recognizerSupport() {
  const SR = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  return SR ? { SR, local: 'processLocally' in SR.prototype } : null;
}

// Push-to-talk session. Returns {stop()}; calls onResult(finalText) once.
export function startListening({ lang = 'en-US', onInterim, onResult, onError }) {
  const sup = recognizerSupport();
  if (!sup) { onError && onError('unsupported'); return null; }
  const rec = new sup.SR();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = true;
  // Chrome 139+: force on-device recognition (no audio leaves the phone; works offline
  // once the language pack is installed).
  if (sup.local) { try { rec.processLocally = true; } catch { /* ignore */ } }
  let finalText = '';
  let done = false;
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript + ' ';
      else interim += e.results[i][0].transcript;
    }
    onInterim && onInterim((finalText + interim).trim());
  };
  rec.onerror = (e) => { if (!done) { done = true; onError && onError(e.error || 'error'); } };
  rec.onend = () => { if (!done) { done = true; onResult && onResult(finalText.trim()); } };
  try { rec.start(); } catch (e) { onError && onError(String(e)); return null; }
  return { stop: () => { try { rec.stop(); } catch { /* ignore */ } } };
}
