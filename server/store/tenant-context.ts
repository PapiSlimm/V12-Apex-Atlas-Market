/**
 * Which tenant the current unit of work belongs to, carried through the async
 * call stack rather than threaded through every signature.
 *
 * WHY THIS EXISTS
 * ---------------
 * `SqlStore` already scopes every query by putting `tenant_id = ?` in the WHERE
 * clause, and no method signature permits reading a scoped table without a
 * tenant. That is a good control and it protects exactly one thing: code that
 * goes through `SqlStore`. It does nothing for a migration script, an analytics
 * job, a psql session, a future ORM, or an SQL injection that reaches the
 * driver.
 *
 * Postgres row-level security moves the boundary from "the code is careful" to
 * "the database refuses" — but only if the connection says who it is acting
 * for. That is what this file carries.
 *
 * WHY AsyncLocalStorage AND NOT A PARAMETER
 * -----------------------------------------
 * The alternative is threading a connection or a tenant through fifty method
 * signatures and every call site. Every one of those is a place someone can
 * forget, and a control you can forget is a control you do not have. One
 * middleware establishes the scope for a whole request, and every query issued
 * beneath it inherits it whether its author thought about RLS or not.
 *
 * THE SYSTEM SCOPE, AND ITS HONEST COST
 * ------------------------------------
 * Some work legitimately has no tenant: creating the first tenant, running the
 * schema, verifying every chain for a health check. `runAsSystem` marks those,
 * and the RLS policies admit it.
 *
 * That IS a bypass, and pretending otherwise would be worse than having it. The
 * limit on the damage is what may run inside one: `runAsSystem` is for
 * boot-time and operator paths that take no user input. Anything reachable from
 * a request runs under `runWithTenant`, where the database — not the query
 * author — decides which rows exist.
 */

import { AsyncLocalStorage } from 'async_hooks';

export type Scope = { kind: 'tenant'; tenantId: string } | { kind: 'system'; reason: string };

const storage = new AsyncLocalStorage<Scope>();

/**
 * Run `fn` scoped to one tenant. Every query beneath it — however deep, however
 * many awaits later — is issued with that tenant set on the connection.
 */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return storage.run({ kind: 'tenant', tenantId }, fn);
}

/**
 * Run `fn` with no tenant restriction.
 *
 * `reason` is mandatory and is not decoration: it is what someone reads when
 * they are working out why a query saw every tenant's rows. A system scope with
 * no stated reason is a bypass nobody has to justify.
 */
export function runAsSystem<T>(reason: string, fn: () => T): T {
  return storage.run({ kind: 'system', reason }, fn);
}

/** The scope in force, or null outside any. */
export function currentScope(): Scope | null {
  return storage.getStore() ?? null;
}

/**
 * What to set on the connection, or null when nothing should be.
 *
 * Absent scope yields null rather than a permissive default. Under RLS an unset
 * setting matches no tenant, so an unscoped query returns NOTHING rather than
 * everything — the failure falls in the safe direction, which is the whole
 * reason to prefer a missing setting over a wildcard one.
 */
export function scopeSettings(): { tenantId: string; system: boolean } | null {
  const scope = currentScope();
  if (!scope) return null;
  return scope.kind === 'tenant' ? { tenantId: scope.tenantId, system: false } : { tenantId: '', system: true };
}
