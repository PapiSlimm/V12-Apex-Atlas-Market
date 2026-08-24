import test from 'node:test';
import assert from 'node:assert/strict';

import { fromDecimalString, toDecimalString, type Minor } from '../server/constitution/money';
import {
  assertEachSideBalances, buildLegs, computeFee, grossFor, settle, settlementDigest, splitFee, SettlementError,
} from '../server/market/settlement';
import { DEFAULT_FEES, legsFor, participantId, type FeeSchedule, type Trade } from '../server/market/types';

const SELLER = participantId('acme-render');
const BUYER = participantId('borealis-studios');

function trade(over: Partial<Trade> = {}): Trade {
  const quantity = over.quantity ?? 40;
  const unitPrice = over.unitPrice ?? fromDecimalString('12.50');
  const gross = over.grossAmount ?? grossFor(quantity, unitPrice);
  return {
    id: 't-1', offerId: 'o-1', bidId: 'b-1',
    seller: SELLER, buyer: BUYER,
    listing: { sku: 'RENDER-H100', title: 'H100 render hours', category: 'render-hours', unit: 'hour' },
    quantity, unitPrice, grossAmount: gross,
    feeAmount: over.feeAmount ?? computeFee(gross, DEFAULT_FEES),
    status: 'authorised',
    authorisationSerial: 'rcpt-1',
    proposedAt: 1_000, settledAt: null,
    ...over,
  };
}

// =========================================================== the money itself

test('gross is integer arithmetic end to end', () => {
  const gross = grossFor(40, fromDecimalString('12.50'));
  assert.equal(toDecimalString(gross), '500.00');
  assert.equal(typeof gross, 'bigint');
});

test('a non-integer quantity is refused, not rounded', () => {
  assert.throws(() => grossFor(1.5, 100n), /not a positive integer/);
  assert.throws(() => grossFor(0, 100n), /not a positive integer/);
});

test('a split fee never loses or invents a minor unit', () => {
  for (let fee = 0n; fee <= 201n; fee += 1n) {
    const { buyer, seller } = splitFee(fee, DEFAULT_FEES);
    assert.equal(buyer + seller, fee, `fee ${fee} did not split cleanly`);
    // The odd unit is assigned deliberately, to the buyer.
    assert.ok(buyer >= seller, `fee ${fee}: the remainder must not vanish`);
  }
});

test('a one-sided fee schedule puts the whole fee on that side', () => {
  assert.deepEqual(splitFee(101n, { basisPoints: 100, bearer: 'buyer' }), { buyer: 101n, seller: 0n });
  assert.deepEqual(splitFee(101n, { basisPoints: 100, bearer: 'seller' }), { buyer: 0n, seller: 101n });
});

test('a negative fee is refused', () => {
  assert.throws(() => splitFee(-1n, DEFAULT_FEES), SettlementError);
});

// ================================================= each side balances alone

test("each party's legs sum to zero independently", () => {
  const legs = buildLegs(trade(), DEFAULT_FEES);
  const sellerSum = legs.filter((l) => l.participant === SELLER).reduce((a, l) => a + l.amount, 0n);
  const buyerSum = legs.filter((l) => l.participant === BUYER).reduce((a, l) => a + l.amount, 0n);
  assert.equal(sellerSum, 0n);
  assert.equal(buyerSum, 0n);
});

test('balancing only in aggregate is refused', () => {
  // Each side has two legs, so the fewer-than-two check passes and the BALANCE
  // check is what fires. The combined set nets to zero; neither side does.
  // That is the shape a shared ledger produces, and it is not double entry.
  assert.throws(
    () => assertEachSideBalances(
      [
        { participant: SELLER, account: 'cash', amount: 500n, memo: '' },
        { participant: SELLER, account: 'fees', amount: 10n, memo: '' },
        { participant: BUYER, account: 'cash', amount: -500n, memo: '' },
        { participant: BUYER, account: 'fees', amount: -10n, memo: '' },
      ],
      [SELLER, BUYER],
    ),
    /must balance on their own/,
  );
});

test('a party with a single leg is not double entry', () => {
  assert.throws(
    () => assertEachSideBalances([{ participant: SELLER, account: 'cash', amount: 0n, memo: '' }], [SELLER]),
    /fewer than two legs/,
  );
});

test('the buyer pays gross plus their fee; the seller receives gross less theirs', () => {
  const t = trade();
  const legs = buildLegs(t, DEFAULT_FEES);
  const { buyer: buyerFee, seller: sellerFee } = splitFee(t.feeAmount, DEFAULT_FEES);

  const cashOut = legs.find((l) => l.participant === BUYER && l.account === 'cash')!;
  // The seller's proceeds are HELD, not free cash, until the dispute window closes.
  const cashIn = legs.find((l) => l.participant === SELLER && l.account === 'cash_held')!;
  assert.equal(cashOut.amount, -(t.grossAmount + buyerFee));
  assert.equal(cashIn.amount, t.grossAmount - sellerFee);
});

test('balance holds across many generated trades', () => {
  const schedules: FeeSchedule[] = [
    DEFAULT_FEES,
    { basisPoints: 0, bearer: 'split' },
    { basisPoints: 37, bearer: 'buyer' },
    { basisPoints: 250, bearer: 'seller' },
  ];
  for (let q = 1; q <= 60; q += 7) {
    for (const price of ['0.01', '1.00', '12.50', '999.99', '10000.00']) {
      for (const schedule of schedules) {
        const unitPrice: Minor = fromDecimalString(price);
        const gross = grossFor(q, unitPrice);
        const t = trade({ quantity: q, unitPrice, grossAmount: gross, feeAmount: computeFee(gross, schedule) });
        assert.doesNotThrow(() => buildLegs(t, schedule), `q=${q} price=${price} bp=${schedule.basisPoints}`);
      }
    }
  }
});

// ======================================================= settlement decisions

test('an authorised trade settles and produces a verifiable digest', () => {
  const outcome = settle(trade(), DEFAULT_FEES, 5_000);
  assert.equal(outcome.settled, true);
  if (!outcome.settled) return;
  assert.equal(outcome.record.digest.length, 64);
  assert.equal(outcome.record.digest, settlementDigest(trade(), outcome.record.legs, 5_000));
});

test('a trade with no authorisation receipt cannot settle', () => {
  const outcome = settle(trade({ authorisationSerial: null }), DEFAULT_FEES, 5_000);
  assert.equal(outcome.settled, false);
  if (outcome.settled) return;
  assert.equal(outcome.reason, 'not_authorised');
  assert.match(outcome.detail, /Article IV §4\.1/);
});

test('a trade settles exactly once', () => {
  const outcome = settle(trade({ status: 'settled', settledAt: 4_000 }), DEFAULT_FEES, 5_000);
  assert.equal(outcome.settled, false);
  if (outcome.settled) return;
  assert.equal(outcome.reason, 'already_settled');
});

test('only an authorised trade may settle', () => {
  for (const status of ['proposed', 'refused', 'cancelled'] as const) {
    const outcome = settle(trade({ status }), DEFAULT_FEES, 5_000);
    assert.equal(outcome.settled, false, status);
    if (outcome.settled) continue;
    assert.equal(outcome.reason, 'wrong_status');
  }
});

test('a participant cannot trade with itself', () => {
  const outcome = settle(trade({ buyer: SELLER }), DEFAULT_FEES, 5_000);
  assert.equal(outcome.settled, false);
  if (outcome.settled) return;
  assert.equal(outcome.reason, 'self_dealing');
  assert.match(outcome.detail, /wash activity/);
});

test('a negative gross is refused before a fee can even be computed', () => {
  // computeFee guards the boundary, so a negative trade cannot be constructed
  // far enough to reach settle(). Both refusals are wanted; they just live in
  // different places, and the test says which is which.
  assert.throws(() => computeFee(-200n, DEFAULT_FEES), /cannot be negative/);
});

test('a zero or negative price cannot clear', () => {
  assert.equal(settle(trade({ unitPrice: 0n, grossAmount: 0n, feeAmount: 0n }), DEFAULT_FEES, 1).settled, false);
  assert.equal(settle(trade({ unitPrice: -5n, grossAmount: -200n, feeAmount: 0n }), DEFAULT_FEES, 1).settled, false);
});

// ============================================================ isolation

test('a participant reads their own legs and never the counterparty\'s', () => {
  const outcome = settle(trade(), DEFAULT_FEES, 5_000);
  if (!outcome.settled) return assert.fail('expected settlement');

  const sellerView = legsFor(outcome.record, SELLER);
  const buyerView = legsFor(outcome.record, BUYER);

  assert.equal(sellerView.length, 3);
  assert.equal(buyerView.length, 3);
  assert.ok(sellerView.every((l) => l.participant === SELLER));
  assert.ok(buyerView.every((l) => l.participant === BUYER));
  assert.equal(sellerView.length + buyerView.length, outcome.record.legs.length, 'no leg belongs to nobody');
});

test("a participant's view still balances on its own", () => {
  const outcome = settle(trade(), DEFAULT_FEES, 5_000);
  if (!outcome.settled) return assert.fail('expected settlement');
  for (const party of [SELLER, BUYER]) {
    const sum: bigint = legsFor(outcome.record, party).reduce((a: bigint, l) => a + l.amount, 0n);
    assert.equal(sum, 0n, `${party} does not balance in its own view`);
  }
});

test('the digest changes if any leg changes', () => {
  const t = trade();
  const legs = buildLegs(t, DEFAULT_FEES);
  const tampered = legs.map((l, i) => (i === 0 ? { ...l, amount: l.amount + 1n } : l));
  assert.notEqual(settlementDigest(t, legs, 1), settlementDigest(t, tampered, 1));
});

test('no floating point appears anywhere in the settlement path', async () => {
  const fs = await import('fs');
  const source = fs.readFileSync('server/market/settlement.ts', 'utf8');
  // A decimal literal in money arithmetic is the failure this guards.
  assert.ok(!/\b\d+\.\d+\b/.test(source.replace(/§\d+\.\d+/g, '').replace(/Article [IVX]+ /g, '')),
    'settlement.ts must contain no decimal numeric literals');
});
