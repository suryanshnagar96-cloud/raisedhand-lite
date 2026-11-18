import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rh-oauth-'));
process.env.RH_DATA_DIR = dir;
process.env.RH_BASE_URL = 'http://localhost:4321';

const { seedDemo } = await import('../src/seed.js');
const oauth = await import('../src/oauth.js');
const mcp = await import('../src/mcp.js');

seedDemo({ resetFirst: true });

const challengeFor = (v) => crypto.createHash('sha256').update(v).digest('base64url');
const redirect = 'http://127.0.0.1:9999/callback';

function fullFlow() {
  const client = oauth.registerClient({
    client_name: 'Test Agent',
    redirect_uris: [redirect],
    token_endpoint_auth_method: 'none',
  });
  const verifier = crypto.randomBytes(32).toString('base64url');
  const { code } = oauth.authorize({
    client_id: client.client_id,
    redirect_uri: redirect,
    state: 'abc',
    code_challenge: challengeFor(verifier),
    code_challenge_method: 'S256',
  });
  const tokens = oauth.exchangeCode({
    grant_type: 'authorization_code',
    code,
    client_id: client.client_id,
    redirect_uri: redirect,
    code_verifier: verifier,
  });
  return { client, verifier, code, tokens };
}

test('metadata advertises exactly what an MCP client must discover', () => {
  const meta = oauth.authServerMetadata();
  assert.equal(meta.issuer, 'http://localhost:4321');
  assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(meta.grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.deepEqual(meta.scopes_supported, ['raisedhand']);

  const pr = oauth.protectedResourceMetadata('/mcp');
  assert.equal(pr.resource, 'http://localhost:4321/mcp/mcp');
  assert.equal(pr.authorization_servers[0], 'http://localhost:4321');
});

test('dynamic client registration issues a public client with no secret', () => {
  const client = oauth.registerClient({ client_name: 'Agent', redirect_uris: [redirect] });
  assert.match(client.client_id, /^rhc_/);
  assert.equal(client.token_endpoint_auth_method, 'none');
  assert.equal(client.client_secret, undefined);
  assert.ok(client.client_id_issued_at > 0);
});

test('authorization code + PKCE issues a usable bearer token', () => {
  const { tokens } = fullFlow();
  assert.match(tokens.access_token, /^rhat_/);
  assert.equal(tokens.token_type, 'Bearer');
  assert.ok(tokens.expires_in > 0);
  assert.ok(tokens.refresh_token);

  const record = oauth.verifyBearer(`Bearer ${tokens.access_token}`);
  assert.ok(record);
  assert.equal(oauth.verifyBearer(`Bearer nope`), null);
  assert.equal(oauth.verifyBearer(undefined), null);
});

test('PKCE is actually enforced', () => {
  const client = oauth.registerClient({ redirect_uris: [redirect] });
  const { code } = oauth.authorize({
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: challengeFor('the-real-verifier'),
    code_challenge_method: 'S256',
  });
  assert.throws(
    () =>
      oauth.exchangeCode({
        grant_type: 'authorization_code',
        code,
        client_id: client.client_id,
        redirect_uri: redirect,
        code_verifier: 'a-different-verifier',
      }),
    /PKCE/,
  );
});

test('an authorization code can only be used once', () => {
  const client = oauth.registerClient({ redirect_uris: [redirect] });
  const verifier = crypto.randomBytes(16).toString('base64url');
  const { code } = oauth.authorize({
    client_id: client.client_id,
    redirect_uri: redirect,
    code_challenge: challengeFor(verifier),
    code_challenge_method: 'S256',
  });
  const args = {
    grant_type: 'authorization_code',
    code,
    client_id: client.client_id,
    redirect_uri: redirect,
    code_verifier: verifier,
  };
  oauth.exchangeCode(args);
  assert.throws(() => oauth.exchangeCode(args), /already used/);
});

test('unregistered redirect URIs are rejected', () => {
  const client = oauth.registerClient({ redirect_uris: [redirect] });
  assert.throws(
    () => oauth.authorize({ client_id: client.client_id, redirect_uri: 'https://evil.example/cb' }),
    /not registered/,
  );
});

test('refresh tokens mint a new access token', () => {
  const { tokens } = fullFlow();
  const next = oauth.exchangeCode({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
  assert.match(next.access_token, /^rhat_/);
  assert.notEqual(next.access_token, tokens.access_token);
});

test('MCP: initialize and tools/list describe the same twelve tools', () => {
  const init = mcp.handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.serverInfo.name, 'raisedhand-lite');
  assert.ok(init.result.capabilities.tools);

  const list = mcp.handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const names = list.result.tools.map((t) => t.name);
  assert.equal(names.length, 12);
  for (const expected of ['get_workspace', 'get_ideal_customer', 'list_leads', 'get_lead', 'find_leads_now', 'rate_lead', 'set_lead_outcome']) {
    assert.ok(names.includes(expected), `missing ${expected}`);
  }
});

test('MCP: reads work and return structured content', () => {
  const call = mcp.handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_workspace', arguments: {} } });
  assert.ok(call.result.content[0].text.includes('Northwind Automation'));
  assert.equal(call.result.structuredContent.daily.limit, 10);
});

test('MCP: anything that spends credits refuses without confirm:true', () => {
  const call = mcp.handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'find_leads_now', arguments: {} } });
  const body = call.result.content[0].text;
  assert.match(body, /confirm: true/);
  assert.match(body, /credits/);
});

test('MCP: a confirmed search spends credits and creates leads', () => {
  const before = mcp.callTool('get_workspace').structuredContent.credits.remaining;
  const call = mcp.handleRpc({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'find_leads_now', arguments: { confirm: true } },
  });
  assert.ok(!call.result.isError);
  const after = mcp.callTool('get_workspace').structuredContent.credits.remaining;
  const created = call.result.structuredContent.created.length;
  assert.equal(before - after, created);
});

test('MCP: unknown tools and methods return protocol errors', () => {
  const bad = mcp.handleRpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'drop_database' } });
  assert.equal(bad.error.code, -32602);
  const missing = mcp.handleRpc({ jsonrpc: '2.0', id: 7, method: 'nope' });
  assert.equal(missing.error.code, -32601);
});

test('MCP: rating a lead changes the stored record', () => {
  const lead = mcp.callTool('list_leads', { limit: 1 }).structuredContent.leads[0];
  mcp.handleRpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'rate_lead', arguments: { lead_id: lead.id, rating: 'good' } } });
  const detail = mcp.callTool('get_lead', { lead_id: lead.id });
  assert.ok(detail.content[0].text.includes('rated good'));
});
