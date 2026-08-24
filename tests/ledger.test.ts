/**
 * Ledger accounting tests.
 *
 * The core of this file is a property test: thousands of randomised fill
 * sequences, asserting after EVERY fill that
 *
 *     realisedPnl - quantity * averageCost === cashFlow
 *
 * Worked examples catch the cases you thought of. The property catches the
 * ones you did not — which, for fee apportionment across partial fills, is
 * where the bugs actually live.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyFill,
  applyFillsToOrder,
  derivePosition,
  reconciles,
  remainingQuantity,
  sortFills,
  unrealisedPnl,
} from '../server/assets/ledger';
import { emptyPosition, roundToLot, roundToTick, type Fill, type Order } from '../server/assets/types';

let fillCounter = 0;

function makeFill(patch: Partial<Fill> & Pick<Fill, 'side' | 'quantity' | 'price'>): Fill {
  fillCounter += 1;
  return {
    id: `fill-${fillCounter}`,
    clientOrderId: 'coid-1',
    marketplaceFillId: `vf-${fillCounter}`,
    assetId: 'TEST',
    fee: 0,
    timestamp: new Date(1_700_000_000_000 + fillCounter * 1000).toISOString(),
    receivedAt: new Date(1_700_000_000_000 + fillCounter * 1000).toISOString(),
    sequence: fillCounter,
    ...patch,
  };
}

describe('Position accounting — worked examples', () => {
  it('opens a long with fees capitalised into the basis', () => {
    const p = applyFill(emptyPosition('TEST'), makeFill({ side: 'buy', quantity: 10, price: 100, fee: 5 }));

    assert.equal(p.quantity, 10);
    assert.equal(p.averageCost, 100.5); // (1000 + 5) / 10
    assert.equal(p.cashFlow, -1005);
    assert.equal(p.realisedPnl, 0);
    assert.ok(reconciles(p));
  });

  it('blends the basis across two buy lots at different prices', () => {
    let p = applyFill(emptyPosition('TEST'), makeFill({ side: 'buy', quantity: 10, price: 100, fee: 5 }));
    p = applyFill(p, makeFill({ side: 'buy', quantity: 10, price: 120, fee: 6 }));

    assert.equal(p.quantity, 20);
    assert.equal(p.averageCost, 110.55); // (1005 + 1206) / 20
    assert.ok(reconciles(p));
  });

  it('realises P&L on a partial sale and leaves the surviving basis alone', () => {
    let p = applyFill(emptyPosition('TEST'), makeFill({ side: 'buy', quantity: 10, price: 100, fee: 5 }));
    p = applyFill(p, makeFill({ side: 'sell', quantity: 4, price: 110, fee: 4 }));

    // 440 proceeds − 4 fee − (100.5 × 4) basis = 34
    assert.equal(p.realisedPnl, 34);
    assert.equal(p.quantity, 6);
    assert.equal(p.averageCost, 100.5, 'basis of the remaining units must not move');
    assert.equal(p.cashFlow, -569);
    assert.ok(reconciles(p));
  });

  it('is order-independent for the same total: two half-fills equal one full fill', () => {
    // This is the partial-fill correctness question stated as a test.
    let split = applyFill(emptyPosition('TEST'), makeFill({ side: 'buy', quantity: 10, price: 100, fee: 5 }));
    split = applyFill(split, makeFill({ side: 'sell', quantity: 5, price: 110, fee: 2.75 }));
    split = applyFill(split, makeFill({ side: 'sell', quantity: 5, price: 110, fee: 2.75 }));

    let single = applyFill(emptyPosition('TEST'), makeFill({ side: 'buy', quantity: 10, price: 100, fee: 5 }));
    single = applyFill(single, makeFill({ side: 'sell', quantity: 10, price: 110, fee: 5.5 }));

    assert.equal(split.quantity, single.quantity);
    assert.ok(Math.abs(split.realisedPnl - single.realisedPnl) < 1e-9);
    assert.ok(Math.abs(split.cashFlow - single.cashFlow) < 1e-9);
  });

  it('flattens cleanly to zero basis', () => {
    let p = applyFill(emptyPosition('TEST'), makeFill({ side: 'buy', quantity: 10, price: 100, fee: 5 }));
    p = applyFill(p, makeFill({ side: 'sell', quantity: 10, price: 100, fee: 5 }));

    assert.equal(p.quantity, 0);
    assert.equal(p.averageCost, 0);
    assert.equal(p.realisedPnl, -10); // both fees, no price move
    assert.ok(reconciles(p));
  });

  it('opens a short and realises on the buy-back', () => {
    let p = applyFill(emptyPosition('TEST'), makeFill({ side: 'sell', quantity: 10, price: 100, fee: 5 }));
    assert.equal(p.quantity, -10);
    assert.equal(p.averageCost, 99.5); // net proceeds per unit
    assert.ok(reconciles(p));

    p = applyFill(p, makeFill({ side: 'buy', quantity: 4, price: 90, fee: 2 }));
    assert.equal(p.realisedPnl, 36); // 99.5×4 − (360 + 2)
    assert.equal(p.quantity, -6);
    assert.ok(reconciles(p));
  });

  it('handles a fill that crosses through flat, apportioning the fee pro rata', () => {
    let p = applyFill(emptyPosition('TEST'), makeFill({ side: 'buy', quantity: 10, price: 100, fee: 5 }));
    // Sell 15: closes the 10 long and opens a 5 short in one fill.
    p = applyFill(p, makeFill({ side: 'sell', quantity: 15, price: 110, fee: 15 }));

    assert.equal(p.quantity, -5);
    // Closing leg carries 10/15 of the fee, opening leg the other 5/15.
    assert.equal(p.realisedPnl, 85); // 1100 − 10 − 1005
    assert.equal(p.averageCost, 109); // (550 − 5) / 5
    assert.ok(reconciles(p), 'books must balance across a zero crossing');
  });

  it('computes unrealised P&L in both directions', () => {
    const long = applyFill(emptyPosition('TEST'), makeFill({ side: 'buy', quantity: 10, price: 100, fee: 0 }));
    assert.equal(unrealisedPnl(long, 110), 100);
    assert.equal(unrealisedPnl(long, 90), -100);

    const short = applyFill(emptyPosition('TEST'), makeFill({ side: 'sell', quantity: 10, price: 100, fee: 0 }));
    assert.equal(unrealisedPnl(short, 90), 100);
    assert.equal(unrealisedPnl(short, 110), -100);

    assert.equal(unrealisedPnl(emptyPosition('TEST'), 100), 0);
  });

  it('ignores non-positive quantities rather than corrupting the basis', () => {
    const p = applyFill(emptyPosition('TEST'), makeFill({ side: 'buy', quantity: 0, price: 100, fee: 1 }));
    assert.deepEqual(p, emptyPosition('TEST'));
  });
});

describe('Position accounting — property: the books always balance', () => {
  /** Deterministic PRNG so a failure is reproducible from its seed. */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  it('holds after every fill across 2000 randomised sequences', () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const rand = rng(seed);
      let position = emptyPosition('TEST');
      const history: string[] = [];

      const fillCount = 1 + Math.floor(rand() * 12);
      for (let i = 0; i < fillCount; i++) {
        const side = rand() < 0.5 ? 'buy' : 'sell';
        const quantity = Math.round((0.5 + rand() * 40) * 100) / 100;
        const price = Math.round((1 + rand() * 500) * 100) / 100;
        const fee = Math.round(price * quantity * rand() * 0.03 * 100) / 100;

        position = applyFill(position, makeFill({ side, quantity, price, fee }));
        history.push(`${side} ${quantity} @ ${price} fee ${fee}`);

        assert.ok(
          reconciles(position),
          `seed ${seed}, fill ${i + 1}\n` +
            `  history: ${history.join(' | ')}\n` +
            `  realised ${position.realisedPnl} − qty ${position.quantity} × basis ${position.averageCost}` +
            ` = ${position.realisedPnl - position.quantity * position.averageCost}` +
            `, expected cashFlow ${position.cashFlow}`,
        );
      }
    }
  });

  it('gives the same result whether folded incrementally or derived from scratch', () => {
    const rand = rng(99);
    const fills: Fill[] = [];
    let incremental = emptyPosition('TEST');

    for (let i = 0; i < 40; i++) {
      const fill = makeFill({
        side: rand() < 0.5 ? 'buy' : 'sell',
        quantity: Math.round((1 + rand() * 20) * 100) / 100,
        price: Math.round((10 + rand() * 200) * 100) / 100,
        fee: Math.round(rand() * 10 * 100) / 100,
      });
      fills.push(fill);
      incremental = applyFill(incremental, fill);
    }

    const derived = derivePosition('TEST', fills);
    assert.deepEqual(derived, incremental);
  });

  it('is insensitive to the order fills arrive in, given venue sequence numbers', () => {
    const rand = rng(7);
    const fills: Fill[] = [];
    for (let i = 0; i < 25; i++) {
      fills.push(
        makeFill({
          side: rand() < 0.5 ? 'buy' : 'sell',
          quantity: Math.round((1 + rand() * 10) * 100) / 100,
          price: Math.round((10 + rand() * 100) * 100) / 100,
          fee: Math.round(rand() * 5 * 100) / 100,
        }),
      );
    }

    const inOrder = derivePosition('TEST', fills);
    const shuffled = [...fills].reverse();
    // Out-of-order delivery is normal; the venue sequence is what makes the
    // result deterministic.
    assert.deepEqual(derivePosition('TEST', shuffled), inOrder);
  });
});

describe('Fill ordering', () => {
  it('orders by venue sequence ahead of timestamp', () => {
    const a = makeFill({ side: 'buy', quantity: 1, price: 1, sequence: 2, timestamp: '2026-01-01T00:00:05Z' });
    const b = makeFill({ side: 'buy', quantity: 1, price: 1, sequence: 1, timestamp: '2026-01-01T00:00:09Z' });
    assert.deepEqual(
      sortFills([a, b]).map((f) => f.sequence),
      [1, 2],
    );
  });

  it('falls back to timestamp, then id, when sequence is absent', () => {
    const a = makeFill({ side: 'buy', quantity: 1, price: 1, sequence: null, timestamp: '2026-01-01T00:00:09Z' });
    const b = makeFill({ side: 'buy', quantity: 1, price: 1, sequence: null, timestamp: '2026-01-01T00:00:05Z' });
    assert.equal(sortFills([a, b])[0].id, b.id);
  });
});

describe('Order roll-up', () => {
  const baseOrder = (patch: Partial<Order> = {}): Order => ({
    id: 'ord-1',
    clientOrderId: 'coid-1',
    assetId: 'TEST',
    side: 'sell',
    quantity: 100,
    type: 'limit',
    limitPrice: 50,
    timeInForce: 'gtc',
    reason: 'test',
    status: 'working',
    marketplaceOrderId: 'v-1',
    filledQuantity: 0,
    averageFillPrice: 0,
    feesPaid: 0,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    actorId: 'usr-1',
    actorName: 'Ada',
    marketplace: 'internal',
    mode: 'internal',
    ...patch,
  });

  it('marks an order partially filled and averages the fill price', () => {
    const order = applyFillsToOrder(baseOrder(), [
      makeFill({ side: 'sell', quantity: 30, price: 50, fee: 1 }),
      makeFill({ side: 'sell', quantity: 20, price: 52, fee: 1 }),
    ]);

    assert.equal(order.status, 'partially_filled');
    assert.equal(order.filledQuantity, 50);
    assert.equal(order.averageFillPrice, 50.8); // (1500 + 1040) / 50
    assert.equal(order.feesPaid, 2);
    assert.equal(remainingQuantity(order), 50);
  });

  it('marks an order filled once its fills cover the quantity', () => {
    const order = applyFillsToOrder(baseOrder(), [makeFill({ side: 'sell', quantity: 100, price: 50, fee: 3 })]);
    assert.equal(order.status, 'filled');
    assert.equal(remainingQuantity(order), 0);
  });

  it('ignores fills belonging to another order', () => {
    const order = applyFillsToOrder(baseOrder(), [
      makeFill({ side: 'sell', quantity: 100, price: 50, clientOrderId: 'someone-else' }),
    ]);
    assert.equal(order.filledQuantity, 0);
    assert.equal(order.status, 'working');
  });

  it('never moves a terminal order, even if late fills arrive', () => {
    // A duplicate or out-of-order venue message must not resurrect a cancelled
    // order into a working one.
    const cancelled = applyFillsToOrder(baseOrder({ status: 'cancelled' }), [
      makeFill({ side: 'sell', quantity: 10, price: 50 }),
    ]);
    assert.equal(cancelled.status, 'cancelled');
  });
});

describe('Tick and lot rounding', () => {
  it('rounds quantity down to whole lots, never up', () => {
    assert.equal(roundToLot(10.7, 1), 10);
    assert.equal(roundToLot(10.7, 0.5), 10.5);
    assert.equal(roundToLot(0.4, 1), 0);
    assert.equal(roundToLot(7, 0), 7);
  });

  it('rounds a limit price in the conservative direction for each side', () => {
    // A seller never asks for less than intended; a buyer never bids more.
    assert.equal(roundToTick(10.123, 0.01, 'sell'), 10.13);
    assert.equal(roundToTick(10.123, 0.01, 'buy'), 10.12);
    assert.equal(roundToTick(10.5, 0, 'buy'), 10.5);
  });
});
