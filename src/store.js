// Tiny JSON persistence layer. Deliberately boring: everything is one document,
// written atomically, loaded once per process.
//
// Swap this file for Convex/Postgres in production; the rest of the app only
// talks to read()/update().

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.RH_DATA_DIR || path.join(process.cwd(), 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const empty = () => ({
  version: 1,
  workspace: null,
  signals: [],
  leads: [],
  sequences: [],
  runs: [],
  clients: [],
  tokens: [],
  codes: [],
  events: [],
});

let cache = null;

export function dbPath() {
  return DB_FILE;
}

export function read() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    cache = empty();
  }
  return cache;
}

export function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, DB_FILE);
  return cache;
}

export function update(fn) {
  const db = read();
  const result = fn(db);
  save();
  return result;
}

export function reset() {
  cache = empty();
  save();
  return cache;
}

export function id(prefix = '') {
  const raw = crypto.randomUUID().replace(/-/g, '');
  return prefix ? `${prefix}_${raw.slice(0, 18)}` : raw.slice(0, 18);
}

export function logEvent(db, kind, detail = {}) {
  db.events.unshift({ id: id('evt'), kind, at: new Date().toISOString(), ...detail });
  db.events = db.events.slice(0, 400);
}
