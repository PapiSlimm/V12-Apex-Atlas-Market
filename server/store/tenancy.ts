/**
 * Tenancy model.
 *
 * DESIGN DECISIONS (made, not asked — overrule any of these and I'll change it)
 * ────────────────────────────────────────────────────────────────────────────
 *
 * **Shared schema with a `tenant_id` column**, not schema-per-tenant or
 * database-per-tenant. Shared schema is the right default here: it keeps
 * migrations to one operation, keeps the Enterprise self-hosted build identical
 * to the cloud build, and scales to thousands of tenants without a connection
 * pool per customer. Customers who genuinely cannot share a database get the
 * self-hosted edition, which is a single-tenant deployment of the same code.
 *
 * **Isolation is enforced by the type system, not by discipline.** Every scoped
 * store method takes `TenantId` as its first parameter. There is no overload
 * that omits it. A route that forgets to scope a query does not leak data — it
 * fails to compile. This is the whole reason to do tenancy at the store layer
 * rather than by adding `WHERE tenant_id = ?` at call sites and hoping.
 *
 * **The tenant is derived from the session, never from the request.** A
 * `tenantId` in a request body is an attacker's field. It is not read anywhere.
 *
 * **One audit chain per tenant.** A global chain would mean a tenant verifying
 * their own history needs entries belonging to other tenants, and the sequence
 * numbers would leak other customers' activity volume. Per-tenant chains are
 * independently verifiable and leak nothing.
 *
 * **One user belongs to one tenant.** Multi-org membership is a real
 * requirement eventually, but it changes the session model (which org am I
 * acting as?) and the UI. Deferred deliberately; the schema puts the
 * relationship on the user row so it can become a join table later without
 * touching anything that reads it.
 */

/** Branded so a bare string cannot be passed where a tenant is required. */
export type TenantId = string & { readonly __brand: 'TenantId' };

export const asTenantId = (id: string): TenantId => id as TenantId;

/** The tenant every pre-tenancy row is migrated into. */
export const DEFAULT_TENANT_ID = asTenantId('tnt-default');
export const DEFAULT_TENANT_SLUG = 'default';

export type TenantPlan = 'explorer' | 'professional' | 'business' | 'enterprise' | 'enterprise_plus';

export type TenantStatus = 'active' | 'suspended' | 'closed';

export interface Tenant {
  id: TenantId;
  /** URL-safe identifier, unique. */
  slug: string;
  name: string;
  plan: TenantPlan;
  status: TenantStatus;
  /** Seats the plan entitles. Enforced on user creation. */
  seatLimit: number;
  /**
   * Included model spend per month, in cents, across the whole tenant.
   * Enforced server-side — the entire point of metering is that it refuses,
   * not that it warns.
   */
  monthlyAiCreditCents: number;
  /**
   * Whether this tenant may write to the asset ledger.
   *
   * This used to be `tradingEnabled`, and it used to be OFF for the free and
   * $49 tiers. That gate came from a pricing model built around a financial
   * execution platform's liability profile — a product this never was. The
   * consequence was that a paying Professional customer was refused the
   * application's central workflow with a 402 citing "trade execution", a
   * capability the product does not have.
   *
   * The mechanism is kept, because entitlements enforced server-side in the one
   * place they are consumed is the right shape. The defaults are corrected: the
   * ledger books a customer's own inventory, so nothing about it is
   * risk-gated. Scale is gated instead, by seats and inference credit, which
   * is where the cost actually is.
   */
  assetLedgerEnabled: boolean;
  createdAt: string;
}

/**
 * Plan defaults. These mirror PRICING.md; the numbers live here so the server
 * enforces the same limits the price list advertises rather than drifting from
 * it.
 */
export const PLAN_DEFAULTS: Record<TenantPlan, Pick<Tenant, 'seatLimit' | 'monthlyAiCreditCents' | 'assetLedgerEnabled'>> = {
  explorer: { seatLimit: 1, monthlyAiCreditCents: 200, assetLedgerEnabled: true },
  professional: { seatLimit: 5, monthlyAiCreditCents: 1_500, assetLedgerEnabled: true },
  business: { seatLimit: 50, monthlyAiCreditCents: 3_000, assetLedgerEnabled: true },
  enterprise: { seatLimit: 100_000, monthlyAiCreditCents: 5_000, assetLedgerEnabled: true },
  enterprise_plus: { seatLimit: 1_000_000, monthlyAiCreditCents: 100_000, assetLedgerEnabled: true },
};

export const isPlan = (value: unknown): value is TenantPlan =>
  typeof value === 'string' && value in PLAN_DEFAULTS;

/**
 * Platform-level roles sit outside tenancy. A `Platform Operator` administers
 * the deployment; every other role is scoped to one tenant. Keeping these
 * separate stops a tenant admin from ever being able to escalate into
 * cross-tenant visibility, because the capability simply is not on their role.
 */
export type PlatformRole = 'Platform Operator';

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'tenant'
  );
}
