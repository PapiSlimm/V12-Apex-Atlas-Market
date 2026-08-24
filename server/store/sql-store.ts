/**
 * Shared SQL implementation of `Store`.
 *
 * The SQLite and Postgres backends differ in three ways and no more: their DDL
 * types, their placeholder syntax, and how they take a lock. Everything else —
 * every query string, every mapping, the whole audit-chain protocol — lives
 * here once. Portability is enforced by construction rather than by discipline.
 *
 * TENANCY
 * -------
 * Every scoped method takes `TenantId` first, and every scoped query carries
 * `tenant_id = ?` in its WHERE clause. There is no code path that reads a
 * scoped table without a tenant, because there is no method signature that
 * permits one. A route that forgets to scope does not leak — it fails to
 * compile.
 *
 * JSON-shaped columns are stored as TEXT in both dialects rather than
 * jsonb/JSON. It gives up in-database querying of those fields, which nothing
 * needs, and buys byte-identical round-tripping across backends, which the
 * audit hash chain does need.
 */

import crypto from 'crypto';
import type {
  AuditEntry,
  ChainVerification,
  LiquidationResult,
  NewAuditEntry,
  Store,
  TradeRecord,
  TwinNode,
  UserRecord,
  UserRole,
} from './types';
import type { Tenant, TenantId, TenantPlan } from './tenancy';
import { PLAN_DEFAULTS, asTenantId } from './tenancy';
import type { MarketAsset, AssetClass } from '../hermes';
import type { Fill, Order } from '../assets/types';
import { emptyUsage, type AiUsage, type Invite, type RedeemResult, type UsageDelta } from './beta';
import { GENESIS_HASH, hashEntry, verifyChain } from './chain';
import type { CorrectionRecord, ExternalKeyRecord, Scope } from './types';
import type { InventoryPosition, SkuKind } from '../market/inventory';
import type { Leg, ParticipantId } from '../market/types';
import { migrateToTenancy, type MigrationReport } from './migrate';

export type Row = Record<string, any>;

const bool = (v: unknown) => (v ? 1 : 0);
const unbool = (v: unknown) => v === 1 || v === true || v === '1' || v === 't';
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export abstract class SqlStore implements Store {
  abstract readonly dialect: 'sqlite' | 'postgres';

  /** Run a query returning rows. Placeholders are always `?`. */
  protected abstract query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run a statement for effect. */
  protected abstract exec(sql: string, params?: unknown[]): Promise<void>;
  /**
   * Like `exec`, but returns the number of rows the statement changed.
   *
   * This is what makes a compare-and-swap possible: the preconditions live in
   * the WHERE clause and the row count is the verdict. Without it, every
   * conditional update degrades into a read-then-write race.
   */
  protected abstract execCount(sql: string, params?: unknown[]): Promise<number>;
  /** Run `fn` inside a transaction that serialises audit appends. */
  protected abstract transaction<T>(fn: () => Promise<T>): Promise<T>;
  /** Statements creating the schema, in order. */
  protected abstract ddl(): string[];
  /** Statements dropping the schema, in order. */
  protected abstract dropSql(): string[];

  abstract close(): Promise<void>;

  /** Backend-specific introspection, used only by the migration. */
  protected abstract tableExists(table: string): Promise<boolean>;
  protected abstract columnsOf(table: string): Promise<string[]>;

  async init(): Promise<void> {
    // Upgrade a pre-tenancy database BEFORE creating the schema: on an existing
    // install `CREATE TABLE IF NOT EXISTS` is a no-op, so without this the
    // server boots fine and then fails on the first query.
    const report = await migrateToTenancy({
      tableExists: (t) => this.tableExists(t),
      columnsOf: (t) => this.columnsOf(t),
      exec: (sql, params) => this.exec(sql, params),
      createSchema: async () => {
        for (const statement of this.ddl()) await this.exec(statement);
      },
    });

    if (!report.ran) {
      for (const statement of this.ddl()) await this.exec(statement);
    }
  }

  /** Exposed for the migration test. */
  async lastMigration(): Promise<MigrationReport> {
    return migrateToTenancy({
      tableExists: (t) => this.tableExists(t),
      columnsOf: (t) => this.columnsOf(t),
      exec: (sql, params) => this.exec(sql, params),
      createSchema: async () => {
        for (const statement of this.ddl()) await this.exec(statement);
      },
    });
  }

  async reset(): Promise<void> {
    for (const statement of this.dropSql()) await this.exec(statement);
    await this.init();
  }

  private async one<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T | null> {
    const rows = await this.query<T>(sql, params);
    return rows[0] ?? null;
  }

  // ---------------------------------------------------------------- tenants
  private toTenant = (r: Row | null): Tenant | null =>
    r
      ? {
          id: asTenantId(r.id),
          slug: r.slug,
          name: r.name,
          plan: r.plan as TenantPlan,
          status: r.status,
          seatLimit: num(r.seat_limit),
          monthlyAiCreditCents: num(r.monthly_ai_credit_cents),
          assetLedgerEnabled: unbool(r.trading_enabled),
          createdAt: r.created_at,
        }
      : null;

  tenants = {
    create: async (tenant: Tenant) => {
      await this.exec(
        `INSERT INTO tenants
           (id, slug, name, plan, status, seat_limit, monthly_ai_credit_cents, trading_enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          tenant.id,
          tenant.slug,
          tenant.name,
          tenant.plan,
          tenant.status,
          tenant.seatLimit,
          tenant.monthlyAiCreditCents,
          bool(tenant.assetLedgerEnabled),
          tenant.createdAt,
        ],
      );
      return tenant;
    },

    get: async (id: TenantId) => this.toTenant(await this.one('SELECT * FROM tenants WHERE id = ?', [id])),

    getBySlug: async (slug: string) =>
      this.toTenant(await this.one('SELECT * FROM tenants WHERE slug = ?', [slug.toLowerCase()])),

    list: async () =>
      (await this.query('SELECT * FROM tenants ORDER BY created_at')).map((r) => this.toTenant(r) as Tenant),

    setPlan: async (id: TenantId, plan: TenantPlan) => {
      const defaults = PLAN_DEFAULTS[plan];
      await this.exec(
        `UPDATE tenants SET plan = ?, seat_limit = ?, monthly_ai_credit_cents = ?, trading_enabled = ?
         WHERE id = ?`,
        [plan, defaults.seatLimit, defaults.monthlyAiCreditCents, bool(defaults.assetLedgerEnabled), id],
      );
      return this.tenants.get(id);
    },

    count: async () => num((await this.one<{ n: number }>('SELECT COUNT(*) AS n FROM tenants'))?.n),
  };

  // ------------------------------------------------------------------ users
  private toUser = (r: Row | null): UserRecord | null =>
    r
      ? {
          id: r.id,
          tenantId: asTenantId(r.tenant_id),
          email: r.email,
          name: r.name,
          passwordHash: r.password_hash,
          role: r.role as UserRole,
          createdAt: r.created_at,
        }
      : null;

  users = {
    // Global lookup by design: sign-in has an email and a password, no tenant
    // selector, so the email must resolve to exactly one account.
    findByEmail: async (email: string) =>
      this.toUser(await this.one('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()])),

    findById: async (id: string) => this.toUser(await this.one('SELECT * FROM users WHERE id = ?', [id])),

    create: async (user: UserRecord) => {
      await this.exec(
        `INSERT INTO users (id, tenant_id, email, name, password_hash, role, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          user.id,
          user.tenantId,
          user.email.trim().toLowerCase(),
          user.name,
          user.passwordHash,
          user.role,
          user.createdAt,
        ],
      );
      return user;
    },

    countForTenant: async (tenantId: TenantId) =>
      num((await this.one<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE tenant_id = ?', [tenantId]))?.n),

    listForTenant: async (tenantId: TenantId) =>
      (await this.query('SELECT * FROM users WHERE tenant_id = ? ORDER BY created_at', [tenantId])).map(
        (r) => this.toUser(r) as UserRecord,
      ),

    count: async () => num((await this.one<{ n: number }>('SELECT COUNT(*) AS n FROM users'))?.n),
  };

  // ------------------------------------------------------------------ nodes
  private toNode = (r: Row | null): TwinNode | null =>
    r
      ? {
          id: r.id,
          name: r.name,
          type: r.type,
          node_id: r.node_id,
          parent_hub: r.parent_hub ?? undefined,
          filePath: r.file_path,
          coordinates: r.coordinates ? JSON.parse(r.coordinates) : undefined,
          connectedNodes: JSON.parse(r.connected_nodes || '[]'),
          metrics: JSON.parse(r.metrics || '{}'),
          content: r.content,
          updatedAt: r.updated_at ?? undefined,
          updatedBy: r.updated_by ?? undefined,
        }
      : null;

  nodes = {
    list: async (tenantId: TenantId) =>
      (
        await this.query('SELECT * FROM twin_nodes WHERE tenant_id = ? ORDER BY sort_order, id', [tenantId])
      ).map((r) => this.toNode(r) as TwinNode),

    get: async (tenantId: TenantId, id: string) =>
      this.toNode(await this.one('SELECT * FROM twin_nodes WHERE tenant_id = ? AND id = ?', [tenantId, id])),

    update: async (
      tenantId: TenantId,
      id: string,
      patch: { content?: string; metrics?: Record<string, unknown> },
      actor: string,
    ) => {
      const existing = await this.nodes.get(tenantId, id);
      if (!existing) return null;

      const content = patch.content ?? existing.content;
      const metrics = patch.metrics ? { ...existing.metrics, ...patch.metrics } : existing.metrics;
      const updatedAt = new Date().toISOString();

      await this.exec(
        `UPDATE twin_nodes SET content = ?, metrics = ?, updated_at = ?, updated_by = ?
         WHERE tenant_id = ? AND id = ?`,
        [content, JSON.stringify(metrics), updatedAt, actor, tenantId, id],
      );

      return { ...existing, content, metrics: metrics as TwinNode['metrics'], updatedAt, updatedBy: actor };
    },
  };

  // ----------------------------------------------------------------- assets
  private toAsset = (r: Row | null): MarketAsset | null =>
    r
      ? {
          asset_id: r.asset_id,
          name: r.name,
          asset_class: r.asset_class as AssetClass,
          acquisition_price: num(r.acquisition_price),
          current_price: num(r.current_price),
          buy_fees: num(r.buy_fees),
          sell_fees: num(r.sell_fees),
          is_guaranteed: unbool(r.is_guaranteed),
          fundamentals_intact: unbool(r.fundamentals_intact),
          quantity: num(r.quantity),
          active_offer:
            r.active_offer === null || r.active_offer === undefined ? undefined : num(r.active_offer),
          simulated: unbool(r.simulated),
        }
      : null;

  assets = {
    list: async (tenantId: TenantId) =>
      (
        await this.query('SELECT * FROM assets WHERE tenant_id = ? ORDER BY sort_order, asset_id', [tenantId])
      ).map((r) => this.toAsset(r) as MarketAsset),

    get: async (tenantId: TenantId, id: string) =>
      this.toAsset(
        await this.one('SELECT * FROM assets WHERE tenant_id = ? AND asset_id = ?', [tenantId, id]),
      ),

    /**
     * Single-statement compare-and-swap, scoped to the tenant. The
     * `quantity > 0` predicate is the double-spend guard; the `tenant_id`
     * predicate means one tenant cannot liquidate another's inventory even by
     * guessing an asset id.
     */
    liquidate: async (tenantId: TenantId, id: string): Promise<LiquidationResult | null> => {
      const before = await this.assets.get(tenantId, id);
      if (!before || before.quantity <= 0) return null;

      const rows = await this.query(
        `UPDATE assets SET quantity = 0, active_offer = NULL
         WHERE tenant_id = ? AND asset_id = ? AND quantity > 0
         RETURNING *`,
        [tenantId, id],
      );
      if (rows.length === 0) return null;

      const after = this.toAsset(rows[0]) as MarketAsset;
      return {
        asset: after,
        quantity: before.quantity,
        unitPrice: before.active_offer ?? before.current_price,
      };
    },
  };

  // ----------------------------------------------------------------- trades
  private toTrade = (r: Row): TradeRecord => ({
    id: r.id,
    asset_id: r.asset_id,
    action: r.action,
    quantity: num(r.quantity),
    unit_price: num(r.unit_price),
    realized_net_per_unit: num(r.realized_net_per_unit),
    realized_net_total: num(r.realized_net_total),
    executedBy: r.executed_by,
    executedById: r.executed_by_id,
    timestamp: r.timestamp,
    simulated: unbool(r.simulated),
  });

  trades = {
    record: async (tenantId: TenantId, trade: TradeRecord) => {
      await this.exec(
        `INSERT INTO trades
           (id, tenant_id, asset_id, action, quantity, unit_price, realized_net_per_unit,
            realized_net_total, executed_by, executed_by_id, timestamp, simulated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          trade.id,
          tenantId,
          trade.asset_id,
          trade.action,
          trade.quantity,
          trade.unit_price,
          trade.realized_net_per_unit,
          trade.realized_net_total,
          trade.executedBy,
          trade.executedById,
          trade.timestamp,
          bool(trade.simulated),
        ],
      );
      return trade;
    },

    list: async (tenantId: TenantId, limit = 100) =>
      (
        await this.query(
          'SELECT * FROM trades WHERE tenant_id = ? ORDER BY timestamp DESC, id DESC LIMIT ?',
          [tenantId, limit],
        )
      ).map(this.toTrade),
  };

  // ------------------------------------------------------------------ audit
  private toAudit = (r: Row): AuditEntry => ({
    seq: num(r.seq),
    id: r.id,
    timestamp: r.timestamp,
    event: r.event,
    actorId: r.actor_id ?? null,
    actorName: r.actor_name ?? null,
    actorRole: r.actor_role ?? null,
    subject: r.subject ?? null,
    outcome: r.outcome,
    detail: JSON.parse(r.detail || '{}'),
    prevHash: r.prev_hash,
    hash: r.hash,
  });

  /**
   * The chain append itself, WITHOUT taking a transaction.
   *
   * Split out because a caller that is already inside `transaction()` cannot
   * open a second one: SQLite rejects a nested BEGIN, and the in-process queue
   * that serialises transactions would deadlock waiting for the outer one to
   * finish. Anything that needs to write a record and its audit entry in a
   * single atomic unit — `commitCorrection`, for one — calls this instead.
   *
   * It is private, and it stays private. An append outside a lock can fork the
   * chain, and a forked chain is indistinguishable from tampering.
   */
  private async appendAuditLocked(tenantId: TenantId, entry: NewAuditEntry): Promise<AuditEntry> {
    const last = await this.one<{ seq: number; hash: string }>(
      'SELECT seq, hash FROM audit_log WHERE tenant_id = ? ORDER BY seq DESC LIMIT 1',
      [tenantId],
    );

    const seq = last ? num(last.seq) + 1 : 1;
    const prevHash = last ? last.hash : GENESIS_HASH;

    const base = {
      seq,
      id: `aud-${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      event: entry.event,
      actorId: entry.actorId,
      actorName: entry.actorName,
      actorRole: entry.actorRole,
      subject: entry.subject,
      outcome: entry.outcome,
      detail: entry.detail,
    };

    const hash = hashEntry(base, prevHash);

    await this.exec(
      `INSERT INTO audit_log
         (tenant_id, seq, id, timestamp, event, actor_id, actor_name, actor_role,
          subject, outcome, detail, prev_hash, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId,
        base.seq,
        base.id,
        base.timestamp,
        base.event,
        base.actorId,
        base.actorName,
        base.actorRole,
        base.subject,
        base.outcome,
        JSON.stringify(base.detail),
        prevHash,
        hash,
      ],
    );

    return { ...base, prevHash, hash };
  }

  audit = {
    /**
     * Appends inside a transaction holding an exclusive lock, because the
     * sequence number and previous hash must be read and committed without
     * another append interleaving. A gap or fork in the chain is
     * indistinguishable from tampering, so this path trades throughput for
     * correctness deliberately.
     *
     * Sequence numbers restart per tenant: each tenant owns an independently
     * verifiable chain, and a shared counter would leak other customers'
     * activity volume through the gaps in your own numbering.
     */
    append: async (tenantId: TenantId, entry: NewAuditEntry): Promise<AuditEntry> =>
      this.transaction(() => this.appendAuditLocked(tenantId, entry)),

    list: async (tenantId: TenantId, limit = 100) =>
      (
        await this.query('SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY seq DESC LIMIT ?', [
          tenantId,
          limit,
        ])
      ).map(this.toAudit),

    verify: async (tenantId: TenantId): Promise<ChainVerification> => {
      const rows = await this.query('SELECT * FROM audit_log WHERE tenant_id = ? ORDER BY seq ASC', [
        tenantId,
      ]);
      return verifyChain(rows.map(this.toAudit));
    },

    verifyAll: async () => {
      const tenants = await this.tenants.list();
      const broken: TenantId[] = [];
      for (const tenant of tenants) {
        const result = await this.audit.verify(tenant.id);
        if (!result.ok) broken.push(tenant.id);
      }
      return { ok: broken.length === 0, tenants: tenants.length, broken };
    },
  };

  // ----------------------------------------------------------------- orders
  private toOrder = (r: Row): Order => ({
    id: r.id,
    clientOrderId: r.client_order_id,
    assetId: r.symbol,
    side: r.side,
    quantity: num(r.quantity),
    type: r.order_type,
    limitPrice: r.limit_price === null || r.limit_price === undefined ? undefined : num(r.limit_price),
    timeInForce: r.time_in_force,
    reason: r.reason,
    status: r.status,
    marketplaceOrderId: r.venue_order_id ?? null,
    filledQuantity: num(r.filled_quantity),
    averageFillPrice: num(r.average_fill_price),
    feesPaid: num(r.fees_paid),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    actorId: r.actor_id ?? null,
    actorName: r.actor_name ?? null,
    marketplace: r.venue,
    mode: r.mode,
    rejectReason: r.reject_reason ?? null,
  });

  orders = {
    /**
     * Idempotent on clientOrderId within a tenant. The intent is written here
     * BEFORE the venue is contacted, so a timeout on `place()` leaves a durable
     * record to reconcile against instead of an unanswerable question.
     */
    create: async (tenantId: TenantId, order: Order) => {
      const existing = await this.orders.get(tenantId, order.clientOrderId);
      if (existing) return { order: existing, created: false };

      await this.exec(
        `INSERT INTO orders
           (id, tenant_id, client_order_id, symbol, side, quantity, order_type, limit_price,
            time_in_force, reason, status, venue_order_id, filled_quantity,
            average_fill_price, fees_paid, created_at, updated_at, actor_id,
            actor_name, venue, mode, reject_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          order.id,
          tenantId,
          order.clientOrderId,
          order.assetId,
          order.side,
          order.quantity,
          order.type,
          order.limitPrice ?? null,
          order.timeInForce,
          order.reason,
          order.status,
          order.marketplaceOrderId,
          order.filledQuantity,
          order.averageFillPrice,
          order.feesPaid,
          order.createdAt,
          order.updatedAt,
          order.actorId,
          order.actorName,
          order.marketplace,
          order.mode,
          order.rejectReason ?? null,
        ],
      );
      return { order, created: true };
    },

    get: async (tenantId: TenantId, clientOrderId: string) => {
      const row = await this.one('SELECT * FROM orders WHERE tenant_id = ? AND client_order_id = ?', [
        tenantId,
        clientOrderId,
      ]);
      return row ? this.toOrder(row) : null;
    },

    update: async (tenantId: TenantId, clientOrderId: string, patch: Partial<Order>) => {
      const existing = await this.orders.get(tenantId, clientOrderId);
      if (!existing) return null;

      const next: Order = { ...existing, ...patch, updatedAt: new Date().toISOString() };
      await this.exec(
        `UPDATE orders SET status = ?, venue_order_id = ?, filled_quantity = ?,
           average_fill_price = ?, fees_paid = ?, updated_at = ?, reject_reason = ?
         WHERE tenant_id = ? AND client_order_id = ?`,
        [
          next.status,
          next.marketplaceOrderId,
          next.filledQuantity,
          next.averageFillPrice,
          next.feesPaid,
          next.updatedAt,
          next.rejectReason ?? null,
          tenantId,
          clientOrderId,
        ],
      );
      return next;
    },

    list: async (tenantId: TenantId, limit = 200) =>
      (
        await this.query(
          'SELECT * FROM orders WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
          [tenantId, limit],
        )
      ).map(this.toOrder),

    open: async (tenantId: TenantId) =>
      (
        await this.query(
          `SELECT * FROM orders
           WHERE tenant_id = ? AND status NOT IN ('filled','cancelled','rejected','expired')
           ORDER BY created_at ASC`,
          [tenantId],
        )
      ).map(this.toOrder),
  };

  // ------------------------------------------------------------------ fills
  private toFill = (r: Row): Fill => ({
    id: r.id,
    clientOrderId: r.client_order_id,
    marketplaceFillId: r.venue_fill_id,
    assetId: r.symbol,
    side: r.side,
    quantity: num(r.quantity),
    price: num(r.price),
    fee: num(r.fee),
    timestamp: r.timestamp,
    receivedAt: r.received_at,
    sequence: r.sequence === null || r.sequence === undefined ? null : num(r.sequence),
  });

  fills = {
    /**
     * Idempotent on (tenant, marketplaceFillId). Reconciliation replays fills from a
     * cursor and the push and pull paths overlap, so the same fill WILL arrive
     * twice; counting it twice would silently double a position.
     */
    record: async (tenantId: TenantId, fill: Fill) => {
      const existing = await this.one('SELECT * FROM fills WHERE tenant_id = ? AND venue_fill_id = ?', [
        tenantId,
        fill.marketplaceFillId,
      ]);
      if (existing) return { fill: this.toFill(existing), created: false };

      await this.exec(
        `INSERT INTO fills
           (id, tenant_id, client_order_id, venue_fill_id, symbol, side, quantity, price, fee,
            timestamp, received_at, sequence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fill.id,
          tenantId,
          fill.clientOrderId,
          fill.marketplaceFillId,
          fill.assetId,
          fill.side,
          fill.quantity,
          fill.price,
          fill.fee,
          fill.timestamp,
          fill.receivedAt,
          fill.sequence,
        ],
      );
      return { fill, created: true };
    },

    forOrder: async (tenantId: TenantId, clientOrderId: string) =>
      (
        await this.query('SELECT * FROM fills WHERE tenant_id = ? AND client_order_id = ?', [
          tenantId,
          clientOrderId,
        ])
      ).map(this.toFill),

    forAsset: async (tenantId: TenantId, assetId: string) =>
      (await this.query('SELECT * FROM fills WHERE tenant_id = ? AND symbol = ?', [tenantId, assetId])).map(
        this.toFill,
      ),

    list: async (tenantId: TenantId, limit = 200) =>
      (
        await this.query(
          'SELECT * FROM fills WHERE tenant_id = ? ORDER BY sequence DESC, received_at DESC LIMIT ?',
          [tenantId, limit],
        )
      ).map(this.toFill),

    notionalSince: async (tenantId: TenantId, isoTimestamp: string) => {
      const row = await this.one<{ total: number }>(
        `SELECT COALESCE(SUM(price * quantity), 0) AS total FROM fills
         WHERE tenant_id = ? AND received_at >= ?`,
        [tenantId, isoTimestamp],
      );
      return num(row?.total);
    },
  };


  // ---------------------------------------------------------------- invites
  private toInvite = (r: Row): Invite => ({
    id: r.id,
    codeHash: r.code_hash,
    label: r.label ?? null,
    createdAt: r.created_at,
    createdBy: r.created_by ?? null,
    maxUses: Number(r.max_uses),
    uses: Number(r.uses),
    expiresAt: r.expires_at ?? null,
    revokedAt: r.revoked_at ?? null,
    lastUsedAt: r.last_used_at ?? null,
    lastUsedBy: r.last_used_by ?? null,
  });

  invites = {
    create: async (invite: Invite) => {
      await this.exec(
        `INSERT INTO invites
           (id, code_hash, label, created_at, created_by, max_uses, uses, expires_at, revoked_at,
            last_used_at, last_used_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          invite.id,
          invite.codeHash,
          invite.label,
          invite.createdAt,
          invite.createdBy,
          invite.maxUses,
          invite.uses,
          invite.expiresAt,
          invite.revokedAt,
          invite.lastUsedAt,
          invite.lastUsedBy,
        ],
      );
      return invite;
    },

    /**
     * Compare-and-swap redemption.
     *
     * Every precondition lives in the WHERE clause, so the database decides in
     * one statement whether this redemption is the one that wins. Two people
     * pasting the same single-use code at the same instant produce exactly one
     * success — a read-then-write would produce two.
     *
     * The failure reason is derived afterwards, from a plain read, purely to
     * give the operator a useful audit entry. It is never the authority.
     */
    redeem: async (codeHash: string, email: string): Promise<RedeemResult> => {
      const now = new Date().toISOString();

      const changed = await this.execCount(
        `UPDATE invites
            SET uses = uses + 1, last_used_at = ?, last_used_by = ?
          WHERE code_hash = ?
            AND revoked_at IS NULL
            AND uses < max_uses
            AND (expires_at IS NULL OR expires_at > ?)`,
        [now, email, codeHash, now],
      );

      if (changed > 0) {
        const row = await this.one('SELECT * FROM invites WHERE code_hash = ?', [codeHash]);
        return { ok: true, invite: this.toInvite(row!) };
      }

      const row = await this.one('SELECT * FROM invites WHERE code_hash = ?', [codeHash]);
      if (!row) return { ok: false, reason: 'unknown_code' };

      const invite = this.toInvite(row);
      if (invite.revokedAt) return { ok: false, reason: 'revoked' };
      if (invite.expiresAt && invite.expiresAt <= now) return { ok: false, reason: 'expired' };
      return { ok: false, reason: 'exhausted' };
    },

    list: async (limit = 200) =>
      (await this.query('SELECT * FROM invites ORDER BY created_at DESC LIMIT ?', [limit])).map(
        this.toInvite,
      ),

    revoke: async (id: string) => {
      await this.exec('UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
        new Date().toISOString(),
        id,
      ]);
      const row = await this.one('SELECT * FROM invites WHERE id = ?', [id]);
      return row ? this.toInvite(row) : null;
    },

    countRedeemable: async () => {
      const now = new Date().toISOString();
      const row = await this.one<{ n: number | string }>(
        `SELECT COUNT(*) AS n FROM invites
          WHERE revoked_at IS NULL AND uses < max_uses AND (expires_at IS NULL OR expires_at > ?)`,
        [now],
      );
      return Number(row?.n ?? 0);
    },
  };

  // ------------------------------------------------------------------ usage
  private toUsage = (r: Row): AiUsage => ({
    tenantId: r.tenant_id,
    period: r.period,
    requests: Number(r.requests),
    inputTokens: Number(r.input_tokens),
    outputTokens: Number(r.output_tokens),
    costCents: num(r.cost_cents),
    updatedAt: r.updated_at,
  });

  usage = {
    get: async (tenantId: TenantId, period: string) => {
      const row = await this.one('SELECT * FROM ai_usage WHERE tenant_id = ? AND period = ?', [
        tenantId,
        period,
      ]);
      return row ? this.toUsage(row) : emptyUsage(tenantId, period);
    },

    /**
     * Additive upsert, in ONE statement.
     *
     * This was originally UPDATE-then-INSERT-if-nothing-changed, and the
     * concurrency test found the hole immediately: on the first call of a new
     * month, twenty simultaneous requests all see zero rows updated, all
     * attempt the INSERT, and nineteen die on the primary key. The tenant's
     * first minute of every month would have thrown.
     *
     * `ON CONFLICT ... DO UPDATE` closes it — the database resolves the race,
     * and the addition happens inside the same statement so no write is lost.
     * Both backends support this form.
     */
    record: async (tenantId: TenantId, period: string, delta: UsageDelta) => {
      const now = new Date().toISOString();
      const d = {
        requests: delta.requests ?? 0,
        inputTokens: delta.inputTokens ?? 0,
        outputTokens: delta.outputTokens ?? 0,
        costCents: delta.costCents ?? 0,
      };

      await this.exec(
        `INSERT INTO ai_usage
           (tenant_id, period, requests, input_tokens, output_tokens, cost_cents, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, period) DO UPDATE SET
           requests      = ai_usage.requests + excluded.requests,
           input_tokens  = ai_usage.input_tokens + excluded.input_tokens,
           output_tokens = ai_usage.output_tokens + excluded.output_tokens,
           cost_cents    = ai_usage.cost_cents + excluded.cost_cents,
           updated_at    = excluded.updated_at`,
        [tenantId, period, d.requests, d.inputTokens, d.outputTokens, d.costCents, now],
      );

      return this.usage.get(tenantId, period);
    },

    list: async (period: string) =>
      (await this.query('SELECT * FROM ai_usage WHERE period = ? ORDER BY cost_cents DESC', [period])).map(
        this.toUsage,
      ),
  };

  // ------------------------------------------------------------------- meta
  meta = {
    get: async (tenantId: TenantId, key: string) => {
      const row = await this.one<{ value: string }>(
        'SELECT value FROM meta WHERE tenant_id = ? AND key = ?',
        [tenantId, key],
      );
      return row ? row.value : null;
    },
    set: async (tenantId: TenantId, key: string, value: string) => {
      const existing = await this.meta.get(tenantId, key);
      if (existing === null) {
        await this.exec('INSERT INTO meta (tenant_id, key, value) VALUES (?, ?, ?)', [tenantId, key, value]);
      } else {
        await this.exec('UPDATE meta SET value = ? WHERE tenant_id = ? AND key = ?', [value, tenantId, key]);
      }
    },
  };

  // -------------------------------------------------------------- bootstrap
  bootstrap = {
    isEmpty: async (tenantId: TenantId) =>
      num(
        (
          await this.one<{ n: number }>('SELECT COUNT(*) AS n FROM twin_nodes WHERE tenant_id = ?', [
            tenantId,
          ])
        )?.n,
      ) === 0,

    seed: async (tenantId: TenantId, nodes: TwinNode[], assets: MarketAsset[]) => {
      for (const [i, n] of nodes.entries()) {
        await this.exec(
          `INSERT INTO twin_nodes
             (id, tenant_id, name, type, node_id, parent_hub, file_path, coordinates,
              connected_nodes, metrics, content, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            n.id,
            tenantId,
            n.name,
            n.type,
            n.node_id,
            n.parent_hub ?? null,
            n.filePath,
            n.coordinates ? JSON.stringify(n.coordinates) : null,
            JSON.stringify(n.connectedNodes ?? []),
            JSON.stringify(n.metrics ?? {}),
            n.content,
            i,
          ],
        );
      }

      for (const [i, a] of assets.entries()) {
        await this.exec(
          `INSERT INTO assets
             (asset_id, tenant_id, name, asset_class, acquisition_price, current_price, buy_fees,
              sell_fees, is_guaranteed, fundamentals_intact, quantity, active_offer,
              simulated, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            a.asset_id,
            tenantId,
            a.name,
            a.asset_class,
            a.acquisition_price,
            a.current_price,
            a.buy_fees,
            a.sell_fees,
            bool(a.is_guaranteed),
            bool(a.fundamentals_intact),
            a.quantity,
            a.active_offer ?? null,
            bool(a.simulated ?? true),
            i,
          ],
        );
      }
    },

    importUsers: async (users: UserRecord[]) => {
      for (const u of users) {
        if (await this.users.findByEmail(u.email)) continue;
        await this.users.create(u);
      }
    },

    importTrades: async (tenantId: TenantId, trades: TradeRecord[]) => {
      for (const t of trades) await this.trades.record(tenantId, t);
    },
  };

  // -------------------------------------------------------------- market
  /**
   * Inventory, listings and corrections.
   *
   * Everything here exists because the pure functions in `server/market` decide
   * correctly and then need somewhere to land atomically. A perfect decision
   * written non-atomically is not a control — it is a race with good manners.
   */
  private toPosition = (r: Row): InventoryPosition => ({
    participant: String(r.participant) as ParticipantId,
    sku: String(r.sku),
    kind: String(r.kind) as SkuKind,
    onHand: num(r.on_hand),
    committed: num(r.committed),
    delivered: num(r.delivered),
    periodStart: r.period_start === null || r.period_start === undefined ? null : num(r.period_start),
    periodEnd: r.period_end === null || r.period_end === undefined ? null : num(r.period_end),
    issuanceCap: r.issuance_cap === null || r.issuance_cap === undefined ? null : num(r.issuance_cap),
    issued: num(r.issued),
    updatedAt: num(r.updated_at),
  });

  /** Legs carry `bigint` amounts, which JSON refuses. Decimal strings round-trip exactly. */
  private static legsToJson = (legs: Leg[]): string =>
    JSON.stringify(legs.map((l) => ({ ...l, amount: l.amount.toString() })));

  private static legsFromJson = (raw: string): Leg[] =>
    (JSON.parse(raw) as { participant: string; account: string; amount: string; memo: string }[]).map((l) => ({
      participant: l.participant as ParticipantId,
      account: l.account,
      amount: BigInt(l.amount),
      memo: l.memo,
    }));

  market = {
    inventory: {
      get: async (tenantId: TenantId, participant: ParticipantId, sku: string): Promise<InventoryPosition | null> => {
        const row = await this.one(
          'SELECT * FROM market_inventory WHERE tenant_id = ? AND participant = ? AND sku = ?',
          [tenantId, participant, sku],
        );
        return row ? this.toPosition(row) : null;
      },

      listFor: async (tenantId: TenantId, participant: ParticipantId): Promise<InventoryPosition[]> =>
        (
          await this.query('SELECT * FROM market_inventory WHERE tenant_id = ? AND participant = ? ORDER BY sku', [
            tenantId,
            participant,
          ])
        ).map(this.toPosition),

      /** Declare or replace a position outright. Used at admission, not on the trade path. */
      put: async (tenantId: TenantId, position: InventoryPosition): Promise<void> => {
        await this.exec(
          `INSERT INTO market_inventory
             (tenant_id, participant, sku, kind, on_hand, committed, delivered,
              period_start, period_end, issuance_cap, issued, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, participant, sku) DO UPDATE SET
             kind = excluded.kind, on_hand = excluded.on_hand, committed = excluded.committed,
             delivered = excluded.delivered, period_start = excluded.period_start,
             period_end = excluded.period_end, issuance_cap = excluded.issuance_cap,
             issued = excluded.issued, updated_at = excluded.updated_at`,
          [
            tenantId, position.participant, position.sku, position.kind,
            position.onHand, position.committed, position.delivered,
            position.periodStart, position.periodEnd, position.issuanceCap,
            position.issued, position.updatedAt,
          ],
        );
      },

      /**
       * Compare-and-swap on `updated_at`.
       *
       * THIS IS THE CONTROL. `commit()` in inventory.ts decides that 30 of 100
       * units may be reserved; between that decision and this write, the
       * seller's other agent may have reserved 80. Writing unconditionally would
       * overwrite their reservation and oversell the seller — the exact failure
       * the whole module exists to prevent, reintroduced at the last step.
       *
       * Returns rows changed: 1 won, 0 means re-read and decide again.
       */
      save: async (tenantId: TenantId, position: InventoryPosition, expectedUpdatedAt: number): Promise<number> =>
        this.execCount(
          `UPDATE market_inventory
              SET kind = ?, on_hand = ?, committed = ?, delivered = ?,
                  period_start = ?, period_end = ?, issuance_cap = ?, issued = ?, updated_at = ?
            WHERE tenant_id = ? AND participant = ? AND sku = ? AND updated_at = ?`,
          [
            position.kind, position.onHand, position.committed, position.delivered,
            position.periodStart, position.periodEnd, position.issuanceCap, position.issued,
            position.updatedAt,
            tenantId, position.participant, position.sku, expectedUpdatedAt,
          ],
        ),
    },

    listings: {
      /** How many times this participant has listed this SKU. Feeds `requireAccounting`. */
      count: async (tenantId: TenantId, participant: ParticipantId, sku: string): Promise<number> =>
        num(
          (
            await this.one<{ listings: number }>(
              'SELECT listings FROM market_listings WHERE tenant_id = ? AND participant = ? AND sku = ?',
              [tenantId, participant, sku],
            )
          )?.listings,
        ),

      /** Additive upsert, never a read-modify-write: two concurrent listings both count. */
      record: async (tenantId: TenantId, participant: ParticipantId, sku: string, at: number): Promise<void> => {
        await this.exec(
          `INSERT INTO market_listings (tenant_id, participant, sku, listings, first_at, last_at)
           VALUES (?, ?, ?, 1, ?, ?)
           ON CONFLICT (tenant_id, participant, sku) DO UPDATE SET
             listings = market_listings.listings + 1,
             last_at  = excluded.last_at`,
          [tenantId, participant, sku, at, at],
        );
      },
    },

    corrections: {
      /**
       * Write a refund or an escrow release AND its audit entries in one
       * transaction, exactly once.
       *
       * `disputes.ts` produces the postings; nothing committed them, which meant
       * a refund existed as a correct calculation and never as money. This is
       * that gap closed.
       *
       * Idempotency is structural twice over: the select inside the transaction
       * catches the ordinary retry, and UNIQUE (tenant_id, trade_id, kind)
       * catches anything that reaches the insert by another route. Paying a
       * buyer their refund twice is not a rounding error.
       */
      commit: async (
        tenantId: TenantId,
        correction: CorrectionRecord,
        entries: NewAuditEntry[],
      ): Promise<'committed' | 'already_committed'> =>
        this.transaction(async () => {
          const existing = await this.one(
            'SELECT id FROM market_corrections WHERE tenant_id = ? AND trade_id = ? AND kind = ?',
            [tenantId, correction.tradeId, correction.kind],
          );
          if (existing) return 'already_committed' as const;

          await this.exec(
            `INSERT INTO market_corrections
               (tenant_id, id, trade_id, kind, legs, digest, reason, decided_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              tenantId, correction.id, correction.tradeId, correction.kind,
              SqlStore.legsToJson(correction.legs), correction.digest,
              correction.reason, correction.decidedBy, correction.createdAt,
            ],
          );

          // Inside the same transaction, so a correction cannot exist without
          // its audit trail and an audit entry cannot claim a correction that
          // rolled back.
          for (const entry of entries) await this.appendAuditLocked(tenantId, entry);

          return 'committed' as const;
        }),

      forTrade: async (tenantId: TenantId, tradeId: string): Promise<CorrectionRecord[]> =>
        (
          await this.query(
            'SELECT * FROM market_corrections WHERE tenant_id = ? AND trade_id = ? ORDER BY created_at ASC',
            [tenantId, tradeId],
          )
        ).map((r) => ({
          id: String(r.id),
          tradeId: String(r.trade_id),
          kind: String(r.kind) as CorrectionRecord['kind'],
          legs: SqlStore.legsFromJson(String(r.legs)),
          digest: String(r.digest),
          reason: String(r.reason),
          decidedBy: String(r.decided_by),
          createdAt: num(r.created_at),
        })),
    },
  };

  // -------------------------------------------------------- external keys
  private toExternalKey = (r: Row): ExternalKeyRecord => ({
    keyId: String(r.key_id),
    secretHash: String(r.secret_hash),
    tenantId: String(r.tenant_id),
    label: String(r.label),
    scopes: JSON.parse(String(r.scopes)) as Scope[],
    createdAt: num(r.created_at),
    expiresAt: r.expires_at === null || r.expires_at === undefined ? null : num(r.expires_at),
    revokedAt: r.revoked_at === null || r.revoked_at === undefined ? null : num(r.revoked_at),
    ratePerMinute: num(r.rate_per_minute),
  });

  externalKeys = {
    save: async (record: ExternalKeyRecord): Promise<void> => {
      await this.exec(
        `INSERT INTO external_keys
           (key_id, tenant_id, secret_hash, label, scopes, created_at, expires_at, revoked_at, rate_per_minute)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          record.keyId, record.tenantId, record.secretHash, record.label,
          JSON.stringify(record.scopes), record.createdAt, record.expiresAt,
          record.revokedAt, record.ratePerMinute,
        ],
      );
    },

    get: async (keyId: string): Promise<ExternalKeyRecord | null> => {
      const row = await this.one('SELECT * FROM external_keys WHERE key_id = ?', [keyId]);
      return row ? this.toExternalKey(row) : null;
    },

    listFor: async (tenantId: TenantId): Promise<ExternalKeyRecord[]> =>
      (await this.query('SELECT * FROM external_keys WHERE tenant_id = ? ORDER BY created_at DESC', [tenantId]))
        .map(this.toExternalKey),

    /** Revocation is immediate and one-way. Returns rows changed. */
    revoke: async (keyId: string, at: number): Promise<number> =>
      this.execCount('UPDATE external_keys SET revoked_at = ? WHERE key_id = ? AND revoked_at IS NULL', [at, keyId]),
  };
}
