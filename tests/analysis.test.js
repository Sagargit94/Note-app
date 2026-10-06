import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, trend, scanRedFlags } from '../js/analysis.js';

const d = (n) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();
const visit = (day, pain, fn, extra = {}) => ({ id: 'v' + day, date: d(day), pain, function: fn, ...extra });

test('improving patient is on track', () => {
  const a = analyze({}, [visit(0, 8, 3), visit(7, 6, 5), visit(14, 4, 7)], Date.parse(d(15)));
  assert.equal(a.status, 'on-track');
  assert.equal(a.pain.change, -4);
  assert.equal(a.function.direction, 'improving');
});

test('worsening pain raises alert and priority suggestion', () => {
  const a = analyze({}, [visit(0, 3, 6), visit(7, 6, 4)], Date.parse(d(8)));
  assert.equal(a.status, 'worsening');
  assert.ok(a.alerts.some((t) => t.includes('Pain rose')));
  assert.ok(a.suggestions.some((s) => s.priority === 'high'));
});

test('plateau detected over last three visits', () => {
  const a = analyze({}, [visit(0, 7, 3), visit(7, 5, 5), visit(14, 5, 5), visit(21, 5, 5), visit(28, 5, 5)], Date.parse(d(29)));
  assert.equal(a.status, 'plateau');
});

test('plateau not reported when already at goal', () => {
  const t = trend([{ t: 0, y: 1 }, { t: 8 * 864e5, y: 1 }, { t: 16 * 864e5, y: 1 }], { lowerIsBetter: true, atGoal: (y) => y <= 2 });
  assert.equal(t.plateau, false);
});

test('single visit is baseline; no visits is no-data', () => {
  assert.equal(analyze({}, [visit(0, 6, 4)]).status, 'baseline');
  assert.equal(analyze({}, []).status, 'no-data');
});

test('red flags found but negated mentions ignored', () => {
  const flags = scanRedFlags([
    { id: 'a', date: d(0), subjective: 'Denies bladder dysfunction. No night pain.' },
    { id: 'b', date: d(7), subjective: 'Reports pain at night waking him. Some saddle numbness since Monday' },
  ]);
  const labels = flags.map((f) => f.label);
  assert.ok(labels.some((l) => l.includes('Night')));
  assert.ok(labels.some((l) => l.includes('cauda equina')));
  assert.equal(flags.length, 2);
});

test('lost-to-follow-up alert for active patients only', () => {
  const vs = [visit(0, 5, 5)];
  assert.ok(analyze({ status: 'active' }, vs, Date.parse(d(40))).alerts.some((t) => t.includes('No visit in')));
  assert.equal(analyze({ status: 'discharged' }, vs, Date.parse(d(40))).alerts.length, 0);
});

test('measures: lower-is-better direction respected', () => {
  const vs = [
    { id: '1', date: d(0), measures: [{ name: 'TUG', value: '14', unit: 's', better: 'down' }] },
    { id: '2', date: d(14), measures: [{ name: 'tug', value: '10', unit: 's', better: 'down' }] },
  ];
  const a = analyze({}, vs, Date.parse(d(15)));
  assert.equal(a.measures.length, 1);
  assert.equal(a.measures[0].direction, 'improving');
});
