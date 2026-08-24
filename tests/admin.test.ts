/**
 * Administrative API tests.
 *
 * This endpoint prints credentials. The tests that matter are therefore not
 * "does minting work" — that is the easy half — but the four ways an invite
 * printer becomes an incident:
 *
 *   1. A weak token that gives false confidence.
 *   2. A wrong token that is distinguishable from a missing route.
 *   3. A token comparison that leaks its answer through timing.
 *   4. A code that survives anywhere after it is handed over once.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';

import { SqliteStore } from '../server/store/sqlite';
import { adminConfigFromEnv, createAdminRouter, MIN_TOKEN_LENGTH } from '../server/admin';
import { hashInviteCode } from '../server/store/beta';

const STRONG = 'a'.repeat(MIN_TOKEN_LENGTH);

function fakeReq(over: Record<string, unknown> = {}) {
  return { headers: {}, query: {}, params: {}, body: {}, path: '/api/admin/invites', ip: '1.2.3.4', ...over } as never;
}

function fakeRes() {
  const state: { status: number; body: unknown } = { status: 200, body: null };
  const res = {
    status(code: number) {
      state.status = code;
      return res;
    },
    json(body: unknown) {
      state.body = body;
      return res;
    },
  };
  return { res: res as never, state };
}

async function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-admin-'));
  const store = new SqliteStore(path.join(dir, 'test.db'));
  await store.init();
  return store;
}

test('Admin configuration', async (t) => {
  await t.test('is absent unless a token is set', () => {
    const config = adminConfigFromEnv({} as NodeJS.ProcessEnv);
    assert.equal(config.token, null);
    // Absent, not disabled. server.ts does not mount the routes at all in this
    // state, so there is no surface to probe rather than a locked one.
  });

  await t.test('a strong token is accepted', () => {
    const config = adminConfigFromEnv({ ADMIN_API_TOKEN: STRONG } as NodeJS.ProcessEnv);
    assert.equal(config.token, STRONG);
  });

  await t.test('the IP allowlist parses to exact addresses', () => {
    const config = adminConfigFromEnv({
      ADMIN_API_TOKEN: STRONG,
      ADMIN_IP_ALLOWLIST: ' 10.0.0.1, 10.0.0.2 ,, ',
    } as NodeJS.ProcessEnv);
    assert.deepEqual(config.ipAllowlist, ['10.0.0.1', '10.0.0.2']);
  });

  await t.test('the minimum length is at least 128 bits of hex', () => {
    // A 12-character admin token is worse than none: it produces the
    // confidence of having one. The boot-time refusal is exercised by
    // scripts/verify-beta.ts against a real process, since it calls exit().
    assert.ok(MIN_TOKEN_LENGTH >= 32);
  });
});

test('Admin authentication', async (t) => {
  const store = await freshStore();
  t.after(async () => store.close());

  const admin = createAdminRouter(() => store, { token: STRONG, ipAllowlist: [] });

  const call = async (headers: Record<string, string>, ip = '1.2.3.4') => {
    const { res, state } = fakeRes();
    let passed = false;
    await admin.authenticate(fakeReq({ headers, ip }), res, () => {
      passed = true;
    });
    return { passed, ...state };
  };

  await t.test('a correct bearer token passes', async () => {
    assert.equal((await call({ authorization: `Bearer ${STRONG}` })).passed, true);
  });

  await t.test('the X-Admin-Token header also works', async () => {
    assert.equal((await call({ 'x-admin-token': STRONG })).passed, true);
  });

  await t.test('a wrong token is indistinguishable from a missing route', async () => {
    const wrong = await call({ authorization: `Bearer ${'b'.repeat(MIN_TOKEN_LENGTH)}` });
    assert.equal(wrong.passed, false);
    assert.equal(wrong.status, 404, 'must be 404, never 401 — a 401 confirms the route exists');
    assert.deepEqual(wrong.body, { error: 'Not found.' });
  });

  await t.test('no token at all is refused the same way', async () => {
    const none = await call({});
    assert.equal(none.status, 404);
    assert.deepEqual(none.body, { error: 'Not found.' });
  });

  await t.test('a token of the wrong length does not throw', async () => {
    // timingSafeEqual throws on a length mismatch; that must be handled, not
    // turned into a 500 that confirms the route exists.
    assert.equal((await call({ authorization: 'Bearer short' })).status, 404);
  });

  await t.test('a query-string token is never accepted', async () => {
    // Query strings land in access logs, proxy logs and referrer headers.
    const { res, state } = fakeRes();
    let passed = false;
    await admin.authenticate(fakeReq({ headers: {}, query: { token: STRONG } }), res, () => {
      passed = true;
    });
    assert.equal(passed, false);
    assert.equal(state.status, 404);
  });

  await t.test('the IP allowlist is enforced when configured', async () => {
    const pinned = createAdminRouter(() => store, { token: STRONG, ipAllowlist: ['10.0.0.1'] });
    const attempt = async (ip: string) => {
      const { res, state } = fakeRes();
      let passed = false;
      await pinned.authenticate(fakeReq({ headers: { authorization: `Bearer ${STRONG}` }, ip }), res, () => {
        passed = true;
      });
      return { passed, status: state.status };
    };

    assert.equal((await attempt('10.0.0.1')).passed, true);
    const blocked = await attempt('10.0.0.9');
    assert.equal(blocked.passed, false);
    assert.equal(blocked.status, 404);
  });

  await t.test('refusals are written to the audit chain', async () => {
    await call({ authorization: 'Bearer wrongwrongwrongwrongwrongwrongwr' });
    // Give the fire-and-forget append a tick to land.
    await new Promise((r) => setTimeout(r, 30));
    const entries = await store.audit.list('tnt-default' as never, 50);
    const refusals = entries.filter((e) => e.event === 'admin.refused');
    assert.ok(refusals.length > 0, 'a failed admin call must leave a record');
    assert.equal(refusals[0].outcome, 'refused');
    assert.equal(refusals[0].detail.ip, '1.2.3.4');
  });
});

test('Admin invite minting', async (t) => {
  const store = await freshStore();
  t.after(async () => store.close());
  const admin = createAdminRouter(() => store, { token: STRONG, ipAllowlist: [] });

  const mint = async (body: Record<string, unknown>) => {
    const { res, state } = fakeRes();
    await admin.mint(fakeReq({ body }), res, () => undefined);
    await new Promise((r) => setTimeout(r, 20));
    return state;
  };

  await t.test('returns usable plaintext codes exactly once', async () => {
    const result = await mint({ count: 3, label: 'test' });
    assert.equal(result.status, 201);

    const body = result.body as { invites: { id: string; code: string }[] };
    assert.equal(body.invites.length, 3);

    // Each code must actually redeem.
    for (const { code } of body.invites) {
      const redeemed = await store.invites.redeem(hashInviteCode(code), 'x@example.com');
      assert.equal(redeemed.ok, true, `${code} should redeem`);
    }
  });

  await t.test('the list endpoint never returns a code or a hash', async () => {
    const { res, state } = fakeRes();
    // The handlers are wrapped for Express, so they return void and settle on a
    // later tick. Awaiting one is the difference between testing the response
    // and testing `null`.
    admin.list(fakeReq({ query: {} }), res, () => undefined);
    await new Promise((r) => setTimeout(r, 30));

    const body = state.body as { invites: Record<string, unknown>[] };
    assert.ok(body.invites.length > 0);
    for (const invite of body.invites) {
      assert.ok(!('code' in invite), 'a code must never be returned after minting');
      assert.ok(!('codeHash' in invite), 'the hash is credential-equivalent offline');
    }
  });

  await t.test('the audit entry records ids, never codes', async () => {
    const entries = await store.audit.list('tnt-default' as never, 50);
    const minted = entries.find((e) => e.event === 'admin.invites.minted');
    assert.ok(minted, 'minting must be audited');

    const serialised = JSON.stringify(minted!.detail);
    assert.ok(serialised.includes('inv-'), 'ids are recorded');
    assert.ok(
      !/[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{5}/.test(serialised),
      'an audit log containing working codes is a credential store',
    );
  });

  await t.test('batch size is bounded', async () => {
    const result = await mint({ count: 10_000 });
    const body = result.body as { invites: unknown[] };
    assert.ok(body.invites.length <= 50, `bounded, got ${body.invites.length}`);
  });

  await t.test('nonsense input degrades to a sane default rather than throwing', async () => {
    const result = await mint({ count: 'lots', maxUses: -4, expiresInDays: 'soon' });
    const body = result.body as { invites: unknown[]; maxUses: number; expiresAt: string | null };
    assert.equal(body.invites.length, 1);
    assert.equal(body.maxUses, 1);
    assert.equal(body.expiresAt, null);
  });

  await t.test('revoking an unknown id is a 404, not a crash', async () => {
    const { res, state } = fakeRes();
    admin.revoke(fakeReq({ params: { id: 'inv-does-not-exist' } }), res, () => undefined);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(state.status, 404);
  });
});
