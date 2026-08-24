/**
 * Row-level security, proved against a real Postgres.
 *
 * WHAT THIS IS ACTUALLY TESTING
 * ----------------------------
 * Not "does the SQL parse". The claim RLS makes is much stronger and much more
 * useful: a query that ASKS for another tenant's rows gets nothing back. Every
 * query in `SqlStore` already carries `tenant_id = ?`, so a test that only ever
 * asks for its own rows proves nothing at all — it would pass with RLS switched
 * off.
 *
 * So these tests deliberately ask the WRONG question. `listForTenant(B)` while
 * scoped to A is exactly the shape of a route that forgot to scope, or an
 * injection that reached the driver, and it must come back empty.
 *
 * Skipped unless TEST_DATABASE_URL points at a Postgres the test may own — it
 * drops and recreates the schema, and it enables RLS on it.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { PostgresStore } from '../server/store/postgres';
import { asTenantId, type Tenant, type TenantId } from '../server/store/tenancy';
import { runAsSystem, runWithTenant, currentScope, scopeSettings } from '../server/store/tenant-context';
import { RLS_SETTING, RLS_SYSTEM_SETTING, RLS_TABLES, marketRlsSql } from '../server/store/market-schema';

const PG_URL = process.env.TEST_DATABASE_URL;

const A = asTenantId('tnt-alpha');
const B = asTenantId('tnt-beta');

const tenant = (id: TenantId, slug: string): Tenant => ({
  id, slug, name: slug, plan: 'enterprise', status: 'active',
  seatLimit: 100, monthlyAiCreditCents: 0, assetLedgerEnabled: true,
  createdAt: new Date(0).toISOString(),
});

const user = (id: string, tenantId: TenantId, email: string) => ({
  id, tenantId, email, name: id, passwordHash: 'x', role: 'Executive' as const,
  createdAt: new Date(0).toISOString(),
});

/* ---------------------------------------------------------------- *
 * The scope carrier — no database needed
 * ---------------------------------------------------------------- */

describe('tenant context', () => {
  it('is absent by default, and absence is not a permissive default', () => {
    assert.equal(currentScope(), null);
    assert.equal(scopeSettings(), null, 'an unset setting matches no tenant, so nothing comes back');
  });

  it('carries through awaits and nested calls', async () => {
    await runWithTenant('tnt-alpha', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      const inner = await (async () => currentScope())();
      assert.deepEqual(inner, { kind: 'tenant', tenantId: 'tnt-alpha' });
    });
    assert.equal(currentScope(), null, 'and does not leak out');
  });

  it('a system scope must state a reason', () => {
    runAsSystem('boot: schema', () => {
      const scope = currentScope();
      assert.equal(scope?.kind, 'system');
      assert.equal(scope!.kind === 'system' && scope.reason, 'boot: schema');
      assert.deepEqual(scopeSettings(), { tenantId: '', system: true });
    });
  });

  it('nesting a tenant inside a system scope narrows it, not the reverse', () => {
    runAsSystem('boot', () => {
      runWithTenant('tnt-alpha', () => {
        assert.deepEqual(scopeSettings(), { tenantId: 'tnt-alpha', system: false });
      });
      assert.equal(scopeSettings()?.system, true);
    });
  });
});

describe('the RLS policy text', () => {
  it('admits the system scope through a separate setting', () => {
    const policy = marketRlsSql(['users']).find((s) => s.includes('CREATE POLICY'))!;
    assert.ok(policy.includes(RLS_SETTING));
    assert.ok(policy.includes(RLS_SYSTEM_SETTING));
  });

  it('covers every table that carries customer data', () => {
    for (const table of ['users', 'assets', 'trades', 'audit_log', 'orders', 'fills', 'market_inventory']) {
      assert.ok((RLS_TABLES as readonly string[]).includes(table), `${table} is uncovered`);
    }
  });
});

/* ---------------------------------------------------------------- *
 * The real thing
 * ---------------------------------------------------------------- */

describe('row-level security on Postgres', { skip: PG_URL ? false : 'TEST_DATABASE_URL not set' }, () => {
  let store: PostgresStore;

  before(async () => {
    store = new PostgresStore(PG_URL!);
    await runAsSystem('test: schema', async () => {
      await store.reset();
      await store.tenants.create(tenant(A, 'alpha'));
      await store.tenants.create(tenant(B, 'beta'));
      await store.users.create(user('u-a', A, 'a@example.com'));
      await store.users.create(user('u-b', B, 'b@example.com'));
    });
    await store.applyRowLevelSecurity();
  });

  after(async () => {
    await store.close();
  });

  it('a tenant sees its own rows', async () => {
    await runWithTenant(A, async () => {
      const users = await store.users.listForTenant(A);
      assert.equal(users.length, 1);
      assert.equal(users[0].email, 'a@example.com');
    });
  });

  it('ASKING for another tenant\'s rows returns nothing', async () => {
    await runWithTenant(A, async () => {
      const stolen = await store.users.listForTenant(B);
      assert.equal(stolen.length, 0, 'this is the query a forgotten scope or an injection would issue');
      assert.equal(await store.users.countForTenant(B), 0);
    });
  });

  it('a global lookup cannot cross the boundary either', async () => {
    // findByEmail is global by design — sign-in has an email and no tenant
    // selector. Under RLS it is still bounded by the connection's scope, which
    // is the difference between "the code scopes it" and "the database does".
    await runWithTenant(A, async () => {
      assert.ok(await store.users.findByEmail('a@example.com'));
      assert.equal(await store.users.findByEmail('b@example.com'), null);
    });
  });

  it('an unscoped connection sees nothing rather than everything', async () => {
    const users = await store.users.listForTenant(A);
    assert.equal(users.length, 0, 'the failure falls in the safe direction');
  });

  it('a tenant cannot write rows stamped with another tenant', async () => {
    await runWithTenant(A, async () => {
      await assert.rejects(
        () => store.users.create(user('u-smuggled', B, 'smuggled@example.com')),
        /row-level security/i,
        'reading another tenant is loud; writing INTO one is the quieter bug',
      );
    });
  });

  it('the audit chain appends under a tenant scope and still verifies', async () => {
    await runWithTenant(A, async () => {
      for (const event of ['market.offer.posted', 'market.trade.proposed']) {
        await store.audit.append(A, {
          event, actorId: 'u-a', actorName: 'alpha', actorRole: 'Executive',
          subject: 'trade-1', outcome: 'allowed', detail: {},
        });
      }
      const verification = await store.audit.verify(A);
      assert.equal(verification.ok, true);
      assert.equal(verification.entries, 2);
    });
  });

  it('one tenant\'s chain is invisible to another, not merely filtered', async () => {
    await runWithTenant(B, async () => {
      assert.equal((await store.audit.list(A, 100)).length, 0);
      const verification = await store.audit.verify(A);
      assert.equal(verification.entries, 0, 'B cannot even learn how much activity A has');
    });
  });

  it('the scope does not leak to the next borrower of a pooled connection', async () => {
    // The classic RLS-under-load failure: a session-level setting survives back
    // into the pool and the next request inherits it. Everything here is set
    // transaction-locally, so twenty interleaved scopes must each see only
    // their own rows.
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        runWithTenant(i % 2 === 0 ? A : B, async () => {
          const own = i % 2 === 0 ? A : B;
          const other = i % 2 === 0 ? B : A;
          return {
            own: (await store.users.listForTenant(own)).length,
            other: (await store.users.listForTenant(other)).length,
          };
        }),
      ),
    );
    for (const result of results) {
      assert.equal(result.own, 1);
      assert.equal(result.other, 0);
    }
  });

  it('withTenant scopes a whole unit of work', async () => {
    const seen = await store.withTenant(B, async () => {
      const mine = await store.users.listForTenant(B);
      const theirs = await store.users.listForTenant(A);
      return { mine: mine.length, theirs: theirs.length };
    });
    assert.deepEqual(seen, { mine: 1, theirs: 0 });
  });

  it('the system scope is the documented bypass, and it works', async () => {
    await runAsSystem('test: platform-wide health check', async () => {
      const health = await store.audit.verifyAll();
      assert.equal(health.ok, true);
      assert.ok(health.tenants >= 2, 'a platform health check must be able to see every chain');
    });
  });
});

describe('the superuser trap', { skip: PG_URL ? false : 'TEST_DATABASE_URL not set' }, () => {
  it('reports whether the connecting role bypasses RLS', async () => {
    // A superuser bypasses row-level security entirely, FORCE included: every
    // policy applies, every query still returns every tenant's rows, and
    // nothing errors. Reporting the fact is the difference between an operator
    // who knows and one with a green terminal and no isolation.
    const store = new PostgresStore(PG_URL!);
    try {
      const result = await runAsSystem('test: apply rls', () => store.applyRowLevelSecurity());
      assert.equal(typeof result.superuser, 'boolean');
      assert.equal(
        result.superuser,
        false,
        'this suite must run as a non-superuser, or its isolation assertions prove nothing',
      );
    } finally {
      await store.close();
    }
  });
});
