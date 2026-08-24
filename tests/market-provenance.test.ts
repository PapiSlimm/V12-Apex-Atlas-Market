import test from 'node:test';
import assert from 'node:assert/strict';

import { fromDecimalString } from '../server/constitution/money';
import { computeFee, grossFor, settle } from '../server/market/settlement';
import {
  GENESIS, buildPostings, digestRationale, explain, postingDigest, reconcile, reverse,
  type ChainHeads, type Posting,
} from '../server/market/provenance';
import { DEFAULT_FEES, participantId, type Trade } from '../server/market/types';

const SELLER = participantId('acme-render');
const BUYER = participantId('borealis-studios');
const RATIONALE_DIGEST = digestRationale('Listing idle capacity below the utilisation floor.', { idle: 200 }, { name: 'floor', value: 60 });

const heads: ChainHeads = { get: () => GENESIS };

function fixture() {
  const quantity = 40;
  const unitPrice = fromDecimalString('12.50');
  const gross = grossFor(quantity, unitPrice);
  const trade: Trade = {
    id: 'trade-1', offerId: 'offer-1', bidId: 'bid-1',
    seller: SELLER, buyer: BUYER,
    listing: { sku: 'RENDER-H100', title: 'H100 hours', category: 'render-hours', unit: 'hour' },
    quantity, unitPrice, grossAmount: gross, feeAmount: computeFee(gross, DEFAULT_FEES),
    status: 'authorised', authorisationSerial: 'rcpt-9', proposedAt: 1, settledAt: null,
  };
  const outcome = settle(trade, DEFAULT_FEES, 5_000);
  if (!outcome.settled) throw new Error('fixture must settle');
  const postings = buildPostings({
    record: outcome.record, trade, offerRationaleDigest: RATIONALE_DIGEST, heads,
    idFor: (i) => `post-${i}`,
  });
  return { trade, record: outcome.record, postings };
}

// ============================================================ forward links

test('every posting names its trade, offer, bid, receipt, rationale and counterparty', () => {
  const { postings } = fixture();
  assert.equal(postings.length, 6);
  for (const p of postings) {
    assert.equal(p.provenance.tradeId, 'trade-1');
    assert.equal(p.provenance.offerId, 'offer-1');
    assert.equal(p.provenance.bidId, 'bid-1');
    assert.equal(p.provenance.authorisationSerial, 'rcpt-9');
    assert.equal(p.provenance.rationaleDigest, RATIONALE_DIGEST);
    assert.ok(p.provenance.settlementDigest.length === 64);
    assert.notEqual(p.provenance.counterparty, p.participant, 'a party is not its own counterparty');
  }
});

test('a posting explains itself in full, in plain language', () => {
  const { trade, postings } = fixture();
  const story = explain(postings.find((p) => p.participant === BUYER && p.account === 'cash')!, trade);
  for (const fragment of ['trade-1', 'acme-render', '40 hour', 'RENDER-H100', '12.50', 'offer-1', 'bid-1', 'rcpt-9']) {
    assert.ok(story.includes(fragment), `the explanation omits ${fragment}: ${story}`);
  }
});

test('postings cannot be built for an unauthorised trade', () => {
  const { trade, record } = fixture();
  assert.throws(
    () => buildPostings({
      record, trade: { ...trade, authorisationSerial: null },
      offerRationaleDigest: RATIONALE_DIGEST, heads, idFor: (i) => `p-${i}`,
    }),
    /Article IV §4\.1/,
  );
});

// =========================================================== chains per party

test("each participant's chain starts at genesis and links forward", () => {
  const { postings } = fixture();
  for (const party of [SELLER, BUYER]) {
    const own = postings.filter((p) => p.participant === party);
    assert.equal(own[0].previousDigest, GENESIS);
    for (let i = 1; i < own.length; i += 1) {
      assert.equal(own[i].previousDigest, own[i - 1].digest, `${party} chain broken at ${i}`);
    }
  }
});

test('chains are per participant, so one party cannot infer the other\'s volume', () => {
  const { postings } = fixture();
  const sellerDigests = new Set(postings.filter((p) => p.participant === SELLER).map((p) => p.previousDigest));
  const buyerDigests = postings.filter((p) => p.participant === BUYER).map((p) => p.digest);
  for (const d of buyerDigests) {
    assert.ok(!sellerDigests.has(d), "the seller's chain must not reference the buyer's postings");
  }
});

// ============================================================ reconciliation

test('a clean settlement reconciles', () => {
  const { trade, postings } = fixture();
  assert.deepEqual(reconcile(trade, postings, heads), { ok: true });
});

test('a tampered amount is detected', () => {
  const { trade, postings } = fixture();
  const tampered: Posting[] = postings.map((p, i) => (i === 0 ? { ...p, amount: p.amount + 1n } : p));
  const result = reconcile(trade, tampered, heads);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.failures.some((f) => f.kind === 'tampered'));
  assert.ok(result.failures.some((f) => f.kind === 'unbalanced'), 'and it no longer balances');
});

test('re-digesting a tampered posting does not save it — the chain still breaks', () => {
  const { trade, postings } = fixture();
  const forged = postings.map((p, i) => {
    if (i !== 0) return p;
    const { digest, ...unsigned } = p;
    const changed = { ...unsigned, amount: p.amount + 1n };
    return { ...changed, digest: postingDigest(changed) };
  });
  const result = reconcile(trade, forged, heads);
  assert.equal(result.ok, false, 'a re-hashed forgery must still fail reconciliation');
});

test('a posting swapped onto another trade is an orphan', () => {
  const { trade, postings } = fixture();
  const orphaned = postings.map((p, i) =>
    i === 0 ? { ...p, provenance: { ...p.provenance, tradeId: 'other-trade' } } : p);
  const result = reconcile(trade, orphaned, heads);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.failures.some((f) => f.kind === 'orphan_posting'));
});

test('a missing link is detected', () => {
  const { trade, postings } = fixture();
  const stripped = postings.map((p, i) =>
    i === 0 ? { ...p, provenance: { ...p.provenance, authorisationSerial: '' } } : p);
  const result = reconcile(trade, stripped, heads);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.failures.some((f) => f.kind === 'missing_link' && f.field === 'authorisationSerial'));
});

test('a broken chain link is detected', () => {
  const { trade, postings } = fixture();
  const broken = postings.map((p, i) => (i === 1 ? { ...p, previousDigest: GENESIS } : p));
  const result = reconcile(trade, broken, heads);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.failures.some((f) => f.kind === 'broken_chain'));
});

test('the trade and the postings must agree on gross and fee', () => {
  const { trade, postings } = fixture();
  const lying = { ...trade, grossAmount: trade.grossAmount + 100n };
  const result = reconcile(lying, postings, heads);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.failures.some((f) => f.kind === 'gross_mismatch'));
});

test('reconciliation reports every failure, not just the first', () => {
  const { trade, postings } = fixture();
  const wrecked = postings.map((p) => ({ ...p, provenance: { ...p.provenance, tradeId: 'nope' } }));
  const result = reconcile(trade, wrecked, heads);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.failures.length >= 6, 'an integrity report must be complete, not first-fail');
});

// ================================================================= reversal

test('a reversal is linked to the original and inherits its provenance', () => {
  const { postings } = fixture();
  const original = postings[0];
  const r = reverse(original, 'Counterparty disputed the delivered hours.', 9_000, 'post-r', original.digest);
  assert.equal(r.amount, -original.amount);
  assert.deepEqual(r.provenance, original.provenance, 'the pair stays attached to the same trade');
  assert.equal(r.previousDigest, original.digest);
  assert.match(r.memo, /REVERSAL of post-0/);
});

test('a reversal with no stated cause is refused', () => {
  const { postings } = fixture();
  assert.throws(() => reverse(postings[0], 'oops', 1, 'x', postings[0].digest), /must state its cause/);
});

test('an original and its reversal net to zero', () => {
  const { postings } = fixture();
  const original = postings[0];
  const r = reverse(original, 'Counterparty disputed the delivered hours.', 9_000, 'post-r', original.digest);
  assert.equal(original.amount + r.amount, 0n);
});

test('the provenance links are INSIDE the digest, not merely beside it', () => {
  // Added after a mutation test: removing provenance from postingDigest broke
  // nothing, which meant the file's own claim that the links are tamper-evident
  // was unverified. Swapping a link WITHOUT re-digesting must be detected as
  // tampering — and the field chosen here is deliberately not tradeId, because
  // reconcile() catches that one separately as an orphan and would mask the gap.
  const { trade, postings } = fixture();

  for (const field of ['offerId', 'bidId', 'settlementDigest', 'authorisationSerial', 'rationaleDigest'] as const) {
    const swapped = postings.map((p, i) =>
      i === 0 ? { ...p, provenance: { ...p.provenance, [field]: 'swapped-value' } } : p);
    const result = reconcile(trade, swapped, heads);
    assert.equal(result.ok, false, `swapping ${field} was not detected`);
    if (result.ok) continue;
    assert.ok(
      result.failures.some((f) => f.kind === 'tampered'),
      `swapping ${field} must register as tampering, not merely as a mismatch`,
    );
  }
});

test('swapping the counterparty is tamper-evident', () => {
  const { trade, postings } = fixture();
  const swapped = postings.map((p, i) =>
    i === 0 ? { ...p, provenance: { ...p.provenance, counterparty: participantId('someone-else') } } : p);
  const result = reconcile(trade, swapped, heads);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.failures.some((f) => f.kind === 'tampered'));
});

// =================================================== corrections and the ledger

test('a refunded trade still reconciles — corrections are not measured against gross', () => {
  const { trade, postings } = fixture();

  // A refund is FOUR legs — two per party — because it is double entry on both
  // sides. My first attempt wrote one leg each and reconcile() correctly
  // reported both books unbalanced, which is how the bug was found.
  const held = postings.find((p) => p.participant === SELLER && p.account === 'cash_held')!;
  const sellerInv = postings.find((p) => p.participant === SELLER && p.account === 'inventory')!;
  const buyerCash = postings.find((p) => p.participant === BUYER && p.account === 'cash')!;
  const buyerInv = postings.find((p) => p.participant === BUYER && p.account === 'inventory')!;

  const refund = fromDecimalString('100.00');
  const why = 'Dispute upheld: 8 of the 40 contracted hours never ran.';

  // Chained onto each participant's LAST settlement posting, not an arbitrary one.
  const sellerHead = postings.filter((p) => p.participant === SELLER).at(-1)!.digest;
  const buyerHead = postings.filter((p) => p.participant === BUYER).at(-1)!.digest;

  const rs1 = reverse({ ...held, amount: refund }, why, 9_000, 'r-s1', sellerHead);
  const rs2 = reverse({ ...sellerInv, amount: -refund }, why, 9_000, 'r-s2', rs1.digest);
  const rb1 = reverse({ ...buyerCash, amount: -refund }, why, 9_000, 'r-b1', buyerHead);
  const rb2 = reverse({ ...buyerInv, amount: refund }, why, 9_000, 'r-b2', rb1.digest);

  const result = reconcile(trade, [...postings, rs1, rs2, rb1, rb2], heads);
  assert.equal(result.ok, true, `a refunded trade must still reconcile: ${JSON.stringify((result as any).failures)}`);
});

test('a correction is still tamper-evident and still balances its participant', () => {
  const { trade, postings } = fixture();
  const held = postings.find((p) => p.participant === SELLER && p.account === 'cash_held')!;
  const sellerInv = postings.find((p) => p.participant === SELLER && p.account === 'inventory')!;
  const sellerHead = postings.filter((p) => p.participant === SELLER).at(-1)!.digest;

  const refund = fromDecimalString('100.00');
  const why = 'Dispute upheld: 8 of the 40 contracted hours never ran.';
  const rs1 = reverse({ ...held, amount: refund }, why, 9_000, 'r-s1', sellerHead);
  const rs2 = reverse({ ...sellerInv, amount: -refund }, why, 9_000, 'r-s2', rs1.digest);

  // Tampering with a correction is caught exactly like a settlement leg.
  const tampered = { ...rs2, amount: rs2.amount - 1n };
  const result = reconcile(trade, [...postings, rs1, tampered], heads);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.failures.some((f) => f.kind === 'tampered'));
  assert.ok(result.failures.some((f) => f.kind === 'unbalanced'), 'and the seller no longer balances');
});

test('the posting kind is inside the digest', () => {
  const { postings } = fixture();
  const relabelled = { ...postings[0], kind: 'correction' as const };
  const { digest, ...unsigned } = relabelled;
  assert.notEqual(postingDigest(unsigned), digest, 'relabelling a settlement as a correction must break the digest');
});
