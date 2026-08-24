import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAsset, authoriseSell, netYieldPerUnit, type MarketAsset } from '../server/hermes';

const base: MarketAsset = {
  asset_id: 'TEST-1',
  name: 'Test instrument',
  asset_class: 'H266_Video_NFT',
  acquisition_price: 100,
  current_price: 140,
  buy_fees: 0.02,
  sell_fees: 0.025,
  is_guaranteed: true,
  fundamentals_intact: true,
  quantity: 10,
  active_offer: 140,
};

const asset = (patch: Partial<MarketAsset> = {}): MarketAsset => ({ ...base, ...patch });

describe('netYieldPerUnit', () => {
  it('charges both fee legs', () => {
    // 140 * 0.975 = 136.5 out; 100 * 1.02 = 102 in; 34.5 net.
    assert.equal(netYieldPerUnit(asset(), 140), 34.5);
  });

  it('goes negative when fees exceed the spread', () => {
    assert.ok(netYieldPerUnit(asset({ acquisition_price: 100 }), 101) < 0);
  });
});

describe('evaluateAsset', () => {
  it('executes when the offer clears the strike and survives fees', () => {
    const e = evaluateAsset(asset());
    assert.equal(e.action, 'EXECUTE_SELL');
    assert.equal(e.zero_loss_satisfied, true);
    assert.equal(e.realized_net_total, 345);
  });

  it('refuses when the gross offer clears the strike but fees erase the margin', () => {
    // Fees of 60% a side make a nominally +30% offer a loser.
    const e = evaluateAsset(asset({ sell_fees: 0.6, active_offer: 130 }));
    assert.equal(e.action, 'HOLD_REJECT_OFFER');
    assert.equal(e.zero_loss_satisfied, false);
  });

  it('holds when the offer has not reached the strike', () => {
    const e = evaluateAsset(asset({ active_offer: 120, current_price: 120 }));
    assert.equal(e.action, 'HOLD_CONTINUE_MONITOR');
  });

  it('will not auto-strike an instrument that is not guaranteed', () => {
    const e = evaluateAsset(asset({ is_guaranteed: false }));
    assert.equal(e.action, 'HOLD_CONTINUE_MONITOR');
  });

  it('fires the stop loss on a breach', () => {
    const e = evaluateAsset(asset({ current_price: 80, active_offer: 80 }));
    assert.equal(e.action, 'SELL_IMMEDIATELY');
    assert.match(e.reason, /Stop-loss breach/);
    assert.equal(e.zero_loss_satisfied, false);
  });

  it('fires the fundamental breaker ahead of the price checks', () => {
    const e = evaluateAsset(asset({ fundamentals_intact: false }));
    assert.equal(e.action, 'SELL_IMMEDIATELY');
    assert.match(e.reason, /Fundamental invalidation/);
  });

  it('treats a flat position as nothing to do', () => {
    const e = evaluateAsset(asset({ quantity: 0 }));
    assert.equal(e.action, 'HOLD_CONTINUE_MONITOR');
  });

  it('uses the live offer rather than the last trade price', () => {
    // Last trade is below the strike, but there is a firm offer above it.
    const e = evaluateAsset(asset({ current_price: 110, active_offer: 145 }));
    assert.equal(e.action, 'EXECUTE_SELL');
    assert.equal(e.target_price, 145);
  });

  it('honours a custom policy', () => {
    const e = evaluateAsset(asset({ active_offer: 110, current_price: 110 }), { profit_target_pct: 0.05 });
    assert.equal(e.action, 'EXECUTE_SELL');
  });
});

describe('authoriseSell — the execution gate', () => {
  it('allows a qualifying sell', () => {
    assert.equal(authoriseSell(asset()).allowed, true);
  });

  it('allows a risk exit even though it is not profitable', () => {
    const r = authoriseSell(asset({ current_price: 70, active_offer: 70 }));
    assert.equal(r.allowed, true);
    assert.equal(r.evaluation.action, 'SELL_IMMEDIATELY');
  });

  it('refuses a sell the engine did not sanction', () => {
    // This is the hole the old endpoint had: the client asked for
    // EXECUTE_SELL and the server complied without checking anything.
    const r = authoriseSell(asset({ active_offer: 105, current_price: 105 }));
    assert.equal(r.allowed, false);
    assert.match(r.reason, /Execution refused/);
  });

  it('refuses to sell a position that is already flat', () => {
    assert.equal(authoriseSell(asset({ quantity: 0 })).allowed, false);
  });

  it('refuses an offer that only clears the strike before fees', () => {
    const r = authoriseSell(asset({ sell_fees: 0.6, active_offer: 130 }));
    assert.equal(r.allowed, false);
  });
});
