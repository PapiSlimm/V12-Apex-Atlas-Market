/**
 * Upgrade-path test.
 *
 * A pre-tenancy database is built by hand, then opened with the current code.
 * This is the scenario that would hit every existing deployment on upgrade, and
 * the one `CREATE TABLE IF NOT EXISTS` silently fails to handle.
 *
 * I only found this because a stale Postgres test database disagreed with a
 * fresh SQLite one. Without this test, the next person to find it would be a
 * customer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

import { SqliteStore } from '../server/store/sqlite';
import { DEFAULT_TENANT_ID } from '../server/store/tenancy';
import { LEGACY_SUFFIX } from '../server/store/migrate';

/** The schema exactly as it shipped before tenancy. */
function buildLegacyDatabase(file: string) {
  const db = new Database(file);
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      password_hash TEXT NOT NULL, role TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE twin_nodes (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, node_id TEXT NOT NULL,
      parent_hub TEXT, file_path TEXT NOT NULL, coordinates TEXT,
      connected_nodes TEXT NOT NULL DEFAULT '[]', metrics TEXT NOT NULL DEFAULT '{}',
      content TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT, updated_by TEXT
    );
    CREATE TABLE assets (
      asset_id TEXT PRIMARY KEY, name TEXT NOT NULL, asset_class TEXT NOT NULL,
      acquisition_price REAL NOT NULL, current_price REAL NOT NULL, buy_fees REAL NOT NULL,
      sell_fees REAL NOT NULL, is_guaranteed INTEGER NOT NULL DEFAULT 0,
      fundamentals_intact INTEGER NOT NULL DEFAULT 1, quantity REAL NOT NULL DEFAULT 0,
      active_offer REAL, simulated INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE trades (
      id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, action TEXT NOT NULL, quantity REAL NOT NULL,
      unit_price REAL NOT NULL, realized_net_per_unit REAL NOT NULL, realized_net_total REAL NOT NULL,
      executed_by TEXT NOT NULL, executed_by_id TEXT NOT NULL, timestamp TEXT NOT NULL,
      simulated INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE audit_log (
      seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, timestamp TEXT NOT NULL, event TEXT NOT NULL,
      actor_id TEXT, actor_name TEXT, actor_role TEXT, subject TEXT, outcome TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '{}', prev_hash TEXT NOT NULL, hash TEXT NOT NULL
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  db.prepare(
    `INSERT INTO users (id, email, name, password_hash, role, created_at) VALUES (?,?,?,?,?,?)`,
  ).run('usr-legacy', 'legacy@example.com', 'Legacy User', 'hash', 'Executive', '2026-01-01T00:00:00.000Z');

  db.prepare(
    `INSERT INTO twin_nodes (id, name, type, node_id, file_path, content, sort_order)
     VALUES (?,?,?,?,?,?,?)`,
  ).run('node-legacy', 'Legacy Node', 'city_hub', 'LEG-01', 'legacy.md', 'IMPORTANT CUSTOMER DATA', 0);

  db.prepare(
    `INSERT INTO assets (asset_id, name, asset_class, acquisition_price, current_price, buy_fees,
       sell_fees, is_guaranteed, fundamentals_intact, quantity, sort_order)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('AST-LEGACY', 'Legacy Asset', 'H266_Video_NFT', 10, 12, 0.01, 0.01, 1, 1, 500, 0);

  db.prepare(
    `INSERT INTO trades (id, asset_id, action, quantity, unit_price, realized_net_per_unit,
       realized_net_total, executed_by, executed_by_id, timestamp, simulated)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run('trd-legacy', 'AST-LEGACY', 'EXECUTE_SELL', 10, 12, 1.5, 15, 'Legacy User', 'usr-legacy',
    '2026-01-02T00:00:00.000Z', 1);

  db.prepare(
    `INSERT INTO audit_log (seq, id, timestamp, event, outcome, detail, prev_hash, hash)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run(1, 'aud-legacy', '2026-01-02T00:00:00.000Z', 'trade.executed', 'allowed', '{"legacy":true}',
    '0'.repeat(64), 'deadbeef');

  db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?)`).run('venue.fill_cursor', '42');
  db.close();
}

describe('Upgrade from a pre-tenancy database', () => {
  it('migrates existing data into the default tenant without losing any of it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-migrate-'));
    const file = path.join(dir, 'legacy.db');

    try {
      buildLegacyDatabase(file);

      // Opening with the current code must upgrade, not explode.
      const store = new SqliteStore(file);
      await store.init();

      // Every row survives, stamped with the default tenant.
      const user = await store.users.findByEmail('legacy@example.com');
      assert.ok(user, 'the existing account must survive the upgrade');
      assert.equal(user!.tenantId, DEFAULT_TENANT_ID);
      assert.equal(user!.name, 'Legacy User');

      const nodes = await store.nodes.list(DEFAULT_TENANT_ID);
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].content, 'IMPORTANT CUSTOMER DATA');

      const asset = await store.assets.get(DEFAULT_TENANT_ID, 'AST-LEGACY');
      assert.ok(asset);
      assert.equal(asset!.quantity, 500);
      assert.equal(asset!.is_guaranteed, true);

      const trades = await store.trades.list(DEFAULT_TENANT_ID, 10);
      assert.equal(trades.length, 1);
      assert.equal(trades[0].realized_net_total, 15);

      const audit = await store.audit.list(DEFAULT_TENANT_ID, 10);
      assert.equal(audit.length, 1);
      assert.deepEqual(audit[0].detail, { legacy: true });

      // The fill cursor matters: losing it would replay or skip fills.
      assert.equal(await store.meta.get(DEFAULT_TENANT_ID, 'venue.fill_cursor'), '42');

      await store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves the original tables rather than dropping them', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-migrate-'));
    const file = path.join(dir, 'legacy.db');

    try {
      buildLegacyDatabase(file);
      const store = new SqliteStore(file);
      await store.init();
      await store.close();

      // Deleting a customer's only copy of their data to save a few megabytes
      // is a bad trade. The originals stay until they choose otherwise.
      const db = new Database(file);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r: any) => r.name);
      db.close();

      assert.ok(tables.includes(`users${LEGACY_SUFFIX}`), 'the legacy table must be kept for rollback');
      assert.ok(tables.includes(`twin_nodes${LEGACY_SUFFIX}`));
      assert.ok(tables.includes('users'), 'and the new table must exist alongside it');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent — a second open does not migrate again', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-migrate-'));
    const file = path.join(dir, 'legacy.db');

    try {
      buildLegacyDatabase(file);

      const first = new SqliteStore(file);
      await first.init();
      await first.close();

      const second = new SqliteStore(file);
      await second.init();
      const report = await (second as any).lastMigration();
      assert.equal(report.ran, false, 'an already-migrated database must be left alone');

      // And the data is still there exactly once.
      const nodes = await second.nodes.list(DEFAULT_TENANT_ID);
      assert.equal(nodes.length, 1, 'a repeated migration must not duplicate rows');
      await second.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing to a fresh database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-migrate-'));
    try {
      const store = new SqliteStore(path.join(dir, 'fresh.db'));
      await store.init();
      const report = await (store as any).lastMigration();
      assert.equal(report.ran, false);
      await store.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
