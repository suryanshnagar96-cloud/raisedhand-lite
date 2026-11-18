// The daily run: signals in, qualified leads out.
//
// This is the core loop the whole product is built around, so the accounting is
// explicit: what was seen, what was dropped and why, what it cost.

import { read, update, id, logEvent } from './store.js';
import { scoreLead, bestSignal } from './scoring.js';
import { findContacts } from './enrich.js';

const today = () => new Date().toISOString().slice(0, 10);

export function ensureAllowance(ws, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  if (ws.credits.day !== day) {
    ws.credits.day = day;
    ws.credits.usedToday = 0;
  }
  return ws.credits;
}

export function groupSignals(signals) {
  const byPerson = new Map();
  for (const signal of signals) {
    const key = signal.person.url || signal.person.name;
    if (!byPerson.has(key)) byPerson.set(key, []);
    byPerson.get(key).push(signal);
  }
  return byPerson;
}

/**
 * Preview a run without writing anything. Used by the UI and by
 * find_leads_now so the user can be told what a search will cost.
 */
export function previewRun({ now = Date.now() } = {}) {
  const db = read();
  const ws = db.workspace;
  if (!ws) return { error: 'no workspace' };

  const existing = new Set(db.leads.map((l) => l.person.url));
  const fresh = db.signals.filter((s) => !s.usedByLeadId);
  const groups = groupSignals(fresh);

  const scored = [];
  const dropped = [];

  for (const [key, signals] of groups) {
    if (existing.has(key)) {
      dropped.push({ key, reason: 'already a lead' });
      continue;
    }
    const headline = bestSignal(signals);
    const verdict = scoreLead({ person: headline.person, signal: headline, icp: ws.icp, now });
    const row = {
      key,
      person: headline.person,
      signals,
      headline,
      ...verdict,
    };
    if (!verdict.eligible) dropped.push({ key, reason: verdict.reasons[0], fit: verdict.fit });
    else if (verdict.fit < ws.daily.minFit) dropped.push({ key, reason: `below minimum fit (${ws.daily.minFit})`, fit: verdict.fit });
    else scored.push(row);
  }

  scored.sort((a, b) => b.fit - a.fit);
  const credits = ensureAllowance(ws);
  const roomByPlan = Math.max(0, ws.daily.limit - credits.usedToday);
  const roomByCredits = Math.max(0, credits.remaining);
  const take = Math.min(scored.length, roomByPlan, roomByCredits);

  return {
    eligible: scored.length,
    willTake: take,
    cappedBy: take === scored.length ? null : take === roomByPlan ? 'daily limit' : 'credits',
    creditsLeft: credits.remaining,
    cost: take,
    leads: scored.slice(0, take),
    dropped,
  };
}

/**
 * Execute a run. Returns the new leads plus a full accounting of the decision.
 */
export function runDaily({ now = new Date(), source = 'daily' } = {}) {
  return update((db) => {
    const ws = db.workspace;
    if (!ws) throw new Error('no workspace');
    if (source === 'daily' && !ws.daily.enabled) {
      return { skipped: true, reason: 'daily search is paused' };
    }

    const plan = previewRun({ now: now.getTime() });
    const credits = ensureAllowance(ws, now);
    const created = [];

    for (const row of plan.leads) {
      const contacts = findContacts(row.person);
      const lead = {
        id: id('lead'),
        person: row.person,
        fit: row.fit,
        reasons: row.reasons,
        qualification: row.qualification,
        contacts,
        signalIds: row.signals.map((s) => s.id),
        evidence: row.signals.map((s) => ({
          kind: s.kind,
          text: s.text,
          context: s.context || null,
          url: s.url,
          at: s.at,
        })),
        foundAt: now.toISOString(),
        search: source,
        status: 'new',
        rating: null,
        outcome: null,
        replied: false,
      };
      db.leads.unshift(lead);
      created.push(lead);
      for (const s of row.signals) s.usedByLeadId = lead.id;
    }

    credits.remaining = Math.max(0, credits.remaining - created.length);
    credits.usedToday += created.length;

    const run = {
      id: id('run'),
      kind: source,
      at: now.toISOString(),
      found: plan.eligible,
      created: created.length,
      dropped: plan.dropped.length,
      credits: created.length,
      cappedBy: plan.cappedBy,
    };
    db.runs.unshift(run);
    logEvent(db, 'run', { run: run.id, created: created.length, source });

    return { run, leads: created, dropped: plan.dropped, credits: { ...credits } };
  });
}

export function todayLeads() {
  const db = read();
  const d = today();
  return db.leads.filter((l) => l.foundAt.slice(0, 10) === d);
}
