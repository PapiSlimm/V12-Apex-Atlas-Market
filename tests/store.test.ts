/**
 * Store conformance suite.
 *
 * Runs against SQLite always, and additionally against Postgres when
 * TEST_DATABASE_URL is set. Two implementations of one interface diverge
 * quietly unless something forces them not to; this is that something.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { SqliteStore } from '../server/store/sqlite';
import { PostgresStore } from '../server/store/postgres';
import { verifyChain, hashEntry, canonicalise, GENESIS_HASH } from '../server/store/chain';
import type { Store } from '../server/store/types';
import { asTenantId, type Tenant, type TenantId } from '../server/store/tenancy';
import { seedAssets, seedNodes } from '../server/seed';

const PG_URL = process.env.TEST_DATABASE_URL;

const T = asTenantId('tnt-a');
const OTHER = asTenantId('tnt-b');

const tenantFixture = (id: TenantId, slug: string): Tenant => ({
  id,
  slug,
  name: slug,
  plan: 'enterprise',
  status: 'active',
  seatLimit: 100,
  monthlyAiCreditCents: 0,
  assetLedgerEnabled: true,
  createdAt: new Date(0).toISOString(),
});

function makeSqlite(): { store: Store; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-store-'));
  const file = path.join(dir, 'test.db');
  return {
    store: new SqliteStore(file),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function runConformance(label: string, makeStore: () => { store: Store; cleanup: () => void }) {
  describe(`Store conformance — ${label}`, () => {
    let store: Store;
    let cleanup: () => void;

    before(async () => {
      const made = makeStore();
      store = made.store;
      cleanup = made.cleanup;
      await store.init();
      await store.reset();
      await store.tenants.create(tenantFixture(T, 'tenant-a'));
      await store.tenants.create(tenantFixture(OTHER, 'tenant-b'));
      await store.bootstrap.seed(T, seedNodes(), seedAssets());
      await store.bootstrap.seed(OTHER, seedNodes(), seedAssets());
    });

    after(async () => {
      await store.close();
      cleanup();
    });

    // ------------------------------------------------------------- users
    it('creates and finds users, normalising email case', async () => {
      await store.users.create({
        id: 'usr-1',
        tenantId: T,
        email: 'Ada@Example.COM',
        name: 'Ada',
        passwordHash: 'hash',
        role: 'Executive',
        createdAt: new Date(0).toISOString(),
      });

      const byEmail = await store.users.findByEmail('  ADA@example.com ');
      assert.equal(byEmail?.id, 'usr-1');
      assert.equal(byEmail?.email, 'ada@example.com');
      assert.equal((await store.users.findById('usr-1'))?.name, 'Ada');
      assert.equal(await store.users.count(), 1);
    });

    it('returns null rather than throwing for unknown users', async () => {
      assert.equal(await store.users.findByEmail('nobody@example.com'), null);
      assert.equal(await store.users.findById('usr-nope'), null);
    });

    // ------------------------------------------------------------- nodes
    it('round-trips nodes with their nested JSON intact', async () => {
      const nodes = await store.nodes.list(T);
      // Asserted against the seed rather than a literal, so adding a vault node
      // is not a test failure — only losing one on the round trip is.
      assert.equal(nodes.length, seedNodes().length);

      const detroit = nodes.find((n) => n.id === 'node-detroit')!;
      assert.deepEqual(detroit.coordinates, [42.3314, -83.0458]);
      assert.deepEqual(detroit.connectedNodes, seedNodes()[0].connectedNodes);
      assert.equal(detroit.metrics.status, 'operational');
      assert.equal(detroit.metrics.energy_cost_mwh, 72.4);
    });

    it('merges metrics on update rather than replacing them', async () => {
      const updated = await store.nodes.update(T, 'node-warehouse-alpha',
        { metrics: { allocated_inventory: 0 } },
        'Tester',
      );
      assert.equal(updated?.metrics.allocated_inventory, 0);
      // Untouched key survives the merge.
      assert.equal(updated?.metrics.storage_capacity_tb, 5000);
      assert.equal(updated?.updatedBy, 'Tester');

      const reread = await store.nodes.get(T, 'node-warehouse-alpha');
      assert.equal(reread?.metrics.storage_capacity_tb, 5000);
    });

    it('returns null when updating a node that does not exist', async () => {
      assert.equal(await store.nodes.update(T, 'node-nope', { content: 'x' }, 'Tester'), null);
    });

    // ------------------------------------------------------------ assets
    it('round-trips assets including booleans and optional offers', async () => {
      const asset = await store.assets.get(T, 'AST-H266-001');
      assert.equal(asset?.is_guaranteed, true);
      assert.equal(asset?.fundamentals_intact, true);
      assert.equal(asset?.simulated, true);
      assert.equal(asset?.acquisition_price, 12.5);
      assert.equal(asset?.active_offer, 16.8);

      const notGuaranteed = await store.assets.get(T, 'AST-COMPUTE-003');
      assert.equal(notGuaranteed?.is_guaranteed, false);
    });

    it('liquidates a position exactly once', async () => {
      const first = await store.assets.liquidate(T, 'AST-AUDIO-002');
      assert.ok(first);
      assert.equal(first!.quantity, 500);
      assert.equal(first!.unitPrice, 58.5); // the live offer, not the last trade
      assert.equal(first!.asset.quantity, 0);
      assert.equal(first!.asset.active_offer, undefined);

      // This is the double-spend guard. Before the compare-and-swap, a second
      // request could sell inventory that was already gone.
      const second = await store.assets.liquidate(T, 'AST-AUDIO-002');
      assert.equal(second, null);
    });

    it('refuses concurrent liquidation of the same position', async () => {
      const results = await Promise.all([
        store.assets.liquidate(T, 'AST-H266-001'),
        store.assets.liquidate(T, 'AST-H266-001'),
        store.assets.liquidate(T, 'AST-H266-001'),
      ]);
      const winners = results.filter(Boolean);
      assert.equal(winners.length, 1, 'exactly one concurrent liquidation may succeed');
      assert.equal(winners[0]!.quantity, 1420);
    });

    it('returns null for an unknown asset', async () => {
      assert.equal(await store.assets.liquidate(T, 'AST-NOPE'), null);
    });

    // ------------------------------------------------------------ trades
    it('records and lists trades newest first', async () => {
      for (const [i, id] of ['t1', 't2', 't3'].entries()) {
        await store.trades.record(T, {
          id,
          asset_id: 'AST-H266-001',
          action: 'EXECUTE_SELL',
          quantity: 10,
          unit_price: 16.8,
          realized_net_per_unit: 3.63,
          realized_net_total: 36.3,
          executedBy: 'Ada',
          executedById: 'usr-1',
          timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
          simulated: true,
        });
      }

      const trades = await store.trades.list(T, 10);
      assert.equal(trades.length, 3);
      assert.equal(trades[0].id, 't3');
      assert.equal(trades[0].realized_net_per_unit, 3.63);
      assert.equal(trades[0].simulated, true);
    });

    it('honours the list limit', async () => {
      assert.equal((await store.trades.list(T, 2)).length, 2);
    });

    // ------------------------------------------------------------- audit
    it('links each audit entry to its predecessor', async () => {
      const a = await store.audit.append(T, {
        event: 'trade.executed',
        actorId: 'usr-1',
        actorName: 'Ada',
        actorRole: 'Executive',
        subject: 'AST-H266-001',
        outcome: 'allowed',
        detail: { net: 5154.6 },
      });
      const b = await store.audit.append(T, {
        event: 'trade.refused',
        actorId: 'usr-1',
        actorName: 'Ada',
        actorRole: 'Executive',
        subject: 'AST-COMPUTE-003',
        outcome: 'refused',
        detail: { reason: 'not guaranteed' },
      });

      assert.equal(a.prevHash, GENESIS_HASH);
      assert.equal(b.prevHash, a.hash);
      assert.equal(b.seq, a.seq + 1);
      assert.notEqual(a.hash, b.hash);
    });

    it('records refusals, not just successes', async () => {
      const entries = await store.audit.list(T, 50);
      assert.ok(entries.some((e) => e.outcome === 'refused'));
    });

    it('preserves detail payloads through the round trip', async () => {
      const entry = await store.audit.append(T, {
        event: 'vault.updated',
        actorId: 'usr-1',
        actorName: 'Ada',
        actorRole: 'Executive',
        subject: 'file.md',
        outcome: 'allowed',
        detail: { nested: { a: [1, 2, 3], b: 'x' }, n: 4.5 },
      });

      const found = (await store.audit.list(T, 50)).find((e) => e.id === entry.id);
      assert.deepEqual(found?.detail, { nested: { a: [1, 2, 3], b: 'x' }, n: 4.5 });
    });

    it('verifies an untampered chain', async () => {
      const result = await store.audit.verify(T);
      assert.equal(result.ok, true, result.reason);
      assert.ok(result.entries >= 3);
    });


    // ------------------------------------------------------- TENANT ISOLATION
    // The whole point of the refactor. For every scoped collection: tenant A
    // must not be able to read, mutate, or infer tenant B's data — including
    // by guessing an id, since ids are seeded identically in both tenants.
    describe('tenant isolation', () => {
      it('scopes node reads and writes', async () => {
        await store.nodes.update(OTHER, 'node-detroit', { content: 'OTHER TENANT SECRET' }, 'Mallory');

        const mine = await store.nodes.get(T, 'node-detroit');
        assert.ok(mine);
        assert.ok(
          !mine!.content.includes('OTHER TENANT SECRET'),
          "tenant A must not see tenant B's edit to an identically-named node",
        );

        const theirs = await store.nodes.get(OTHER, 'node-detroit');
        assert.ok(theirs!.content.includes('OTHER TENANT SECRET'));
      });

      it('scopes asset inventory', async () => {
        // Both tenants seeded the same asset id. Liquidating one must not
        // touch the other.
        const before = await store.assets.get(OTHER, 'AST-COMPUTE-003');
        assert.ok(before && before.quantity > 0);

        await store.assets.liquidate(T, 'AST-COMPUTE-003');

        const after = await store.assets.get(OTHER, 'AST-COMPUTE-003');
        assert.equal(after!.quantity, before!.quantity, "one tenant's liquidation must not drain another's book");
      });

      it('scopes orders and fills', async () => {
        const order = {
          id: 'ord-iso',
          clientOrderId: 'coid-iso',
          assetId: 'ISO-1',
          side: 'buy' as const,
          quantity: 5,
          type: 'limit' as const,
          limitPrice: 10,
          timeInForce: 'gtc' as const,
          reason: 'iso',
          status: 'working' as const,
          marketplaceOrderId: 'v-iso',
          filledQuantity: 0,
          averageFillPrice: 0,
          feesPaid: 0,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          actorId: null,
          actorName: null,
          marketplace: 'internal',
          mode: 'internal' as const,
          rejectReason: null,
        };
        await store.orders.create(OTHER, order);

        assert.equal(await store.orders.get(T, 'coid-iso'), null, "tenant A must not read tenant B's order");
        assert.ok(await store.orders.get(OTHER, 'coid-iso'));
        assert.equal((await store.orders.list(T, 500)).some((o) => o.clientOrderId === 'coid-iso'), false);
        assert.equal((await store.orders.open(T)).some((o) => o.clientOrderId === 'coid-iso'), false);

        // A cross-tenant update must be a no-op, not a silent write.
        assert.equal(await store.orders.update(T, 'coid-iso', { status: 'cancelled' }), null);
        assert.equal((await store.orders.get(OTHER, 'coid-iso'))!.status, 'working');

        await store.fills.record(OTHER, {
          id: 'fill-iso',
          clientOrderId: 'coid-iso',
          marketplaceFillId: 'vf-iso',
          assetId: 'ISO-1',
          side: 'buy',
          quantity: 5,
          price: 10,
          fee: 0.1,
          timestamp: new Date(0).toISOString(),
          receivedAt: new Date(0).toISOString(),
          sequence: 1,
        });

        assert.equal((await store.fills.forOrder(T, 'coid-iso')).length, 0);
        assert.equal((await store.fills.forAsset(T, 'ISO-1')).length, 0);
        assert.equal((await store.fills.forAsset(OTHER, 'ISO-1')).length, 1);
        // Notional is the input to the daily risk limit; leaking it across
        // tenants would let one customer exhaust another's budget.
        assert.equal(await store.fills.notionalSince(T, new Date(0).toISOString()), 0);
        assert.ok((await store.fills.notionalSince(OTHER, new Date(0).toISOString())) > 0);
      });

      it('scopes trades', async () => {
        await store.trades.record(OTHER, {
          id: 'trd-iso',
          asset_id: 'AST-H266-001',
          action: 'EXECUTE_SELL',
          quantity: 1,
          unit_price: 1,
          realized_net_per_unit: 1,
          realized_net_total: 1,
          executedBy: 'Mallory',
          executedById: 'usr-x',
          timestamp: new Date().toISOString(),
          simulated: true,
        });

        assert.equal((await store.trades.list(T, 500)).some((t) => t.id === 'trd-iso'), false);
        assert.ok((await store.trades.list(OTHER, 500)).some((t) => t.id === 'trd-iso'));
      });

      it('scopes the meta keyspace', async () => {
        await store.meta.set(T, 'shared-key', 'a');
        await store.meta.set(OTHER, 'shared-key', 'b');
        assert.equal(await store.meta.get(T, 'shared-key'), 'a');
        assert.equal(await store.meta.get(OTHER, 'shared-key'), 'b');
      });

      it('gives each tenant an independent audit chain', async () => {
        const a1 = await store.audit.append(OTHER, {
          event: 'iso.test',
          actorId: null,
          actorName: null,
          actorRole: null,
          subject: 'x',
          outcome: 'info',
          detail: {},
        });

        // Sequence numbers restart per tenant. A shared counter would leak
        // other customers' activity volume through the gaps in your own.
        assert.equal(a1.seq, 1, "a new tenant's chain starts at 1 regardless of other tenants' history");
        assert.equal(a1.prevHash, GENESIS_HASH);

        const mine = await store.audit.list(T, 500);
        assert.equal(mine.some((e) => e.id === a1.id), false, "tenant A must not see tenant B's audit entries");

        // Each chain verifies on its own.
        assert.equal((await store.audit.verify(T)).ok, true);
        assert.equal((await store.audit.verify(OTHER)).ok, true);
      });

      it('counts seats per tenant, not globally', async () => {
        await store.users.create({
          id: 'usr-other',
          tenantId: OTHER,
          email: 'other@example.com',
          name: 'Other',
          passwordHash: 'h',
          role: 'Executive',
          createdAt: new Date(0).toISOString(),
        });

        const a = await store.users.countForTenant(T);
        const b = await store.users.countForTenant(OTHER);
        assert.equal(b, 1);
        assert.ok(a >= 1);
        assert.equal(await store.users.count(), a + b, 'global count is the sum of the tenants');

        const listed = await store.users.listForTenant(OTHER);
        assert.equal(listed.length, 1);
        assert.equal(listed[0].id, 'usr-other');
      });
    });

    it('keeps sequence numbers contiguous under concurrent appends', async () => {
      await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          store.audit.append(T, {
            event: 'load.test',
            actorId: null,
            actorName: null,
            actorRole: null,
            subject: `n-${i}`,
            outcome: 'info',
            detail: { i },
          }),
        ),
      );

      const all = await store.audit.list(T, 500);
      const seqs = all.map((e) => e.seq).sort((a, b) => a - b);
      // No duplicates and no gaps: a fork in the chain is indistinguishable
      // from tampering, so interleaved appends must serialise.
      assert.equal(new Set(seqs).size, seqs.length, 'duplicate sequence numbers');
      for (let i = 1; i < seqs.length; i++) {
        assert.equal(seqs[i], seqs[i - 1] + 1, `gap before seq ${seqs[i]}`);
      }
      assert.equal((await store.audit.verify(T)).ok, true);
    });
  });
}

runConformance('sqlite', makeSqlite);

if (PG_URL) {
  runConformance('postgres', () => ({
    store: new PostgresStore(PG_URL),
    cleanup: () => undefined,
  }));
} else {
  describe('Store conformance — postgres', () => {
    it('skipped (set TEST_DATABASE_URL to run)', () => {
      assert.ok(true);
    });
  });
}

// ---------------------------------------------------------------- chain unit
describe('Audit chain integrity', () => {
  const base = {
    seq: 1,
    id: 'aud-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    event: 'trade.executed',
    actorId: 'usr-1',
    actorName: 'Ada',
    actorRole: 'Executive' as const,
    subject: 'AST-1',
    outcome: 'allowed' as const,
    detail: { a: 1 },
  };

  const link = (n: number, prev: string, detail: Record<string, unknown> = { a: n }) => {
    const entry = { ...base, seq: n, id: `aud-${n}`, detail };
    return { ...entry, prevHash: prev, hash: hashEntry(entry, prev) };
  };

  it('canonicalises objects independently of key order', () => {
    assert.equal(canonicalise({ b: 1, a: 2 }), canonicalise({ a: 2, b: 1 }));
    assert.equal(canonicalise({ x: { q: 1, p: 2 } }), canonicalise({ x: { p: 2, q: 1 } }));
  });

  it('accepts a well-formed chain', () => {
    const one = link(1, GENESIS_HASH);
    const two = link(2, one.hash);
    assert.equal(verifyChain([one, two]).ok, true);
  });

  it('detects a modified record', () => {
    const one = link(1, GENESIS_HASH);
    const two = link(2, one.hash);
    // Someone edits the amount after the fact.
    const tampered = { ...two, detail: { a: 999 } };
    const result = verifyChain([one, tampered]);
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 2);
    assert.match(result.reason!, /modified/);
  });

  it('detects a deleted record', () => {
    const one = link(1, GENESIS_HASH);
    const two = link(2, one.hash);
    const three = link(3, two.hash);
    const result = verifyChain([one, three]); // #2 excised
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 3);
    assert.match(result.reason!, /removed or reordered/);
  });

  it('detects reordering', () => {
    const one = link(1, GENESIS_HASH);
    const two = link(2, one.hash);
    const result = verifyChain([two, one]);
    assert.equal(result.ok, false);
  });

  it('accepts an empty chain', () => {
    assert.equal(verifyChain([]).ok, true);
  });
});
