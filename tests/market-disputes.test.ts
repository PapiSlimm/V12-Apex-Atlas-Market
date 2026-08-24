import test from 'node:test';
import assert from 'node:assert/strict';

import { fromDecimalString } from '../server/constitution/money';
import { computeFee, grossFor, settle } from '../server/market/settlement';
import { GENESIS, buildPostings, digestRationale, postingDigest, type ChainHeads, type Posting } from '../server/market/provenance';
import {
  DEFAULT_DISPUTE_WINDOW_MS, raiseDispute, refundPostings, releaseEscrow, resolve, respond, type Dispute,
} from '../server/market/disputes';
import { DEFAULT_FEES, participantId, type Trade } from '../server/market/types';

const SELLER = participantId('acme-render');
const BUYER = participantId('borealis-studios');
const OUTSIDER = participantId('nosy-co');
const HUMAN = { id: 'ops-14', name: 'R. Dixon', kind: 'human' as const };

const SETTLED_AT = 1_000_000;
const heads: ChainHeads = { get: () => GENESIS };

const CLAIM = 'Only 12 of the 40 contracted H100 hours were delivered; the remaining 28 never started, per the job log.';
const ANSWER = 'Our scheduler shows 40 hours queued but 28 failed to launch after a node eviction on the 3rd.';
const REASONS = 'The seller concedes 28 hours never ran. A pro-rata refund of those hours is awarded to the buyer.';

function fixture() {
  const quantity = 40;
  const unitPrice = fromDecimalString('12.50');
  const gross = grossFor(quantity, unitPrice);
  const trade: Trade = {
    id: 'trade-1', offerId: 'offer-1', bidId: 'bid-1',
    seller: SELLER, buyer: BUYER,
    listing: { sku: 'RENDER-H100', title: 'H100 hours', category: 'render-hours', unit: 'hour' },
    quantity, unitPrice, grossAmount: gross, feeAmount: computeFee(gross, DEFAULT_FEES),
    status: 'settled', authorisationSerial: 'rcpt-9', proposedAt: 1, settledAt: SETTLED_AT,
  };
  const outcome = settle({ ...trade, status: 'authorised', settledAt: null }, DEFAULT_FEES, SETTLED_AT);
  if (!outcome.settled) throw new Error('fixture must settle');
  const postings = buildPostings({
    record: outcome.record, trade, heads, idFor: (i) => `post-${i}`,
    offerRationaleDigest: digestRationale('idle capacity', { idle: 200 }, { name: 'floor', value: 60 }),
  });
  return { trade, postings };
}

const held = (postings: Posting[]) => postings.find((p) => p.participant === SELLER && p.account === 'cash_held')!;
const buyerCash = (postings: Posting[]) => postings.find((p) => p.participant === BUYER && p.account === 'cash')!;
const sellerInv = (postings: Posting[]) => postings.find((p) => p.participant === SELLER && p.account === 'inventory')!;
const buyerInv = (postings: Posting[]) => postings.find((p) => p.participant === BUYER && p.account === 'inventory')!;

/** Real chain heads: the LAST posting each participant wrote. */
function headsFor(postings: Posting[]): ChainHeads {
  return {
    get: (p) => {
      const own = postings.filter((x) => x.participant === p);
      return own.length ? own[own.length - 1].digest : GENESIS;
    },
  };
}

const refundArgs = (postings: Posting[], dispute: Dispute, now: number) => ({
  dispute,
  sellerHeldPosting: held(postings), sellerInventoryPosting: sellerInv(postings),
  buyerCashPosting: buyerCash(postings), buyerInventoryPosting: buyerInv(postings),
  heads: headsFor(postings), idFor: (s: string) => `refund-${s}`, now,
});

function raised(over: Partial<Parameters<typeof raiseDispute>[0]> = {}) {
  const { trade } = fixture();
  return raiseDispute({
    id: 'disp-1', trade, raisedBy: BUYER, ground: 'partially_delivered',
    statement: CLAIM, amountDisputed: fromDecimalString('350.00'),
    now: SETTLED_AT + 60_000, ...over,
  });
}

// ============================================================ escrow first

test('seller proceeds are HELD at settlement, not free cash', () => {
  const { postings } = fixture();
  assert.ok(held(postings), 'there must be a cash_held posting');
  assert.equal(postings.find((p) => p.participant === SELLER && p.account === 'cash'), undefined,
    'the seller has no free cash until the window closes');
});

test('escrow cannot be released while the window is open', () => {
  const { trade, postings } = fixture();
  const result = releaseEscrow({
    trade, heldPosting: held(postings), dispute: null,
    now: SETTLED_AT + 1_000, idFor: (s) => s, heads,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'window_open');
  assert.match(result.detail, /released early is not escrow/);
});

test('escrow cannot be released while a dispute is open', () => {
  const { trade, postings } = fixture();
  const d = raised();
  if (!d.ok) return assert.fail();
  const result = releaseEscrow({
    trade, heldPosting: held(postings), dispute: d.value,
    now: SETTLED_AT + DEFAULT_DISPUTE_WINDOW_MS + 1, idFor: (s) => s, heads,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'escrow_still_held');
});

test('escrow releases after a quiet window, balanced and properly digested', () => {
  const { trade, postings } = fixture();
  const result = releaseEscrow({
    trade, heldPosting: held(postings), dispute: null,
    now: SETTLED_AT + DEFAULT_DISPUTE_WINDOW_MS + 1, idFor: (s) => s, heads,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const [outHeld, intoCash] = result.value;
  assert.equal(outHeld.amount + intoCash.amount, 0n, 'the release balances on its own');
  assert.equal(intoCash.account, 'cash');
  assert.equal(intoCash.previousDigest, outHeld.digest, 'the second leg chains onto the first');
  for (const p of result.value) {
    const { digest, ...unsigned } = p;
    assert.equal(postingDigest(unsigned), digest, `${p.id} carries a real digest`);
  }
});

// ============================================================ who may dispute

test('only a party to the trade may dispute it', () => {
  const result = raised({ raisedBy: OUTSIDER });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'not_a_party');
});

test('either party may dispute, not only the buyer', () => {
  assert.equal(raised({ raisedBy: SELLER }).ok, true);
  assert.equal(raised({ raisedBy: BUYER }).ok, true);
});

test('the dispute is automatically against the other side', () => {
  const asBuyer = raised({ raisedBy: BUYER });
  if (!asBuyer.ok) return assert.fail();
  assert.equal(asBuyer.value.against, SELLER);

  const asSeller = raised({ raisedBy: SELLER });
  if (!asSeller.ok) return assert.fail();
  assert.equal(asSeller.value.against, BUYER);
});

// ============================================================== the window

test('a dispute after the window closes is refused, and says why finality matters', () => {
  const result = raised({ now: SETTLED_AT + DEFAULT_DISPUTE_WINDOW_MS + 1 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'window_closed');
  assert.match(result.detail, /certainty is worth as much/);
});

test('an unsettled trade cannot be disputed', () => {
  const { trade } = fixture();
  const result = raiseDispute({
    id: 'd', trade: { ...trade, status: 'authorised', settledAt: null }, raisedBy: BUYER,
    ground: 'not_delivered', statement: CLAIM, amountDisputed: 100n, now: SETTLED_AT,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'trade_not_settled');
});

test('a second dispute cannot be opened while one is live', () => {
  const first = raised();
  if (!first.ok) return assert.fail();
  const second = raised({ existing: first.value });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, 'already_disputed');
});

// ================================================================== grounds

test('vacuous grounds are not grounds', () => {
  for (const statement of ['', 'scam', 'it didn\'t work', 'refund me', 'bad']) {
    const result = raised({ statement });
    assert.equal(result.ok, false, `"${statement}" should be refused`);
    if (result.ok) continue;
    assert.equal(result.reason, 'grounds_vacuous');
  }
});

test('a claim beyond the trade gross is refused', () => {
  const result = raised({ amountDisputed: fromDecimalString('99999.00') });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'amount_exceeds_trade');
});

// ============================================================== being heard

test('the counterparty is heard before anything is decided', () => {
  const d = raised();
  if (!d.ok) return assert.fail();
  const attempt = resolve({
    dispute: d.value, resolvedBy: HUMAN, upheld: true,
    refund: fromDecimalString('350.00'), reasons: REASONS, now: SETTLED_AT + 100,
  });
  assert.equal(attempt.ok, false);
  if (attempt.ok) return;
  assert.equal(attempt.reason, 'not_answered');
  assert.match(attempt.detail, /unheard party/);
});

test('only the party accused may answer', () => {
  const d = raised();
  if (!d.ok) return assert.fail();
  const wrong = respond(d.value, BUYER, ANSWER, SETTLED_AT + 100);
  assert.equal(wrong.ok, false);
  if (wrong.ok) return;
  assert.equal(wrong.reason, 'not_a_party');
});

// ============================================================== resolution

function answered(): Dispute {
  const d = raised();
  if (!d.ok) throw new Error('raise failed');
  const a = respond(d.value, SELLER, ANSWER, SETTLED_AT + 100);
  if (!a.ok) throw new Error('respond failed');
  return a.value;
}

test('no agent may resolve a dispute', () => {
  const notHuman = { id: 'pricing-agent', name: 'Pricing Agent', kind: 'agent' as unknown as 'human' };
  const result = resolve({
    dispute: answered(), resolvedBy: notHuman, upheld: true,
    refund: fromDecimalString('350.00'), reasons: REASONS, now: SETTLED_AT + 200,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'resolver_not_human');
  assert.match(result.detail, /Article X §10\.1/);
});

test('an anonymous resolver is refused', () => {
  const result = resolve({
    dispute: answered(), resolvedBy: { id: '', name: '', kind: 'human' }, upheld: true,
    refund: 100n, reasons: REASONS, now: SETTLED_AT + 200,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'resolver_not_human');
});

test('a resolution must give reasons the losing party can read', () => {
  const result = resolve({
    dispute: answered(), resolvedBy: HUMAN, upheld: true, refund: 100n, reasons: 'no', now: SETTLED_AT + 200,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'reasons_vacuous');
});

test('a resolution cannot award more than was disputed', () => {
  const result = resolve({
    dispute: answered(), resolvedBy: HUMAN, upheld: true,
    refund: fromDecimalString('500.00'), reasons: REASONS, now: SETTLED_AT + 200,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'refund_exceeds_disputed');
});

test('a rejected dispute refunds nothing', () => {
  const bad = resolve({
    dispute: answered(), resolvedBy: HUMAN, upheld: false, refund: 100n, reasons: REASONS, now: SETTLED_AT + 200,
  });
  assert.equal(bad.ok, false);

  const good = resolve({
    dispute: answered(), resolvedBy: HUMAN, upheld: false, refund: 0n, reasons: REASONS, now: SETTLED_AT + 200,
  });
  assert.equal(good.ok, true);
  if (!good.ok) return;
  assert.equal(good.value.status, 'rejected');
});

test('a dispute resolves once', () => {
  const first = resolve({
    dispute: answered(), resolvedBy: HUMAN, upheld: true,
    refund: fromDecimalString('350.00'), reasons: REASONS, now: SETTLED_AT + 200,
  });
  if (!first.ok) return assert.fail();
  const second = resolve({
    dispute: first.value, resolvedBy: HUMAN, upheld: true, refund: 1n, reasons: REASONS, now: SETTLED_AT + 300,
  });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, 'already_resolved');
});

// ================================================================= the refund

test('an upheld dispute produces linked, balancing reversing postings', () => {
  const { postings } = fixture();
  const resolved = resolve({
    dispute: answered(), resolvedBy: HUMAN, upheld: true,
    refund: fromDecimalString('350.00'), reasons: REASONS, now: SETTLED_AT + 200,
  });
  if (!resolved.ok) return assert.fail();

  const refunds = refundPostings(refundArgs(postings, resolved.value, SETTLED_AT + 300));

  assert.equal(refunds.length, 4, 'a refund is double entry on BOTH sides');
  const [sellerCash, , buyerCashLeg] = refunds;
  assert.equal(sellerCash.amount, -fromDecimalString('350.00'), 'held funds leave the seller');
  assert.equal(buyerCashLeg.amount, fromDecimalString('350.00'), 'and return to the buyer');

  // The property that matters: each party's refund legs balance on their own.
  for (const party of [SELLER, BUYER]) {
    const sum = refunds.filter((p) => p.participant === party).reduce((a: bigint, p) => a + p.amount, 0n);
    assert.equal(sum, 0n, `${party}'s refund does not balance`);
  }

  // Provenance survives: the refund stays attached to its trade.
  for (const p of refunds) {
    assert.equal(p.provenance.tradeId, 'trade-1');
    assert.equal(p.provenance.authorisationSerial, 'rcpt-9');
    assert.match(p.memo, /REVERSAL of/);
    assert.match(p.memo, /Dispute disp-1 upheld by R\. Dixon/);
  }
});

test('a partial award refunds only what was awarded', () => {
  const { postings } = fixture();
  const partial = resolve({
    dispute: answered(), resolvedBy: HUMAN, upheld: true,
    refund: fromDecimalString('100.00'), reasons: REASONS, now: SETTLED_AT + 200,
  });
  if (!partial.ok) return assert.fail();

  const refunds = refundPostings(refundArgs(postings, partial.value, SETTLED_AT + 300));
  assert.equal(refunds[2].amount, fromDecimalString('100.00'),
    'a partial award must not hand back money nobody disputed');
});

test('a rejected dispute produces no refund postings', () => {
  const { postings } = fixture();
  const rejected = resolve({
    dispute: answered(), resolvedBy: HUMAN, upheld: false, refund: 0n, reasons: REASONS, now: SETTLED_AT + 200,
  });
  if (!rejected.ok) return assert.fail();
  assert.throws(() => refundPostings(refundArgs(postings, rejected.value, SETTLED_AT + 300)),
    /Only an upheld dispute/);
});

test('escrow releases normally once a dispute is rejected', () => {
  const { trade, postings } = fixture();
  const rejected = resolve({
    dispute: answered(), resolvedBy: HUMAN, upheld: false, refund: 0n, reasons: REASONS, now: SETTLED_AT + 200,
  });
  if (!rejected.ok) return assert.fail();

  const result = releaseEscrow({
    trade, heldPosting: held(postings), dispute: rejected.value,
    now: SETTLED_AT + DEFAULT_DISPUTE_WINDOW_MS + 1, idFor: (s) => s, heads,
  });
  assert.equal(result.ok, true);
});
