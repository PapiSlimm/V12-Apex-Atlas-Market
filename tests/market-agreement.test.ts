import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import { fromDecimalString } from '../server/constitution/money';
import {
  assertDelivered, bothSigned, confirmReceipt, decline, describeAgreement, sign, termsCanonical, termsDigest,
  type Actor, type Delivery, type Proposal, type Signature, type Terms,
} from '../server/market/agreement';
import { participantId, type Trade } from '../server/market/types';

const SELLER = participantId('acme-render');
const BUYER = participantId('borealis-studios');

function keypair() {
  const kp = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: kp.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    publicKey: kp.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

const sellerKeys = keypair();
const buyerKeys = keypair();
const rogueKeys = keypair();

const sellerPrincipal: Actor = { id: 'p-1', name: 'A. Okafor', kind: 'principal', participant: SELLER };
const buyerPrincipal: Actor = { id: 'p-2', name: 'J. Reyes', kind: 'principal', participant: BUYER };
const buyerAgent: Actor = { id: 'agent-7', name: 'Procurement Agent', kind: 'agent', participant: BUYER };
const sellerAgent: Actor = { id: 'agent-3', name: 'Listing Agent', kind: 'agent', participant: SELLER };

const TERMS: Terms = {
  proposalId: 'prop-1', seller: SELLER, buyer: BUYER, sku: 'RENDER-H100',
  quantity: 40, unitPrice: fromDecimalString('12.50'),
  grossAmount: fromDecimalString('500.00'), feeAmount: fromDecimalString('5.00'),
  deliverBy: 2_000_000,
};

const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 'prop-1', offerId: 'offer-1', bidId: 'bid-1', terms: TERMS,
  sellerSignature: null, buyerSignature: null, status: 'open',
  createdAt: 1_000, expiresAt: 1_000_000, declinedReason: null,
  ...over,
});

function signatureBy(actor: Actor, privateKey: string, terms: Terms = TERMS, at = 2_000): Signature {
  const sig = crypto.sign(null, Buffer.from(termsCanonical(terms), 'utf8'), crypto.createPrivateKey({
    key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8',
  })).toString('base64');
  return { actor, at, signature: sig, termsDigest: termsDigest(terms) };
}

const publicKeyFor = (actor: Actor): string | null => {
  if (actor.participant === SELLER) return sellerKeys.publicKey;
  if (actor.participant === BUYER) return buyerKeys.publicKey;
  return null;
};

// ================================================= agents find, principals bind

test('an AGENT cannot bind by default — only under a mandate a principal granted', () => {
  // This test previously asserted agents can NEVER bind. That was the wrong
  // rule: it put a human signature in front of every small trade and destroyed
  // the economics the market exists for. The correct rule is that an agent
  // binds only inside limits a principal set in advance — see mandate.ts.
  for (const [agent, keys] of [[buyerAgent, buyerKeys], [sellerAgent, sellerKeys]] as const) {
    const result = sign({
      proposal: proposal(), signature: signatureBy(agent, keys.privateKey), publicKeyFor, now: 3_000,
    });
    assert.equal(result.ok, false, `${agent.name} must not sign without a mandate`);
    if (result.ok) continue;
    assert.equal(result.reason, 'agent_cannot_bind');
    assert.match(result.detail, /a principal granted in advance/);
  }
});

test('a principal binds', () => {
  const result = sign({
    proposal: proposal(), signature: signatureBy(sellerPrincipal, sellerKeys.privateKey), publicKeyFor, now: 3_000,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(result.value.sellerSignature);
  assert.equal(result.value.status, 'open', 'one signature is not an agreement');
});

test('a trade binds only when BOTH principals have signed', () => {
  const first = sign({
    proposal: proposal(), signature: signatureBy(sellerPrincipal, sellerKeys.privateKey), publicKeyFor, now: 3_000,
  });
  if (!first.ok) return assert.fail();
  assert.equal(bothSigned(first.value), false);

  const second = sign({
    proposal: first.value, signature: signatureBy(buyerPrincipal, buyerKeys.privateKey), publicKeyFor, now: 3_100,
  });
  if (!second.ok) return assert.fail();
  assert.equal(bothSigned(second.value), true);
  assert.equal(second.value.status, 'agreed');
});

test('an agent cannot decline either — that is a decision', () => {
  const result = decline(proposal(), buyerAgent, 'we do not want this');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'agent_cannot_bind');
});

// ============================================== counterparty choice is theirs

test('a seller may decline a buyer they are happy to price', () => {
  const result = decline(proposal(), sellerPrincipal, 'Direct competitor; we do not sell them capacity.');
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, 'declined');
  assert.match(result.value.declinedReason!, /competitor/);
});

test('a decline must state a reason', () => {
  const result = decline(proposal(), sellerPrincipal, 'no');
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'reason_required');
});

test('a stranger cannot sign or decline', () => {
  const stranger: Actor = { id: 'x', name: 'Nosy Co', kind: 'principal', participant: participantId('nosy-co') };
  const signed = sign({ proposal: proposal(), signature: signatureBy(stranger, rogueKeys.privateKey), publicKeyFor, now: 3_000 });
  assert.equal(signed.ok, false);
  if (!signed.ok) assert.equal(signed.reason, 'not_a_party');

  const declined = decline(proposal(), stranger, 'because I say so');
  assert.equal(declined.ok, false);
});

// ================================================================ signatures

test('a signature the market could not have produced is what makes this checkable', () => {
  const forged = signatureBy(sellerPrincipal, rogueKeys.privateKey);
  const result = sign({ proposal: proposal(), signature: forged, publicKeyFor, now: 3_000 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'signature_invalid');
});

test('signing terms the signer was never shown is refused', () => {
  const sig = signatureBy(sellerPrincipal, sellerKeys.privateKey);
  const mismatched = { ...sig, termsDigest: 'a'.repeat(64) };
  const result = sign({ proposal: proposal(), signature: mismatched, publicKeyFor, now: 3_000 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'wrong_terms');
  assert.match(result.detail, /worse than no signature/);
});

test('altering the price after signing invalidates the signature', () => {
  const sig = signatureBy(sellerPrincipal, sellerKeys.privateKey);
  const altered = proposal({ terms: { ...TERMS, unitPrice: fromDecimalString('99.00') } });
  const result = sign({ proposal: altered, signature: sig, publicKeyFor, now: 3_000 });
  assert.equal(result.ok, false, 'the terms digest no longer matches');
});

test('a side signs once', () => {
  const first = sign({ proposal: proposal(), signature: signatureBy(sellerPrincipal, sellerKeys.privateKey), publicKeyFor, now: 3_000 });
  if (!first.ok) return assert.fail();
  const again = sign({ proposal: first.value, signature: signatureBy(sellerPrincipal, sellerKeys.privateKey), publicKeyFor, now: 3_100 });
  assert.equal(again.ok, false);
  if (again.ok) return;
  assert.equal(again.reason, 'already_signed');
});

test('an expired proposal cannot be signed', () => {
  const result = sign({
    proposal: proposal({ expiresAt: 1_500 }), signature: signatureBy(sellerPrincipal, sellerKeys.privateKey),
    publicKeyFor, now: 2_000,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'proposal_expired');
});

// ================================================== delivery is the owner's job

const trade = { id: 'trade-1', seller: SELLER, buyer: BUYER } as unknown as Trade;
const emptyDelivery: Delivery = { tradeId: 'trade-1', assertedBySeller: null, confirmedByBuyer: null };

test('only the seller asserts delivery, and only a principal may', () => {
  const wrongParty = assertDelivered({ delivery: emptyDelivery, trade, actor: buyerPrincipal, note: 'done', now: 1 });
  assert.equal(wrongParty.ok, false);
  if (!wrongParty.ok) assert.equal(wrongParty.reason, 'not_a_party');

  const byAgent = assertDelivered({ delivery: emptyDelivery, trade, actor: sellerAgent, note: 'done', now: 1 });
  assert.equal(byAgent.ok, false);
  if (!byAgent.ok) assert.equal(byAgent.reason, 'agent_cannot_bind');

  const ok = assertDelivered({ delivery: emptyDelivery, trade, actor: sellerPrincipal, note: '40 hours ran', now: 1 });
  assert.equal(ok.ok, true);
});

test('a seller cannot confirm their own delivery', () => {
  const asserted = assertDelivered({ delivery: emptyDelivery, trade, actor: sellerPrincipal, note: '40 hours ran', now: 1 });
  if (!asserted.ok) return assert.fail();
  const selfConfirm = confirmReceipt({ delivery: asserted.value, trade, actor: sellerPrincipal, note: 'yes', now: 2 });
  assert.equal(selfConfirm.ok, false, 'marking your own homework with the buyer\'s money');
  if (!selfConfirm.ok) assert.equal(selfConfirm.reason, 'not_a_party');
});

test('receipt cannot be confirmed before delivery is asserted', () => {
  const early = confirmReceipt({ delivery: emptyDelivery, trade, actor: buyerPrincipal, note: 'got it', now: 2 });
  assert.equal(early.ok, false);
  if (!early.ok) assert.equal(early.reason, 'not_asserted');
});

test('the buyer confirms, and only once', () => {
  const asserted = assertDelivered({ delivery: emptyDelivery, trade, actor: sellerPrincipal, note: '40 hours ran', now: 1 });
  if (!asserted.ok) return assert.fail();
  const confirmed = confirmReceipt({ delivery: asserted.value, trade, actor: buyerPrincipal, note: 'verified', now: 2 });
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;

  const again = confirmReceipt({ delivery: confirmed.value, trade, actor: buyerPrincipal, note: 'again', now: 3 });
  assert.equal(again.ok, false);
});

test('an agent cannot confirm receipt — it releases another company\'s money', () => {
  const asserted = assertDelivered({ delivery: emptyDelivery, trade, actor: sellerPrincipal, note: '40 hours ran', now: 1 });
  if (!asserted.ok) return assert.fail();
  const byAgent = confirmReceipt({ delivery: asserted.value, trade, actor: buyerAgent, note: 'ok', now: 2 });
  assert.equal(byAgent.ok, false);
  if (!byAgent.ok) assert.equal(byAgent.reason, 'agent_cannot_bind');
});

// ================================================================== the record

test('an agreed proposal reads as a contract naming both signers', () => {
  const first = sign({ proposal: proposal(), signature: signatureBy(sellerPrincipal, sellerKeys.privateKey), publicKeyFor, now: 3_000 });
  if (!first.ok) return assert.fail();
  const second = sign({ proposal: first.value, signature: signatureBy(buyerPrincipal, buyerKeys.privateKey), publicKeyFor, now: 3_100 });
  if (!second.ok) return assert.fail();

  const text = describeAgreement(second.value);
  for (const fragment of ['borealis-studios', 'acme-render', '40 × RENDER-H100', '12.50', '500.00', 'A. Okafor', 'J. Reyes', "seller's obligation"]) {
    assert.ok(text.includes(fragment), `the contract omits ${fragment}: ${text}`);
  }
});

// ============================================ agents CAN bind, within a mandate

test('an agent with a covering mandate may sign — that is what makes small trades viable', () => {
  const result = sign({
    proposal: proposal(), signature: signatureBy(buyerAgent, buyerKeys.privateKey),
    publicKeyFor, now: 3_000, mandateSatisfied: true,
  });
  assert.equal(result.ok, true, 'a mandated agent binds');
  if (!result.ok) return;
  assert.equal(result.value.buyerSignature!.actor.kind, 'agent');
});

test('a principal never needs a mandate', () => {
  const result = sign({
    proposal: proposal(), signature: signatureBy(sellerPrincipal, sellerKeys.privateKey),
    publicKeyFor, now: 3_000, mandateSatisfied: false,
  });
  assert.equal(result.ok, true);
});

test('an agent without a covering mandate is still refused', () => {
  const result = sign({
    proposal: proposal(), signature: signatureBy(buyerAgent, buyerKeys.privateKey),
    publicKeyFor, now: 3_000, mandateSatisfied: false,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'agent_cannot_bind');
  assert.match(result.detail, /a principal granted in advance/);
});

test('a mandated agent still cannot forge a signature', () => {
  const result = sign({
    proposal: proposal(), signature: signatureBy(buyerAgent, rogueKeys.privateKey),
    publicKeyFor, now: 3_000, mandateSatisfied: true,
  });
  assert.equal(result.ok, false, 'a mandate authorises; it does not authenticate');
  if (result.ok) return;
  assert.equal(result.reason, 'signature_invalid');
});
