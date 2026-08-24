import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import {
  OrionClient,
  OrionError,
  canonicalString,
  orionClientConfigFromEnv,
  type OrionClientConfig,
} from '../server/orion-client';

const keypair = crypto.generateKeyPairSync('ed25519');
const PRIVATE_KEY = keypair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const PUBLIC_KEY = keypair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

const CONFIG: OrionClientConfig = {
  orionUrl: 'https://orion.invalid',
  appId: 'v12-apex-atlas',
  realm: 'v12-ecosystem',
  privateKey: PRIVATE_KEY,
  timeoutMs: 500,
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function recorder(handler: (call: number) => Response): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: String(init.body ?? ''),
    });
    return handler(calls.length);
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const ok = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200 });

// ---------------------------------------------------------------- the contract

test('the canonical string is exactly the eight documented lines', () => {
  const canonical = canonicalString({
    realm: 'v12-ecosystem',
    appId: 'v12-apex-atlas',
    method: 'post',
    requestTarget: '/v1/ask',
    body: '{"prompt":"hello"}',
    timestamp: '1785792025301',
    nonce: 'fixed-nonce',
  });

  const lines = canonical.split('\n');
  assert.equal(lines.length, 8, 'the canonical string is eight newline-separated fields');
  assert.equal(lines[0], 'orion-v2');
  assert.equal(lines[1], 'v12-ecosystem');
  assert.equal(lines[2], 'v12-apex-atlas');
  assert.equal(lines[3], 'POST', 'the method is upper-cased');
  assert.equal(lines[4], '/v1/ask');
  assert.equal(lines[5], crypto.createHash('sha256').update('{"prompt":"hello"}').digest('hex'));
  assert.equal(lines[6], '1785792025301');
  assert.equal(lines[7], 'fixed-nonce');
});

test('the query string is inside the signature', () => {
  // The bug this guards: signing only the path leaves ?limit=20 rewritable to
  // ?limit=100000 in flight, and the signature still verifies.
  const withQuery = canonicalString({
    realm: 'r', appId: 'a', method: 'GET', requestTarget: '/v1/audit?limit=20',
    body: '', timestamp: '1', nonce: 'n',
  });
  const withoutQuery = canonicalString({
    realm: 'r', appId: 'a', method: 'GET', requestTarget: '/v1/audit',
    body: '', timestamp: '1', nonce: 'n',
  });
  assert.notEqual(withQuery, withoutQuery);
});

test('the signature actually verifies against the public half', async () => {
  const { fetch: impl, calls } = recorder(() => ok({ answer: 'x', routedTo: 'general' }));
  await new OrionClient(CONFIG, impl).ask('reconcile royalties');

  const sent = calls[0];
  const canonical = canonicalString({
    realm: sent.headers['x-orion-realm'],
    appId: sent.headers['x-orion-app'],
    method: 'POST',
    requestTarget: '/v1/ask',
    body: sent.body,
    timestamp: sent.headers['x-orion-timestamp'],
    nonce: sent.headers['x-orion-nonce'],
  });

  const verified = crypto.verify(
    null,
    Buffer.from(canonical, 'utf8'),
    crypto.createPublicKey({ key: Buffer.from(PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' }),
    Buffer.from(sent.headers['x-orion-signature'], 'base64'),
  );
  assert.equal(verified, true, 'a broker holding only the public key can verify this request');
});

test('the private key never leaves the process', async () => {
  const { fetch: impl, calls } = recorder(() => ok({ answer: 'x' }));
  await new OrionClient(CONFIG, impl).ask('anything');

  const wire = JSON.stringify(calls[0]);
  assert.ok(!wire.includes(PRIVATE_KEY), 'the private key must not appear on the wire');
  assert.ok(!wire.includes('MC4CAQAwBQYDK2Vw'), 'no PKCS8 preamble anywhere in the request');
});

// ------------------------------------------------------------------- behaviour

test('relay is never retried, even on a transport failure', async () => {
  let attempts = 0;
  const impl = (async () => {
    attempts += 1;
    throw new Error('ECONNRESET');
  }) as unknown as typeof fetch;

  const client = new OrionClient(CONFIG, impl);
  await assert.rejects(() => client.relay('nexion', '/api/ecosystem/ping'));
  assert.equal(attempts, 1, 'Orion may have delivered the request and lost the response');
});

test('an idempotent call is retried, with a fresh nonce every attempt', async () => {
  const { fetch: impl, calls } = recorder((n) =>
    n < 3 ? new Response('{"error":"busy"}', { status: 503 }) : ok({ answer: 'done', routedTo: 'ops' }),
  );
  const result = await new OrionClient(CONFIG, impl).ask('warehouse throughput');
  assert.equal(result.answer, 'done');
  assert.equal(calls.length, 3);

  const nonces = new Set(calls.map((c) => c.headers['x-orion-nonce']));
  assert.equal(nonces.size, 3, 'reusing a nonce would be refused as a replay');
});

test('an authorisation failure is not retried', async () => {
  const { fetch: impl, calls } = recorder(() => new Response('{"error":"Unauthorised."}', { status: 401 }));
  await assert.rejects(
    () => new OrionClient(CONFIG, impl).ask('let me in'),
    (err: OrionError) => err.kind === 'unauthorised',
  );
  assert.equal(calls.length, 1, 'a 401 will still be a 401 next time');
});

test('a refusal by the target surfaces as forbidden', async () => {
  const { fetch: impl } = recorder(() => new Response('{"error":"Relay rejected."}', { status: 403 }));
  await assert.rejects(
    () => new OrionClient(CONFIG, impl).relay('nexion', '/api/execution/order', { method: 'POST' }),
    (err: OrionError) => err.kind === 'forbidden',
  );
});

// --------------------------------------------------------------- configuration

test('no private key means outbound is disabled, not half-configured', () => {
  const config = orionClientConfigFromEnv({ ORION_URL: 'https://orion.example.com' } as NodeJS.ProcessEnv);
  assert.equal(config.orionUrl, null);
  assert.equal(new OrionClient(config).enabled, false);
});

test('a disabled client makes no network call at all', async () => {
  let called = false;
  const spy = (async () => {
    called = true;
    return ok({});
  }) as unknown as typeof fetch;

  const client = new OrionClient({ ...CONFIG, orionUrl: null }, spy);
  await assert.rejects(() => client.ask('hello'), (err: OrionError) => err.kind === 'disabled');
  assert.equal(called, false);
});

test('a plaintext broker URL is refused', () => {
  const config = orionClientConfigFromEnv({
    ORION_URL: 'http://orion.example.com',
    ORION_PRIVATE_KEY: PRIVATE_KEY,
  } as NodeJS.ProcessEnv);
  assert.equal(config.orionUrl, null);
});

test('this app defaults to its own identity in the ecosystem', () => {
  const config = orionClientConfigFromEnv({} as NodeJS.ProcessEnv);
  assert.equal(config.appId, 'v12-apex-atlas');
  assert.equal(config.realm, 'v12-ecosystem');
});
