import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import {
  JsonNumber,
  assessProtocol,
  attestationDigest,
  checkFreshness,
  describeAttestation,
  draftToUnsignedMandate,
  importCartMandate,
  importIntentMandate,
  importSharedPaymentToken,
  isApexSignature,
  parseJsonStrict,
  readPayload,
  toCount,
  toMinor,
  verifyCompactJws,
  type ForeignAttestation,
  type ForeignIssuer,
  type ReplayPort,
} from '../server/market/interop';
import { mandateCanonical, verifyMandate, type Mandate } from '../server/market/mandate';
import { participantId, DEFAULT_FEES } from '../server/market/types';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

const SELLER = participantId('acme-render');
const BUYER = participantId('borealis-studios');

/* ---------------------------------------------------------------- *
 * Keys and JWS construction
 * ---------------------------------------------------------------- */

const ed = crypto.generateKeyPairSync('ed25519');
const p256 = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const k256 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
const rogueEd = crypto.generateKeyPairSync('ed25519');

const spki = (kp: crypto.KeyPairKeyObjectResult): string =>
  kp.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

const b64url = (input: Buffer | string): string => Buffer.from(input as never).toString('base64url');

function jws(
  alg: 'EdDSA' | 'ES256' | 'ES256K' | 'none' | 'HS256',
  payload: Record<string, unknown>,
  key: crypto.KeyObject,
  kid = 'k-1',
): string {
  const header = b64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const input = Buffer.from(`${header}.${body}`, 'utf8');
  const signature =
    alg === 'EdDSA' || alg === 'none' || alg === 'HS256'
      ? crypto.sign(null, input, key)
      : crypto.sign('sha256', input, { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${body}.${b64url(signature)}`;
}

const issuer = (over: Partial<ForeignIssuer> = {}): ForeignIssuer => ({
  issuerId: 'did:example:borealis',
  protocol: 'ap2',
  alg: 'EdDSA',
  kid: 'k-1',
  publicKeySpki: spki(ed),
  participant: BUYER,
  ...over,
});

function replayPort(): ReplayPort {
  const seen = new Set<string>();
  return { seen: (id) => seen.has(id), remember: (id) => void seen.add(id) };
}

const admitAll = () => true;

/* ---------------------------------------------------------------- *
 * The JSON reader — Article III at the boundary
 * ---------------------------------------------------------------- */

test('the reader keeps a number\'s literal digits instead of a double', () => {
  const parsed = parseJsonStrict('{"value": 45.99, "big": 900719925474099123}') as Record<string, JsonNumber>;
  assert.ok(parsed.value instanceof JsonNumber);
  assert.equal(parsed.value.literal, '45.99');
  assert.equal(parsed.big.literal, '900719925474099123', 'JSON.parse would have rounded this');
  assert.notEqual(String(JSON.parse('{"big": 900719925474099123}').big), '900719925474099123');
});

test('duplicate keys are refused rather than resolved', () => {
  const result = readPayload('{"total": "10.00", "total": "10000.00"}');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'duplicate_keys');
  assert.match(result.detail, /"total" more than once/);
  assert.match(result.remedy, /Ambiguity about which value is authoritative/);
});

test('trailing content after the top-level value is refused', () => {
  const result = readPayload('{"a": 1} {"a": 2}');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'malformed_payload');
});

test('a top-level array is not a credential', () => {
  const result = readPayload('[1,2,3]');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'malformed_payload');
});

test('the reader handles strings, escapes, nesting and the literals', () => {
  const parsed = parseJsonStrict('{"s":"a\\"b\\u0041\\n","t":true,"f":false,"n":null,"a":[1,[2]],"o":{"k":{}}}') as Record<string, unknown>;
  assert.equal(parsed.s, 'a"bA\n');
  assert.equal(parsed.t, true);
  assert.equal(parsed.f, false);
  assert.equal(parsed.n, null);
  assert.deepEqual((parsed.a as unknown[]).length, 2);
});

test('a JavaScript number reaching a money field is refused, never converted', () => {
  const viaJsonParse = JSON.parse('{"value": 45.99}') as { value: number };
  const result = toMinor(viaJsonParse.value, 'total');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'amount_is_float');
  assert.match(result.detail, /Article III §3.1/);
  assert.match(result.remedy, /parseJsonStrict/);
});

test('exponent notation is refused for money', () => {
  const parsed = parseJsonStrict('{"v": 1e3}') as Record<string, unknown>;
  const result = toMinor(parsed.v, 'v');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'amount_not_decimal');
});

test('excess precision is refused rather than rounded by the receiver', () => {
  const result = toMinor(new JsonNumber('45.999'), 'v');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'amount_not_decimal');
  assert.match(result.remedy, /Round at source/);
});

test('written digits convert exactly to minor units', () => {
  for (const [literal, expected] of [['45.99', 4599n], ['0.01', 1n], ['-3.00', -300n], ['1000', 100_000n]] as const) {
    const result = toMinor(new JsonNumber(literal), 'v');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value, expected);
  }
});

test('quantities must be positive whole numbers', () => {
  assert.equal(toCount(new JsonNumber('3'), 'q').ok, true);
  assert.equal(toCount(new JsonNumber('3.5'), 'q').ok, false);
  assert.equal(toCount(new JsonNumber('0'), 'q').ok, false);
  assert.equal(toCount(undefined, 'q').ok, false);
});

/* ---------------------------------------------------------------- *
 * Signatures — the token does not choose its own algorithm
 * ---------------------------------------------------------------- */

test('a valid Ed25519 credential verifies', () => {
  const token = jws('EdDSA', { intent_mandate_id: 'im-1' }, ed.privateKey);
  const result = verifyCompactJws(token, issuer());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.payload.intent_mandate_id, 'im-1');
});

test('ES256 and ES256K verify when the registered key matches the algorithm', () => {
  const es256 = verifyCompactJws(
    jws('ES256', { id: 'c-1' }, p256.privateKey),
    issuer({ alg: 'ES256', publicKeySpki: spki(p256) }),
  );
  assert.equal(es256.ok, true);

  const es256k = verifyCompactJws(
    jws('ES256K', { id: 'c-1' }, k256.privateKey),
    issuer({ alg: 'ES256K', publicKeySpki: spki(k256) }),
  );
  assert.equal(es256k.ok, true);
});

test('alg: none is refused as a mismatch, not verified', () => {
  const token = jws('none', { intent_mandate_id: 'im-1' }, ed.privateKey);
  const result = verifyCompactJws(token, issuer());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'algorithm_mismatch');
  assert.match(result.detail, /chooses how it will be checked is not a credential/);
});

test('an HMAC algorithm cannot be substituted for the pinned asymmetric one', () => {
  const token = jws('HS256', { intent_mandate_id: 'im-1' }, ed.privateKey);
  const result = verifyCompactJws(token, issuer());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'algorithm_mismatch');
});

test('an unregistered key id is refused before any verification', () => {
  const token = jws('EdDSA', { intent_mandate_id: 'im-1' }, ed.privateKey, 'k-rotated');
  const result = verifyCompactJws(token, issuer());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'key_mismatch');
  assert.match(result.remedy, /rotation is an act rather than an accident/);
});

test('an issuer whose registered key does not match its algorithm is refused', () => {
  const result = verifyCompactJws(
    jws('ES256', { id: 'c-1' }, p256.privateKey),
    issuer({ alg: 'ES256', publicKeySpki: spki(k256) }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'key_mismatch');
});

test('a credential signed by another key does not verify', () => {
  const token = jws('EdDSA', { intent_mandate_id: 'im-1' }, rogueEd.privateKey);
  const result = verifyCompactJws(token, issuer());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'signature_invalid');
});

test('a tampered payload does not verify', () => {
  const token = jws('EdDSA', { intent_mandate_id: 'im-1' }, ed.privateKey);
  const [header, , signature] = token.split('.');
  const swapped = `${header}.${b64url(JSON.stringify({ intent_mandate_id: 'im-2' }))}.${signature}`;
  const result = verifyCompactJws(swapped, issuer());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'signature_invalid');
});

test('something that is not a compact JWS is refused as malformed', () => {
  assert.equal(verifyCompactJws('not-a-token', issuer()).ok, false);
});

/* ---------------------------------------------------------------- *
 * Freshness
 * ---------------------------------------------------------------- */

test('a credential with no expiry is a standing key and is refused', () => {
  const result = checkFreshness({ expiresAt: null, issuedAt: NOW, now: NOW });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'no_expiry');
  assert.match(result.detail, /standing key/);
});

test('an expired credential is refused, with two minutes of tolerance', () => {
  assert.equal(checkFreshness({ expiresAt: NOW - 60_000, issuedAt: NOW - HOUR, now: NOW }).ok, true);
  const result = checkFreshness({ expiresAt: NOW - 10 * 60_000, issuedAt: NOW - HOUR, now: NOW });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'credential_expired');
});

test('a credential issued in the future is refused as clock skew', () => {
  const result = checkFreshness({ expiresAt: NOW + HOUR, issuedAt: NOW + HOUR, now: NOW });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'clock_skew');
});

test('a credential valid for longer than a day is refused however it is signed', () => {
  const result = checkFreshness({ expiresAt: NOW + 72 * HOUR, issuedAt: NOW, now: NOW });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'no_expiry');
  assert.match(result.remedy, /fail safe/);
});

/* ---------------------------------------------------------------- *
 * AP2 Intent Mandate
 * ---------------------------------------------------------------- */

function intentJson(
  o: {
    id?: string;
    agentId?: string;
    issuedAt?: number | null;
    expiresAt?: number | null;
    maxPerPurchase?: string;
    maxTotal?: string;
    skus?: string[] | null;
    merchants?: string[];
    sides?: string[];
    auth?: string;
  } = {},
): string {
  const id = o.id ?? 'im-1';
  const rows: string[] = [
    `"intent_mandate_id": ${JSON.stringify(id)}`,
    `"agent_id": ${JSON.stringify(o.agentId ?? 'agent-7')}`,
    `"human_present": false`,
  ];
  if (o.issuedAt !== null) rows.push(`"issued_at": ${o.issuedAt ?? NOW - 1_000}`);
  if (o.expiresAt !== null) rows.push(`"expires_at": ${o.expiresAt ?? NOW + HOUR}`);
  rows.push(
    `"constraints": {"max_per_purchase": ${o.maxPerPurchase ?? '1000.00'}, "max_total": ${o.maxTotal ?? '5000.00'}}`,
  );
  const intent: string[] = [];
  if (o.skus !== null) intent.push(`"skus": ${JSON.stringify(o.skus ?? ['RENDER-H100'])}`);
  intent.push(`"merchants": ${JSON.stringify(o.merchants ?? ['acme-render'])}`);
  intent.push(`"sides": ${JSON.stringify(o.sides ?? ['buy'])}`);
  rows.push(`"shopping_intent": {${intent.join(', ')}}`);
  rows.push(`"user_authorization": ${JSON.stringify(o.auth ?? jws('EdDSA', { intent_mandate_id: id }, ed.privateKey))}`);
  return `{${rows.join(', ')}}`;
}

const importIntent = (rawJson: string, over: Partial<Parameters<typeof importIntentMandate>[0]> = {}) =>
  importIntentMandate({
    rawJson,
    issuer: issuer(),
    participant: BUYER,
    grantedBy: { id: 'p-2', name: 'J. Reyes' },
    now: NOW,
    replay: replayPort(),
    isAdmitted: admitAll,
    ...over,
  });

test('a valid AP2 intent imports as a DRAFT, with no signature to be found', () => {
  const result = importIntent(intentJson());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.maxPerTrade, 100_000n);
  assert.equal(result.value.maxPerDay, 500_000n);
  assert.deepEqual(result.value.skus, ['RENDER-H100']);
  assert.deepEqual(result.value.sides, ['buy']);
  assert.equal(result.value.expiresAt, NOW + HOUR);

  assert.equal(
    Object.prototype.hasOwnProperty.call(result.value, 'signature'),
    false,
    'an import can never produce something checkMandate would accept',
  );
});

test('an intent naming no SKUs is refused — foreign credentials do not get the "any" default', () => {
  const result = importIntent(intentJson({ skus: null }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'scope_unbounded');
  assert.match(result.detail, /does not inherit that latitude/);
});

test('an intent naming an unadmitted counterparty is refused by name', () => {
  const result = importIntent(intentJson({ merchants: ['acme-render', 'ghost-co'] }), {
    isAdmitted: (id) => id !== 'ghost-co',
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'counterparty_not_admitted');
  assert.match(result.detail, /ghost-co/);
});

test('an intent with a zero ceiling authorises nothing and says so', () => {
  const result = importIntent(intentJson({ maxPerPurchase: '0.00' }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'scope_unbounded');
});

test('an intent permitting neither side binds nothing', () => {
  const result = importIntent(intentJson({ sides: ['sideways'] }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'binds_nothing');
});

test('an intent with no expiry is refused', () => {
  const result = importIntent(intentJson({ expiresAt: null }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'no_expiry');
});

test('an authorisation signed over a DIFFERENT intent is refused', () => {
  const stolen = jws('EdDSA', { intent_mandate_id: 'some-other-intent' }, ed.privateKey);
  const result = importIntent(intentJson({ auth: stolen }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'signature_invalid');
  assert.match(result.detail, /signed over intent some-other-intent/);
});

test('the same credential cannot be presented twice', () => {
  const replay = replayPort();
  const raw = intentJson();
  assert.equal(importIntent(raw, { replay }).ok, true);

  const second = importIntent(raw, { replay });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, 'replayed');
});

test('a draft becomes authority only when a principal signs it — and then it is ordinary', () => {
  const result = importIntent(intentJson());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const unsigned = draftToUnsignedMandate(result.value, 'm-imported-1', NOW);
  const principal = crypto.generateKeyPairSync('ed25519');
  const signature = crypto
    .sign(null, Buffer.from(mandateCanonical(unsigned), 'utf8'), principal.privateKey)
    .toString('base64');
  const adopted: Mandate = { ...unsigned, signature };

  assert.equal(verifyMandate(adopted, spki(principal)), true);
  assert.equal(verifyMandate(adopted, spki(ed)), false, 'the foreign issuer\'s key does not adopt anything');
});

test('the attestation records which key would be shown to an adjudicator', () => {
  const result = importIntent(intentJson());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const text = describeAttestation(result.value.attestation);
  assert.match(text, /AP2 credential im-1 from did:example:borealis/);
  assert.match(text, /key k-1 \(EdDSA\)/);
  assert.match(text, /human not present/);
  assert.match(text, /Not authority here/);
});

/* ---------------------------------------------------------------- *
 * AP2 Cart Mandate
 * ---------------------------------------------------------------- */

function cartJson(
  o: {
    id?: string;
    items?: string;
    total?: string;
    currency?: string;
    expiresAt?: number | null;
    signature?: string;
    extra?: string;
  } = {},
): string {
  const id = o.id ?? 'cart-1';
  const currency = o.currency ?? 'GBP';
  const items =
    o.items ??
    `[{"sku": "RENDER-H100", "quantity": 10, "unit_amount": {"value": 45.99, "currency": ${JSON.stringify(currency)}}}]`;
  const rows = [
    `"id": ${JSON.stringify(id)}`,
    `"timestamp": ${NOW - 1_000}`,
    `"user_signature_required": true`,
    `"deliver_by": ${NOW + 48 * HOUR}`,
  ];
  if (o.expiresAt !== null) rows.push(`"expires_at": ${o.expiresAt ?? NOW + 900_000}`);
  rows.push(
    `"payment_request": {"details": {"displayItems": ${items}, ` +
      `"total": {"amount": {"value": ${o.total ?? '459.90'}, "currency": ${JSON.stringify(currency)}}}}}`,
  );
  if (o.extra) rows.push(o.extra);
  rows.push(`"merchant_signature": ${JSON.stringify(o.signature ?? jws('EdDSA', { id }, ed.privateKey))}`);
  return `{${rows.join(', ')}}`;
}

const importCart = (rawJson: string, over: Partial<Parameters<typeof importCartMandate>[0]> = {}) =>
  importCartMandate({
    rawJson,
    issuer: issuer(),
    seller: SELLER,
    buyer: BUYER,
    proposalId: 'prop-1',
    fees: DEFAULT_FEES,
    now: NOW,
    replay: replayPort(),
    supportedCurrency: 'GBP',
    ...over,
  });

test('a valid AP2 cart imports as Apex terms, with gross recomputed from the line item', () => {
  const result = importCart(cartJson());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.terms.unitPrice, 4599n);
  assert.equal(result.value.terms.quantity, 10);
  assert.equal(result.value.terms.grossAmount, 45_990n);
  assert.equal(result.value.terms.seller, SELLER);
  assert.equal(result.value.terms.buyer, BUYER);
  assert.match(result.value.stillRequired, /must sign these Apex terms/);
});

test('the market fee comes from Apex\'s schedule, never from the payload', () => {
  const result = importCart(cartJson({ extra: '"fee_amount": 0.00, "platform_fee_basis_points": 0' }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.terms.feeAmount, 459n, '1% of 459.90, as Apex charges — not the zero the cart asked for');
});

test('a cart whose total does not equal its line items is refused, not reconciled', () => {
  const result = importCart(cartJson({ total: '45.99' }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'total_mismatch');
  assert.match(result.detail, /states a total of 45.99 but its line item multiplies out to 459.90/);
});

test('a multi-line cart is several trades and is refused as one', () => {
  const two =
    '[{"sku": "A", "quantity": 1, "unit_amount": {"value": 1.00, "currency": "GBP"}},' +
    ' {"sku": "B", "quantity": 1, "unit_amount": {"value": 1.00, "currency": "GBP"}}]';
  const result = importCart(cartJson({ items: two, total: '2.00' }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'missing_field');
  assert.match(result.detail, /its own escrow/);
});

test('a foreign currency is refused rather than converted', () => {
  const result = importCart(cartJson({ currency: 'USD' }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'currency_unsupported');
  assert.match(result.remedy, /a rate is a price/);
});

test('a merchant signature covering another cart is refused', () => {
  const result = importCart(cartJson({ signature: jws('EdDSA', { id: 'cart-99' }, ed.privateKey) }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'signature_invalid');
});

test('a cart may not live longer than an hour', () => {
  const result = importCart(cartJson({ expiresAt: NOW + 6 * HOUR }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'no_expiry');
});

test('a cart cannot be replayed', () => {
  const replay = replayPort();
  const raw = cartJson();
  assert.equal(importCart(raw, { replay }).ok, true);
  const second = importCart(raw, { replay });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, 'replayed');
});

/* ---------------------------------------------------------------- *
 * ACP, and the protocols that are recognised and refused
 * ---------------------------------------------------------------- */

test('an ACP shared payment token imports as attestation only', () => {
  const raw =
    `{"shared_payment_token": "spt-1", "expires_at": ${NOW + 600_000}, ` +
    `"signature": ${JSON.stringify(jws('EdDSA', { spt: 'spt-1' }, ed.privateKey))}}`;
  const result = importSharedPaymentToken({ rawJson: raw, issuer: issuer({ protocol: 'acp' }), now: NOW, replay: replayPort() });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.protocol, 'acp');
  assert.equal(result.value.credentialId, 'spt-1');
});

test('x402 is recognised, refused, and told why', () => {
  const result = assessProtocol('x402');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'protocol_not_settleable');
  assert.match(result.detail, /holds no digital assets/);
  assert.match(result.remedy, /AP2 or ACP/);
});

test('MPP is refused because a session token names no seller to agree with', () => {
  const result = assessProtocol('mpp');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.detail, /bilateral agreements/);
});

test('an unrecognised protocol is refused rather than guessed at', () => {
  const result = assessProtocol('somepay-v9');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'unknown_protocol');
});

test('ap2 and acp are the protocols that proceed', () => {
  assert.equal(assessProtocol('ap2').ok, true);
  assert.equal(assessProtocol('acp').ok, true);
});

/* ---------------------------------------------------------------- *
 * Evidence, not authority
 * ---------------------------------------------------------------- */

const attestation = (over: Partial<ForeignAttestation> = {}): ForeignAttestation => ({
  protocol: 'ap2',
  issuerId: 'did:example:borealis',
  credentialId: 'im-1',
  alg: 'EdDSA',
  kid: 'k-1',
  payloadDigest: 'a'.repeat(64),
  verifiedAt: NOW,
  expiresAt: NOW + HOUR,
  humanPresent: false,
  ...over,
});

test('every field of an attestation is inside its digest', () => {
  const base = attestationDigest(attestation());
  const mutations: Partial<ForeignAttestation>[] = [
    { protocol: 'acp' },
    { issuerId: 'did:example:other' },
    { credentialId: 'im-2' },
    { alg: 'ES256' },
    { kid: 'k-2' },
    { payloadDigest: 'b'.repeat(64) },
    { verifiedAt: NOW + 1 },
    { expiresAt: NOW + 2 * HOUR },
    { humanPresent: true },
  ];
  for (const mutation of mutations) {
    assert.notEqual(attestationDigest(attestation(mutation)), base, `${Object.keys(mutation)[0]} escaped the digest`);
  }
});

test('a foreign attestation is not an Apex signature, and the type says so', () => {
  assert.equal(isApexSignature(attestation()), false);
});
