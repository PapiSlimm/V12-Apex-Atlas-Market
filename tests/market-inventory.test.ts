import test from 'node:test';
import assert from 'node:assert/strict';

import {
  available,
  checkAvailability,
  commit,
  describePosition,
  detectPhantomSupply,
  detectUnaccountedRepeatSelling,
  fulfil,
  reconcile,
  release,
  requireAccounting,
  rollPeriod,
  type InventoryPosition,
} from '../server/market/inventory';
import { checkInventory } from '../server/market/guards';
import { participantId } from '../server/market/types';

const SELLER = participantId('acme-render');

const NOW = 1_700_000_000_000;
const WEEK = 7 * 24 * 60 * 60 * 1000;

function depleting(over: Partial<InventoryPosition> = {}): InventoryPosition {
  return {
    participant: SELLER,
    sku: 'GPU-A100-USED',
    kind: 'depleting',
    onHand: 100,
    committed: 0,
    delivered: 0,
    periodStart: null,
    periodEnd: null,
    issuanceCap: null,
    issued: 0,
    updatedAt: NOW,
    ...over,
  };
}

function renewable(over: Partial<InventoryPosition> = {}): InventoryPosition {
  return {
    ...depleting(),
    sku: 'RENDER-HOURS',
    kind: 'renewable',
    onHand: 40,
    periodStart: NOW - 1_000,
    periodEnd: NOW + WEEK,
    ...over,
  };
}

function issuable(over: Partial<InventoryPosition> = {}): InventoryPosition {
  return {
    ...depleting(),
    sku: 'FOOTAGE-LICENCE',
    kind: 'issuable',
    onHand: 0,
    issuanceCap: null,
    ...over,
  };
}

/* ---------------------------------------------------------------- *
 * The mandatory rule
 * ---------------------------------------------------------------- */

test('a genuine one-off — one unit, never listed before — needs no record', () => {
  const result = requireAccounting({ participant: SELLER, sku: 'USED-CAMERA-1', quantity: 1, priorListings: 0 }, null);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.mandatory, false);
});

test('selling more than one unit in a single offer makes accounting mandatory', () => {
  const result = requireAccounting({ participant: SELLER, sku: 'RENDER-HOURS', quantity: 40, priorListings: 0 }, null);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'accounting_required');
  assert.match(result.detail, /40 units/);
  assert.match(result.remedy, /depleting, renewable or issuable/);
});

test('listing the same SKU a second time makes accounting mandatory', () => {
  const result = requireAccounting({ participant: SELLER, sku: 'STUDIO-DAY', quantity: 1, priorListings: 1 }, null);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'accounting_required');
  assert.match(result.detail, /selling the same unit twice/i);
});

test('a record for a different SKU does not satisfy the rule', () => {
  const result = requireAccounting(
    { participant: SELLER, sku: 'RENDER-HOURS', quantity: 10, priorListings: 3 },
    depleting({ sku: 'SOMETHING-ELSE' }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'no_inventory_record');
});

test('a record belonging to another participant does not satisfy the rule', () => {
  const result = requireAccounting(
    { participant: SELLER, sku: 'GPU-A100-USED', quantity: 10, priorListings: 3 },
    depleting({ participant: participantId('someone-else') }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'no_inventory_record');
});

test('a listing of zero or a fraction is refused before anything else', () => {
  for (const quantity of [0, -5, 2.5]) {
    const result = requireAccounting({ participant: SELLER, sku: 'X', quantity, priorListings: 9 }, null);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'quantity_invalid');
  }
});

/* ---------------------------------------------------------------- *
 * The double-sell
 * ---------------------------------------------------------------- */

test('the same units cannot be committed twice', () => {
  const first = commit(depleting({ onHand: 100 }), 100, NOW);
  assert.equal(first.ok, true);
  if (!first.ok) return;

  const second = commit(first.value, 1, NOW);
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.reason, 'oversold');
  assert.match(second.detail, /100 on hand with 100 already committed/);
});

test('an oversell refusal states the arithmetic rather than just refusing', () => {
  const result = checkAvailability(depleting({ onHand: 10, committed: 7 }), 5, NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'oversold');
  assert.match(result.detail, /10 on hand with 7 already committed, leaving 3/);
  assert.match(result.remedy, /Reduce the quantity/);
});

test('committing reduces what remains for the next agent', () => {
  const after = commit(depleting({ onHand: 100 }), 30, NOW);
  assert.equal(after.ok, true);
  if (!after.ok) return;
  assert.equal(available(after.value, NOW), 70);
  assert.equal(after.value.committed, 30);
  assert.equal(after.value.onHand, 100, 'stock does not leave until delivery is confirmed');
});

/* ---------------------------------------------------------------- *
 * Renewable capacity
 * ---------------------------------------------------------------- */

test('renewable capacity outside its period is zero, not last period\'s remainder', () => {
  const stale = renewable({ periodStart: NOW - 2 * WEEK, periodEnd: NOW - WEEK, onHand: 40, committed: 0 });
  assert.equal(available(stale, NOW), 0);

  const result = checkAvailability(stale, 1, NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'capacity_period_stale');
  assert.match(result.detail, /does not carry forward/);
});

test('renewable capacity inside its period sells normally', () => {
  const result = checkAvailability(renewable(), 40, NOW);
  assert.equal(result.ok, true);
});

test('selling more than this period\'s capacity is capacity_exhausted, not oversold', () => {
  const result = checkAvailability(renewable({ onHand: 40, committed: 35 }), 10, NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'capacity_exhausted');
  assert.match(result.detail, /5 of this period's 40/);
});

test('a period cannot be rolled while commitments are still open against it', () => {
  const result = rollPeriod(renewable({ committed: 4 }), {
    capacity: 40,
    periodStart: NOW + WEEK,
    periodEnd: NOW + 2 * WEEK,
    now: NOW,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'not_committed');
  assert.match(result.detail, /still committed in the period being closed/);
});

test('rolling a period resets capacity and does not carry the remainder forward', () => {
  const result = rollPeriod(renewable({ onHand: 40, committed: 0, delivered: 12 }), {
    capacity: 40,
    periodStart: NOW + WEEK,
    periodEnd: NOW + 2 * WEEK,
    now: NOW,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.onHand, 40, 'not 68 — unsold capacity is gone');
  assert.equal(available(result.value, NOW + WEEK + 1), 40);
});

test('only renewable positions have periods', () => {
  const result = rollPeriod(depleting(), { capacity: 10, periodStart: NOW, periodEnd: NOW + WEEK, now: NOW });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'kind_mismatch');
});

test('a period must end after it starts', () => {
  const result = rollPeriod(renewable({ committed: 0 }), {
    capacity: 10,
    periodStart: NOW + WEEK,
    periodEnd: NOW,
    now: NOW,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'quantity_invalid');
});

/* ---------------------------------------------------------------- *
 * Issuable — non-depleting is not unaccounted
 * ---------------------------------------------------------------- */

test('an uncapped licence still counts every issuance', () => {
  const committed = commit(issuable(), 3, NOW);
  assert.equal(committed.ok, true);
  if (!committed.ok) return;

  const done = fulfil(committed.value, 3, NOW + 1);
  assert.equal(done.ok, true);
  if (!done.ok) return;
  assert.equal(done.value.issued, 3);
  assert.equal(done.value.delivered, 3);
  assert.equal(done.value.onHand, 0, 'an issuable SKU does not deplete stock');
});

test('an issuance cap is enforced and explained as the exclusivity term it usually is', () => {
  const result = checkAvailability(issuable({ issuanceCap: 10, issued: 9, committed: 1 }), 1, NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'issuance_cap_reached');
  assert.match(result.detail, /exclusivity term/);
});

/* ---------------------------------------------------------------- *
 * Transitions
 * ---------------------------------------------------------------- */

test('you cannot release more than was reserved', () => {
  const result = release(depleting({ committed: 2 }), 3, NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'not_committed');
  assert.match(result.detail, /would invent stock/);
});

test('releasing returns units to the sellable pool', () => {
  const result = release(depleting({ onHand: 10, committed: 4 }), 4, NOW);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(available(result.value, NOW), 10);
});

test('delivering more than was committed is an accounting break, not a rounding difference', () => {
  const result = fulfil(depleting({ committed: 1 }), 2, NOW);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'not_committed');
  assert.match(result.remedy, /Investigate/);
});

test('confirmed delivery is when depleting stock actually leaves', () => {
  const reserved = commit(depleting({ onHand: 10 }), 4, NOW);
  assert.equal(reserved.ok, true);
  if (!reserved.ok) return;
  assert.equal(reserved.value.onHand, 10);

  const delivered = fulfil(reserved.value, 4, NOW + 1);
  assert.equal(delivered.ok, true);
  if (!delivered.ok) return;
  assert.equal(delivered.value.onHand, 6);
  assert.equal(delivered.value.committed, 0);
  assert.equal(delivered.value.delivered, 4);
});

/* ---------------------------------------------------------------- *
 * Reconciliation
 * ---------------------------------------------------------------- */

test('reconcile is silent when the record matches what the trades say', () => {
  const breaks = reconcile(depleting({ committed: 5, delivered: 12 }), { openCommitments: 5, confirmedDeliveries: 12 });
  assert.equal(breaks.length, 0);
});

test('reconcile names the direction: promised more than the book shows', () => {
  const breaks = reconcile(depleting({ committed: 2 }), { openCommitments: 9, confirmedDeliveries: 0 });
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].field, 'committed');
  assert.match(breaks[0].detail, /7 units are promised on open offers/);
  assert.match(breaks[0].detail, /outside the reservation path/);
});

test('reconcile names the other direction too: stock held against nothing', () => {
  const breaks = reconcile(depleting({ committed: 9 }), { openCommitments: 2, confirmedDeliveries: 0 });
  assert.equal(breaks.length, 1);
  assert.match(breaks[0].detail, /7 units are held as committed with nothing claiming them/);
  assert.match(breaks[0].detail, /unsellable until it is found/);
});

test('a delivery break says the buyer\'s confirmation is the fact', () => {
  const breaks = reconcile(depleting({ delivered: 30 }), { openCommitments: 0, confirmedDeliveries: 4 });
  assert.equal(breaks.length, 1);
  assert.equal(breaks[0].field, 'delivered');
  assert.match(breaks[0].detail, /the trades are the fact and the record is the claim/);
});

/* ---------------------------------------------------------------- *
 * Detection
 * ---------------------------------------------------------------- */

test('four agents each posting the whole stock is caught as phantom supply', () => {
  const findings = detectPhantomSupply(
    depleting({ onHand: 200, committed: 0 }),
    [
      { offerId: 'o1', sku: 'GPU-A100-USED', quantity: 200 },
      { offerId: 'o2', sku: 'GPU-A100-USED', quantity: 200 },
      { offerId: 'o3', sku: 'GPU-A100-USED', quantity: 200 },
      { offerId: 'o4', sku: 'GPU-A100-USED', quantity: 200 },
    ],
    NOW,
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].signal, 'phantom_supply');
  assert.equal(findings[0].severity, 'serious');
  assert.match(findings[0].detail, /totalling 800 units against declared capacity of 200/);
  assert.match(findings[0].detail, /Each offer is individually valid/);
});

test('phantom supply ignores other SKUs and stays silent within capacity', () => {
  const findings = detectPhantomSupply(
    depleting({ onHand: 200 }),
    [
      { offerId: 'o1', sku: 'GPU-A100-USED', quantity: 150 },
      { offerId: 'o2', sku: 'SOMETHING-ELSE', quantity: 9_000 },
    ],
    NOW,
  );
  assert.equal(findings.length, 0);
});

test('offers already reserved against the position are not counted twice', () => {
  // 200 declared, 150 of them already committed to agreed trades, and 200 units
  // on the board in total. Nothing phantom: the committed units are the same
  // units the open offers represent. Comparing offers against UNCOMMITTED stock
  // would refuse every seller the moment their first offer was taken.
  const findings = detectPhantomSupply(
    depleting({ onHand: 200, committed: 150 }),
    [{ offerId: 'o1', sku: 'GPU-A100-USED', quantity: 200 }],
    NOW,
  );
  assert.equal(findings.length, 0);

  const over = detectPhantomSupply(
    depleting({ onHand: 200, committed: 150 }),
    [{ offerId: 'o1', sku: 'GPU-A100-USED', quantity: 201 }],
    NOW,
  );
  assert.equal(over.length, 1, 'one unit past the declared total is still phantom');
});

test('an uncapped issuable SKU cannot be phantom supply', () => {
  const findings = detectPhantomSupply(
    issuable({ issuanceCap: null }),
    [{ offerId: 'o1', sku: 'FOOTAGE-LICENCE', quantity: 1_000_000 }],
    NOW,
  );
  assert.equal(findings.length, 0);
});

test('repeat listing with no record at all is reported for review', () => {
  const findings = detectUnaccountedRepeatSelling(SELLER, { 'RENDER-HOURS': 6, 'ONE-OFF': 1 }, () => false);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].signal, 'inventory_unaccounted');
  assert.match(findings[0].detail, /RENDER-HOURS \(6\)/);
  assert.doesNotMatch(findings[0].detail, /ONE-OFF/);
});

test('a seller who has declared their inventory is not reported', () => {
  const findings = detectUnaccountedRepeatSelling(SELLER, { 'RENDER-HOURS': 6 }, () => true);
  assert.equal(findings.length, 0);
});

/* ---------------------------------------------------------------- *
 * Description and the guard bridge
 * ---------------------------------------------------------------- */

test('a renewable position describes itself as not carrying forward', () => {
  const text = describePosition(renewable({ committed: 8 }), NOW);
  assert.match(text, /32 of 40 uncommitted this period/);
  assert.match(text, /does not carry forward/);
});

test('an issuable position reports issuances rather than stock', () => {
  const text = describePosition(issuable({ issued: 412, issuanceCap: null }), NOW);
  assert.match(text, /412 issued/);
  assert.match(text, /uncapped/);
  assert.match(text, /Every issuance is counted/);
});

test('the guard bridge separates "no accounting" from "not enough"', () => {
  const missing = requireAccounting({ participant: SELLER, sku: 'X', quantity: 5, priorListings: 0 }, null);
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(checkInventory(missing)?.code, 'inventory_unaccounted');

  const short = checkAvailability(depleting({ onHand: 1 }), 5, NOW);
  assert.equal(short.ok, false);
  if (short.ok) return;
  assert.equal(checkInventory(short)?.code, 'inventory_insufficient');

  assert.equal(checkInventory(null), null);
});

test('the guard bridge carries the seller\'s remedy through, not just a code', () => {
  const short = checkAvailability(renewable({ onHand: 40, committed: 40 }), 1, NOW);
  assert.equal(short.ok, false);
  if (short.ok) return;
  const refusal = checkInventory(short);
  assert.ok(refusal);
  assert.match(refusal.detail, /Sell into a later period/);
  assert.equal(refusal.citation, 'Article III §3.2');
});
