import { esc } from './util.js';

// Small dependency-free SVG line chart. series: [{label, color, points:[{t,y}]}]
export function lineChart(series, { yMin = 0, yMax = 10, height = 220 } = {}) {
  const W = 640, H = height, m = { l: 34, r: 14, t: 14, b: 30 };
  const pts = series.flatMap((s) => s.points);
  if (!pts.length) return '<p class="muted">No scored visits yet — enter pain / function scores to see the trend.</p>';
  let t0 = Math.min(...pts.map((p) => p.t));
  let t1 = Math.max(...pts.map((p) => p.t));
  if (t0 === t1) { t0 -= 86400000 * 3; t1 += 86400000 * 3; }
  const x = (t) => m.l + ((t - t0) / (t1 - t0)) * (W - m.l - m.r);
  const y = (v) => H - m.b - ((v - yMin) / (yMax - yMin)) * (H - m.t - m.b);
  const fmt = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  let g = '';
  for (let v = yMin; v <= yMax; v += 2) {
    g += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  const xt = [t0, (t0 + t1) / 2, t1];
  g += xt.map((t, i) => `<text class="tick" x="${x(t)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}">${fmt(t)}</text>`).join('');

  for (const s of series) {
    if (!s.points.length) continue;
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
    g += `<path d="${d}" fill="none" style="stroke:${s.color}" stroke-width="2.5" stroke-linejoin="round"/>`;
    g += s.points.map((p) => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="4.5" style="fill:${s.color}"><title>${esc(s.label)}: ${p.y} on ${fmt(p.t)}</title></circle>`).join('');
  }
  const legend = series.map((s) => `<span class="legend-item"><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="chart" role="img" aria-label="Pain and function trend">${g}</svg><div class="legend">${legend}</div>`;
}
