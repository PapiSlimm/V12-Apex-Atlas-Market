/**
 * Execution and reconciliation tests.
 *
 * These exercise the paths that only matter when things go wrong: venue
 * timeouts, duplicate submissions, replayed fills, and a process that dies
 * mid-order. The happy path is the easy part.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { SqliteStore } from '../server/store/sqlite';
import type { Store } from '../server/store/types';
import { DEFAULT_TENANT_ID as T } from '../server/store/tenancy';
import { ExecutionService } from '../server/assets/execution';
import { InternalMarketplace, InternalBidFeed, CALM, REALISTIC } from '../server/assets/internal-marketplace';
import { MarketplaceError } from '../server/assets/marketplace';
import { reconciles } from '../server/assets/ledger';
import type { AssetSpec, OrderIntent } from '../server/assets/types';

const INSTRUMENT: AssetSpec = {
  assetId: 'AST-H266-001',
  name: 'H266 Render NFT Vector Array #104',
  asset_class: 'H266_Video_NFT',
  price_increment: 0.01,
  block_size: 1,
  min_blocks: 1,
  buy_fee_rate: 0.02,
  sell_fee_rate: 0.025,
  is_guaranteed: true,
  fundamentals_intact: true,
  simulated: true,
};

const assetSpecs = new Map([[INSTRUMENT.assetId, INSTRUMENT]]);

function intent(patch: Partial<OrderIntent> = {}): OrderIntent {
  return {
    clientOrderId: ExecutionService.newClientOrderId(),
    assetId: INSTRUMENT.assetId,
    side: 'sell',
    quantity: 100,
    type: 'limit',
    limitPrice: 16.8,
    timeInForce: 'gtc',
    reason: 'test',
    ...patch,
  };
}

const ACTOR = { id: 'usr-1', name: 'Ada' };

let dir: string;
let store: Store;

async function freshStore(): Promise<Store> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-exec-'));
  const s = new SqliteStore(path.join(dir, 'test.db'));
  await s.init();
  await s.tenants.create({
    id: T,
    slug: 'default',
    name: 'Test',
    plan: 'enterprise',
    status: 'active',
    seatLimit: 100,
    monthlyAiCreditCents: 0,
    assetLedgerEnabled: true,
    createdAt: new Date(0).toISOString(),
  });
  return s;
}

function makeVenue(behaviour = CALM, seed = 1) {
  const md = new InternalBidFeed({ [INSTRUMENT.assetId]: 16.8 }, 8, seed);
  const venue = new InternalMarketplace(assetSpecs, (s) => md.lastPrice(s), behaviour, seed);
  return { md, venue };
}

beforeEach(async () => {
  store = await freshStore();
});

afterEach(async () => {
  await store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Order placement', () => {
  it('persists the intent before the venue is called', async () => {
    const { md, venue } = makeVenue();
    const svc = new ExecutionService(store, venue, md, T);
    const i = intent();

    await svc.place(i, ACTOR);
    const stored = await store.orders.get(T, i.clientOrderId);

    assert.ok(stored, 'the order row must exist regardless of what the venue did');
    assert.equal(stored!.marketplace, 'internal');
    assert.equal(stored!.mode, 'internal');
    assert.equal(stored!.actorName, 'Ada');
  });

  it('is idempotent: resubmitting a clientOrderId does not place a second order', async () => {
    const { md, venue } = makeVenue();
    const svc = new ExecutionService(store, venue, md, T);
    const i = intent();

    const first = await svc.place(i, ACTOR);
    const second = await svc.place(i, ACTOR);

    assert.equal(second.deduplicated, true);
    assert.equal(second.order.id, first.order.id);
    assert.equal((await store.orders.list(T)).length, 1);
  });

  it('records a venue rejection with its reason', async () => {
    const { md, venue } = makeVenue({ ...CALM, rejectRate: 1 });
    const svc = new ExecutionService(store, venue, md, T);

    const result = await svc.place(intent(), ACTOR);
    assert.equal(result.order.status, 'rejected');
    assert.match(result.order.rejectReason!, /rejection/i);
  });
});

describe('Venue failure handling — the case that matters', () => {
  it('resolves by querying, not by resubmitting, when place() throws', async () => {
    // The simulator records the order and then throws, exactly as a real venue
    // timeout after acceptance would. A blind retry here is how one intent
    // becomes two positions.
    const { md, venue } = makeVenue({ ...CALM, networkFailureRate: 1 });
    const svc = new ExecutionService(store, venue, md, T);
    const i = intent();

    const result = await svc.place(i, ACTOR);

    assert.match(result.resolvedAfterFailure!, /recovered by query/);
    assert.equal(result.order.status, 'working', 'the live order must be adopted, not abandoned');
    assert.ok(result.order.marketplaceOrderId);
    assert.equal((await venue.openOrders()).length, 1, 'exactly one order at the venue');
  });

  it('leaves the order pending when the venue is unreachable entirely', async () => {
    // Both place() and the follow-up query fail. "Pending" is the only honest
    // status: marking it rejected could orphan a live position.
    const { md, venue } = makeVenue();
    const svc = new ExecutionService(store, venue, md, T);

    venue.place = async () => {
      throw new MarketplaceError('connection reset', true, 'network');
    };
    venue.get = async () => {
      throw new MarketplaceError('connection reset', true, 'network');
    };

    const i = intent();
    await assert.rejects(() => svc.place(i, ACTOR), /unknown state/);

    const stored = await store.orders.get(T, i.clientOrderId);
    assert.equal(stored!.status, 'pending');
  });

  it('marks the order rejected when the venue confirms nothing landed', async () => {
    const { md, venue } = makeVenue();
    const svc = new ExecutionService(store, venue, md, T);

    venue.place = async () => {
      throw new MarketplaceError('rejected upstream', false, 'network');
    };
    venue.get = async () => null;

    const result = await svc.place(intent(), ACTOR);
    assert.equal(result.order.status, 'rejected');
    assert.match(result.resolvedAfterFailure!, /nothing was placed/);
  });
});

describe('Fill ingestion', () => {
  it('accumulates partial fills into a position that balances', async () => {
    const { md, venue } = makeVenue({ ...CALM, partialFillRate: 1 });
    const svc = new ExecutionService(store, venue, md, T);
    const i = intent({ quantity: 100 });

    await svc.place(i, ACTOR);
    await venue.drain();
    await svc.ingestFills();

    const order = await store.orders.get(T, i.clientOrderId);
    assert.equal(order!.status, 'filled');
    assert.equal(order!.filledQuantity, 100);

    const fills = await store.fills.forOrder(T, i.clientOrderId);
    assert.ok(fills.length > 1, 'this scenario should produce more than one fill');

    const position = await svc.position(INSTRUMENT.assetId);
    assert.equal(position.quantity, -100); // sold 100 from flat
    assert.ok(reconciles(position), 'books must balance after partial fills');
  });

  it('never double-counts a replayed fill', async () => {
    const { md, venue } = makeVenue({ ...CALM, partialFillRate: 1 });
    const svc = new ExecutionService(store, venue, md, T);
    const i = intent({ quantity: 60 });

    await svc.place(i, ACTOR);
    await venue.drain();

    await svc.ingestFills();
    const afterFirst = await svc.position(INSTRUMENT.assetId);

    // Rewind the cursor and replay: overlapping push/pull delivery is normal.
    await store.meta.set(T, 'venue.fill_cursor', '0');
    const second = await svc.ingestFills();

    assert.equal(second.recorded, 0, 'replayed fills must be recognised as duplicates');
    assert.deepEqual(await svc.position(INSTRUMENT.assetId), afterFirst);
  });

  it('advances the cursor so a restart resumes where it left off', async () => {
    const { md, venue } = makeVenue({ ...CALM, partialFillRate: 1 });
    const svc = new ExecutionService(store, venue, md, T);

    await svc.place(intent({ quantity: 40 }), ACTOR);
    await venue.drain();
    await svc.ingestFills();

    const cursor = await store.meta.get(T, 'venue.fill_cursor');
    assert.ok(cursor && Number(cursor) > 0);
  });
});

describe('Reconciliation', () => {
  it('adopts fills that arrived while we were not listening', async () => {
    const { md, venue } = makeVenue({ ...CALM, partialFillRate: 1 });
    const svc = new ExecutionService(store, venue, md, T);
    const i = intent({ quantity: 80 });

    await svc.place(i, ACTOR);
    // Fills happen with nobody ingesting them — the "process was down" case.
    await venue.drain();

    const report = await svc.reconcile();
    assert.ok(report.fillsReplayed > 0);
    assert.equal(report.discrepancies.length, 0);
    assert.equal((await store.orders.get(T, i.clientOrderId))!.status, 'filled');
  });

  it('rejects a pending order the venue never received', async () => {
    const { md, venue } = makeVenue();
    const svc = new ExecutionService(store, venue, md, T);

    // Simulate a crash between persisting intent and calling the venue.
    const i = intent();
    await store.orders.create(T, {
      ...i,
      id: 'ord-orphan',
      status: 'pending',
      marketplaceOrderId: null,
      filledQuantity: 0,
      averageFillPrice: 0,
      feesPaid: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      actorId: ACTOR.id,
      actorName: ACTOR.name,
      marketplace: 'internal',
      mode: 'internal',
      rejectReason: null,
    });

    const report = await svc.reconcile();
    assert.equal(report.ordersUpdated, 1);
    assert.equal((await store.orders.get(T, i.clientOrderId))!.status, 'rejected');
    assert.equal(report.discrepancies.length, 0, 'a never-landed pending order is not a discrepancy');
  });

  it('reports — rather than silently patches — a live order the venue has lost', async () => {
    const { md, venue } = makeVenue();
    const svc = new ExecutionService(store, venue, md, T);
    const i = intent();

    await svc.place(i, ACTOR);
    // The venue forgets it. Guessing here would be worse than reporting.
    venue.openOrders = async () => [];
    venue.get = async () => null;

    const report = await svc.reconcile();
    assert.equal(report.discrepancies.length, 1);
    assert.match(report.discrepancies[0].issue, /unknown to the venue/);
  });

  it('converges after a simulated crash mid-order', async () => {
    // The test that says whether the design is real: place an order, let it
    // partially fill, throw away the service as if the process died, then start
    // a new one against the same database and the same venue.
    const { md, venue } = makeVenue({ ...CALM, partialFillRate: 1 });
    const first = new ExecutionService(store, venue, md, T);
    const i = intent({ quantity: 100 });

    await first.place(i, ACTOR);
    await venue.tick(); // one tranche fills
    await first.ingestFills();

    const midFlight = await store.orders.get(T, i.clientOrderId);
    assert.equal(midFlight!.status, 'partially_filled');

    // --- crash here; nothing else is ingested ---
    await venue.drain(); // the rest fills while we are "down"

    const recovered = new ExecutionService(store, venue, md, T);
    const report = await recovered.reconcile();

    assert.ok(report.fillsReplayed > 0, 'missed fills must be replayed');
    const final = await store.orders.get(T, i.clientOrderId);
    assert.equal(final!.status, 'filled');
    assert.equal(final!.filledQuantity, 100);

    const position = await recovered.position(INSTRUMENT.assetId);
    assert.equal(position.quantity, -100);
    assert.ok(reconciles(position), 'the ledger must balance after crash recovery');
  });
});

describe('Cancellation', () => {
  it('cancels a working order and stops further fills', async () => {
    const { md, venue } = makeVenue({ ...CALM, partialFillRate: 1 });
    const svc = new ExecutionService(store, venue, md, T);
    const i = intent({ quantity: 100 });

    await svc.place(i, ACTOR);
    await venue.tick();
    await svc.ingestFills();

    const cancelled = await svc.cancel(i.clientOrderId);
    assert.equal(cancelled!.status, 'cancelled');

    const before = (await store.fills.forOrder(T, i.clientOrderId)).length;
    await venue.drain();
    await svc.ingestFills();
    assert.equal((await store.fills.forOrder(T, i.clientOrderId)).length, before, 'no fills after cancel');
  });

  it('will not cancel an order that already completed', async () => {
    const { md, venue } = makeVenue();
    const svc = new ExecutionService(store, venue, md, T);
    const i = intent({ quantity: 10 });

    await svc.place(i, ACTOR);
    await venue.drain();
    await svc.ingestFills();

    const result = await svc.cancel(i.clientOrderId);
    assert.equal(result!.status, 'filled');
  });
});

describe('Under a hostile venue', () => {
  it('keeps the ledger balanced across many randomised orders', async () => {
    // REALISTIC rejects, drops connections, partially fills and stalls.
    const { md, venue } = makeVenue(REALISTIC, 42);
    const svc = new ExecutionService(store, venue, md, T);

    let placed = 0;
    let failed = 0;

    for (let n = 0; n < 40; n++) {
      const side = n % 2 === 0 ? 'sell' : 'buy';
      try {
        await svc.place(intent({ side, quantity: 5 + (n % 7), type: 'market', limitPrice: undefined }), ACTOR);
        placed += 1;
      } catch {
        failed += 1; // unknown-state orders are expected under this behaviour
      }
      await venue.tick();
      await svc.ingestFills();
    }

    await venue.drain();
    await svc.reconcile();

    assert.ok(placed > 0);
    const position = await svc.position(INSTRUMENT.assetId);
    assert.ok(
      reconciles(position),
      `books must balance after ${placed} placed / ${failed} failed orders under a hostile venue`,
    );

    // Every order's aggregate must match its own fills.
    for (const order of await store.orders.list(T, 500)) {
      const fills = await store.fills.forOrder(T, order.clientOrderId);
      const summed = fills.reduce((s, f) => s + f.quantity, 0);
      assert.ok(
        Math.abs(summed - order.filledQuantity) < 1e-9,
        `order ${order.clientOrderId}: filledQuantity ${order.filledQuantity} != sum of fills ${summed}`,
      );
      assert.ok(order.filledQuantity <= order.quantity + 1e-9, 'an order must never overfill');
    }
  });
});
