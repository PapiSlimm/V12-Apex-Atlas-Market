import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOrionPrime, orionPrimeConfigFromEnv, type OrionPrimeConfig } from '../server/orion-prime';

const CONFIG: OrionPrimeConfig = { baseUrl: 'https://example.invalid', timeoutMs: 500 };

/** The exact body the live service returned when probed. */
const LIVE_BODY = JSON.stringify({
  status: 'online',
  system: 'ORION PRIME MEGA (O.P.M.)',
  version: 'v12.4.0-MULTIMEDIA-ENTERPRISE',
  timestamp: '2026-08-08T21:31:49.032Z',
  aiConnected: true,
});

const respond = (body: string, init: ResponseInit = {}) =>
  (async () => new Response(body, { status: 200, ...init })) as unknown as typeof fetch;

test('parses the real Orion Prime health document', async () => {
  const status = await checkOrionPrime(CONFIG, respond(LIVE_BODY));
  assert.equal(status.state, 'online');
  if (status.state !== 'online') return;
  assert.equal(status.health.system, 'ORION PRIME MEGA (O.P.M.)');
  assert.equal(status.health.version, 'v12.4.0-MULTIMEDIA-ENTERPRISE');
  assert.equal(status.health.aiConnected, true);
});

test('a 200 of console HTML is not treated as health', async () => {
  // This is the actual failure mode: the SPA catch-all answers 200 with HTML
  // for any route that does not exist. Treating that as "online" would report
  // a service as healthy on the strength of it serving a web page.
  const status = await checkOrionPrime(CONFIG, respond('<!doctype html><title>ORION PRIME</title>'));
  assert.equal(status.state, 'unreachable');
  if (status.state !== 'unreachable') return;
  assert.equal(status.reason, 'not_json');
});

test('valid JSON of the wrong shape is refused', async () => {
  const status = await checkOrionPrime(CONFIG, respond(JSON.stringify({ hello: 'world' })));
  assert.equal(status.state, 'unreachable');
});

test('a non-2xx response is unreachable, not a throw', async () => {
  const status = await checkOrionPrime(CONFIG, respond('', { status: 503 }));
  assert.equal(status.state, 'unreachable');
  if (status.state !== 'unreachable') return;
  assert.equal(status.reason, 'http_503');
});

test('a network failure never propagates to the caller', async () => {
  const boom = (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
  const status = await checkOrionPrime(CONFIG, boom);
  assert.equal(status.state, 'unreachable');
  if (status.state !== 'unreachable') return;
  assert.equal(status.reason, 'network_error');
});

test('unconfigured means no call is made at all', async () => {
  let called = false;
  const spy = (async () => {
    called = true;
    return new Response(LIVE_BODY);
  }) as unknown as typeof fetch;

  const status = await checkOrionPrime({ baseUrl: null, timeoutMs: 500 }, spy);
  assert.equal(status.state, 'disabled');
  assert.equal(called, false, 'a disabled integration must not touch the network');
});

test('a plaintext http peer URL is refused', () => {
  const config = orionPrimeConfigFromEnv({ ORION_PRIME_URL: 'http://orion-prime.example.com' } as NodeJS.ProcessEnv);
  assert.equal(config.baseUrl, null);
});

test('localhost over http is allowed, for development only', () => {
  const config = orionPrimeConfigFromEnv({ ORION_PRIME_URL: 'http://localhost:4000' } as NodeJS.ProcessEnv);
  assert.equal(config.baseUrl, 'http://localhost:4000');
});

test('the URL is reduced to an origin, so a path cannot smuggle in', () => {
  const config = orionPrimeConfigFromEnv({
    ORION_PRIME_URL: 'https://orion-prime-wkvl.onrender.com/some/path?x=1',
  } as NodeJS.ProcessEnv);
  assert.equal(config.baseUrl, 'https://orion-prime-wkvl.onrender.com');
});

test('garbage in the environment disables rather than crashes the boot', () => {
  const config = orionPrimeConfigFromEnv({ ORION_PRIME_URL: 'not a url' } as NodeJS.ProcessEnv);
  assert.equal(config.baseUrl, null);
});
