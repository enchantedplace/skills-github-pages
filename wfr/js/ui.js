// Small DOM helpers: escaping, bottom sheets, toasts, glove-friendly number pad, beep.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let sheetStack = [];

export function openSheet(html, { onClose, cls = '' } = {}) {
  const root = document.getElementById('sheet-root');
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet-backdrop"></div><div class="sheet ${cls}" role="dialog" aria-modal="true">${html}</div>`;
  root.appendChild(wrap);
  const entry = { wrap, onClose };
  sheetStack.push(entry);
  wrap.querySelector('.sheet-backdrop').addEventListener('click', () => closeSheet(entry));
  wrap.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(entry); });
  return { el: wrap.querySelector('.sheet'), close: () => closeSheet(entry) };
}

export function closeSheet(entry) {
  entry = entry || sheetStack[sheetStack.length - 1];
  if (!entry) return;
  sheetStack = sheetStack.filter((x) => x !== entry);
  entry.wrap.remove();
  entry.onClose && entry.onClose();
}
export const sheetOpen = () => sheetStack.length > 0;

let toastTimer;
export function toast(msg, { ms = 3500, action, onAction } = {}) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button" class="btn small inv">${esc(action)}</button>` : ''}`;
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; onAction && onAction(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function confirmSheet(message, { ok = 'Confirm', danger = false } = {}) {
  return new Promise((resolve) => {
    let answered = false;
    const s = openSheet(`<p class="big">${esc(message)}</p>
      <div class="row2"><button type="button" class="btn" data-close>Cancel</button>
      <button type="button" class="btn ${danger ? 'danger' : 'primary'}" data-ok>${esc(ok)}</button></div>`,
    { onClose: () => { if (!answered) resolve(false); } });
    s.el.querySelector('[data-ok]').onclick = () => { answered = true; s.close(); resolve(true); };
  });
}

// Number pad. value: string. Returns nothing; calls onDone(valueString) on Done/Next.
export function openKeypad({ label, value = '', unit = '', decimal = false, hint = '', maxLen = 5, mask = false, onDone, onNext, nextLabel = 'Next' }) {
  let v = String(value ?? '');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', decimal ? '.' : '', '0', '⌫'];
  const s = openSheet(`
    <div class="kp-head"><div class="kp-label">${esc(label)}</div><button type="button" class="btn icon" data-close aria-label="Cancel">✕</button></div>
    <div class="kp-display" aria-live="polite"><span class="kp-val"></span><span class="kp-unit">${esc(unit)}</span></div>
    ${hint ? `<div class="kp-hint">${esc(hint)}</div>` : ''}
    <div class="kp-grid">${keys.map((k) => (k ? `<button type="button" class="kp-key" data-k="${k}">${k}</button>` : '<span></span>')).join('')}</div>
    <div class="kp-actions">
      <button type="button" class="btn" data-clear>Clear</button>
      ${onNext ? `<button type="button" class="btn" data-next>${esc(nextLabel)} →</button>` : ''}
      <button type="button" class="btn primary" data-done>Done ✓</button>
    </div>`, { cls: 'keypad' });
  const disp = s.el.querySelector('.kp-val');
  const show = () => { disp.textContent = v === '' ? '—' : mask ? '•'.repeat(v.length) : v; };
  show();
  const press = (k) => {
    if (k === '⌫') v = v.slice(0, -1);
    else if (k === '.') { if (!v.includes('.')) v = (v || '0') + '.'; }
    else if (v.replace('.', '').length < maxLen) v = v === '0' ? k : v + k;
    show();
  };
  const finish = () => { if (v.endsWith('.')) v = v.slice(0, -1); };
  s.el.querySelectorAll('.kp-key').forEach((b) => b.addEventListener('click', () => press(b.dataset.k)));
  s.el.querySelector('[data-clear]').onclick = () => { v = ''; show(); };
  s.el.querySelector('[data-done]').onclick = () => { finish(); s.close(); onDone && onDone(v); };
  const nx = s.el.querySelector('[data-next]');
  if (nx) nx.onclick = () => { finish(); s.close(); onDone && onDone(v); onNext(); };
  const onKey = (e) => {
    if (!document.body.contains(s.el)) { document.removeEventListener('keydown', onKey); return; }
    if (/^[0-9]$/.test(e.key)) press(e.key);
    else if (e.key === '.' && decimal) press('.');
    else if (e.key === 'Backspace') press('⌫');
    else if (e.key === 'Enter') s.el.querySelector('[data-done]').click();
    else if (e.key === 'Escape') s.close();
    else return;
    e.preventDefault();
  };
  document.addEventListener('keydown', onKey);
}

let audioCtx;
export function unlockAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ }
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
export function beep(times = 3) {
  try { navigator.vibrate && navigator.vibrate([300, 150, 300, 150, 300]); } catch { /* ignore */ }
  if (!audioCtx) return;
  for (let i = 0; i < times; i++) {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    o.connect(g); g.connect(audioCtx.destination);
    const t = audioCtx.currentTime + i * 0.35;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.start(t); o.stop(t + 0.3);
  }
}
