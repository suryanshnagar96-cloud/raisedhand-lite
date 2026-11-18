import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreLead, bestSignal, SIGNAL_WEIGHT } from '../src/scoring.js';

const icp = {
  titles: ['practice manager', 'owner', 'coo'],
  industries: ['dental', 'hvac'],
  sizeRange: [10, 200],
  geos: ['United States'],
  keywords: ['missed call', 'after hours', 'receptionist'],
  negatives: ['student', 'looking for work'],
};

const person = {
  name: 'Rachel Okafor',
  title: 'Practice Manager',
  company: 'Whitlock Dental Group',
  companySize: 46,
  industry: 'Dental clinics',
  geo: 'United States',
  url: 'https://www.linkedin.com/in/rachel',
};

const post = {
  kind: 'posted',
  text: 'We missed 23 calls last week. How are other practices handling this?',
  at: new Date().toISOString(),
};

test('a strong post from a target title scores high and stays eligible', () => {
  const r = scoreLead({ person, signal: post, icp });
  assert.ok(r.fit >= 85, `expected >= 85, got ${r.fit}`);
  assert.equal(r.eligible, true);
  assert.ok(r.reasons.some((x) => x.includes('Title matches')));
  assert.ok(r.reasons.some((x) => x.includes('missed call')));
});

test('a like with a senior title but no target role is capped below the bar', () => {
  const r = scoreLead({
    person: { ...person, title: 'Marketing Director' },
    signal: { kind: 'liked', text: 'Liked a post about missed calls', at: new Date().toISOString() },
    icp,
  });
  assert.ok(r.fit <= 62, `expected cap at 62, got ${r.fit}`);
  assert.equal(r.eligible, false);
});

test('"COO" does not match inside "Coordinator"', () => {
  const r = scoreLead({
    person: { ...person, title: 'Marketing Coordinator' },
    signal: post,
    icp,
  });
  assert.ok(!r.reasons.some((x) => x.includes('Title matches')), 'substring matched a title');
});

test('the negative list is a hard stop, not a penalty', () => {
  const r = scoreLead({
    person: { ...person, title: 'Student', company: 'Self-taught' },
    signal: { kind: 'commented', text: 'I am a student looking for work, happy to help', at: new Date().toISOString() },
    icp,
  });
  assert.equal(r.eligible, false);
  assert.ok(r.fit <= 25);
  assert.ok(r.reasons[0].startsWith('Excluded'));
});

test('the same signal always produces the same score', () => {
  const a = scoreLead({ person, signal: post, icp, now: Date.parse('2026-11-01T00:00:00Z') });
  const b = scoreLead({ person, signal: post, icp, now: Date.parse('2026-11-01T00:00:00Z') });
  assert.deepEqual(a, b);
});

test('freshness decays the score', () => {
  const now = Date.parse('2026-11-10T00:00:00Z');
  const fresh = scoreLead({ person, signal: { ...post, at: '2026-11-09T23:00:00Z' }, icp, now });
  const stale = scoreLead({ person, signal: { ...post, at: '2026-10-01T00:00:00Z' }, icp, now });
  assert.ok(fresh.fit > stale.fit);
});

test('signal strength is ordered post > comment > like', () => {
  assert.ok(SIGNAL_WEIGHT.posted > SIGNAL_WEIGHT.commented);
  assert.ok(SIGNAL_WEIGHT.commented > SIGNAL_WEIGHT.liked);
});

test('bestSignal picks the strongest kind, not the newest', () => {
  const best = bestSignal([
    { kind: 'liked', at: '2026-11-09T00:00:00Z' },
    { kind: 'posted', at: '2026-10-01T00:00:00Z' },
  ]);
  assert.equal(best.kind, 'posted');
});
