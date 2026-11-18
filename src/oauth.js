// A small but standards-shaped OAuth 2.1 authorization server for the MCP
// endpoint: metadata discovery, dynamic client registration (RFC 7591),
// authorization code + PKCE (S256), refresh tokens, bearer verification.
//
// The real product puts the same endpoints behind Clerk so a human signs in.
// Here the consent screen is local and the "account" is the single workspace.

import crypto from 'node:crypto';
import { read, update, id, save } from './store.js';

export const SCOPE = 'raisedhand';
const ACCESS_TTL = 60 * 60 * 1000; // 1h
const REFRESH_TTL = 30 * 24 * 60 * 60 * 1000; // 30d

let baseOverride = null;

/** Per-request override, so the same build works on localhost and on a host. */
export function setBaseUrl(url) {
  baseOverride = url ? String(url).replace(/\/$/, '') : null;
}

export const baseUrl = () =>
  baseOverride ||
  (process.env.RH_BASE_URL || `http://localhost:${process.env.PORT || 4321}`).replace(/\/$/, '');

export const authServerMetadata = () => ({
  issuer: baseUrl(),
  authorization_endpoint: `${baseUrl()}/oauth/authorize`,
  token_endpoint: `${baseUrl()}/oauth/token`,
  registration_endpoint: `${baseUrl()}/oauth/register`,
  response_types_supported: ['code'],
  response_modes_supported: ['query'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none'],
  scopes_supported: [SCOPE],
  service_documentation: `${baseUrl()}/docs/HOW-IT-WORKS.md`,
});

export const protectedResourceMetadata = (path = '') => ({
  resource: `${baseUrl()}/mcp${path}`,
  authorization_servers: [baseUrl()],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ['header'],
  resource_name: 'Raised Hand Lite',
});

export function registerClient(input = {}) {
  const redirectUris = Array.isArray(input.redirect_uris) ? input.redirect_uris : [];
  if (!redirectUris.length) throw new Error('redirect_uris is required');
  const client = {
    client_id: `rhc_${id()}`,
    client_name: input.client_name || 'MCP client',
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: SCOPE,
    created_at: Date.now(),
  };
  update((db) => {
    db.clients.push(client);
    if (db.clients.length > 200) db.clients = db.clients.slice(-200);
  });
  return { ...client, client_id_issued_at: Math.floor(client.created_at / 1000) };
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => b64url(crypto.createHash('sha256').update(s).digest());

export function authorize({ client_id, redirect_uri, state, code_challenge, code_challenge_method, scope }) {
  const db = read();
  const client = db.clients.find((c) => c.client_id === client_id);
  if (!client) throw new Error('unknown client_id');
  if (!client.redirect_uris.includes(redirect_uri)) throw new Error('redirect_uri not registered');
  if (code_challenge_method && code_challenge_method !== 'S256') throw new Error('only S256 PKCE is supported');

  const code = `rhcode_${id()}`;
  update((d) => {
    d.codes.push({
      code,
      client_id,
      redirect_uri,
      code_challenge,
      scope: scope || SCOPE,
      expires_at: Date.now() + 5 * 60 * 1000,
      used: false,
    });
  });
  return { code };
}

export function exchangeCode({ grant_type, code, client_id, redirect_uri, code_verifier, refresh_token }) {
  if (grant_type === 'refresh_token') return refresh(refresh_token);

  const db = read();
  const record = db.codes.find((c) => c.code === code);
  if (!record) throw new Error('invalid_grant: unknown code');
  if (record.used) throw new Error('invalid_grant: code already used');
  if (record.expires_at < Date.now()) throw new Error('invalid_grant: code expired');
  if (record.client_id !== client_id) throw new Error('invalid_grant: client mismatch');
  if (redirect_uri && record.redirect_uri !== redirect_uri) throw new Error('invalid_grant: redirect mismatch');
  if (record.code_challenge) {
    if (!code_verifier) throw new Error('invalid_grant: code_verifier required');
    if (sha256(code_verifier) !== record.code_challenge) throw new Error('invalid_grant: PKCE verification failed');
  }

  record.used = true;
  save();
  return issueTokens({ client_id, scope: record.scope });
}

function refresh(token) {
  const db = read();
  const record = db.tokens.find((t) => t.refresh_token === token);
  if (!record || record.refresh_expires_at < Date.now()) throw new Error('invalid_grant: refresh token expired');
  return issueTokens({ client_id: record.client_id, scope: record.scope });
}

function issueTokens({ client_id, scope }) {
  const tokens = {
    access_token: `rhat_${id()}`,
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TTL / 1000),
    refresh_token: `rhrf_${id()}`,
    scope,
    client_id,
    expires_at: Date.now() + ACCESS_TTL,
    refresh_expires_at: Date.now() + REFRESH_TTL,
  };
  update((db) => {
    db.tokens.push(tokens);
    db.tokens = db.tokens.filter((t) => t.refresh_expires_at > Date.now()).slice(-500);
  });
  return {
    access_token: tokens.access_token,
    token_type: 'Bearer',
    expires_in: tokens.expires_in,
    refresh_token: tokens.refresh_token,
    scope,
  };
}

export function verifyBearer(header) {
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  const db = read();
  const record = db.tokens.find((t) => t.access_token === token);
  if (!record || record.expires_at < Date.now()) return null;
  return record;
}

export function consentPage(query) {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const q = new URLSearchParams({
    client_id: query.client_id,
    redirect_uri: query.redirect_uri,
    state: query.state || '',
    code_challenge: query.code_challenge || '',
    code_challenge_method: query.code_challenge_method || 'S256',
    scope: query.scope || SCOPE,
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Allow access · Raised Hand Lite</title>
<link rel="stylesheet" href="/styles.css"></head>
<body class="consent">
<main class="consent-card">
  <div class="brand"><span class="hand">✋</span><span>Raised<b>Hand</b> <em>lite</em></span></div>
  <h1>Allow this app to read your leads?</h1>
  <p><b>${esc(query.client_name || 'An MCP client')}</b> wants to connect to <b>Raised Hand Lite</b>.</p>
  <ul class="consent-scope">
    <li>Read your workspace, ideal customer and leads</li>
    <li>Read and write lead ratings and outcomes</li>
    <li>Run a search or look up a contact <b>only when you say yes in chat</b></li>
    <li class="no">It cannot send messages, edit your ICP, or see your password</li>
  </ul>
  <form method="post" action="/oauth/authorize">
    <input type="hidden" name="q" value="${esc(q.toString())}">
    <button class="btn primary" type="submit">Allow</button>
    <a class="btn" href="/">Cancel</a>
  </form>
  <p class="fine">You are signed in as the single workspace owner. Tokens last 1 hour and refresh for 30 days.</p>
</main></body></html>`;
}
