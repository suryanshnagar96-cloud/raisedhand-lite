#!/usr/bin/env node
// Terminal access, for people who would rather not open a browser.

import { read } from './store.js';
import { ensureSeeded } from './seed.js';
import { runDaily, previewRun } from './daily.js';
import { labelSignal } from './scoring.js';
import { createSequence, approveMessage, sendDue, markReplied } from './outreach.js';

ensureSeeded();

const [, , command, ...args] = process.argv;
const db = read();
const w = db.workspace;

const pad = (s, n) => String(s).padEnd(n).slice(0, n);

switch (command) {
  case 'daily': {
    const plan = previewRun();
    console.log(`eligible ${plan.eligible} · will take ${plan.willTake} · ${plan.creditsLeft} credits left`);
    const result = runDaily({ source: 'manual' });
    for (const l of result.leads) {
      console.log(`  ${pad(`${l.fit}%`, 5)} ${pad(l.person.name, 20)} ${pad(l.person.company, 26)} ${labelSignal(l.evidence[0].kind)}`);
    }
    console.log(`created ${result.leads.length} lead(s)`);
    break;
  }

  case 'leads': {
    for (const l of db.leads) {
      console.log(`${pad(`${l.fit}%`, 5)} ${pad(l.person.name, 20)} ${pad(l.person.company, 26)} ${pad(l.id, 22)} ${l.rating || ''}`);
    }
    if (!db.leads.length) console.log('no leads yet — run `npm run run:daily`');
    break;
  }

  case 'show': {
    const lead = db.leads.find((l) => l.id === args[0]) || db.leads.find((l) => l.person.name.toLowerCase().includes((args[0] || '').toLowerCase()));
    if (!lead) {
      console.log('lead not found');
      break;
    }
    console.log(`\n${lead.person.name} — ${lead.person.title} at ${lead.person.company}`);
    console.log(`Fit ${lead.fit}% · ${lead.person.industry} · ${lead.person.companySize} people · ${lead.person.geo}`);
    console.log(`\nWhy:`);
    for (const r of lead.reasons) console.log(`  · ${r}`);
    console.log(`\nEvidence:`);
    for (const e of lead.evidence) console.log(`  · [${e.kind}] ${e.text}\n    ${e.url}`);
    console.log(`\nContacts:`);
    console.log(`  email: ${lead.contacts.email ? `${lead.contacts.email.value} (${lead.contacts.email.verified ? 'verified' : 'unverified'})` : '—'}`);
    console.log(`  phone: ${lead.contacts.phone ? `${lead.contacts.phone.value} (${lead.contacts.phone.verified ? 'verified' : 'unverified'})` : '—'}`);
    break;
  }

  case 'outreach': {
    const ids = args.length ? args : db.leads.slice(0, 3).map((l) => l.id);
    const seq = createSequence({ leadIds: ids });
    console.log(`created ${seq.messages.length} messages across ${seq.leadIds.length} lead(s) — ${seq.id}`);
    break;
  }

  case 'drafts': {
    const drafts = db.sequences.flatMap((s) => s.messages).filter((m) => m.status === 'draft');
    for (const m of drafts) {
      console.log(`\n[${m.id}] ${m.kind} → ${db.leads.find((l) => l.id === m.leadId)?.person.name}`);
      console.log(m.body);
    }
    if (!drafts.length) console.log('no drafts waiting');
    break;
  }

  case 'approve': {
    for (const id of args) approveMessage(id);
    console.log(`approved ${args.length}`);
    break;
  }

  case 'send': {
    const { sent, blocked } = sendDue();
    console.log(`sent ${sent.length}`);
    for (const b of blocked) console.log(`  blocked ${b.message}: ${b.reason}`);
    break;
  }

  case 'replied': {
    const { stopped } = markReplied(args[0]);
    console.log(`stopped ${stopped} pending message(s)`);
    break;
  }

  case 'preview': {
    const plan = previewRun();
    console.log(JSON.stringify({ ...plan, leads: plan.leads.map((l) => ({ name: l.person.name, fit: l.fit })) }, null, 2));
    break;
  }

  default:
    console.log(`
  Raised Hand Lite — ${w.name} (${w.leads ?? ''}${db.leads.length} leads, ${w.credits.remaining} credits)

  node src/cli.js daily             run today's search
  node src/cli.js leads             list leads
  node src/cli.js show <id|name>    full detail with evidence
  node src/cli.js outreach [id...]  draft a sequence
  node src/cli.js drafts            show messages waiting for approval
  node src/cli.js approve <id...>   approve drafts
  node src/cli.js send              send what is approved and due
  node src/cli.js replied <id>      mark a reply (stops the sequence)
  node src/cli.js preview           what a run would do, without spending
`);
}
