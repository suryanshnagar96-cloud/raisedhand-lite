#!/usr/bin/env node
// End-to-end proof that the MCP server is a real one: discover, register,
// authorize with PKCE, exchange the code, then speak JSON-RPC.
//
//   node scripts/smoke.mjs [baseUrl]

import crypto from 'node:crypto';

const base = (process.argv[2] || 'http://localhost:4321').replace(/\/$/, '');
const j = (r) => r.json();
const ok = (label, cond, extra = '') => {
  console.log(`${cond ? '✔' : '✖'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!cond) process.exitCode = 1;
};

// 1. Discovery
const meta = await fetch(`${base}/.well-known/oauth-authorization-server`).then(j);
ok('authorization server metadata', meta.issuer === base && meta.code_challenge_methods_supported.includes('S256'));

const prm = await fetch(`${base}/.well-known/oauth-protected-resource`).then(j);
ok('protected resource metadata', prm.resource === `${base}/mcp`);

// 2. Dynamic client registration
const client = await fetch(`${base}/oauth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_name: 'smoke-test',
    redirect_uris: ['http://127.0.0.1:8765/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }),
}).then(j);
ok('dynamic client registration', client.client_id?.startsWith('rhc_'));

// 3. Unauthenticated MCP call is refused, correctly
const unauthorized = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
});
const challenge = unauthorized.headers.get('www-authenticate') || '';
ok('unauthenticated /mcp is 401', unauthorized.status === 401);
ok('401 points at resource metadata', challenge.includes('resource_metadata='), challenge.slice(0, 60));

// 4. Authorization code + PKCE
const verifier = crypto.randomBytes(32).toString('base64url');
const challengeValue = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(8).toString('hex');

const authorizePage = await fetch(
  `${base}/oauth/authorize?${new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: 'http://127.0.0.1:8765/callback',
    response_type: 'code',
    state,
    code_challenge: challengeValue,
    code_challenge_method: 'S256',
    scope: 'raisedhand',
  })}`,
);
const html = await authorizePage.text();
ok('consent screen renders', authorizePage.status === 200 && html.includes('Allow'));

const form = new URLSearchParams({
  q: new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: 'http://127.0.0.1:8765/callback',
    state,
    code_challenge: challengeValue,
    code_challenge_method: 'S256',
    scope: 'raisedhand',
  }).toString(),
});
const consent = await fetch(`${base}/oauth/authorize`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: form,
  redirect: 'manual',
});
const location = consent.headers.get('location');
const code = location ? new URL(location).searchParams.get('code') : null;
ok('authorization redirects with a code', consent.status === 302 && Boolean(code));

const tokens = await fetch(`${base}/oauth/token`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: client.client_id,
    redirect_uri: 'http://127.0.0.1:8765/callback',
    code_verifier: verifier,
  }),
}).then(j);
ok('token exchange with PKCE', tokens.access_token?.startsWith('rhat_'), tokens.token_type);

// 5. MCP over the bearer token
const rpc = (payload) =>
  fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${tokens.access_token}`,
    },
    body: JSON.stringify(payload),
  }).then(j);

const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } });
ok('initialize', init.result?.serverInfo?.name === 'raisedhand-lite');

const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
ok('tools/list', list.result?.tools?.length === 12, `${list.result?.tools?.length} tools`);

const workspace = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_workspace', arguments: {} } });
ok('tools/call get_workspace', workspace.result?.content?.[0]?.text?.includes('credits'));

const preview = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'find_leads_now', arguments: {} } });
ok('spending tool refuses without confirm', preview.result?.content?.[0]?.text?.includes('confirm: true'));

console.log('\nDone. The dashboard is at', base);
