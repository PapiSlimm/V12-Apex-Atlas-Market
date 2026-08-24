/**
 * Administrative API — invite minting.
 *
 * THE RISK, STATED PLAINLY
 * ------------------------
 * An endpoint that prints invite codes is the highest-value target on a free
 * beta: whoever reaches it issues themselves unlimited accounts against a real
 * inference budget. That is why the first version of the closed beta shipped
 * with a CLI and no endpoint at all.
 *
 * The endpoint now exists because it was asked for. It does not, therefore,
 * get to be a normal route. Everything below is the difference between "an
 * admin API" and "an admin API worth having":
 *
 *  1. **A dedicated secret, not a session role.** Roles are assigned to humans
 *     who get phished, share laptops and stay logged in. This token is not a
 *     login, is not in a cookie, cannot be replayed from a browser tab, and is
 *     rotated by changing one environment variable.
 *  2. **Absent by default.** With no `ADMIN_API_TOKEN` the routes are not
 *     mounted at all — a deployment that never configures one has no attack
 *     surface here, not a disabled one.
 *  3. **404, never 401.** A wrong token gets the same response as a route that
 *     does not exist. There is nothing to probe for and nothing to confirm.
 *  4. **A weak token refuses to boot.** A 12-character admin token is worse
 *     than none, because it produces the confidence of having one.
 *  5. **Rate limited far below anything legitimate.** Minting is a human
 *     action performed a handful of times a week.
 *  6. **Everything is audited**, including failures, with the caller's address.
 *     The hash chain makes the record tamper-evident.
 *  7. **Codes are returned exactly once.** The list endpoint never returns a
 *     code, because the store does not have one to return — only a hash.
 *  8. **Optional IP allowlist**, for deployments that can pin the operator.
 *
 * What none of that buys back: the token is a bearer credential, and anyone
 * holding it is an administrator. Keep it in a secret manager, not in `.env` on
 * a laptop, and rotate it when anyone with access leaves.
 */

import crypto from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import rateLimit from 'express-rate-limit';

import type { Store } from './store/types';
import { DEFAULT_TENANT_ID } from './store/tenancy';
import { currentPeriod, generateInviteCode, hashInviteCode, type Invite } from './store/beta';

/** Below this, a token is theatre. 32 hex chars is 128 bits. */
export const MIN_TOKEN_LENGTH = 32;

export interface AdminConfig {
  token: string | null;
  /** Empty means any address. Exact matches only — no CIDR, deliberately. */
  ipAllowlist: string[];
}

export function adminConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const token = env.ADMIN_API_TOKEN?.trim() || null;

  if (token && token.length < MIN_TOKEN_LENGTH) {
    // Refusing to boot is deliberate. Silently ignoring a short token would
    // leave an operator believing the API is protected when it is not; mounting
    // it anyway would be worse still.
    console.error(
      `[fatal] ADMIN_API_TOKEN must be at least ${MIN_TOKEN_LENGTH} characters. ` +
        `Generate one with: openssl rand -hex 32`,
    );
    process.exit(1);
  }

  return {
    token,
    ipAllowlist: (env.ADMIN_IP_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** `Authorization: Bearer …` or `X-Admin-Token: …`. Never a query parameter. */
function presentedToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();

  const direct = req.headers['x-admin-token'];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();

  // A token in a query string ends up in access logs, proxy logs, browser
  // history and referrer headers. It is not accepted, at all.
  return null;
}

/**
 * `getStore` rather than `store`.
 *
 * Routes are registered while the module evaluates; the store is created later,
 * during boot. Capturing the binding eagerly would capture `undefined` and every
 * admin call would fail at runtime with a null dereference — the kind of bug
 * that type-checks perfectly.
 */
export function createAdminRouter(getStore: () => Store, config: AdminConfig) {
  const store = new Proxy({} as Store, {
    get: (_t, prop) => (getStore() as unknown as Record<string | symbol, unknown>)[prop],
  });

  const limiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    // Keyed on the token rather than the IP: an operator behind a rotating
    // address is still one operator, and an attacker rotating addresses should
    // not get a fresh budget per address.
    keyGenerator: (req) => presentedToken(req) ?? req.ip ?? 'unknown',
    message: { error: 'Not found.' },
  });

  const audit = (req: Request, event: string, outcome: 'allowed' | 'refused', detail: Record<string, unknown>) =>
    store.audit
      .append(DEFAULT_TENANT_ID, {
        event,
        actorId: null,
        actorName: 'admin-api',
        actorRole: 'Platform Operator',
        subject: req.path,
        outcome,
        detail: { ...detail, ip: req.ip ?? null },
      })
      .catch((err) => console.error('[admin] audit append failed:', err));

  const authenticate: RequestHandler = (req, res, next) => {
    // Not mounted without a token, so this is belt and braces.
    if (!config.token) return res.status(404).json({ error: 'Not found.' });

    if (config.ipAllowlist.length > 0 && !config.ipAllowlist.includes(req.ip ?? '')) {
      void audit(req, 'admin.refused', 'refused', { reason: 'ip_not_allowlisted' });
      return res.status(404).json({ error: 'Not found.' });
    }

    const presented = presentedToken(req);
    if (!presented || !constantTimeEqual(presented, config.token)) {
      void audit(req, 'admin.refused', 'refused', { reason: 'bad_token' });
      // 404 rather than 401: a probe learns nothing, not even that the route
      // exists on this deployment.
      return res.status(404).json({ error: 'Not found.' });
    }

    next();
  };

  const wrap =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => {
      void fn(req, res).catch(next);
    };

  return {
    limiter,
    authenticate,

    /** POST /api/admin/invites — mint. The one place a plaintext code exists. */
    mint: wrap(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;

      const count = Math.min(50, Math.max(1, Number(body.count) || 1));
      const maxUses = Math.min(1000, Math.max(1, Number(body.maxUses) || 1));
      const expiresDays = Math.max(0, Number(body.expiresInDays) || 0);
      const label =
        typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 200) : null;

      const expiresAt =
        expiresDays > 0 ? new Date(Date.now() + expiresDays * 86_400_000).toISOString() : null;

      const codes: { id: string; code: string }[] = [];

      for (let i = 0; i < count; i++) {
        const code = generateInviteCode();
        const invite: Invite = {
          id: `inv-${crypto.randomUUID()}`,
          codeHash: hashInviteCode(code),
          label,
          createdAt: new Date().toISOString(),
          createdBy: 'admin-api',
          maxUses,
          uses: 0,
          expiresAt,
          revokedAt: null,
          lastUsedAt: null,
          lastUsedBy: null,
        };
        await store.invites.create(invite);
        codes.push({ id: invite.id, code });
      }

      // The audit entry records the ids and the label — never the codes. An
      // audit log that contains working credentials is a credential store.
      await audit(req, 'admin.invites.minted', 'allowed', {
        count,
        maxUses,
        expiresAt,
        label,
        ids: codes.map((c) => c.id),
      });

      res.status(201).json({
        invites: codes,
        maxUses,
        expiresAt,
        notice: 'These codes are shown once and are not recoverable. Store them now.',
      });
    }),

    /** GET /api/admin/invites — metadata only. Codes are not returnable. */
    list: wrap(async (req, res) => {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
      const invites = await store.invites.list(limit);
      const now = new Date().toISOString();

      res.json({
        redeemable: await store.invites.countRedeemable(),
        invites: invites.map((invite) => ({
          id: invite.id,
          label: invite.label,
          createdAt: invite.createdAt,
          createdBy: invite.createdBy,
          uses: invite.uses,
          maxUses: invite.maxUses,
          expiresAt: invite.expiresAt,
          revokedAt: invite.revokedAt,
          lastUsedAt: invite.lastUsedAt,
          lastUsedBy: invite.lastUsedBy,
          state: invite.revokedAt
            ? 'revoked'
            : invite.expiresAt && invite.expiresAt <= now
              ? 'expired'
              : invite.uses >= invite.maxUses
                ? 'used'
                : 'open',
          // Deliberately absent: `code`, `codeHash`. The first does not exist
          // any more; the second is a credential-equivalent for an offline
          // attacker and has no reason to leave the database.
        })),
      });
    }),

    /** POST /api/admin/invites/:id/revoke */
    revoke: wrap(async (req, res) => {
      const invite = await store.invites.revoke(req.params.id);

      if (!invite) {
        await audit(req, 'admin.invites.revoke', 'refused', { id: req.params.id, reason: 'not_found' });
        return res.status(404).json({ error: 'No invite with that id.' });
      }

      await audit(req, 'admin.invites.revoke', 'allowed', { id: invite.id, label: invite.label });
      res.json({ id: invite.id, revokedAt: invite.revokedAt, label: invite.label });
    }),

    /** GET /api/admin/usage — inference spend for a period. */
    usage: wrap(async (req, res) => {
      const period = typeof req.query.period === 'string' ? req.query.period : currentPeriod();
      const rows = await store.usage.list(period);

      const tenants = await Promise.all(
        rows.map(async (row) => {
          const tenant = await store.tenants.get(row.tenantId as never);
          return {
            tenantId: row.tenantId,
            name: tenant?.name ?? null,
            plan: tenant?.plan ?? null,
            requests: row.requests,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            costCents: row.costCents,
            creditCents: tenant?.monthlyAiCreditCents ?? 0,
          };
        }),
      );

      res.json({
        period,
        totalCostCents: rows.reduce((n, r) => n + r.costCents, 0),
        tenants,
      });
    }),
  };
}
