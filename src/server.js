// HTTP server: dashboard, JSON API, OAuth endpoints, and the MCP endpoint.
// No frameworks, no dependencies — everything is node:http.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { read, update, reset, save, logEvent, id } from './store.js';
import { ensureSeeded, seedDemo } from './seed.js';
import { runDaily, previewRun } from './daily.js';
import { scoreLead } from './scoring.js';
import {
  createSequence,
  approveMessage,
  editMessage,
  sendDue,
  markReplied,
} from './outreach.js';
import {
  authServerMetadata,
  protectedResourceMetadata,
  registerClient,
  authorize,
  exchangeCode,
  verifyBearer,
  consentPage,
} from './oauth.js';
import { handleRpc } from './mcp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');
const PORT = Number(process.env.PORT || 4321);

ensureSeeded();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

async function body(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] || '';
  if (type.includes('application/json')) {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error('invalid JSON body');
    }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function state() {
  const db = read();
  const w = db.workspace;
  const msgs = db.sequences.flatMap((s) => s.messages);
  const byLead = (leadId) => msgs.filter((m) => m.leadId === leadId);

  return {
    workspace: {
      ...w,
      credits: w.credits,
    },
    counts: {
      leads: db.leads.length,
      today: db.leads.filter((l) => l.foundAt.slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
      readyToContact: db.leads.filter((l) => l.contacts?.email?.value || l.contacts?.phone?.value).length,
      drafts: msgs.filter((m) => m.status === 'draft').length,
      approved: msgs.filter((m) => m.status === 'approved').length,
      sent: msgs.filter((m) => m.status === 'sent').length,
      replied: db.leads.filter((l) => l.replied).length,
      creditsLeft: w.credits.remaining,
    },
    leads: db.leads.map((l) => ({
      ...l,
      messages: byLead(l.id).map((m) => ({ id: m.id, kind: m.kind, status: m.status, body: m.body, scheduledFor: m.scheduledFor })),
    })),
    signals: db.signals.map((s) => ({ ...s, used: Boolean(s.usedByLeadId) })),
    sequences: db.sequences,
    runs: db.runs.slice(0, 10),
    events: db.events.slice(0, 40),
    blocked: previewRun().dropped,
  };
}

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

// ---------- dashboard API ----------

route('GET', /^\/api\/state$/, async (req, res) => json(res, 200, state()));

route('POST', /^\/api\/run$/, async (req, res) => {
  const result = runDaily({ source: 'manual' });
  json(res, 200, { ...result, state: state() });
});

route('POST', /^\/api\/leads\/([^/]+)\/rate$/, async (req, res, params) => {
  const { rating } = await body(req);
  update((db) => {
    const lead = db.leads.find((l) => l.id === params[0]);
    if (!lead) throw new Error('lead not found');
    lead.rating = rating;
    if (rating === 'not_a_fit') lead.status = 'hidden';
    logEvent(db, 'lead_rated', { lead: lead.id, rating });
  });
  json(res, 200, { ok: true, state: state() });
});

route('POST', /^\/api\/leads\/([^/]+)\/outcome$/, async (req, res, params) => {
  const { outcome, note } = await body(req);
  update((db) => {
    const lead = db.leads.find((l) => l.id === params[0]);
    if (!lead) throw new Error('lead not found');
    lead.outcome = outcome;
    if (note) lead.outcomeNote = note;
    logEvent(db, 'lead_outcome', { lead: lead.id, outcome });
  });
  json(res, 200, { ok: true, state: state() });
});

route('POST', /^\/api\/leads\/([^/]+)\/replied$/, async (req, res, params) => {
  markReplied(params[0]);
  json(res, 200, { ok: true, state: state() });
});

route('POST', /^\/api\/leads\/([^/]+)\/enrich$/, async (req, res, params) => {
  const { findContacts } = await import('./enrich.js');
  const result = update((db) => {
    const lead = db.leads.find((l) => l.id === params[0]);
    if (!lead) throw new Error('lead not found');
    const c = db.workspace.credits;
    if (c.remaining < 1) throw new Error('no credits left');
    c.remaining -= 1;
    c.usedToday += 1;
    lead.contacts = { ...lead.contacts, ...findContacts(lead.person) };
    return lead.contacts;
  });
  json(res, 200, { ok: true, contacts: result, state: state() });
});

route('POST', /^\/api\/sequences$/, async (req, res) => {
  const { leadIds, name, steps } = await body(req);
  const seq = createSequence({ leadIds, name, steps });
  json(res, 200, { ok: true, sequence: seq, state: state() });
});

route('POST', /^\/api\/messages\/([^/]+)\/approve$/, async (req, res, params) => {
  const msg = approveMessage(params[0]);
  json(res, 200, { ok: true, message: msg, state: state() });
});

route('POST', /^\/api\/messages\/([^/]+)\/edit$/, async (req, res, params) => {
  const { body: text } = await body(req);
  const msg = editMessage(params[0], text);
  json(res, 200, { ok: true, message: msg, state: state() });
});

route('POST', /^\/api\/send$/, async (req, res) => {
  const result = sendDue();
  json(res, 200, { ...result, state: state() });
});

route('POST', /^\/api\/signals$/, async (req, res) => {
  const incoming = await body(req);
  const rows = Array.isArray(incoming) ? incoming : [incoming];
  const created = update((db) => {
    const out = [];
    for (const s of rows) {
      if (!s?.person?.name || !s?.kind) continue;
      const signal = {
        id: id('sig'),
        kind: s.kind,
        person: {
          ...s.person,
          domain: s.person.domain || `${String(s.person.company || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '')}.example`,
        },
        text: s.text || '',
        context: s.context || null,
        url: s.url || '',
        at: s.at || new Date().toISOString(),
        usedByLeadId: null,
        createdAt: new Date().toISOString(),
      };
      db.signals.push(signal);
      out.push(signal);
    }
    logEvent(db, 'signals_ingested', { count: out.length });
    return out;
  });
  json(res, 201, { ingested: created.length, signals: created });
});

route('POST', /^\/api\/watchlist$/, async (req, res) => {
  const { name, url, note } = await body(req);
  const entry = { id: id('w'), name, url, note };
  update((db) => db.workspace.watchlist.push(entry));
  json(res, 200, { ok: true, entry, state: state() });
});

route('POST', /^\/api\/icp$/, async (req, res) => {
  const patch = await body(req);
  update((db) => {
    db.workspace.icp = { ...db.workspace.icp, ...patch };
    if (patch.daily) db.workspace.daily = { ...db.workspace.daily, ...patch.daily };
    logEvent(db, 'icp_updated', { fields: Object.keys(patch) });
  });
  json(res, 200, { ok: true, state: state() });
});

route('POST', /^\/api\/reset$/, async (req, res) => {
  reset();
  seedDemo();
  save();
  json(res, 200, { ok: true, state: state() });
});

route('POST', /^\/api\/preview$/, async (req, res) => {
  // What would a run do right now, without spending anything?
  json(res, 200, previewRun());
});

route('GET', /^\/api\/score$/, async (req, res) => {
  // Playground: score an ad-hoc person against the ICP.
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const person = {
    name: url.searchParams.get('name') || 'Test Person',
    title: url.searchParams.get('title') || 'Owner',
    company: url.searchParams.get('company') || 'Test Co',
    companySize: Number(url.searchParams.get('size') || 30),
    industry: url.searchParams.get('industry') || 'Dental clinics',
    geo: url.searchParams.get('geo') || 'United States',
  };
  const signal = {
    kind: url.searchParams.get('kind') || 'posted',
    text: url.searchParams.get('text') || '',
    at: new Date().toISOString(),
  };
  json(res, 200, scoreLead({ person, signal, icp: read().workspace.icp }));
});

// ---------- MCP + OAuth ----------

route('GET', /^\/\.well-known\/oauth-authorization-server$/, async (req, res) =>
  json(res, 200, authServerMetadata(), { 'access-control-allow-origin': '*' }),
);

route('GET', /^\/\.well-known\/oauth-protected-resource(\/mcp)?$/, async (req, res, params) =>
  json(res, 200, protectedResourceMetadata(params[0] || ''), { 'access-control-allow-origin': '*' }),
);

route('POST', /^\/oauth\/register$/, async (req, res) => {
  try {
    const input = await body(req);
    json(res, 201, registerClient(input), {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      pragma: 'no-cache',
    });
  } catch (err) {
    json(res, 400, { error: 'invalid_client_metadata', error_description: err.message });
  }
});

route('GET', /^\/oauth\/authorize$/, async (req, res) => {
  const q = Object.fromEntries(new URL(req.url, `http://localhost:${PORT}`).searchParams);
  // A real deployment redirects to Clerk here. The prototype shows the consent
  // screen directly because there is exactly one account.
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(consentPage(q));
});

route('POST', /^\/oauth\/authorize$/, async (req, res) => {
  const parsed = await body(req);
  const q = new URLSearchParams(parsed.q || '');
  const params = {
    client_id: q.get('client_id') || parsed.client_id,
    redirect_uri: q.get('redirect_uri') || parsed.redirect_uri,
    state: q.get('state') || parsed.state || '',
    code_challenge: q.get('code_challenge') || parsed.code_challenge,
    code_challenge_method: q.get('code_challenge_method') || 'S256',
    scope: q.get('scope') || parsed.scope || 'raisedhand',
  };
  try {
    const { code } = authorize(params);
    const location = new URL(params.redirect_uri);
    location.searchParams.set('code', code);
    if (params.state) location.searchParams.set('state', params.state);
    res.writeHead(302, { location: location.toString(), 'cache-control': 'no-store' });
    res.end();
  } catch (err) {
    json(res, 400, { error: 'invalid_request', error_description: err.message });
  }
});

route('POST', /^\/oauth\/token$/, async (req, res) => {
  try {
    const input = await body(req);
    const tokens = exchangeCode(input);
    json(res, 200, tokens, { 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  } catch (err) {
    json(res, 400, { error: 'invalid_grant', error_description: err.message }, { 'access-control-allow-origin': '*' });
  }
});

route('GET', /^\/mcp$/, async (req, res) =>
  res.writeHead(405, { allow: 'POST' }).end(),
);

route('POST', /^\/mcp$/, async (req, res) => {
  const auth = verifyBearer(req.headers.authorization);
  const headers = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'WWW-Authenticate' };
  if (!auth) {
    json(
      res,
      401,
      { error: 'unauthorized', error_description: 'Connect with your Raised Hand Lite account.' },
      {
        ...headers,
        'www-authenticate': `Bearer resource_metadata="${authServerMetadata().issuer}/.well-known/oauth-protected-resource/mcp", scope="raisedhand"`,
      },
    );
    return;
  }

  let payload;
  try {
    payload = await body(req);
  } catch (err) {
    json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: err.message } }, headers);
    return;
  }

  const messages = Array.isArray(payload) ? payload : [payload];
  const replies = messages.map((m) => handleRpc(m)).filter(Boolean);
  if (!replies.length) {
    res.writeHead(202, headers);
    res.end();
    return;
  }
  json(res, 200, Array.isArray(payload) ? replies : replies[0], headers);
});

route('OPTIONS', /^\/mcp$/, async (req, res) =>
  res
    .writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
    })
    .end(),
);

route('GET', /^\/health$/, async (req, res) => json(res, 200, { ok: true, leads: read().leads.length }));

// ---------- static ----------

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    // Single-page fallback for client-side routes.
    const fallback = path.join(PUBLIC, 'index.html');
    if (fs.existsSync(fallback)) {
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
      res.end(fs.readFileSync(fallback));
      return;
    }
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': file.endsWith('.html') ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);

  try {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = pathname.match(r.pattern);
      if (m) return await r.handler(req, res, m.slice(1));
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
    json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Raised Hand Lite`);
  console.log(`  dashboard   http://localhost:${PORT}`);
  console.log(`  MCP         http://localhost:${PORT}/mcp`);
  console.log(`  connect     claude mcp add --transport http raised-hand http://localhost:${PORT}/mcp\n`);
});
