import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { fromDecimalString } from '../server/constitution/money';
import { checkMandate, describeMandate, mandateCanonical, revoke, type Mandate } from '../server/market/mandate';
import type { Actor } from '../server/market/agreement';
import { participantId } from '../server/market/types';

const BUYER = participantId('borealis-studios');
const SELLER = participantId('acme-render');
const OTHER = participantId('third-party-co');

const kp = crypto.generateKeyPairSync('ed25519');
const PRINCIPAL_PRIVATE = kp.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
const PRINCIPAL_PUBLIC = kp.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const rogue = crypto.generateKeyPairSync('ed25519');

const agent: Actor = { id: 'agent-7', name: 'Procurement Agent', kind: 'agent', participant: BUYER };

function mandate(over: Partial<Omit<Mandate, 'signature'>> = {}): Mandate {
  const unsigned: Omit<Mandate, 'signature'> = {
    id: 'm-1', participant: BUYER, agentId: 'agent-7',
    grantedBy: { id: 'p-2', name: 'J. Reyes' },
    maxPerTrade: fromDecimalString('1000.00'),
    maxPerDay: fromDecimalString('5000.00'),
    skus: [], counterparties: [], sides: ['buy'],
    grantedAt: 1_000, expiresAt: 9_000_000, revokedAt: null,
    ...over,
  };
  const signature = crypto.sign(null, Buffer.from(mandateCanonical(unsigned), 'utf8'),
    crypto.createPrivateKey({ key: Buffer.from(PRINCIPAL_PRIVATE, 'base64'), format: 'der', type: 'pkcs8' })).toString('base64');
  return { ...unsigned, signature };
}

const check = (over: Partial<Parameters<typeof checkMandate>[0]> = {}) => checkMandate({
  actor: agent, mandate: mandate(), usage: { spentToday: 0n },
  principalPublicKey: PRINCIPAL_PUBLIC, side: 'buy', sku: 'RENDER-H100',
  counterparty: SELLER, amount: fromDecimalString('500.00'), now: 2_000,
  participantMaxPerTrade: fromDecimalString('100000.00'),
  ...over,
});

test('a covering mandate permits the agent to bind', () => {
  const result = check();
  assert.equal(result.permitted, true);
});

test('no mandate means no binding, and says what to do instead', () => {
  const result = check({ mandate: null });
  assert.equal(result.permitted, false);
  if (result.permitted) return;
  assert.equal(result.reason, 'no_mandate');
  assert.match(result.escalation, /A principal must sign/);
});

test('every refusal carries an escalation path, not just a no', () => {
  const cases = [
    check({ mandate: null }),
    check({ amount: fromDecimalString('5000.00') }),
    check({ usage: { spentToday: fromDecimalString('4900.00') } }),
    check({ mandate: mandate({ skus: ['OTHER-SKU'] }) }),
    check({ mandate: mandate({ counterparties: [OTHER] }) }),
    check({ mandate: mandate({ sides: ['sell'] }) }),
    check({ now: 10_000_000 }),
    check({ mandate: revoke(mandate(), 1_500) }),
  ];
  for (const c of cases) {
    assert.equal(c.permitted, false);
    if (c.permitted) continue;
    assert.ok(c.escalation.length > 15, `"${c.reason}" gives no escalation path`);
  }
});

test('the per-trade limit binds', () => {
  const result = check({ amount: fromDecimalString('1000.01') });
  assert.equal(result.permitted, false);
  if (result.permitted) return;
  assert.equal(result.reason, 'exceeds_per_trade');
});

test('the daily limit is real, because spend is counted', () => {
  const ok = check({ usage: { spentToday: fromDecimalString('4500.00') }, amount: fromDecimalString('500.00') });
  assert.equal(ok.permitted, true, 'exactly at the limit is allowed');

  const over = check({ usage: { spentToday: fromDecimalString('4500.00') }, amount: fromDecimalString('500.01') });
  assert.equal(over.permitted, false);
  if (over.permitted) return;
  assert.equal(over.reason, 'exceeds_per_day');
});

test('an empty allow-list means ANY; a populated one means only those', () => {
  assert.equal(check({ mandate: mandate({ skus: [] }) }).permitted, true);
  assert.equal(check({ mandate: mandate({ skus: ['RENDER-H100'] }) }).permitted, true);
  assert.equal(check({ mandate: mandate({ skus: ['SOMETHING-ELSE'] }) }).permitted, false);

  assert.equal(check({ mandate: mandate({ counterparties: [SELLER] }) }).permitted, true);
  assert.equal(check({ mandate: mandate({ counterparties: [OTHER] }) }).permitted, false);
});

test('a mandate for buying does not permit selling', () => {
  const result = check({ mandate: mandate({ sides: ['buy'] }), side: 'sell' });
  assert.equal(result.permitted, false);
  if (result.permitted) return;
  assert.equal(result.reason, 'side_not_permitted');
});

test('a delegation cannot exceed the authority delegating it', () => {
  const result = check({
    mandate: mandate({ maxPerTrade: fromDecimalString('50000.00') }),
    participantMaxPerTrade: fromDecimalString('10000.00'),
  });
  assert.equal(result.permitted, false);
  if (result.permitted) return;
  assert.equal(result.reason, 'exceeds_principal_limits');
  assert.match(result.detail, /cannot exceed the authority delegating it/);
});

test('an over-broad mandate is void, not silently capped', () => {
  // Capping would be friendlier and wrong — the operator never learns they
  // granted more than the company permits.
  const result = check({
    mandate: mandate({ maxPerTrade: fromDecimalString('50000.00') }),
    participantMaxPerTrade: fromDecimalString('10000.00'),
    amount: fromDecimalString('100.00'),
  });
  assert.equal(result.permitted, false, 'even a small trade under an over-broad mandate is refused');
});

test('revocation is immediate', () => {
  const result = check({ mandate: revoke(mandate(), 1_500) });
  assert.equal(result.permitted, false);
  if (result.permitted) return;
  assert.equal(result.reason, 'revoked');
});

test('an expired mandate stops working', () => {
  const result = check({ now: 9_000_001 });
  assert.equal(result.permitted, false);
  if (result.permitted) return;
  assert.equal(result.reason, 'expired');
});

test('a mandate the market could have minted is refused', () => {
  const forged = { ...mandate(), maxPerTrade: fromDecimalString('999999.00') };
  const result = check({ mandate: forged });
  assert.equal(result.permitted, false);
  if (result.permitted) return;
  assert.equal(result.reason, 'signature_invalid');
});

test('a mandate signed by the wrong key is refused', () => {
  // Properly signed — just by somebody who is not the granting principal.
  const { signature: _ignored, ...unsigned } = mandate();
  const sig = crypto
    .sign(null, Buffer.from(mandateCanonical(unsigned), 'utf8'), rogue.privateKey)
    .toString('base64');
  const result = check({ mandate: { ...unsigned, signature: sig } });
  assert.equal(result.permitted, false);
  if (result.permitted) return;
  assert.equal(result.reason, 'signature_invalid');
});

test("another company's mandate cannot be borrowed", () => {
  const result = check({ mandate: mandate({ participant: SELLER }) });
  assert.equal(result.permitted, false);
});

test("another agent's mandate cannot be borrowed", () => {
  const result = check({ mandate: mandate({ agentId: 'agent-99' }) });
  assert.equal(result.permitted, false);
  if (result.permitted) return;
  assert.equal(result.reason, 'wrong_agent');
});

test('a mandate reads as a plain-language grant', () => {
  const text = describeMandate(mandate({ skus: ['RENDER-H100'], counterparties: [SELLER] }));
  for (const fragment of ['J. Reyes', 'agent-7', 'buy', 'RENDER-H100', 'acme-render', '1000.00', '5000.00']) {
    assert.ok(text.includes(fragment), `the grant omits ${fragment}: ${text}`);
  }
  assert.match(describeMandate(revoke(mandate(), 1)), /REVOKED/);
});
