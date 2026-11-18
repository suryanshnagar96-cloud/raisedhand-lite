import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-pipeline-'));
process.env.RH_DATA_DIR = dir;

const store = await import('../src/store.js');
const seed = await import('../src/seed.js');
const daily = await import('../src/daily.js');
const outreach = await import('../src/outreach.js');

seed.seedDemo({ resetFirst: true });

test('the demo seeds one workspace and a pile of signals', () => {
  const db = store.read();
  assert.equal(db.workspace.name, 'Northwind Automation');
  assert.ok(db.signals.length >= 10);
});

test('a run respects the daily limit and the minimum fit', () => {
  store.update((db) => {
    db.workspace.daily.limit = 10;
    db.workspace.daily.minFit = 70;
  });
  const result = daily.runDaily();
  assert.ok(result.leads.length >= 3 && result.leads.length <= 10, `got ${result.leads.length}`);
  for (const lead of result.leads) {
    assert.ok(lead.fit >= 70, `lead ${lead.fit} below minimum`);
    assert.ok(lead.evidence.length >= 1);
    assert.ok(lead.reasons.length >= 1);
  }
  // Best-first ordering
  const fits = result.leads.map((l) => l.fit);
  assert.deepEqual(fits, [...fits].sort((a, b) => b - a));
});

test('credits are spent one per lead', () => {
  const db = store.read();
  assert.equal(db.workspace.credits.remaining, 350 - db.leads.length);
});

test('the excluded profiles never become leads', () => {
  const db = store.read();
  const names = db.leads.map((l) => l.person.name);
  assert.ok(!names.includes('Kevin Adeyemi'), 'student leaked through');
  assert.ok(!names.includes('Bianca Moretti'), 'agency leaked through');
});

test('the same person with two signals becomes one lead with both signals', () => {
  const db = store.read();
  const rachel = db.leads.filter((l) => l.person.name === 'Rachel Okafor');
  assert.equal(rachel.length, 1);
  assert.equal(rachel[0].evidence.length, 2);
});

test('a second run does not duplicate anyone', () => {
  const before = store.read().leads.length;
  const result = daily.runDaily();
  const after = store.read().leads.length;
  assert.equal(after, before + result.leads.length);
  const urls = store.read().leads.map((l) => l.person.url);
  assert.equal(new Set(urls).size, urls.length);
});

test('previewRun spends nothing', () => {
  const before = store.read().workspace.credits.remaining;
  daily.previewRun();
  assert.equal(store.read().workspace.credits.remaining, before);
});

test('a run with no credits produces nothing and says which cap bound it', () => {
  store.update((db) => {
    db.workspace.credits.remaining = 0;
  });
  const plan = daily.previewRun();
  assert.equal(plan.willTake, 0);
  assert.equal(plan.creditsLeft, 0);
});

test('outreach drafts wait for approval and follow-ups depend on the previous step', () => {
  store.update((db) => {
    db.workspace.credits.remaining = 50;
    db.sequences = [];
  });
  const leads = store.read().leads.slice(0, 2);
  const seq = outreach.createSequence({ leadIds: leads.map((l) => l.id) });

  const messages = seq.messages;
  assert.equal(messages.filter((m) => m.kind === 'invite').every((m) => m.status === 'approved'), true);
  assert.equal(messages.filter((m) => m.kind !== 'invite').every((m) => m.status === 'draft'), true);

  const due = outreach.sendDue();
  assert.equal(due.sent.filter((m) => m.kind === 'invite').length, 2);
  // The message step is scheduled a day out, so nothing else goes.
  assert.equal(due.sent.filter((m) => m.kind === 'message').length, 0);
});

test('an approved message with zero delay goes out right after the invite', () => {
  store.update((db) => {
    db.sequences = [];
  });
  const lead = store.read().leads[0];
  const seq = outreach.createSequence({
    leadIds: [lead.id],
    steps: [
      { type: 'invite', afterDays: 0, body: 'Hi {{first_name}}' },
      { type: 'message', afterDays: 0, body: 'About {{their_words}}' },
    ],
  });
  for (const msg of seq.messages) {
    if (msg.status === 'draft') outreach.approveMessage(msg.id);
  }
  const result = outreach.sendDue();
  assert.equal(result.sent.length, 2);
});

test('a reply stops every pending message for that person', () => {
  const lead = store.read().leads[0];
  const { stopped } = outreach.markReplied(lead.id);
  assert.ok(stopped >= 0);
  const after = store.read().sequences.flatMap((s) => s.messages).filter((m) => m.leadId === lead.id);
  assert.equal(after.every((m) => m.status === 'sent' || m.status === 'stopped'), true);
});
