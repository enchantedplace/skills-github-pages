// Monochrome SVG line charts for vitals trends. Uses currentColor so it follows the theme.
// Worsening points are drawn as large filled triangles (shape, not colour, carries meaning).

import { TREND_METRICS, metric, analyzeTrends, LOR, fmtTime, cToF, mgToMmol } from './model.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function displayValue(k, v, units) {
  if (k === 'temp' && units.temp === 'F') return Math.round(cToF(v) * 10) / 10;
  if (k === 'bgl' && units.bgl === 'mmol') return Math.round(mgToMmol(v) * 10) / 10;
  return v;
}

export function trendChart(vitals, key, { width = 340, height = 150, units = {} } = {}) {
  const m = TREND_METRICS.find((x) => x.k === key);
  const { sorted, flags } = analyzeTrends(vitals);
  const pts = sorted.map((s) => ({ s, v: metric(s, key) })).filter((p) => p.v !== null);
  if (!pts.length) return '';
  const padL = 46, padR = 14, padT = 26, padB = 30;
  const W = width - padL - padR, H = height - padT - padB;
  const t0 = pts[0].s.t, t1 = pts[pts.length - 1].s.t;
  const span = Math.max(t1 - t0, 60000);
  let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
  if (key === 'lor') { lo = 1; hi = 8; }
  if (hi === lo) { const pad = Math.max(1, Math.abs(hi) * 0.1); lo -= pad; hi += pad; }
  const x = (t) => padL + (pts.length === 1 ? W / 2 : ((t - t0) / span) * W);
  const y = (v) => padT + H - ((v - lo) / (hi - lo)) * H;
  const label = (v) => (key === 'lor' ? (LOR.find((l) => l.rank === Math.round(v)) || {}).label || '' : displayValue(key, Math.round(v * 10) / 10, units));

  const latest = pts[pts.length - 1];
  const lf = flags[latest.s.id]?.[key] || {};
  const title = `${m.label}  ${label(latest.v)}${lf.worse ? (lf.dir === 'up' ? '  ▲ WORSE' : '  ▼ WORSE') : ''}`;

  let svg = `<svg class="chart" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${esc(m.label)} trend">`;
  svg += `<text x="${padL}" y="17" class="ct">${esc(title)}</text>`;
  // axes
  svg += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + H}" class="ax"/><line x1="${padL}" y1="${padT + H}" x2="${padL + W}" y2="${padT + H}" class="ax"/>`;
  const yt = key === 'lor' ? [8, 6, 4, 3, 1] : [hi, (hi + lo) / 2, lo];
  for (const v of yt) {
    svg += `<text x="${padL - 6}" y="${y(v) + 5}" class="cl" text-anchor="end">${esc(label(v))}</text>`;
    svg += `<line x1="${padL}" y1="${y(v)}" x2="${padL + W}" y2="${y(v)}" class="grid"/>`;
  }
  svg += `<text x="${padL}" y="${height - 8}" class="cl">${fmtTime(t0)}</text>`;
  if (pts.length > 1) svg += `<text x="${padL + W}" y="${height - 8}" class="cl" text-anchor="end">${fmtTime(t1)}</text>`;
  // line segments: dashed when the segment is a worsening change
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const worse = flags[b.s.id]?.[key]?.worse;
    svg += `<line x1="${x(a.s.t)}" y1="${y(a.v)}" x2="${x(b.s.t)}" y2="${y(b.v)}" class="${worse ? 'seg worse' : 'seg'}"/>`;
  }
  for (const p of pts) {
    const f = flags[p.s.id]?.[key] || {};
    const cx = x(p.s.t), cy = y(p.v);
    if (f.worse) {
      const up = f.dir === 'up';
      const s = 9;
      const tri = up ? `${cx},${cy - s} ${cx - s},${cy + s * 0.7} ${cx + s},${cy + s * 0.7}` : `${cx},${cy + s} ${cx - s},${cy - s * 0.7} ${cx + s},${cy - s * 0.7}`;
      svg += `<polygon points="${tri}" class="pt-worse"/>`;
    } else if (f.abnormal) {
      svg += `<rect x="${cx - 6}" y="${cy - 6}" width="12" height="12" class="pt-abn"/>`;
    } else {
      svg += `<circle cx="${cx}" cy="${cy}" r="5" class="pt"/>`;
    }
  }
  svg += '</svg>';
  return svg;
}

export function chartsFor(vitals, units) {
  return TREND_METRICS.map((m) => trendChart(vitals, m.k, { units })).filter(Boolean);
}
