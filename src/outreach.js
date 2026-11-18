// Outreach: sequences of steps, a hard human approval gate, and a reply stop.
//
// Rules that mirror the real product:
//   - invites may send on their own (within a per-account daily cap)
//   - every message and follow-up lands in "Ready to send" as a draft
//   - a reply stops the rest of that person's sequence, permanently
//   - a follow-up only exists if the previous step actually went out

import { read, update, id, logEvent } from './store.js';
import { labelSignal } from './scoring.js';

export const MAX_INVITES_PER_DAY = 10;
export const EMAIL_PER_MINUTE = 1;

export function renderTemplate(template, lead) {
  const first = lead.person.name.split(' ')[0];
  const headline = lead.evidence?.[0] || {};
  const quote = (headline.text || '').replace(/^Liked a post about /i, '').replace(/^New in role: /i, '');
  return String(template)
    .replaceAll('{{first_name}}', first)
    .replaceAll('{{name}}', lead.person.name)
    .replaceAll('{{company}}', lead.person.company || 'your team')
    .replaceAll('{{their_words}}', quote.slice(0, 140))
    .replaceAll('{{signal}}', labelSignal(headline.kind))
    .replaceAll('{{fit}}', String(lead.fit));
}

export const DEFAULT_STEPS = [
  { type: 'invite', afterDays: 0, body: 'Hi {{first_name}} — saw your post about {{their_words}}. Happy to connect.' },
  { type: 'message', afterDays: 1, body: 'Thanks for connecting, {{first_name}}. You mentioned "{{their_words}}". We set up an AI receptionist for {{company}}-sized teams so after-hours calls get answered and booked instead of lost. Worth a 10-minute look?' },
  { type: 'follow_up', afterDays: 2, body: 'Following up, {{first_name}} — still the same problem at {{company}}? I can send a two-line summary of how the missed-call recovery works.' },
];

export function createSequence({ name, leadIds, steps = DEFAULT_STEPS }) {
  return update((db) => {
    const leads = db.leads.filter((l) => leadIds.includes(l.id));
    if (!leads.length) throw new Error('no leads selected');

    const seq = {
      id: id('seq'),
      name: name || `Outreach · ${new Date().toLocaleDateString()}`,
      status: 'active',
      steps,
      leadIds: leads.map((l) => l.id),
      createdAt: new Date().toISOString(),
      messages: [],
    };

    for (const lead of leads) {
      let day = 0;
      for (const [index, step] of steps.entries()) {
        day += step.afterDays || 0;
        const isInvite = step.type === 'invite';
        seq.messages.push({
          id: id('msg'),
          leadId: lead.id,
          stepIndex: index,
          kind: step.type,
          scheduledFor: new Date(Date.now() + day * 864e5).toISOString(),
          body: renderTemplate(step.body || '', lead),
          status: isInvite ? 'approved' : 'draft',
          sentAt: null,
          stopped: false,
        });
      }
    }

    db.sequences.unshift(seq);
    logEvent(db, 'sequence_created', { sequence: seq.id, leads: leads.length });
    return seq;
  });
}

export function approveMessage(messageId) {
  return update((db) => {
    const msg = db.sequences.flatMap((s) => s.messages).find((m) => m.id === messageId);
    if (!msg) throw new Error('message not found');
    if (msg.status === 'sent') return msg;
    msg.status = 'approved';
    logEvent(db, 'message_approved', { message: msg.id });
    return msg;
  });
}

export function editMessage(messageId, body) {
  return update((db) => {
    const msg = db.sequences.flatMap((s) => s.messages).find((m) => m.id === messageId);
    if (!msg) throw new Error('message not found');
    if (msg.status === 'sent') throw new Error('already sent');
    msg.body = body;
    return msg;
  });
}

/**
 * Send everything approved whose slot has arrived. Enforces the invite cap and
 * skips anyone who replied.
 */
export function sendDue({ now = new Date() } = {}) {
  return update((db) => {
    const sentToday = db.sequences
      .flatMap((s) => s.messages)
      .filter((m) => m.kind === 'invite' && m.sentAt && m.sentAt.slice(0, 10) === now.toISOString().slice(0, 10))
      .length;

    let invitesLeft = Math.max(0, MAX_INVITES_PER_DAY - sentToday);
    const sent = [];
    const blocked = [];

    for (const seq of db.sequences) {
      if (seq.status !== 'active') continue;
      for (const msg of seq.messages) {
        if (msg.status !== 'approved') continue;
        if (new Date(msg.scheduledFor) > now) continue;
        const lead = db.leads.find((l) => l.id === msg.leadId);
        if (!lead) continue;

        if (lead.replied) {
          msg.stopped = true;
          msg.status = 'stopped';
          blocked.push({ message: msg.id, reason: 'lead replied' });
          continue;
        }
        if (msg.kind === 'invite') {
          if (invitesLeft <= 0) {
            blocked.push({ message: msg.id, reason: 'invite cap reached (10/day)' });
            continue;
          }
          invitesLeft -= 1;
        }

        // A follow-up depends on the previous step having actually gone out.
        const previous = seq.messages.find((m) => m.leadId === msg.leadId && m.stepIndex === msg.stepIndex - 1);
        if (previous && previous.status !== 'sent') {
          blocked.push({ message: msg.id, reason: 'previous step not sent' });
          continue;
        }

        msg.status = 'sent';
        msg.sentAt = now.toISOString();
        sent.push(msg);
      }
    }

    if (sent.length) logEvent(db, 'messages_sent', { count: sent.length });
    return { sent, blocked };
  });
}

/** Reply detection. This is the one-way door: it stops the whole sequence. */
export function markReplied(leadId) {
  return update((db) => {
    const lead = db.leads.find((l) => l.id === leadId);
    if (!lead) throw new Error('lead not found');
    lead.replied = true;
    lead.status = 'replied';
    let stopped = 0;
    for (const seq of db.sequences) {
      for (const msg of seq.messages) {
        if (msg.leadId === leadId && msg.status !== 'sent') {
          msg.status = 'stopped';
          msg.stopped = true;
          stopped += 1;
        }
      }
    }
    logEvent(db, 'reply_stopped', { lead: leadId, messages: stopped });
    return { lead, stopped };
  });
}

export function sequenceSummary() {
  const db = read();
  const msgs = db.sequences.flatMap((s) => s.messages);
  return {
    sequences: db.sequences.length,
    drafts: msgs.filter((m) => m.status === 'draft').length,
    approved: msgs.filter((m) => m.status === 'approved').length,
    sent: msgs.filter((m) => m.status === 'sent').length,
    stopped: msgs.filter((m) => m.status === 'stopped').length,
  };
}
