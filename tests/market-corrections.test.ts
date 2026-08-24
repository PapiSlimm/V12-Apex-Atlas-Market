/**
 * The commit step. `disputes.ts` computed refunds correctly and nothing wrote
 * them; these tests are about what happens now that something does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { fromDecimalString } from '../server/constitution/money';
import { computeFee, grossFor, settle } from '../server/market/settlement';
import { GENESIS, buildPostings, digestRationale, type ChainHeads, type Posting } from '../server/market/provenance';
import {
  DEFAULT_DISPUTE_WINDOW_MS, raiseDispute, refundPostings, releaseEscrow, resolve, respond, type Dispute,
} from '../server/market/disputes';
import {
  commitRefund, commitRelease, correctionDigest, describeCorrection, eachSideBalances, postingsToLegs,
  type CorrectionPort,
} from '../server/market/corrections';
import { DEFAULT_FEES, participantId, type Trade } from '../server/market/types';
import { SqliteStore } from '../server/store/sqlite';
import { DEFAULT_TENANT_ID } from '../server/store/tenancy';
import type { CorrectionRecord, NewAuditEntry } from '../server/store/types';

const SELLER = participantId('acme-render');
const BUYER = participantId('borealis-studios');
const HUMAN = { id: 'ops-14', name: 'R. Dixon', kind: 'human' as const };

const SETTLED_AT = 1_000_000;
const NOW = SETTLED_AT + DEFAULT_DISPUTE_WINDOW_MS + 1;

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
    record: outcome.record, trade, heads: { get: () => GENESIS } as ChainHeads, idFor: (i) => `post-${i}`,
    offerRationaleDigest: digestRationale('idle capacity', { idle: 200 }, { name: 'floor', value: 60 }),
  });
  return { trade, postings };
}

const pick = (postings: Posting[], p: string, account: string) =>
  postings.find((x) => x.participant === p && x.account === account)!;

const headsFor = (postings: Posting[]): ChainHeads => ({
  get: (p) => {
    const own = postings.filter((x) => x.participant === p);
    return own.length ? own[own.length - 1].digest : GENESIS;
  },
});

function upheldDispute(over: Partial<Dispute> = {}): Dispute {
  const { trade } = fixture();
  const raised = raiseDispute({
    id: 'disp-1', trade, raisedBy: BUYER, ground: 'partially_delivered',
    statement: CLAIM, amountDisputed: fromDecimalString('350.00'), now: SETTLED_AT + 1_000,
  });
  if (!raised.ok) throw new Error('fixture must raise');
  const answered = respond(raised.value, SELLER, ANSWER, SETTLED_AT + 2_000);
  if (!answered.ok) throw new Error('fixture must answer');
  const resolved = resolve({
    dispute: answered.value, resolvedBy: HUMAN, upheld: true,
    refund: fromDecimalString('350.00'), reasons: REASONS, now: SETTLED_AT + 3_000,
  });
  if (!resolved.ok) throw new Error('fixture must resolve');
  return { ...resolved.value, ...over };
}

function refundFor(dispute: Dispute): Posting[] {
  const { postings } = fixture();
  return refundPostings({
    dispute,
    sellerHeldPosting: pick(postings, SELLER, 'cash_held'),
    sellerInventoryPosting: pick(postings, SELLER, 'inventory'),
    buyerCashPosting: pick(postings, BUYER, 'cash'),
    buyerInventoryPosting: pick(postings, BUYER, 'inventory'),
    heads: headsFor(postings), idFor: (s) => `refund-${s}`, now: SETTLED_AT + 4_000,
  });
}

function releaseFor(): Posting[] {
  const { trade, postings } = fixture();
  const outcome = releaseEscrow({
    trade, heldPosting: pick(postings, SELLER, 'cash_held'), dispute: null, now: NOW,
    idFor: (s) => `rel-${s}`, heads: headsFor(postings),
  });
  if (!outcome.ok) throw new Error(`fixture must release: ${outcome.detail}`);
  return outcome.value;
}

/** A port that records instead of persisting, for the decision tests. */
function fakePort(): CorrectionPort & { committed: { record: CorrectionRecord; entries: NewAuditEntry[] }[] } {
  const committed: { record: CorrectionRecord; entries: NewAuditEntry[] }[] = [];
  let n = 0;
  return {
    committed,
    commit: async (record, entries) => {
      if (committed.some((c) => c.record.tradeId === record.tradeId && c.record.kind === record.kind)) {
        return 'already_committed';
      }
      committed.push({ record, entries });
      return 'committed';
    },
    now: () => NOW,
    newId: (prefix) => `${prefix}-${++n}`,
  };
}

/* ---------------------------------------------------------------- *
 * Balance
 * ---------------------------------------------------------------- */

test('each party\'s legs must sum to zero independently, not just in aggregate', () => {
  const crossed = [
    { participant: SELLER, account: 'cash_held', amount: -100n, memo: '' },
    { participant: BUYER, account: 'cash', amount: 100n, memo: '' },
  ];
  const aggregate = crossed.reduce((sum, l) => sum + l.amount, 0n);
  assert.equal(aggregate, 0n, 'the naive check would pass this');

  const result = eachSideBalances(crossed);
  assert.equal(result.ok, false, 'and neither book balances');
});

test('a real refund balances on both books', () => {
  const legs = postingsToLegs(refundFor(upheldDispute()));
  assert.equal(legs.length, 4);
  assert.equal(eachSideBalances(legs).ok, true);
});

/* ---------------------------------------------------------------- *
 * Refunds
 * ---------------------------------------------------------------- */

test('an upheld dispute commits a refund with an audit entry for each party', async () => {
  const port = fakePort();
  const result = await commitRefund(port, { dispute: upheldDispute(), postings: refundFor(upheldDispute()) });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.status, 'committed');
  assert.equal(result.value.record.kind, 'refund');
  assert.equal(result.value.record.decidedBy, 'R. Dixon');
  assert.match(result.value.record.reason, /Dispute disp-1 upheld/);

  const [entry] = port.committed[0].entries;
  assert.equal(port.committed[0].entries.length, 2, 'both parties see it in their own record');
  assert.equal(entry.event, 'market.correction.refund');
  assert.equal(entry.actorRole, 'Inspector General');
});

test('a dispute that is not upheld refunds nothing', async () => {
  const port = fakePort();
  const rejected = { ...upheldDispute(), status: 'rejected' as const };
  const result = await commitRefund(port, { dispute: rejected, postings: refundFor(upheldDispute()) });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'dispute_not_upheld');
  assert.equal(port.committed.length, 0);
});

test('a resolution with no named human is an unmade decision', async () => {
  const port = fakePort();
  const dispute = upheldDispute();
  const anonymous: Dispute = {
    ...dispute,
    resolution: { ...dispute.resolution!, resolvedBy: { id: 'x', name: '   ', kind: 'human' } },
  };
  const result = await commitRefund(port, { dispute: anonymous, postings: refundFor(dispute) });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'no_decider');
});

test('unbalanced postings are refused BEFORE they are written', async () => {
  const port = fakePort();
  const postings = refundFor(upheldDispute());
  const broken = [postings[0], postings[2]]; // one leg per party — the bug reconcile once caught
  const result = await commitRefund(port, { dispute: upheldDispute(), postings: broken });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'unbalanced');
  assert.match(result.detail, /double entry on BOTH sides/);
  assert.equal(port.committed.length, 0);
});

test('a settlement posting cannot be smuggled in as a correction', async () => {
  const port = fakePort();
  const { postings } = fixture();
  const result = await commitRefund(port, { dispute: upheldDispute(), postings });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'wrong_kind');
  assert.match(result.detail, /healthy ledger read as broken/);
});

test('an empty posting set is not written at all', async () => {
  const port = fakePort();
  const result = await commitRefund(port, { dispute: upheldDispute(), postings: [] });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'nothing_to_commit');
});

/* ---------------------------------------------------------------- *
 * Escrow release
 * ---------------------------------------------------------------- */

test('a closed window releases escrow and names the rule, not a person', async () => {
  const port = fakePort();
  const result = await commitRelease(port, {
    trade: fixture().trade, postings: releaseFor(), windowMs: DEFAULT_DISPUTE_WINDOW_MS,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.record.kind, 'release');
  assert.equal(result.value.record.decidedBy, 'rule: dispute window closed');
  assert.match(result.value.record.reason, /7 day\(s\) closed/);
  assert.equal(port.committed[0].entries[0].actorName, 'system');
});

test('a release posting cannot be committed as a refund', async () => {
  const port = fakePort();
  const result = await commitRefund(port, { dispute: upheldDispute(), postings: releaseFor() });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'wrong_kind');
});

/* ---------------------------------------------------------------- *
 * Identity and idempotency
 * ---------------------------------------------------------------- */

test('the digest covers chain position, not just amounts', () => {
  const postings = refundFor(upheldDispute());
  const base = correctionDigest('trade-1', 'refund', postings);

  assert.notEqual(correctionDigest('trade-2', 'refund', postings), base);
  assert.notEqual(correctionDigest('trade-1', 'release', postings), base);

  const relinked = [{ ...postings[0], previousDigest: 'f'.repeat(64) }, ...postings.slice(1)];
  assert.notEqual(
    correctionDigest('trade-1', 'refund', relinked),
    base,
    'two refunds of the same value would otherwise digest identically',
  );
});

test('a refund commits exactly once, even through the real database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-corrections-'));
  const store = new SqliteStore(path.join(dir, 'test.db'));
  await store.init();

  let n = 0;
  const port: CorrectionPort = {
    commit: (record, entries) => store.market.corrections.commit(DEFAULT_TENANT_ID, record, entries),
    now: () => NOW,
    newId: (prefix) => `${prefix}-${++n}`,
  };

  const first = await commitRefund(port, { dispute: upheldDispute(), postings: refundFor(upheldDispute()) });
  const second = await commitRefund(port, { dispute: upheldDispute(), postings: refundFor(upheldDispute()) });

  assert.equal(first.ok && first.value.status, 'committed');
  assert.equal(second.ok && second.value.status, 'already_committed');

  const stored = await store.market.corrections.forTrade(DEFAULT_TENANT_ID, 'trade-1');
  assert.equal(stored.length, 1);
  assert.equal(eachSideBalances(stored[0].legs).ok, true, 'and it still balances after the round trip');

  const log = await store.audit.list(DEFAULT_TENANT_ID, 50);
  assert.equal(log.filter((e) => e.event === 'market.correction.refund').length, 2, 'two parties, one correction');
  assert.equal((await store.audit.verify(DEFAULT_TENANT_ID)).ok, true);

  await store.close();
});

test('a correction explains itself in words a party can read', () => {
  const legs = postingsToLegs(refundFor(upheldDispute()));
  const text = describeCorrection({
    id: 'corr-1', tradeId: 'trade-1', kind: 'refund', legs,
    digest: 'a'.repeat(64), reason: 'Dispute disp-1 upheld', decidedBy: 'R. Dixon', createdAt: NOW,
  });
  assert.match(text, /^Refund on trade trade-1/);
  assert.match(text, /Decided by: R\. Dixon/);
});
