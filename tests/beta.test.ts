/**
 * Closed-beta gate tests.
 *
 * The two properties that matter here are both about money:
 *
 *  1. **A single-use invite is redeemed exactly once**, even under a race. If
 *     it can be redeemed twice, the operator's account cap is a suggestion.
 *  2. **Inference spend is counted, not lost.** Two concurrent model calls from
 *     one tenant must both count; losing one is losing the safety margin the
 *     free tier depends on.
 *
 * Both are properties of the SQL implementation rather than of pure functions,
 * so they are exercised against a real database.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

import { SqliteStore } from '../server/store/sqlite';
import { asTenantId } from '../server/store/tenancy';
import {
  assessCredit,
  currentPeriod,
  emptyUsage,
  estimateCostCents,
  generateInviteCode,
  hashInviteCode,
  normaliseInviteCode,
  ratesFromEnv,
  type Invite,
} from '../server/store/beta';

const T = asTenantId('tnt-test');

function makeInvite(over: Partial<Invite> = {}): Invite {
  const code = over.codeHash ? '' : generateInviteCode();
  return {
    id: `inv-${crypto.randomUUID()}`,
    codeHash: over.codeHash ?? hashInviteCode(code),
    label: null,
    createdAt: new Date().toISOString(),
    createdBy: 'test',
    maxUses: 1,
    uses: 0,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    lastUsedBy: null,
    ...over,
  };
}

async function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-beta-'));
  const store = new SqliteStore(path.join(dir, 'test.db'));
  await store.init();
  return { store, dir };
}

// ------------------------------------------------------------------ codes
test('Invite code generation', async (t) => {
  await t.test('excludes the characters people confuse when retyping', () => {
    // 0/O and 1/I/L are the classic misreads on a code somebody types from an
    // email into a form.
    const codes = Array.from({ length: 200 }, () => generateInviteCode()).join('');
    for (const banned of ['0', 'O', '1', 'I', 'L']) {
      assert.ok(!codes.includes(banned), `code alphabet must not contain ${banned}`);
    }
  });

  await t.test('is grouped and long enough to resist guessing', () => {
    const code = generateInviteCode();
    assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    // 31 symbols, 15 positions — comfortably past anything a rate-limited
    // endpoint could be walked through.
    assert.ok(31 ** 15 > 1e22);
  });

  await t.test('normalisation makes retyping forgiving but not ambiguous', () => {
    const code = 'ABCDE-FGHJK-MNPQR';
    assert.equal(normaliseInviteCode('  abcde fghjk-mnpqr '), 'ABCDEFGHJKMNPQR');
    assert.equal(hashInviteCode(code), hashInviteCode('abcde fghjkmnpqr'));
    assert.notEqual(hashInviteCode(code), hashInviteCode('ABCDE-FGHJK-MNPQS'));
  });

  await t.test('the code is never recoverable from what is stored', () => {
    const code = generateInviteCode();
    const hash = hashInviteCode(code);
    assert.equal(hash.length, 64);
    assert.ok(!hash.includes(normaliseInviteCode(code)));
  });
});

// ---------------------------------------------------------------- redemption
test('Invite redemption', async (t) => {
  const { store } = await freshStore();
  t.after(async () => store.close());

  await t.test('a valid code admits exactly one account', async () => {
    const code = generateInviteCode();
    await store.invites.create(makeInvite({ codeHash: hashInviteCode(code) }));

    const first = await store.invites.redeem(hashInviteCode(code), 'a@example.com');
    assert.equal(first.ok, true);

    const second = await store.invites.redeem(hashInviteCode(code), 'b@example.com');
    assert.equal(second.ok, false);
    assert.equal(second.ok === false && second.reason, 'exhausted');
  });

  await t.test('a race for one code produces exactly one winner', async () => {
    // The whole reason redemption is a compare-and-swap. A read-then-write
    // implementation passes the test above and fails this one.
    const code = generateInviteCode();
    await store.invites.create(makeInvite({ codeHash: hashInviteCode(code) }));

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.invites.redeem(hashInviteCode(code), `racer${i}@example.com`),
      ),
    );

    assert.equal(results.filter((r) => r.ok).length, 1, 'exactly one redemption may succeed');
  });

  await t.test('a multi-use code admits exactly its quota', async () => {
    const code = generateInviteCode();
    await store.invites.create(makeInvite({ codeHash: hashInviteCode(code), maxUses: 3 }));

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.invites.redeem(hashInviteCode(code), `u${i}@x.com`)),
    );
    assert.equal(results.filter((r) => r.ok).length, 3);
  });

  await t.test('an unknown code is refused', async () => {
    const result = await store.invites.redeem(hashInviteCode(generateInviteCode()), 'x@example.com');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'unknown_code');
  });

  await t.test('a revoked code stops working immediately', async () => {
    const code = generateInviteCode();
    const invite = await store.invites.create(
      makeInvite({ codeHash: hashInviteCode(code), maxUses: 5 }),
    );
    await store.invites.revoke(invite.id);

    const result = await store.invites.redeem(hashInviteCode(code), 'x@example.com');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'revoked');
  });

  await t.test('an expired code is refused', async () => {
    const code = generateInviteCode();
    await store.invites.create(
      makeInvite({
        codeHash: hashInviteCode(code),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    const result = await store.invites.redeem(hashInviteCode(code), 'x@example.com');
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'expired');
  });

  await t.test('redemption records who used it, for the audit trail', async () => {
    const code = generateInviteCode();
    await store.invites.create(makeInvite({ codeHash: hashInviteCode(code) }));
    const result = await store.invites.redeem(hashInviteCode(code), 'traced@example.com');
    assert.ok(result.ok);
    assert.equal(result.ok && result.invite.lastUsedBy, 'traced@example.com');
  });

  await t.test('countRedeemable ignores revoked, expired and exhausted codes', async () => {
    const { store: fresh } = await freshStore();
    const open = generateInviteCode();
    await fresh.invites.create(makeInvite({ codeHash: hashInviteCode(open) }));
    await fresh.invites.create(
      makeInvite({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    const revoked = await fresh.invites.create(makeInvite());
    await fresh.invites.revoke(revoked.id);
    const used = generateInviteCode();
    await fresh.invites.create(makeInvite({ codeHash: hashInviteCode(used) }));
    await fresh.invites.redeem(hashInviteCode(used), 'someone@example.com');

    assert.equal(await fresh.invites.countRedeemable(), 1);
    await fresh.close();
  });
});

// ------------------------------------------------------------------ metering
test('Inference metering', async (t) => {
  const { store } = await freshStore();
  t.after(async () => store.close());

  await t.test('an unmetered tenant starts at zero rather than undefined', async () => {
    const usage = await store.usage.get(T, currentPeriod());
    assert.equal(usage.requests, 0);
    assert.equal(usage.costCents, 0);
  });

  await t.test('usage accumulates additively', async () => {
    const period = '2026-01';
    await store.usage.record(T, period, { requests: 1, inputTokens: 100, outputTokens: 50, costCents: 0.03 });
    await store.usage.record(T, period, { requests: 1, inputTokens: 200, outputTokens: 80, costCents: 0.05 });

    const usage = await store.usage.get(T, period);
    assert.equal(usage.requests, 2);
    assert.equal(usage.inputTokens, 300);
    assert.equal(usage.outputTokens, 130);
    assert.ok(Math.abs(usage.costCents - 0.08) < 1e-9);
  });

  await t.test('concurrent calls from one tenant all count', async () => {
    // Read-modify-write loses writes here, and a lost write is a free request.
    const period = '2026-02';
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.usage.record(T, period, { requests: 1, inputTokens: 10, outputTokens: 5, costCents: 0.001 }),
      ),
    );
    const usage = await store.usage.get(T, period);
    assert.equal(usage.requests, 20, 'no request may be lost to a race');
    assert.equal(usage.inputTokens, 200);
  });

  await t.test('periods are isolated from each other', async () => {
    assert.equal((await store.usage.get(T, '2026-01')).requests, 2);
    assert.equal((await store.usage.get(T, '2026-03')).requests, 0);
  });

  await t.test('tenants are isolated from each other', async () => {
    const other = asTenantId('tnt-other');
    await store.usage.record(other, '2026-01', { requests: 5 });
    assert.equal((await store.usage.get(T, '2026-01')).requests, 2);
    assert.equal((await store.usage.get(other, '2026-01')).requests, 5);
  });
});

test('Credit assessment', async (t) => {
  const rates = { inputCentsPerMTok: 100, outputCentsPerMTok: 400, configured: true };

  await t.test('cost is estimated per million tokens', () => {
    assert.equal(estimateCostCents(1_000_000, 0, rates), 100);
    assert.equal(estimateCostCents(0, 1_000_000, rates), 400);
    assert.equal(estimateCostCents(0, 0, rates), 0);
  });

  await t.test('sub-cent costs are not rounded away to nothing', () => {
    // Rounding each request to whole cents would meter almost every call as
    // free, which is the same as not metering.
    const cost = estimateCostCents(1000, 500, rates);
    assert.ok(cost > 0, `a real call must cost something, got ${cost}`);
    assert.ok(cost < 1);
  });

  await t.test('a tenant inside its credit is allowed', () => {
    const usage = { ...emptyUsage('t'), costCents: 40 };
    const verdict = assessCredit(usage, 200);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.remainingCents, 160);
  });

  await t.test('a tenant at or past its credit is refused', () => {
    assert.equal(assessCredit({ ...emptyUsage('t'), costCents: 200 }, 200).allowed, false);
    assert.equal(assessCredit({ ...emptyUsage('t'), costCents: 250 }, 200).allowed, false);
    assert.equal(assessCredit({ ...emptyUsage('t'), costCents: 250 }, 200).remainingCents, 0);
  });

  await t.test('a zero limit means unlimited, not blocked', () => {
    // Otherwise a plan whose credit was never configured refuses every request,
    // and the resulting 402s read as a bug rather than as policy.
    assert.equal(assessCredit({ ...emptyUsage('t'), costCents: 9999 }, 0).allowed, true);
  });

  await t.test('unconfigured rates default HIGH, so the failure is early cut-off', () => {
    // The dangerous default is the cheap one: it under-counts and hands out an
    // unbounded bill. Over-counting cuts a user off early, which is annoying
    // and recoverable.
    const defaults = ratesFromEnv({});
    assert.equal(defaults.configured, false);
    assert.ok(defaults.inputCentsPerMTok >= 100);
    assert.ok(defaults.outputCentsPerMTok >= 400);

    const configured = ratesFromEnv({
      AI_INPUT_CENTS_PER_MTOK: '30',
      AI_OUTPUT_CENTS_PER_MTOK: '250',
    } as NodeJS.ProcessEnv);
    assert.equal(configured.configured, true);
    assert.equal(configured.inputCentsPerMTok, 30);
    assert.ok(
      defaults.inputCentsPerMTok > configured.inputCentsPerMTok,
      'the placeholder must over-state, never under-state',
    );
  });

  await t.test('the period key is UTC calendar months', () => {
    assert.equal(currentPeriod(new Date('2026-08-03T23:30:00Z')), '2026-08');
    assert.equal(currentPeriod(new Date('2026-01-01T00:00:00Z')), '2026-01');
    assert.equal(currentPeriod(new Date('2026-12-31T23:59:59Z')), '2026-12');
  });
});
