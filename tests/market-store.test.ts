/**
 * The market layer's persistence, where the pure decisions have to land.
 *
 * Everything in `server/market` is a correct decision made in memory. These
 * tests are about the last step, which is where the correctness is usually
 * lost: two agents of the same seller writing the same position, a refund
 * committed twice, an audit entry that survives a rolled-back correction.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { SqliteStore } from '../server/store/sqlite';
import { DEFAULT_TENANT_ID } from '../server/store/tenancy';
import { commit, type InventoryPosition } from '../server/market/inventory';
import { participantId, type Leg } from '../server/market/types';
import { issueKey } from '../server/external/keys';
import type { CorrectionRecord } from '../server/store/types';

const TENANT = DEFAULT_TENANT_ID;
const SELLER = participantId('acme-render');
const BUYER = participantId('borealis-studios');
const NOW = 1_700_000_000_000;

async function freshStore(): Promise<SqliteStore> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-market-store-'));
  const store = new SqliteStore(path.join(dir, 'test.db'));
  await store.init();
  return store;
}

const position = (over: Partial<InventoryPosition> = {}): InventoryPosition => ({
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
});

test('inventory round-trips through the database unchanged, nulls included', async () => {
  const store = await freshStore();
  await store.market.inventory.put(TENANT, position());
  assert.deepEqual(await store.market.inventory.get(TENANT, SELLER, 'GPU-A100-USED'), position());

  const renewable = position({
    sku: 'RENDER-HOURS',
    kind: 'renewable',
    onHand: 40,
    periodStart: NOW,
    periodEnd: NOW + 604_800_000,
    updatedAt: NOW + 5,
  });
  await store.market.inventory.put(TENANT, renewable);
  assert.deepEqual(await store.market.inventory.get(TENANT, SELLER, 'RENDER-HOURS'), renewable);
  await store.close();
});

test('one company per SKU has ONE position, however many times it is declared', async () => {
  const store = await freshStore();
  await store.market.inventory.put(TENANT, position({ onHand: 100 }));
  await store.market.inventory.put(TENANT, position({ onHand: 250, updatedAt: NOW + 1 }));

  const all = await store.market.inventory.listFor(TENANT, SELLER);
  assert.equal(all.length, 1, 'two rows would be two answers to "how many do you have"');
  assert.equal(all[0].onHand, 250);
  await store.close();
});

test('two of a seller\'s own agents cannot both reserve the same stock', async () => {
  const store = await freshStore();
  await store.market.inventory.put(TENANT, position({ onHand: 100 }));

  // Both agents read the same position — the realistic race.
  const read = (await store.market.inventory.get(TENANT, SELLER, 'GPU-A100-USED'))!;

  const agentA = commit(read, 80, NOW + 1);
  const agentB = commit(read, 80, NOW + 2);
  assert.equal(agentA.ok, true);
  assert.equal(agentB.ok, true, 'in memory BOTH decisions look fine — that is the whole problem');
  if (!agentA.ok || !agentB.ok) return;

  const first = await store.market.inventory.save(TENANT, agentA.value, read.updatedAt);
  const second = await store.market.inventory.save(TENANT, agentB.value, read.updatedAt);

  assert.equal(first, 1, 'one agent wins');
  assert.equal(second, 0, 'the other must re-read rather than overwrite a reservation it never saw');

  const after = (await store.market.inventory.get(TENANT, SELLER, 'GPU-A100-USED'))!;
  assert.equal(after.committed, 80, 'not 160 — the seller has not promised 160 of 100 units');
  await store.close();
});

test('a losing writer succeeds once it re-reads', async () => {
  const store = await freshStore();
  await store.market.inventory.put(TENANT, position({ onHand: 100 }));
  const stale = (await store.market.inventory.get(TENANT, SELLER, 'GPU-A100-USED'))!;

  const winner = commit(stale, 80, NOW + 1);
  assert.equal(winner.ok, true);
  if (!winner.ok) return;
  await store.market.inventory.save(TENANT, winner.value, stale.updatedAt);

  const reread = (await store.market.inventory.get(TENANT, SELLER, 'GPU-A100-USED'))!;
  const retried = commit(reread, 20, NOW + 3);
  assert.equal(retried.ok, true);
  if (!retried.ok) return;
  assert.equal(await store.market.inventory.save(TENANT, retried.value, reread.updatedAt), 1);

  // And the 21st unit is now genuinely unavailable.
  const final = (await store.market.inventory.get(TENANT, SELLER, 'GPU-A100-USED'))!;
  assert.equal(commit(final, 1, NOW + 4).ok, false);
  await store.close();
});

test('the database refuses a negative committed count', async () => {
  const store = await freshStore();
  await store.market.inventory.put(TENANT, position());
  await assert.rejects(() => store.market.inventory.put(TENANT, position({ committed: -1, updatedAt: NOW + 1 })));
  await store.close();
});

test('listings are counted per participant per SKU, additively', async () => {
  const store = await freshStore();
  assert.equal(await store.market.listings.count(TENANT, SELLER, 'RENDER-HOURS'), 0);

  await store.market.listings.record(TENANT, SELLER, 'RENDER-HOURS', NOW);
  assert.equal(await store.market.listings.count(TENANT, SELLER, 'RENDER-HOURS'), 1);

  await store.market.listings.record(TENANT, SELLER, 'RENDER-HOURS', NOW + 1);
  await store.market.listings.record(TENANT, SELLER, 'RENDER-HOURS', NOW + 2);
  assert.equal(
    await store.market.listings.count(TENANT, SELLER, 'RENDER-HOURS'),
    3,
    'this is the number that makes "more than once" answerable at posting time',
  );

  assert.equal(await store.market.listings.count(TENANT, BUYER, 'RENDER-HOURS'), 0, 'not shared between companies');
  assert.equal(await store.market.listings.count(TENANT, SELLER, 'OTHER-SKU'), 0, 'not shared between SKUs');
  await store.close();
});

/* ---------------------------------------------------------------- *
 * Corrections
 * ---------------------------------------------------------------- */

const refundLegs = (): Leg[] => [
  { participant: BUYER, account: 'cash', amount: 45_990n, memo: 'Refund, trade-1' },
  { participant: BUYER, account: 'goods_receivable', amount: -45_990n, memo: 'Refund, trade-1' },
  { participant: SELLER, account: 'cash_held', amount: -45_990n, memo: 'Refund, trade-1' },
  { participant: SELLER, account: 'revenue', amount: 45_990n, memo: 'Refund, trade-1' },
];

const correction = (over: Partial<CorrectionRecord> = {}): CorrectionRecord => ({
  id: 'corr-1',
  tradeId: 'trade-1',
  kind: 'refund',
  legs: refundLegs(),
  digest: 'd'.repeat(64),
  reason: 'Goods never delivered; dispute upheld.',
  decidedBy: 'ig-2 (Inspector General)',
  createdAt: NOW,
  ...over,
});

const auditEntries = () => [
  {
    event: 'market.correction.refund',
    actorId: 'ig-2',
    actorName: 'Inspector General',
    actorRole: 'System Admin',
    subject: 'trade-1',
    outcome: 'allowed' as const,
    detail: { tradeId: 'trade-1' },
  },
];

test('a correction commits with its audit trail, exactly once', async () => {
  const store = await freshStore();

  assert.equal(await store.market.corrections.commit(TENANT, correction(), auditEntries()), 'committed');
  assert.equal(
    await store.market.corrections.commit(TENANT, correction({ id: 'corr-2' }), auditEntries()),
    'already_committed',
    'paying a buyer their refund twice is not a rounding error',
  );

  const found = await store.market.corrections.forTrade(TENANT, 'trade-1');
  assert.equal(found.length, 1);
  assert.equal(found[0].id, 'corr-1');
  assert.equal(found[0].decidedBy, 'ig-2 (Inspector General)');

  const log = await store.audit.list(TENANT, 50);
  assert.equal(log.filter((e) => e.event === 'market.correction.refund').length, 1, 'one correction, one entry');
  await store.close();
});

test('a refund and a release are different corrections on the same trade', async () => {
  const store = await freshStore();
  assert.equal(await store.market.corrections.commit(TENANT, correction(), auditEntries()), 'committed');
  assert.equal(
    await store.market.corrections.commit(TENANT, correction({ id: 'corr-r', kind: 'release' }), auditEntries()),
    'committed',
  );
  assert.equal((await store.market.corrections.forTrade(TENANT, 'trade-1')).length, 2);
  await store.close();
});

test('correction legs survive the round trip as exact minor units', async () => {
  const store = await freshStore();
  const big: Leg[] = [
    { participant: BUYER, account: 'cash', amount: 9_007_199_254_740_993n, memo: 'past Number.MAX_SAFE_INTEGER' },
    { participant: BUYER, account: 'goods_receivable', amount: -9_007_199_254_740_993n, memo: 'and back' },
  ];
  await store.market.corrections.commit(TENANT, correction({ legs: big }), auditEntries());

  const [found] = await store.market.corrections.forTrade(TENANT, 'trade-1');
  assert.equal(found.legs[0].amount, 9_007_199_254_740_993n);
  assert.equal(found.legs[0].amount + found.legs[1].amount, 0n, 'and it still balances');
  await store.close();
});

test('the audit chain still verifies after corrections are committed inside a transaction', async () => {
  const store = await freshStore();
  await store.audit.append(TENANT, {
    event: 'market.settlement.committed',
    actorId: 'sys', actorName: 'system', actorRole: 'System Admin',
    subject: 'trade-1', outcome: 'allowed', detail: {},
  });
  await store.market.corrections.commit(TENANT, correction(), auditEntries());
  await store.audit.append(TENANT, {
    event: 'market.escrow.released',
    actorId: 'sys', actorName: 'system', actorRole: 'System Admin',
    subject: 'trade-2', outcome: 'allowed', detail: {},
  });

  const verification = await store.audit.verify(TENANT);
  assert.equal(verification.ok, true, 'an append inside a nested unit of work must not fork the chain');
  assert.equal(verification.entries, 3);
  await store.close();
});

/* ---------------------------------------------------------------- *
 * External keys
 * ---------------------------------------------------------------- */

test('an external key round-trips and its secret is never stored', async () => {
  const store = await freshStore();
  const issued = issueKey({ tenantId: TENANT, label: 'Partner ERP', scopes: ['inventory:read'], now: NOW });
  await store.externalKeys.save(issued.record);

  const found = await store.externalKeys.get(issued.record.keyId);
  assert.ok(found);
  assert.deepEqual(found.scopes, ['inventory:read']);
  assert.equal(found.ratePerMinute, 60);
  assert.notEqual(found.secretHash, issued.plaintext);
  assert.equal(
    issued.plaintext.includes(found.secretHash),
    false,
    'the stored value must not contain the secret in any form',
  );
  await store.close();
});

test('revocation is immediate and happens once', async () => {
  const store = await freshStore();
  const issued = issueKey({ tenantId: TENANT, label: 'Partner ERP', scopes: ['twin:read'], now: NOW });
  await store.externalKeys.save(issued.record);

  assert.equal(await store.externalKeys.revoke(issued.record.keyId, NOW + 10), 1);
  assert.equal(await store.externalKeys.revoke(issued.record.keyId, NOW + 20), 0, 'already revoked');

  const found = await store.externalKeys.get(issued.record.keyId);
  assert.equal(found?.revokedAt, NOW + 10, 'the first revocation time stands');
  await store.close();
});

test('keys are listed per tenant, newest first', async () => {
  const store = await freshStore();
  const a = issueKey({ tenantId: TENANT, label: 'A', scopes: ['audit:read'], now: NOW });
  const b = issueKey({ tenantId: TENANT, label: 'B', scopes: ['audit:read'], now: NOW + 1_000 });
  const other = issueKey({ tenantId: 'tenant-other', label: 'C', scopes: ['audit:read'], now: NOW + 2_000 });
  for (const k of [a, b, other]) await store.externalKeys.save(k.record);

  const listed = await store.externalKeys.listFor(TENANT);
  assert.deepEqual(listed.map((k) => k.label), ['B', 'A']);
  await store.close();
});
