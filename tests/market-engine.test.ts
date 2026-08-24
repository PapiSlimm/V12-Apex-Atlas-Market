/**
 * Lifecycle and guardrail tests.
 *
 * The fake port is deliberately dumb: it records calls and answers from plain
 * state, so a failure here is a failure of ORDERING or of a guardrail, never of
 * a mock's cleverness. The compare-and-swap is modelled honestly — it returns
 * row counts and can be made to lose a race on demand.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { MarketEngine, type MarketPort } from '../server/market/engine';
import type { AuthorisationFacts, EstateState, ParticipantLimits } from '../server/market/guards';
import { fromDecimalString } from '../server/constitution/money';
import { DEFAULT_FEES, participantId, type Bid, type Listing, type Offer, type SettlementRecord, type Trade } from '../server/market/types';
import type { InventoryPosition } from '../server/market/inventory';
import type { Rationale } from '../server/constitution/types';

const SELLER = participantId('acme-render');
const BUYER = participantId('borealis-studios');
const OUTSIDER = participantId('unknown-co');

const LISTING: Listing = { sku: 'RENDER-H100', title: 'H100 render hours', category: 'render-hours', unit: 'hour' };

const GOOD_RATIONALE: Rationale = {
  summary: 'Listing 200 idle H100 hours at 12.50 because utilisation sat below the 60% floor for 14 days.',
  inputs: { utilisationPct: 41, idleHours: 200, daysBelowFloor: 14 },
  threshold: { name: 'utilisation_floor_pct', value: 60 },
  language: 'en-GB',
};

interface FakeState {
  offer: Offer;
  trades: Map<string, Trade>;
  estate: EstateState;
  limits: Map<string, ParticipantLimits>;
  auth: AuthorisationFacts;
  unitCost: bigint;
  audits: { event: string; participant: string; outcome: string }[];
  commits: SettlementRecord[];
  reserveWins: boolean;
  settleClaimWins: boolean;
  saveTradeThrows: boolean;
  released: number;
  clock: number;
  /** The seller's declared ability to deliver. Null means no record at all. */
  inventory: InventoryPosition | null;
  /** How many times this SKU has been listed before. */
  priorListings: number;
  /** Force the inventory compare-and-swap to lose, to model a concurrent agent. */
  inventorySaveWins: boolean;
  listingsRecorded: { sku: string; at: number }[];
}

function makeFake(over: Partial<FakeState> = {}) {
  const limits: ParticipantLimits = {
    maxOrderNotional: fromDecimalString('100000.00'),
    maxDailyNotional: fromDecimalString('500000.00'),
    committedToday: 0n,
    marginFloorBasisPoints: 2000,
  };

  const state: FakeState = {
    offer: {
      id: 'offer-1', seller: SELLER, listing: LISTING,
      unitPrice: fromDecimalString('12.50'),
      quantityAvailable: 200, minimumQuantity: 10,
      status: 'open', postedAt: 0, expiresAt: null, rationale: GOOD_RATIONALE,
    },
    trades: new Map(),
    estate: {
      halted: false,
      sanctionedParticipants: new Set<string>(),
      admittedParticipants: new Set<string>([SELLER, BUYER]),
    },
    limits: new Map([[SELLER, limits], [BUYER, limits]]),
    auth: {
      serial: 'rcpt-1', authorisedParty: BUYER,
      ceiling: fromDecimalString('100000.00'), expiresAt: 9_000_000,
      requestedBy: 'buying-agent', authorisedBy: 'comptroller',
    },
    unitCost: fromDecimalString('5.00'),
    audits: [], commits: [],
    reserveWins: true, settleClaimWins: true, saveTradeThrows: false,
    released: 0, clock: 1_000,
    // A seller who has declared 200 units and listed before. The default is a
    // compliant seller, so a test that fails here is a real refusal, not a
    // fixture that forgot to declare inventory.
    inventory: {
      participant: SELLER, sku: LISTING.sku, kind: 'depleting',
      onHand: 200, committed: 0, delivered: 0,
      periodStart: null, periodEnd: null, issuanceCap: null, issued: 0,
      updatedAt: 500,
    },
    priorListings: 1,
    inventorySaveWins: true,
    listingsRecorded: [],
    ...over,
  };

  let counter = 0;
  const port: MarketPort = {
    getOffer: async (id) => (id === state.offer.id ? state.offer : null),
    reserveQuantity: async (_id, expected, quantity) => {
      if (!state.reserveWins) return 0;
      if (state.offer.quantityAvailable !== expected) return 0;
      state.offer.quantityAvailable -= quantity;
      return 1;
    },
    releaseQuantity: async (_id, quantity) => {
      state.offer.quantityAvailable += quantity;
      state.released += quantity;
    },
    saveTrade: async (t) => {
      if (state.saveTradeThrows) throw new Error('write failed');
      state.trades.set(t.id, t);
    },
    getTrade: async (id) => state.trades.get(id) ?? null,
    markTradeSettled: async (id, expected, at) => {
      const t = state.trades.get(id);
      if (!state.settleClaimWins || !t || t.status !== expected) return 0;
      state.trades.set(id, { ...t, status: 'settled', settledAt: at });
      return 1;
    },
    commitSettlement: async (record) => void state.commits.push(record),
    estate: async () => state.estate,
    limitsFor: async (p) => state.limits.get(p)!,
    authorisationFor: async () => state.auth,
    unitCostFor: async () => state.unitCost,
    inventoryFor: async (_p, sku) => (state.inventory && state.inventory.sku === sku ? state.inventory : null),
    priorListings: async () => state.priorListings,
    saveInventory: async (position, expectedUpdatedAt) => {
      if (!state.inventorySaveWins) return 0;
      if (!state.inventory || state.inventory.updatedAt !== expectedUpdatedAt) return 0;
      state.inventory = position;
      return 1;
    },
    recordListing: async (_p, sku, at) => void state.listingsRecorded.push({ sku, at }),
    audit: async (e) => void state.audits.push({ event: e.event, participant: e.participant, outcome: e.outcome }),
    now: () => state.clock,
    newId: (prefix) => `${prefix}-${++counter}`,
  };

  return { state, engine: new MarketEngine(port, DEFAULT_FEES) };
}

const bid = (over: Partial<Bid> = {}): Bid => ({
  id: 'bid-1', offerId: 'offer-1', buyer: BUYER,
  quantity: 40, unitPrice: fromDecimalString('12.50'),
  placedAt: 900, expiresAt: 9_000_000, rationale: GOOD_RATIONALE,
  ...over,
});

// ============================================================== the happy path

test('a complete trade: offer, bid, authorise, settle', async () => {
  const { state, engine } = makeFake();

  const accepted = await engine.acceptBid(bid());
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.value.status, 'proposed');
  assert.equal(state.offer.quantityAvailable, 160, 'quantity is reserved on acceptance');

  const authorised = await engine.authorise(accepted.value.id);
  assert.equal(authorised.ok, true);
  if (!authorised.ok) return;
  assert.equal(authorised.value.status, 'authorised');
  assert.equal(authorised.value.authorisationSerial, 'rcpt-1');

  const settled = await engine.settleTrade(accepted.value.id);
  assert.equal(settled.ok, true);
  if (!settled.ok) return;
  assert.equal(state.commits.length, 1);
  assert.equal(settled.value.legs.length, 6, 'three legs each side');
  assert.equal(settled.value.digest.length, 64);
});

test('settlement is recorded for both parties, not just the buyer', async () => {
  const { state, engine } = makeFake();
  const accepted = await engine.acceptBid(bid());
  if (!accepted.ok) return assert.fail();
  await engine.authorise(accepted.value.id);
  await engine.settleTrade(accepted.value.id);

  const committed = state.audits.filter((a) => a.event === 'market.settlement.committed');
  assert.equal(committed.length, 2);
  assert.deepEqual(new Set(committed.map((a) => a.participant)), new Set([SELLER, BUYER]));
});

test('the trade clears at the offer price, never above it', async () => {
  const { engine } = makeFake();
  const generous = await engine.acceptBid(bid({ unitPrice: fromDecimalString('20.00') }));
  assert.equal(generous.ok, true);
  if (!generous.ok) return;
  assert.equal(generous.value.unitPrice, fromDecimalString('12.50'), 'a generous bid does not overpay by accident');
});

// ================================================================== guardrails

test('a halt stops a trade before anything else is considered', async () => {
  const { state, engine } = makeFake();
  state.estate = { ...state.estate, halted: true };
  const result = await engine.acceptBid(bid());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'ecosystem_halted');
  assert.equal(state.offer.quantityAvailable, 200, 'nothing was reserved');
});

test('a sanctioned buyer cannot trade', async () => {
  const { state, engine } = makeFake();
  state.estate = { ...state.estate, sanctionedParticipants: new Set([BUYER]) };
  const result = await engine.acceptBid(bid());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'participant_sanctioned');
});

test('a sanctioned SELLER cannot be traded with either', async () => {
  const { state, engine } = makeFake();
  state.estate = { ...state.estate, sanctionedParticipants: new Set([SELLER]) };
  const result = await engine.acceptBid(bid());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'participant_sanctioned');
});

test('an unadmitted participant cannot trade', async () => {
  const { state, engine } = makeFake();
  state.limits.set(OUTSIDER, state.limits.get(BUYER)!);
  const result = await engine.acceptBid(bid({ buyer: OUTSIDER }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'participant_not_admitted');
});

test('a bid with no real rationale is refused', async () => {
  const { engine } = makeFake();
  const result = await engine.acceptBid(bid({ rationale: { ...GOOD_RATIONALE, summary: 'buying some' } }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'rationale_vacuous');
});

test('"the model decided" is not a rationale, even from a buyer', async () => {
  const { engine } = makeFake();
  const result = await engine.acceptBid(bid({
    rationale: { ...GOOD_RATIONALE, summary: 'The model decided this capacity was worth acquiring at this price today.' },
  }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'rationale_vacuous');
});

test('a participant cannot trade with itself', async () => {
  const { engine } = makeFake();
  const result = await engine.acceptBid(bid({ buyer: SELLER }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'self_dealing');
});

test('an expired bid is refused', async () => {
  const { engine } = makeFake();
  const result = await engine.acceptBid(bid({ expiresAt: 500 }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'bid_expired');
});

test('a quantity below the seller lot minimum is refused', async () => {
  const { engine } = makeFake();
  const result = await engine.acceptBid(bid({ quantity: 3 }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'quantity_below_minimum');
});

test('a quantity beyond what remains is refused', async () => {
  const { engine } = makeFake();
  const result = await engine.acceptBid(bid({ quantity: 500 }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'quantity_exceeds_available');
});

test('a wildly implausible price is refused as an error, not honoured', async () => {
  const { engine } = makeFake();
  const fat = await engine.acceptBid(bid({ unitPrice: fromDecimalString('125000.00') }));
  assert.equal(fat.ok, false);
  if (fat.ok) return;
  assert.equal(fat.refusal.code, 'price_implausible');

  const { engine: e2 } = makeFake();
  const tiny = await e2.acceptBid(bid({ unitPrice: 1n }));
  assert.equal(tiny.ok, false);
});

test('a trade above the single-order ceiling is refused', async () => {
  const { state, engine } = makeFake();
  state.limits.set(BUYER, { ...state.limits.get(BUYER)!, maxOrderNotional: fromDecimalString('100.00') });
  const result = await engine.acceptBid(bid());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'exceeds_order_ceiling');
});

test('a trade breaching the rolling daily ceiling is refused', async () => {
  const { state, engine } = makeFake();
  state.limits.set(BUYER, {
    ...state.limits.get(BUYER)!,
    maxDailyNotional: fromDecimalString('600.00'),
    committedToday: fromDecimalString('550.00'),
  });
  const result = await engine.acceptBid(bid());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'exceeds_daily_exposure');
});

test('an offer below the seller margin floor is refused at posting, not at fill', async () => {
  const { engine } = makeFake();
  const result = await engine.postOffer({
    seller: SELLER, listing: LISTING,
    unitPrice: fromDecimalString('5.50'), // cost is 5.00 → ~9%, floor is 20%
    quantity: 100, minimumQuantity: 1, expiresAt: null, rationale: GOOD_RATIONALE,
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'below_margin_floor');
  assert.match(result.refusal.detail, /below the configured floor/);
});

test('a compliant offer posts', async () => {
  const { engine } = makeFake();
  const result = await engine.postOffer({
    seller: SELLER, listing: LISTING, unitPrice: fromDecimalString('12.50'),
    quantity: 100, minimumQuantity: 10, expiresAt: null, rationale: GOOD_RATIONALE,
  });
  assert.equal(result.ok, true);
});

// ============================================================ Article IV

test('a trade cannot settle without authorisation', async () => {
  const { engine } = makeFake();
  const accepted = await engine.acceptBid(bid());
  if (!accepted.ok) return assert.fail();
  // Skip authorise() entirely.
  const settled = await engine.settleTrade(accepted.value.id);
  assert.equal(settled.ok, false);
});

test('a receipt bound to another participant is refused', async () => {
  const { state, engine } = makeFake();
  state.auth = { ...state.auth, authorisedParty: OUTSIDER };
  const accepted = await engine.acceptBid(bid());
  if (!accepted.ok) return assert.fail();
  const result = await engine.authorise(accepted.value.id);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'authorisation_wrong_party');
});

test('an agent cannot approve its own spending', async () => {
  const { state, engine } = makeFake();
  state.auth = { ...state.auth, requestedBy: 'buying-agent', authorisedBy: 'buying-agent' };
  const accepted = await engine.acceptBid(bid());
  if (!accepted.ok) return assert.fail();
  const result = await engine.authorise(accepted.value.id);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'authorisation_wrong_party');
});

test('an expired receipt is refused', async () => {
  const { state, engine } = makeFake();
  state.auth = { ...state.auth, expiresAt: 500 };
  const accepted = await engine.acceptBid(bid());
  if (!accepted.ok) return assert.fail();
  const result = await engine.authorise(accepted.value.id);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'authorisation_expired');
});

test('a receipt whose ceiling is below the trade total is refused', async () => {
  const { state, engine } = makeFake();
  state.auth = { ...state.auth, ceiling: fromDecimalString('100.00') };
  const accepted = await engine.acceptBid(bid());
  if (!accepted.ok) return assert.fail();
  const result = await engine.authorise(accepted.value.id);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'authorisation_exceeded');
});

test('the ceiling is checked against gross PLUS fee, not gross alone', async () => {
  const { state, engine } = makeFake();
  // gross is 500.00; fee at 100bp is 5.00. A ceiling of exactly 500 must fail.
  state.auth = { ...state.auth, ceiling: fromDecimalString('500.00') };
  const accepted = await engine.acceptBid(bid());
  if (!accepted.ok) return assert.fail();
  const result = await engine.authorise(accepted.value.id);
  assert.equal(result.ok, false, 'the buyer pays the fee too');
});

// ============================================================== concurrency

test('losing the reservation race refuses cleanly and reserves nothing', async () => {
  const { state, engine } = makeFake({ reserveWins: false });
  const result = await engine.acceptBid(bid());
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'quantity_exceeds_available');
  assert.equal(state.offer.quantityAvailable, 200, 'no quantity was taken');
  assert.equal(state.trades.size, 0, 'no trade was created');
});

test('two buyers cannot oversell one offer', async () => {
  const { state, engine } = makeFake();
  state.offer.quantityAvailable = 50;

  const first = await engine.acceptBid(bid({ id: 'bid-a', quantity: 40 }));
  assert.equal(first.ok, true);
  assert.equal(state.offer.quantityAvailable, 10);

  // The second buyer's read is stale — they still believe 50 remain — and the
  // compare-and-swap is what catches it.
  const second = await engine.acceptBid(bid({ id: 'bid-b', quantity: 40 }));
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.refusal.code, 'quantity_exceeds_available');
  assert.equal(state.offer.quantityAvailable, 10, 'the seller is not oversold');
});

test('a failed trade write releases the reservation', async () => {
  const { state, engine } = makeFake({ saveTradeThrows: true });
  await assert.rejects(() => engine.acceptBid(bid()));
  assert.equal(state.released, 40, 'the reservation was returned');
  assert.equal(state.offer.quantityAvailable, 200, 'the offer is whole again');
});

test('a trade settles exactly once, even under a concurrent second attempt', async () => {
  const { state, engine } = makeFake();
  const accepted = await engine.acceptBid(bid());
  if (!accepted.ok) return assert.fail();
  await engine.authorise(accepted.value.id);

  const first = await engine.settleTrade(accepted.value.id);
  assert.equal(first.ok, true);

  const second = await engine.settleTrade(accepted.value.id);
  assert.equal(second.ok, false);
  assert.equal(state.commits.length, 1, 'money moved once');
});

test('losing the settlement claim writes nothing', async () => {
  const { state, engine } = makeFake({ settleClaimWins: false });
  const accepted = await engine.acceptBid(bid());
  if (!accepted.ok) return assert.fail();
  await engine.authorise(accepted.value.id);

  const result = await engine.settleTrade(accepted.value.id);
  assert.equal(result.ok, false);
  assert.equal(state.commits.length, 0, 'no settlement was committed');
});

// ================================================================== auditing

test('every refusal is audited, not just every success', async () => {
  const { state, engine } = makeFake();
  await engine.acceptBid(bid({ quantity: 500 }));
  const refusals = state.audits.filter((a) => a.outcome === 'refused');
  assert.ok(refusals.length >= 1, 'a refused bid must reach the record');
});

test('only the first refusal is returned, so limits cannot be mapped', async () => {
  const { state, engine } = makeFake();
  // Multiple things are wrong at once: halted estate AND a bad quantity.
  state.estate = { ...state.estate, halted: true };
  const result = await engine.acceptBid(bid({ quantity: 99_999 }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'ecosystem_halted', 'the estate answer comes first and alone');
});

// ==================================================== inventory on the trade path
//
// The rule: if a seller offers the same product or service more than once,
// inventory accounting is mandatory. These tests are about that rule being
// enforced where offers are actually posted — not merely available in a module.

const offerArgs = (over: Partial<Parameters<MarketEngine['postOffer']>[0]> = {}) => ({
  seller: SELLER,
  listing: LISTING,
  unitPrice: fromDecimalString('12.50'),
  quantity: 40,
  minimumQuantity: 10,
  expiresAt: null,
  rationale: GOOD_RATIONALE,
  ...over,
});

test('a multi-unit offer with no inventory record is refused at the door', async () => {
  const { state, engine } = makeFake({ inventory: null, priorListings: 0 });

  const result = await engine.postOffer(offerArgs({ quantity: 40 }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'inventory_unaccounted');
  assert.match(result.refusal.detail, /depleting, renewable or issuable/);
  assert.equal(state.listingsRecorded.length, 0, 'a refused offer is not a listing');
  assert.ok(state.audits.some((a) => a.event === 'market.offer.refused'));
});

test('a repeat listing with no inventory record is refused even for a single unit', async () => {
  const { engine } = makeFake({ inventory: null, priorListings: 3 });

  const result = await engine.postOffer(offerArgs({ quantity: 1, minimumQuantity: 1 }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'inventory_unaccounted');
});

test('a genuine one-off — one unit, never listed — proceeds without a record', async () => {
  const { state, engine } = makeFake({ inventory: null, priorListings: 0 });

  const result = await engine.postOffer(offerArgs({ quantity: 1, minimumQuantity: 1 }));
  assert.equal(result.ok, true, 'requiring a stock ledger to sell one used camera drives sellers away');
  assert.equal(state.listingsRecorded.length, 1);
});

test('posting an offer reserves the units against the seller\'s own position', async () => {
  const { state, engine } = makeFake();

  const result = await engine.postOffer(offerArgs({ quantity: 40 }));
  assert.equal(result.ok, true);
  assert.equal(state.inventory!.committed, 40);
  assert.equal(state.inventory!.onHand, 200, 'stock does not leave until delivery is confirmed');
  assert.deepEqual(state.listingsRecorded.map((l) => l.sku), [LISTING.sku]);
});

test('four offers of the whole stock: the fourth cannot be posted', async () => {
  const { state, engine } = makeFake();

  for (const expected of [true, true, true]) {
    const result = await engine.postOffer(offerArgs({ quantity: 60 }));
    assert.equal(result.ok, expected);
  }
  assert.equal(state.inventory!.committed, 180);

  const fourth = await engine.postOffer(offerArgs({ quantity: 60 }));
  assert.equal(fourth.ok, false, 'this is the oversell that every other guard lets through');
  if (fourth.ok) return;
  assert.equal(fourth.refusal.code, 'inventory_insufficient');
  assert.match(fourth.refusal.detail, /200 on hand with 180 already committed, leaving 20/);
});

test('a lost inventory race is retried, then refused rather than spun on', async () => {
  const { state, engine } = makeFake({ inventorySaveWins: false });

  const result = await engine.postOffer(offerArgs({ quantity: 40 }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'inventory_insufficient');
  assert.match(result.refusal.detail, /changed 3 times/);
  assert.equal(state.listingsRecorded.length, 0);
});

test('withdrawing an offer gives its unsold units back', async () => {
  const { state, engine } = makeFake();

  const posted = await engine.postOffer(offerArgs({ quantity: 40 }));
  assert.equal(posted.ok, true);
  if (!posted.ok) return;
  assert.equal(state.inventory!.committed, 40);

  const withdrawn = await engine.withdrawOffer(posted.value);
  assert.equal(withdrawn.ok, true);
  if (!withdrawn.ok) return;
  assert.equal(withdrawn.value.status, 'withdrawn');
  assert.equal(state.inventory!.committed, 0, 'a reservation must not outlive its offer');
  assert.ok(state.audits.some((a) => a.event === 'market.offer.withdrawn'));
});

test('a withdrawn offer cannot be withdrawn twice', async () => {
  const { engine } = makeFake();
  const posted = await engine.postOffer(offerArgs({ quantity: 40 }));
  assert.equal(posted.ok, true);
  if (!posted.ok) return;

  const first = await engine.withdrawOffer(posted.value);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = await engine.withdrawOffer(first.value);
  assert.equal(second.ok, false);
});

test('confirmed delivery is when depleting stock actually leaves the book', async () => {
  const { state, engine } = makeFake();
  await engine.postOffer(offerArgs({ quantity: 40 }));

  const accepted = await engine.acceptBid(bid({ quantity: 40 }));
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;

  const delivered = await engine.recordDelivery(accepted.value);
  assert.equal(delivered.ok, true);
  assert.equal(state.inventory!.committed, 0);
  assert.equal(state.inventory!.delivered, 40);
  assert.equal(state.inventory!.onHand, 160);
  assert.ok(state.audits.some((a) => a.event === 'market.delivery.recorded'));
});

test('delivering more than was ever committed is reported as an accounting break', async () => {
  const { state, engine } = makeFake();
  const accepted = await engine.acceptBid(bid({ quantity: 40 }));
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;

  // Nothing was reserved — the offer in this fixture predates the reservation.
  const delivered = await engine.recordDelivery(accepted.value);
  assert.equal(delivered.ok, false);
  if (delivered.ok) return;
  assert.match(delivered.refusal.detail, /Investigate/);
  assert.ok(state.audits.some((a) => a.event === 'market.delivery.accounting_break'));
});

test('a seller with no inventory record can still deliver, and nothing is invented', async () => {
  const { engine } = makeFake({ inventory: null });
  const accepted = await engine.acceptBid(bid({ quantity: 40 }));
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;

  const delivered = await engine.recordDelivery(accepted.value);
  assert.equal(delivered.ok, true);
  if (!delivered.ok) return;
  assert.equal(delivered.value, null, 'no record to update is not the same as a broken one');
});

test('an offer refused by an earlier guard never touches inventory', async () => {
  const { state, engine } = makeFake({
    estate: { halted: true, sanctionedParticipants: new Set(), admittedParticipants: new Set([SELLER, BUYER]) },
  });

  const result = await engine.postOffer(offerArgs({ quantity: 40 }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.refusal.code, 'ecosystem_halted', 'the halt is checked before anything about the trade');
  assert.equal(state.inventory!.committed, 0);
  assert.equal(state.listingsRecorded.length, 0);
});
