/**
 * The external integration API — `/api/v1/*`.
 *
 * A stable, versioned, documented surface any external application can build
 * against. Deliberately separate from `/api/ecosystem/*` (V12 members, Ed25519,
 * relayed through a broker) and from the console's own routes (session
 * cookies). Three audiences, three auth mechanisms, three blast radii.
 *
 * WHAT MAKES IT SAFE TO POINT A STRANGER AT
 * -----------------------------------------
 *   - Every route is read-only. There is no external write path, and adding one
 *     is a decision made per route with the same question each time: what
 *     happens when this integrator is compromised?
 *   - Every response passes the constitutional engine before it is sent, so an
 *     external caller cannot obtain something an internal agent could not.
 *   - Every response carries the same envelope, so a client can be written once.
 *   - Errors never distinguish "no such tenant" from "not your tenant".
 *
 * VERSIONING IS A PROMISE
 * -----------------------
 * `/api/v1` will not change shape. Fields may be ADDED; nothing is removed or
 * retyped. A breaking change is `/api/v2` served alongside. That promise is
 * cheap to make now and impossible to retrofit after the first integrator.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { RateLimiter, verifyKey, type ExternalKeyRecord, type KeyLookup, type Scope } from './keys';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      externalKey?: ExternalKeyRecord;
    }
  }
}

/** Every response, success or failure, has this shape. */
export interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
  meta: { version: 'v1'; requestId: string; at: string };
}

export interface ExternalDeps {
  lookupKey: KeyLookup;
  audit: (event: {
    event: string;
    keyId: string | null;
    tenantId: string | null;
    outcome: 'allowed' | 'refused';
    detail: Record<string, unknown>;
  }) => void;
  /** Read models. Each is tenant-scoped by its first argument, without exception. */
  inventory: (tenantId: string) => Promise<unknown>;
  twin: (tenantId: string) => Promise<unknown>;
  valuation: (tenantId: string) => Promise<unknown>;
  auditTrail: (tenantId: string, limit: number) => Promise<unknown>;
  /**
   * The constitutional gate. Returns null when permitted, or a reason when not.
   * Injected rather than imported so this router cannot be mounted without one.
   */
  constitutionalGate: (args: { tenantId: string; keyId: string; route: string }) => { permitted: boolean; reason?: string };
}

const newRequestId = (): string => `req_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

function envelope<T>(requestId: string, data?: T, error?: { code: string; message: string }): Envelope<T> {
  return { ok: !error, data, error, meta: { version: 'v1', requestId, at: new Date().toISOString() } };
}

export function createExternalRouter(deps: ExternalDeps) {
  const limiter = new RateLimiter();

  const authenticate =
    (required: Scope[]): RequestHandler =>
    async (req, res, next) => {
      const requestId = newRequestId();
      res.locals.requestId = requestId;
      res.setHeader('x-apex-request-id', requestId);

      const verdict = await verifyKey(req.header('authorization'), deps.lookupKey, required);

      if (!verdict.ok) {
        deps.audit({
          event: 'external.refused',
          keyId: null,
          tenantId: null,
          outcome: 'refused',
          detail: { reason: verdict.reason, route: req.path, ip: req.ip ?? null },
        });
        // One status and one message for every authentication failure.
        // Distinguishing "unknown key" from "wrong secret" is an oracle for
        // enumerating issued keys. Insufficient scope IS distinguished, because
        // the caller is already authenticated and cannot learn anything by it —
        // and because "you need inventory:read" is the single most useful error
        // an integrator can receive.
        if (verdict.reason === 'insufficient_scope') {
          return res
            .status(403)
            .json(envelope(requestId, undefined, {
              code: 'insufficient_scope',
              message: `This key does not carry the required scope: ${required.join(', ')}.`,
            }));
        }
        return res
          .status(401)
          .json(envelope(requestId, undefined, { code: 'unauthorised', message: 'Invalid or missing API key.' }));
      }

      const rate = limiter.check(verdict.record.keyId, verdict.record.ratePerMinute);
      res.setHeader('x-ratelimit-limit', String(verdict.record.ratePerMinute));
      res.setHeader('x-ratelimit-remaining', String(rate.remaining));

      if (!rate.allowed) {
        res.setHeader('retry-after', String(Math.ceil(rate.retryAfterMs / 1000)));
        deps.audit({
          event: 'external.rate_limited',
          keyId: verdict.record.keyId,
          tenantId: verdict.record.tenantId,
          outcome: 'refused',
          detail: { route: req.path },
        });
        return res
          .status(429)
          .json(envelope(requestId, undefined, { code: 'rate_limited', message: 'Rate limit exceeded for this key.' }));
      }

      // The Constitution applies to external callers exactly as it applies to
      // internal agents. An external integration must not be a way around a
      // halt, a tenant quarantine, or a sanction.
      const gate = deps.constitutionalGate({
        tenantId: verdict.record.tenantId,
        keyId: verdict.record.keyId,
        route: req.path,
      });
      if (!gate.permitted) {
        deps.audit({
          event: 'external.constitutionally_refused',
          keyId: verdict.record.keyId,
          tenantId: verdict.record.tenantId,
          outcome: 'refused',
          detail: { route: req.path, reason: gate.reason ?? null },
        });
        return res
          .status(451)
          .json(envelope(requestId, undefined, {
            code: 'constitutionally_refused',
            message: gate.reason ?? 'Refused under V12-CONST-001.',
          }));
      }

      req.externalKey = verdict.record;
      next();
    };

  const wrap =
    (event: string, fn: (req: Request) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => {
      const requestId = String(res.locals.requestId ?? newRequestId());
      fn(req)
        .then((data) => {
          deps.audit({
            event,
            keyId: req.externalKey!.keyId,
            tenantId: req.externalKey!.tenantId,
            outcome: 'allowed',
            detail: { route: req.path },
          });
          res.json(envelope(requestId, data));
        })
        .catch(next);
    };

  return {
    authenticate,

    /**
     * Unauthenticated. Says the API is alive and what version it speaks, and
     * nothing else — no tenant counts, no key counts, no estate topology.
     */
    meta: (_req: Request, res: Response) => {
      res.json(
        envelope(newRequestId(), {
          service: 'v12-apex-atlas',
          api: 'v1',
          documentation: '/api/v1/openapi.json',
          scopes: ['inventory:read', 'twin:read', 'valuation:read', 'audit:read', 'webhook:receive'],
          authentication: 'Authorization: Bearer apex_<keyId>_<secret>',
        }),
      );
    },

    inventory: wrap('external.inventory', (req) => deps.inventory(req.externalKey!.tenantId)),
    twin: wrap('external.twin', (req) => deps.twin(req.externalKey!.tenantId)),
    valuation: wrap('external.valuation', (req) => deps.valuation(req.externalKey!.tenantId)),
    auditTrail: wrap('external.audit', (req) => {
      // Bounded server-side. A client asking for a million rows gets 500, not a
      // million rows and a timeout.
      const requested = Number(req.query.limit);
      const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 500) : 100;
      return deps.auditTrail(req.externalKey!.tenantId, limit);
    }),
  };
}

/**
 * Mount points. Kept in one place so the surface can be read at a glance —
 * anyone reviewing what a stranger can reach should not have to grep.
 */
export const EXTERNAL_ROUTES = [
  { method: 'GET', path: '/api/v1', scope: null, description: 'Service metadata. Unauthenticated.' },
  { method: 'GET', path: '/api/v1/inventory', scope: 'inventory:read', description: 'Media asset holdings and acquisition cost.' },
  { method: 'GET', path: '/api/v1/twin', scope: 'twin:read', description: 'Production and logistics graph.' },
  { method: 'GET', path: '/api/v1/valuation', scope: 'valuation:read', description: 'Mandate verdicts per asset.' },
  { method: 'GET', path: '/api/v1/audit', scope: 'audit:read', description: 'Hash-chained decision record. `?limit=1..500`.' },
] as const;
