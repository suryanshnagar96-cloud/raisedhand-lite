// Demo workspace + synthetic LinkedIn signals.
//
// The point is to make the pipeline observable: strong fits, weak likes,
// someone who should be excluded, and one person who appears twice so
// de-duplication is visible.

import { read, reset, save, id, update } from './store.js';

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();

export const DEMO_ICP = {
  titles: ['owner', 'founder', 'practice manager', 'operations director', 'coo', 'managing partner', 'general manager'],
  industries: ['dental', 'hvac', 'physio', 'law', 'roofing', 'home services', 'clinic'],
  sizeRange: [10, 200],
  geos: ['United States', 'United Kingdom', 'Canada', 'Australia'],
  keywords: ['missed call', 'after hours', 'receptionist', 'front desk', 'no-show', 'booking', 'phone'],
  negatives: ['student', 'looking for work', 'open to work', 'freelancer', 'agency owner', 'bootcamp'],
};

const people = {
  rachel: {
    name: 'Rachel Okafor',
    title: 'Practice Manager',
    company: 'Whitlock Dental Group',
    companySize: 46,
    industry: 'Dental clinics',
    geo: 'United States',
    url: 'https://www.linkedin.com/in/rachel-okafor-demo',
  },
  marco: {
    name: 'Marco Ruiz',
    title: 'Owner',
    company: 'Ruiz HVAC',
    companySize: 28,
    industry: 'HVAC services',
    geo: 'United States',
    url: 'https://www.linkedin.com/in/marco-ruiz-demo',
  },
  sofia: {
    name: 'Sofia Lindqvist',
    title: 'COO',
    company: 'Northgate Physio',
    companySize: 64,
    industry: 'Physiotherapy clinics',
    geo: 'United Kingdom',
    url: 'https://www.linkedin.com/in/sofia-lindqvist-demo',
  },
  owen: {
    name: 'Owen Brandt',
    title: 'Managing Partner',
    company: 'Brandt & Cole Law',
    companySize: 120,
    industry: 'Law firm',
    geo: 'United States',
    url: 'https://www.linkedin.com/in/owen-brandt-demo',
  },
  tom: {
    name: 'Tom Achebe',
    title: 'Owner',
    company: 'Achebe Roofing',
    companySize: 34,
    industry: 'Roofing',
    geo: 'Canada',
    url: 'https://www.linkedin.com/in/tom-achebe-demo',
  },
  priya: {
    name: 'Priya Raman',
    title: 'Operations Director',
    company: 'Harbor Home Services',
    companySize: 88,
    industry: 'Home services',
    geo: 'Australia',
    url: 'https://www.linkedin.com/in/priya-raman-demo',
  },
  dana: {
    name: 'Dana Whitlock',
    title: 'Founder',
    company: 'Whitlock Dental Studio',
    companySize: 19,
    industry: 'Dental clinics',
    geo: 'United States',
    url: 'https://www.linkedin.com/in/dana-whitlock-demo',
  },
  lauren: {
    name: 'Lauren Pike',
    title: 'Operations Director',
    company: 'Harbor Dental Care',
    companySize: 52,
    industry: 'Dental clinics',
    geo: 'United Kingdom',
    url: 'https://www.linkedin.com/in/lauren-pike-demo',
  },
  // Should not reach you
  student: {
    name: 'Kevin Adeyemi',
    title: 'Student',
    company: 'Self-taught',
    companySize: 1,
    industry: 'Marketing student',
    geo: 'Nigeria',
    url: 'https://www.linkedin.com/in/kevin-adeyemi-demo',
  },
  agency: {
    name: 'Bianca Moretti',
    title: 'Founder',
    company: 'Moretti Growth Agency',
    companySize: 6,
    industry: 'Marketing agency',
    geo: 'Italy',
    url: 'https://www.linkedin.com/in/bianca-moretti-demo',
  },
  // Weak: like only, wrong title
  intern: {
    name: 'Josh Kalani',
    title: 'Marketing Coordinator',
    company: 'Kalani Dental',
    companySize: 22,
    industry: 'Dental clinics',
    geo: 'United States',
    url: 'https://www.linkedin.com/in/josh-kalani-demo',
  },
};

export const DEMO_SIGNALS = [
  {
    person: people.rachel,
    kind: 'posted',
    at: hoursAgo(6),
    text: 'We missed 23 calls last week. How are other practices handling this? Two of them were new patients ready to book.',
    url: 'https://www.linkedin.com/posts/rachel-okafor-demo_missed-calls-activity-1',
  },
  {
    person: people.marco,
    kind: 'commented',
    at: hoursAgo(20),
    text: 'Same here. We need something that answers after hours, otherwise every call after 5pm is money we never see.',
    context: 'Commented under a post about after-hours call handling for HVAC companies',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:2',
  },
  {
    person: people.sofia,
    kind: 'engaged_competitor',
    at: hoursAgo(3),
    text: 'Guide please. We lose bookings every weekend and the front desk is drowning by Monday.',
    context: 'Commented on a competitor post offering a free guide',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:3',
  },
  {
    person: people.owen,
    kind: 'liked',
    at: hoursAgo(70),
    text: 'Liked a post about missed calls costing law firms new clients',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:4',
  },
  {
    person: people.tom,
    kind: 'watchlist',
    at: hoursAgo(96),
    text: 'Liked a post by Hana Moretti (on your watch list) about storm-season call volume',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:5',
  },
  {
    person: people.priya,
    kind: 'new_in_role',
    at: hoursAgo(2),
    text: 'New in role: Operations Director at Harbor Home Services since Sep 2026',
    url: 'https://www.linkedin.com/in/priya-raman-demo',
  },
  {
    person: people.dana,
    kind: 'posted',
    at: hoursAgo(28),
    text: 'Our receptionist spends four hours a day on the phone. We need a booking system that answers the calls we miss.',
    url: 'https://www.linkedin.com/posts/dana-whitlock-demo_reception-activity-7',
  },
  {
    person: people.lauren,
    kind: 'commented',
    at: hoursAgo(12),
    text: 'Anyone using an AI receptionist for a multi-site practice? We have no-shows eating our month.',
    context: 'Commented under a post about AI front desk tools',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:8',
  },
  // Second signal for Rachel: de-dupe should merge these into one lead.
  {
    person: people.rachel,
    kind: 'liked',
    at: hoursAgo(4),
    text: 'Liked a post about recovering missed calls with an AI receptionist',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:9',
  },
  // Excluded: student
  {
    person: people.student,
    kind: 'commented',
    at: hoursAgo(9),
    text: 'I am a student looking for work in marketing, happy to help with your socials.',
    context: 'Commented under a post about hiring a receptionist',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:10',
  },
  // Excluded: another agency
  {
    person: people.agency,
    kind: 'posted',
    at: hoursAgo(30),
    text: 'Agency owners: we book 30 calls a month for dental clinics with our missed-call AI. Comment for the guide.',
    url: 'https://www.linkedin.com/posts/bianca-moretti-demo_agency-activity-11',
  },
  // Weak fit: right industry, wrong title, like only
  {
    person: people.intern,
    kind: 'liked',
    at: hoursAgo(50),
    text: 'Liked a post about front desk automation',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:12',
  },
  // Poor geography + weak signal
  {
    person: {
      name: 'Lars Nyberg',
      title: 'Owner',
      company: 'Nyberg Dental',
      companySize: 12,
      industry: 'Dental clinics',
      geo: 'Sweden',
      url: 'https://www.linkedin.com/in/lars-nyberg-demo',
    },
    kind: 'liked',
    at: hoursAgo(140),
    text: 'Liked a post about clinic marketing',
    url: 'https://www.linkedin.com/feed/update/urn:li:activity:13',
  },
];

export function seedDemo({ resetFirst = false } = {}) {
  if (resetFirst) reset();
  const db = read();
  if (db.workspace && !resetFirst) return { seeded: false, reason: 'workspace already exists' };

  db.workspace = {
    id: id('ws'),
    name: 'Northwind Automation',
    website: 'https://northwind.example',
    services: 'AI receptionist and missed-call recovery for clinics and home service businesses',
    icp: structuredClone(DEMO_ICP),
    blocklist: ['ricky@example.com'],
    watchlist: [
      { id: id('w'), name: 'Hana Moretti', url: 'https://www.linkedin.com/in/hana-moretti-demo', note: 'Posts about clinic operations' },
    ],
    daily: { enabled: true, hourUtc: 8, limit: 10, minFit: 70 },
    credits: { plan: 'trial', remaining: 350, usedToday: 0, day: new Date().toISOString().slice(0, 10), trialEndsAt: new Date(Date.now() + 7 * 864e5).toISOString() },
    linkedin: { status: 'connected', account: 'Northwind Automation' },
    mailbox: { status: 'connected', address: 'hello@northwind.example' },
    createdAt: new Date().toISOString(),
  };

  db.signals = DEMO_SIGNALS.map((s) => ({
    id: id('sig'),
    ...s,
    person: { ...s.person, domain: s.person.company.toLowerCase().replace(/[^a-z0-9]+/g, '') + '.example' },
    usedByLeadId: null,
    createdAt: new Date().toISOString(),
  }));

  save();
  return { seeded: true, signals: db.signals.length };
}

export function ensureSeeded() {
  const db = read();
  if (!db.workspace) seedDemo();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const resetFirst = process.argv.includes('--reset');
  const out = resetFirst ? (reset(), seedDemo(), { seeded: true, reset: true }) : seedDemo();
  console.log(JSON.stringify(out, null, 2));
}
