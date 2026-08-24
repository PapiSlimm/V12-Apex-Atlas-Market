/**
 * V12 Apex Atlas — API + static host
 *
 * Security posture:
 *  - Session tokens live in an httpOnly, SameSite=Strict cookie, unreadable by
 *    page scripts.
 *  - Every mutating route is authenticated, role-checked and CSRF-protected.
 *  - Every settlement re-runs the Hermes engine server-side against server-held
 *    state, and liquidation is a compare-and-swap so concurrent requests cannot
 *    sell the same inventory twice.
 *  - Every execution decision — allowed or refused — is appended to a
 *    hash-chained audit log.
 */

import express, { type NextFunction, type Request, type Response } from 'express';
import path from 'path';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { GoogleGenAI } from '@google/genai';

import {
  createStore,
  createTenant,
  initialiseStore,
  DEFAULT_TENANT_ID,
  isPlan,
  asTenantId,
  type Store,
  type Tenant,
  type TenantId,
  type UserRecord,
  type UserRole,
} from './server/store';
import { authoriseSell, evaluateAsset } from './server/hermes';
import { buildGraph, fundamentalsIntact, valueEcosystem, SPEC_MANDATE, type FeeTable } from './server/twin';
import {
  assessCredit,
  currentPeriod,
  estimateCostCents,
  hashInviteCode,
  normaliseInviteCode,
  ratesFromEnv,
} from './server/store/beta';
import { csrfProtection, issueCsrfToken, clearCsrfToken } from './server/csrf';
import { serveSandbox } from './server/sandbox';
import { adminConfigFromEnv, createAdminRouter } from './server/admin';
import { createEcosystemRoutes, ecosystemConfigFromEnv } from './server/ecosystem';
import { createExternalRouter, EXTERNAL_ROUTES } from './server/external/router';
import { runAsSystem, runWithTenant } from './server/store/tenant-context';
import { bootConstitution, type BootedConstitution } from './server/constitution';
import {
  ExecutionService,
  plan as planExecution,
  startAssetRuntime,
  unrealisedPnl,
  round,
  type AssetSpec,
  type Position,
  type Quote,
  type AssetRuntime,
} from './server/assets';

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

/** V12-CONST-001. Assigned at boot; the process does not start without it. */
let constitution: BootedConstitution;
const COOKIE_NAME = 'apex_session';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

let store: Store;
let defaultTenant!: Tenant;

/**
 * Multi-tenant signup is opt-in. The self-hosted and desktop editions run
 * single-tenant: everyone lands in the default organisation and the tenancy
 * machinery costs them one column. Cloud sets MULTI_TENANT=true.
 */
const MULTI_TENANT = process.env.MULTI_TENANT === 'true';

/**
 * Closed-beta controls.
 *
 * Two independent gates, and the order matters: a valid invite is checked
 * first, then the population cap. The cap is deliberately NOT satisfied by
 * holding a valid code — an operator who over-issues invites still cannot
 * exceed the number of accounts they decided to support. Belt and braces,
 * because the failure mode is an inference bill rather than an error page.
 */
const INVITE_ONLY = process.env.INVITE_ONLY === 'true';

/** 0 disables the cap. Any positive number is a hard ceiling on tenants. */
const BETA_MAX_TENANTS = Math.max(0, Number(process.env.BETA_MAX_TENANTS) || 0);

/** Token cost rates, from the operator's own price list. See server/store/beta.ts. */
const AI_RATES = ratesFromEnv();

/**
 * Administrative API configuration.
 *
 * Read at module load so a short token stops the boot rather than being
 * discovered later. `token: null` means the routes are never mounted — see
 * server/admin.ts for why that is stronger than mounting them disabled.
 */
const ADMIN = adminConfigFromEnv();

/**
 * Orion ecosystem membership.
 *
 * `orionSecret: null` means the inbound relay surface is not mounted at all —
 * an app that is not part of an ecosystem should not be listening for one.
 */
const ECOSYSTEM = ecosystemConfigFromEnv();

/**
 * Read-only public endpoints have no session, so they serve the default
 * tenant. In multi-tenant mode that is the demo book, never a customer's.
 */
const publicTenant = (req: Request): TenantId => req.user?.tenantId ?? DEFAULT_TENANT_ID;

/**
 * One asset runtime per tenant, created on demand.
 *
 * Tenants never share a marketplace instance or a book. Two tenants settling
 * against one shared order book would make the isolation tests pass for the
 * wrong reason. The registry makes the separation structural rather than
 * aspirational.
 */
const runtimes = new Map<string, AssetRuntime>();
const runtimeLocks = new Map<string, Promise<AssetRuntime>>();

async function runtimeFor(tenantId: TenantId): Promise<AssetRuntime> {
  const existing = runtimes.get(tenantId);
  if (existing) return existing;

  // Two concurrent requests for a cold tenant must not build two runtimes —
  // that would mean two reconciliations racing over the same book.
  const pending = runtimeLocks.get(tenantId);
  if (pending) return pending;

  /*
   * Scoped explicitly, because this one does not inherit a request's scope.
   *
   * A runtime is built lazily and also at boot, and its reconciliation writes
   * cursors to `meta`. Started outside a scope it runs on an unscoped
   * connection, which under RLS means every write is refused — which is exactly
   * what happened the first time RLS was switched on here, loudly and at boot.
   * That is the failure mode working: the alternative was writing another
   * tenant's rows quietly.
   */
  const building = runWithTenant(tenantId, () => startAssetRuntime(store, tenantId))
    .then((runtime) => {
      runtimes.set(tenantId, runtime);
      runtimeLocks.delete(tenantId);
      return runtime;
    })
    .catch((err) => {
      runtimeLocks.delete(tenantId);
      throw err;
    });

  runtimeLocks.set(tenantId, building);
  return building;
}

/** Wrap the strategy so a bad asset spec cannot take down the state endpoint. */
function planFor(instrument: AssetSpec, position: Position, quote: Quote | null) {
  try {
    return planExecution(instrument, position, quote);
  } catch (err) {
    return {
      action: 'hold' as const,
      reason: `Strategy error: ${err instanceof Error ? err.message : String(err)}`,
      zeroLossSatisfied: false,
      diagnostics: {},
    };
  }
}

// --------------------------------------------------------------------------
// Secrets
// --------------------------------------------------------------------------
const JWT_SECRET = (() => {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  if (IS_PROD) {
    console.error('[fatal] JWT_SECRET must be set to a random string of at least 32 characters.');
    process.exit(1);
  }
  console.warn('[warn] JWT_SECRET not set. Using an ephemeral dev secret; sessions reset on restart.');
  return crypto.randomBytes(48).toString('hex');
})();

// --------------------------------------------------------------------------
// Middleware
// --------------------------------------------------------------------------
app.set('trust proxy', 1);
app.disable('x-powered-by');

// The sandbox route sets its own, much stricter, CSP — it must be mounted
// before helmet so helmet's app-wide policy does not overwrite it.
app.get('/repl-sandbox', serveSandbox(IS_PROD));

// Served before the SPA fallback, which would otherwise return index.html for
// /robots.txt and tell crawlers nothing.
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // No 'unsafe-eval' in production. Moving artifact execution into the
        // sandboxed iframe removed the last `new Function` call from this
        // origin — Babel only parses and prints, it does not evaluate. The one
        // document that can eval is now the opaque-origin sandbox, which has no
        // cookies, no storage and no network. Vite's dev server needs eval for
        // HMR, so it stays allowed in development only.
        scriptSrc: IS_PROD ? ["'self'"] : ["'self'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        frameSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

/**
 * Establish the database tenant scope for the whole request.
 *
 * ONE PLACE, DELIBERATELY. Under Postgres row-level security every scoped query
 * must be issued with `apex.tenant_id` set on the connection, and the
 * alternative to this middleware is remembering to do it at fifty call sites.
 * A control you can forget is a control you do not have — so it is established
 * here, before any route runs, and every query beneath it inherits the scope
 * whether its author thought about RLS or not.
 *
 * The token is read the same way `optionalAuth` reads it. An anonymous visitor,
 * an expired session and a malformed cookie all land on the default tenant,
 * which is the same tenant those requests were already being served from — this
 * changes where isolation is ENFORCED, not who sees what.
 *
 * On SQLite this costs one JWT verification and nothing else: there is no RLS
 * to honour, and the scope is simply unread.
 */
app.use((req: Request, _res: Response, next: NextFunction) => {
  let tenantId: string = DEFAULT_TENANT_ID;
  const token = readToken(req);
  if (token) {
    try {
      tenantId = (jwt.verify(token, JWT_SECRET) as SessionClaims).tenantId;
    } catch {
      // An invalid token is an anonymous visitor, not an error. The route layer
      // decides whether anonymous is allowed; this only decides which rows the
      // database will admit exist.
    }
  }
  runWithTenant(tenantId, next);
});

app.use(csrfProtection);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts. Try again in 15 minutes.' },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Model request rate limit exceeded. Slow down.' },
});

const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 60 });

/** Wraps async handlers so a rejected promise reaches the error middleware. */
const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    void fn(req, res, next).catch(next);
  };

// --------------------------------------------------------------------------
// Gemini client
// --------------------------------------------------------------------------
let ai: GoogleGenAI | null = null;
const hasApiKey = () => Boolean(process.env.GEMINI_API_KEY);

function getGenAI(): GoogleGenAI {
  if (!ai) {
    ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY || 'unset',
      httpOptions: { headers: { 'User-Agent': 'v12-apex-atlas' } },
    });
  }
  return ai;
}

// --------------------------------------------------------------------------
// Auth
// --------------------------------------------------------------------------
interface SessionClaims {
  id: string;
  /**
   * The tenant is carried in the SESSION, never read from the request. A
   * tenantId in a request body is an attacker's field; this one is signed.
   */
  tenantId: TenantId;
  email: string;
  name: string;
  role: UserRole;
}

/** The only sanctioned way to obtain a tenant for a request. */
const tenantOf = (req: Request): TenantId => req.user!.tenantId;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionClaims;
    }
  }
}

const publicUser = (u: UserRecord) => ({
  id: u.id,
  tenantId: u.tenantId,
  email: u.email,
  name: u.name,
  role: u.role,
  createdAt: u.createdAt,
});

function issueSession(res: Response, user: UserRecord): void {
  const claims: SessionClaims = {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    name: user.name,
    role: user.role,
  };
  const token = jwt.sign(claims, JWT_SECRET, { expiresIn: '12h' });

  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'strict',
    maxAge: 12 * 60 * 60 * 1000,
    path: '/',
  });

  issueCsrfToken(res, IS_PROD);
}

function readToken(req: Request): string | undefined {
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : undefined;
  return (req.cookies?.[COOKIE_NAME] as string | undefined) || bearer;
}

function authenticate(req: Request, res: Response, next: NextFunction) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: 'Authentication required.' });

  try {
    req.user = jwt.verify(token, JWT_SECRET) as SessionClaims;
    next();
  } catch {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    clearCsrfToken(res);
    return res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
  }
}

/**
 * Populates `req.user` when a valid session exists, but does not require one.
 *
 * This exists because of a real cross-tenant read. Routes like
 * `/api/execution/state` are deliberately unauthenticated so a signed-out
 * visitor can see the demo book — but they resolved their tenant via
 * `req.user?.tenantId ?? DEFAULT_TENANT_ID`, and with no auth middleware
 * `req.user` was ALWAYS undefined. A signed-in customer with a perfectly valid
 * cookie was therefore served the default organisation's positions, orders and
 * vault instead of their own.
 *
 * "Optional" must mean "read it if present", not "never read it".
 */
function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = readToken(req);
  if (!token) return next();
  try {
    req.user = jwt.verify(token, JWT_SECRET) as SessionClaims;
  } catch {
    // An invalid token on a public route is simply an anonymous visitor.
  }
  next();
}

function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    if (!roles.includes(req.user.role)) {
      // A refused privileged action is worth recording even though it changed
      // nothing — repeated refusals are the signal, not the noise.
      void store.audit
        .append(req.user.tenantId, {
          event: 'authz.denied',
          actorId: req.user.id,
          actorName: req.user.name,
          actorRole: req.user.role,
          subject: `${req.method} ${req.path}`,
          outcome: 'refused',
          detail: { required: roles },
        })
        .catch(() => undefined);

      return res.status(403).json({
        error: `Role "${req.user.role}" is not permitted to perform this action. Required: ${roles.join(' or ')}.`,
      });
    }
    next();
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --------------------------------------------------------------------------
// Health
// --------------------------------------------------------------------------
app.get(
  '/api/health',
  wrap(async (_req, res) => {
    const chain = await store.audit.verifyAll();
    const active = [...runtimes.values()];
    const tenantCount = await store.tenants.count();
    res.json({
      status: chain.ok && !active.some((r) => r.risk.isHalted) ? 'ok' : 'degraded',
      version: process.env.npm_package_version || '12.5.0',
      storage: store.dialect,
      geminiConfigured: hasApiKey(),
      model: GEMINI_MODEL,
      auditChain: { ok: chain.ok, tenants: chain.tenants, broken: chain.broken },
      // V12-CONST-001. Reported so an operator can see at a glance that the
      // instrument loaded and whether the Inspectorate can issue anything.
      // Below quorum every release is refused (Article XIII §13.4), which is a
      // working gate rather than an outage — but it must be visible.
      constitution: {
        instrument: constitution.document.instrument,
        ratification: constitution.document.ratification,
        digest: constitution.digest,
        inspectorate: {
          seated: constitution.engine.inspectorate.seated.length,
          required: constitution.document.inspectorate.minimum_seated,
          quorum: constitution.engine.inspectorate.hasQuorum,
        },
        ecosystemHalted: constitution.engine.sanctions.halted,
      },
      tenants: tenantCount,
      /*
       * Closed-beta posture, so pre-flight can assert it rather than trusting
       * that somebody remembered to set the environment. An open free signup on
       * a deployment with a real API key is the expensive mistake here, and it
       * is invisible from the outside without this.
       */
      beta: {
        inviteOnly: INVITE_ONLY,
        maxTenants: BETA_MAX_TENANTS || null,
        headroom: BETA_MAX_TENANTS > 0 ? Math.max(0, BETA_MAX_TENANTS - tenantCount) : null,
        redeemableInvites: await store.invites.countRedeemable(),
        /** False means the placeholder token prices are in force. */
        meteringConfigured: AI_RATES.configured,
      },
      // Surfaced so pre-flight can check the real condition rather than
      // guessing the password. Seeded credentials in production are the most
      // common way a demo becomes a breach.
      demoUsersEnabled: process.env.ENABLE_DEMO_USERS === 'true',
      multiTenant: MULTI_TENANT,
      execution: {
        activeRuntimes: active.length,
        marketplaces: [...new Set(active.map((r) => r.marketplace.id))],
        halted: active.filter((r) => r.risk.isHalted).length,
        discrepancies: active.reduce((n, r) => n + (r.lastReconciliation?.discrepancies.length ?? 0), 0),
      },
      uptimeSeconds: Math.round(process.uptime()),
    });
  }),
);

// --------------------------------------------------------------------------
// Auth routes
// --------------------------------------------------------------------------
app.post(
  '/api/auth/register',
  authLimiter,
  wrap(async (req, res) => {
    const { email, password, name, role } = req.body ?? {};

    if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'A valid email address is required.' });
    }
    if (typeof name !== 'string' || name.trim().length < 2 || name.length > 120) {
      return res.status(400).json({ error: 'Name must be between 2 and 120 characters.' });
    }
    if (typeof password !== 'string' || password.length < 12) {
      return res.status(400).json({ error: 'Password must be at least 12 characters.' });
    }
    if (password.length > 200) return res.status(400).json({ error: 'Password is too long.' });

    const normalised = email.trim().toLowerCase();
    if (await store.users.findByEmail(normalised)) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const allowed: UserRole[] = ['Executive', 'Arbitrage Trader', 'LoRABlender Engineer'];
    const assignedRole: UserRole = allowed.includes(role) ? role : 'LoRABlender Engineer';

    /*
     * Closed-beta gate.
     *
     * ORDER MATTERS, and the first version of this had it wrong.
     *
     * The cap is checked BEFORE the invite is redeemed. Redeeming first meant a
     * single-use code was consumed and then the signup was refused for being at
     * capacity — burning a code the operator had issued to a real person, while
     * the response told them "your invite is still valid". It was not. The
     * probe caught it: two valid codes went in, one account came out, and two
     * codes were spent.
     *
     * Checking the cap first leaks only that the beta is full, which is what
     * the error says anyway.
     */
    if (MULTI_TENANT && BETA_MAX_TENANTS > 0) {
      const existing = await store.tenants.count();
      if (existing >= BETA_MAX_TENANTS) {
        await store.audit.append(DEFAULT_TENANT_ID, {
          event: 'beta.cap_reached',
          actorId: null,
          actorName: normalised,
          actorRole: null,
          subject: 'registration',
          outcome: 'refused',
          detail: { tenants: existing, cap: BETA_MAX_TENANTS },
        });
        return res.status(403).json({
          error: 'This beta is at capacity. Your invite has not been used — please try again later.',
          code: 'beta_at_capacity',
        });
      }
    }

    /*
     * Invite redemption.
     *
     * Checked before the password is hashed — bcrypt at cost 12 is deliberately
     * expensive, and an unauthenticated endpoint that does expensive work for a
     * request it will refuse anyway is a free denial-of-service primitive.
     *
     * The failure response is identical for every reason a code can fail. An
     * attacker able to distinguish "revoked" from "unknown" would have an
     * oracle for enumerating which codes ever existed.
     */
    const { invite: inviteCode } = req.body ?? {};
    let redeemedInviteId: string | null = null;

    if (INVITE_ONLY) {
      if (typeof inviteCode !== 'string' || normaliseInviteCode(inviteCode).length < 8) {
        return res.status(403).json({
          error: 'This deployment is invite-only. An invite code is required.',
          code: 'invite_required',
        });
      }

      const result = await store.invites.redeem(hashInviteCode(inviteCode), normalised);

      if (!result.ok) {
        // Recorded with the reason even though the client is not told it: the
        // operator needs to see a burst of `unknown_code` attempts.
        await store.audit.append(DEFAULT_TENANT_ID, {
          event: 'invite.refused',
          actorId: null,
          actorName: normalised,
          actorRole: null,
          subject: 'registration',
          outcome: 'refused',
          detail: { reason: result.reason },
        });
        return res.status(403).json({
          error: 'That invite code is not valid.',
          code: 'invite_invalid',
        });
      }

      redeemedInviteId = result.invite.id;
    }

    // Tenant resolution. In single-tenant mode (self-hosted, desktop) everyone
    // lands in the default tenant. In multi-tenant mode a signup either creates
    // a new organisation or is the first seat of one.
    const { organisation, plan } = req.body ?? {};
    let tenant: Tenant;

    if (MULTI_TENANT) {
      // In multi-tenant mode a signup NEVER falls through to the default
      // tenant. That default is the deployment's own organisation; dropping an
      // unknown signup into it would put a stranger inside the operator's book.
      // Without an organisation name they get a personal one of their own.
      tenant = await createTenant(store, {
        name:
          typeof organisation === 'string' && organisation.trim().length >= 2
            ? organisation
            : `${name.trim()}'s workspace`,
        plan: isPlan(plan) ? plan : 'explorer',
      });
    } else {
      // Single-tenant deployments (self-hosted, desktop) have exactly one
      // organisation and everyone joins it.
      tenant = (await store.tenants.get(DEFAULT_TENANT_ID)) ?? defaultTenant;
    }

    // Seat limits are enforced here, not in the billing system, because this is
    // the only place a seat is actually consumed.
    const seatsUsed = await store.users.countForTenant(tenant.id);
    if (seatsUsed >= tenant.seatLimit) {
      return res.status(402).json({
        error: `This organisation has used all ${tenant.seatLimit} seat(s) on the ${tenant.plan} plan.`,
        code: 'seat_limit_reached',
      });
    }

    const user: UserRecord = {
      id: `usr-${crypto.randomUUID()}`,
      tenantId: tenant.id,
      email: normalised,
      name: name.trim(),
      passwordHash: await bcrypt.hash(password, 12),
      role: assignedRole,
      createdAt: new Date().toISOString(),
    };

    await store.users.create(user);
    await store.audit.append(tenant.id, {
      event: 'auth.registered',
      actorId: user.id,
      actorName: user.name,
      actorRole: user.role,
      subject: user.email,
      outcome: 'allowed',
      // The invite that admitted them, so an operator can trace any account
      // back to the code they issued and to whom.
      detail: redeemedInviteId ? { inviteId: redeemedInviteId } : {},
    });

    issueSession(res, user);
    res.status(201).json({ user: publicUser(user) });
  }),
);

app.post(
  '/api/auth/login',
  authLimiter,
  wrap(async (req, res) => {
    const { email, password } = req.body ?? {};
    const normalised = typeof email === 'string' ? email.trim().toLowerCase() : '';
    const user = await store.users.findByEmail(normalised);

    // Always compare a hash so response timing does not reveal whether the
    // account exists.
    const dummy = '$2b$12$0000000000000000000000000000000000000000000000000000';
    const ok = await bcrypt.compare(
      typeof password === 'string' ? password : '',
      user?.passwordHash ?? dummy,
    );

    if (!user || !ok) {
      await store.audit.append(user?.tenantId ?? defaultTenant.id, {
        event: 'auth.login',
        actorId: user?.id ?? null,
        actorName: null,
        actorRole: null,
        subject: normalised || null,
        outcome: 'refused',
        detail: { reason: 'invalid_credentials' },
      });
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    issueSession(res, user);
    res.json({ user: publicUser(user) });
  }),
);

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  clearCsrfToken(res);
  res.json({ success: true });
});

/**
 * Session probe. Returns 200 with `user: null` when signed out — a 401 on first
 * paint is the normal anonymous path and filled the console with false alarms.
 * Also (re)issues the CSRF token so a client that has a valid session cookie
 * but lost its CSRF cookie can recover without signing in again.
 */
app.get(
  '/api/auth/me',
  wrap(async (req, res) => {
    const token = readToken(req);
    if (!token) return res.json({ user: null });

    try {
      const claims = jwt.verify(token, JWT_SECRET) as SessionClaims;
      const user = await store.users.findById(claims.id);
      if (!user) {
        res.clearCookie(COOKIE_NAME, { path: '/' });
        clearCsrfToken(res);
        return res.json({ user: null });
      }
      if (!req.cookies?.apex_csrf) issueCsrfToken(res, IS_PROD);
      return res.json({ user: publicUser(user) });
    } catch {
      res.clearCookie(COOKIE_NAME, { path: '/' });
      clearCsrfToken(res);
      return res.json({ user: null });
    }
  }),
);

// --------------------------------------------------------------------------
// MoL routing gate
// --------------------------------------------------------------------------
type Specialist = 'chat' | 'personal_agent' | 'genui' | 'coding';

const ROUTING_RULES: Array<{
  specialist: Specialist;
  weights: [number, number, number, number];
  terms: string[];
  explanation: string;
}> = [
  {
    specialist: 'genui',
    weights: [0.1, 0.1, 0.7, 0.1],
    terms: ['ui', 'widget', 'component', 'dashboard', 'genui', 'render', 'chart', 'gauge', 'visualise', 'visualize'],
    explanation: 'Routing gate selected the GenUI adapter for dynamic interface synthesis.',
  },
  {
    specialist: 'coding',
    weights: [0.1, 0.1, 0.15, 0.65],
    terms: ['code', 'script', 'python', 'function', 'fix', 'algorithm', 'refactor', 'bug', 'typescript'],
    explanation: 'Routing gate dispatched to the Coding adapter.',
  },
  {
    specialist: 'personal_agent',
    weights: [0.15, 0.65, 0.1, 0.1],
    terms: ['trade', 'profit', 'arbitrage', 'asset', 'task', 'workflow', 'schedule', 'inventory', 'stop loss'],
    explanation: 'Routing gate handed off to the Personal Agent for workflow orchestration and zero-loss checks.',
  },
];

function routeQuery(query: string) {
  const text = query.toLowerCase();
  let best = {
    specialist: 'chat' as Specialist,
    weights: [0.6, 0.2, 0.1, 0.1] as number[],
    explanation: 'Routing gate assigned the conversation to the Chat specialist.',
    score: 0,
  };

  for (const rule of ROUTING_RULES) {
    const score = rule.terms.reduce((acc, term) => (text.includes(term) ? acc + 1 : acc), 0);
    if (score > best.score) {
      best = {
        specialist: rule.specialist,
        weights: rule.weights,
        explanation: rule.explanation,
        score,
      };
    }
  }
  return best;
}

app.post('/api/mol-router', (req, res) => {
  const query = typeof req.body?.query === 'string' ? req.body.query.slice(0, 4000) : '';
  const routed = routeQuery(query);
  const [chat, personal_agent, genui, coding] = routed.weights;

  res.json({
    query,
    selectedSpecialist: routed.specialist,
    routingWeights: routed.weights,
    allocationTrace: { chat, personal_agent, genui, coding },
    latencyMs: Math.floor(12 + Math.random() * 15),
    explanation: routed.explanation,
    matchedTerms: routed.score,
    simulated: true,
  });
});

// --------------------------------------------------------------------------
// Model endpoints
// --------------------------------------------------------------------------
const GENUI_SYSTEM_PROMPT = `You are the GenUI specialist for V12 Apex Atlas.
Return ONLY the body of a React function component — a bare \`return ( ... )\` JSX statement.
Rules:
- No markdown fences, no imports, no export statements, no component declaration.
- Style exclusively with Tailwind utility classes.
- Read incoming values from the \`data\` object (it may be undefined; guard with \`data?.\`).
- Do not use browser storage, network calls, timers, or \`window\`.
Example:
return (
  <div className="p-4 bg-zinc-900 border border-emerald-500/30 rounded-xl text-zinc-100">
    <h3 className="text-emerald-400 font-bold text-sm mb-2">{data?.title || "Custom Component"}</h3>
    <p className="text-xs text-zinc-400">Generated component</p>
  </div>
);`;

function fallbackArtifact(prompt: string) {
  const safe = String(prompt || '').replace(/[<>{}`]/g, '').slice(0, 120);
  return `return (
  <div className="p-4 bg-zinc-900/90 border border-amber-500/40 rounded-xl text-zinc-100 shadow-xl font-mono">
    <div className="flex items-center space-x-2 mb-3">
      <div className="w-2.5 h-2.5 rounded-full bg-amber-400" />
      <span className="text-xs font-bold text-amber-400 uppercase tracking-wide">Offline template</span>
    </div>
    <p className="text-xs text-zinc-400 font-sans mb-3">
      The model was unavailable, so this placeholder was rendered locally. Request: "${safe}"
    </p>
    <div className="grid grid-cols-3 gap-2 text-center text-[11px]">
      <div className="bg-zinc-950 p-2 rounded border border-zinc-800">
        <div className="text-zinc-500">FPS</div>
        <div className="font-bold text-emerald-400">{data?.metrics?.fps ?? "—"}</div>
      </div>
      <div className="bg-zinc-950 p-2 rounded border border-zinc-800">
        <div className="text-zinc-500">LATENCY</div>
        <div className="font-bold text-cyan-400">{data?.metrics?.latencyMs ?? "—"} ms</div>
      </div>
      <div className="bg-zinc-950 p-2 rounded border border-zinc-800">
        <div className="text-zinc-500">LOAD</div>
        <div className="font-bold text-purple-400">{data?.metrics?.loadPct ?? "—"}%</div>
      </div>
    </div>
  </div>
);`;
}


/**
 * Inference metering.
 *
 * `preflight` reported "no usage metering" as a launch warning, and on a free
 * closed beta that is the one warning with teeth: a single enthusiastic user
 * can spend an unbounded amount of somebody else's API budget. These two
 * functions close it.
 *
 * The credit is checked BEFORE the call and recorded AFTER. Checking after
 * means the request that breaks the budget is one you have already paid for,
 * and with a long response that single request can be most of the overage.
 */
async function checkAiCredit(tenantId: TenantId) {
  const [tenant, usage] = await Promise.all([
    store.tenants.get(tenantId),
    store.usage.get(tenantId, currentPeriod()),
  ]);
  return assessCredit(usage, tenant?.monthlyAiCreditCents ?? 0);
}

/**
 * Record what a call actually consumed.
 *
 * Token counts come from the provider's own usage metadata where it is
 * present. When it is absent the call is still recorded, with zero tokens and
 * one request — a call that cost something unknown must not silently count as
 * having cost nothing, and the request counter is what makes that visible.
 */
async function recordAiUsage(tenantId: TenantId, response: unknown): Promise<void> {
  const meta = (response as { usageMetadata?: Record<string, number> } | null)?.usageMetadata;
  const inputTokens = Number(meta?.promptTokenCount ?? 0) || 0;
  const outputTokens =
    (Number(meta?.candidatesTokenCount ?? 0) || 0) + (Number(meta?.thoughtsTokenCount ?? 0) || 0);

  try {
    await store.usage.record(tenantId, currentPeriod(), {
      requests: 1,
      inputTokens,
      outputTokens,
      costCents: estimateCostCents(inputTokens, outputTokens, AI_RATES),
    });
  } catch (err) {
    // Metering must never break the feature it meters. A failed write is
    // logged and swallowed; the rate limiter is still in front of this path.
    console.error('[metering] failed to record usage:', err instanceof Error ? err.message : err);
  }
}

/** The 402 an over-budget tenant receives. One place, so the wording cannot drift. */
const creditExhausted = (verdict: { usedCents: number; limitCents: number }) => ({
  error:
    `This organisation has used its monthly inference credit ` +
    `($${(verdict.usedCents / 100).toFixed(2)} of $${(verdict.limitCents / 100).toFixed(2)}). ` +
    `Deterministic features — the ledger, the vault, Hermes and the audit log — are unaffected.`,
  code: 'ai_credit_exhausted',
});

app.post(
  '/api/gemini/genui',
  authenticate,
  aiLimiter,
  wrap(async (req, res) => {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.slice(0, 2000) : '';
    const propsData = {
      title: prompt || 'Generated UI artifact',
      timestamp: new Date().toISOString(),
      metrics: { fps: 24000, loadPct: 42, latencyMs: 45 },
    };

    if (!hasApiKey()) {
      return res.json({
        code: fallbackArtifact(prompt),
        propsData,
        source: 'fallback',
        reason: 'GEMINI_API_KEY is not configured.',
      });
    }

    const credit = await checkAiCredit(tenantOf(req));
    if (!credit.allowed) return res.status(402).json(creditExhausted(credit));

    try {
      const response = await getGenAI().models.generateContent({
        model: GEMINI_MODEL,
        contents: prompt || 'Create a real-time GPU compute throughput gauge widget.',
        // Schedule B — injected into every agent's system context and
        // non-overridable. It is prepended, so nothing in the product prompt
        // can be read as qualifying it.
        config: { systemInstruction: `${constitution.oath}\n\n${GENUI_SYSTEM_PROMPT}`, temperature: 0.7 },
      });
      await recordAiUsage(tenantOf(req), response);

      const code = (response.text || '')
        .replace(/```(?:tsx|jsx|javascript|js)?/g, '')
        .replace(/```/g, '')
        .trim();

      if (!code) throw new Error('Model returned an empty component.');
      res.json({ code, propsData, source: 'model', model: GEMINI_MODEL });
    } catch (err) {
      console.error('[genui] generation failed:', err instanceof Error ? err.message : err);
      res.json({
        code: fallbackArtifact(prompt),
        propsData,
        source: 'fallback',
        reason: err instanceof Error ? err.message : 'Model request failed.',
      });
    }
  }),
);

const CHAT_SYSTEM_PROMPT = `You are the V12 Apex Atlas operations assistant.
You help operators manage digital-twin nodes, inspect routing decisions, review Hermes arbitrage evaluations, and use the UI4A REPL.
Be concise and concrete. When you reference figures from the workspace, say plainly that the current dataset is simulated. Never claim a settlement has been executed — only the Hermes settlement endpoint can do that.`;

app.post(
  '/api/gemini/chat',
  authenticate,
  aiLimiter,
  wrap(async (req, res) => {
    const message = typeof req.body?.message === 'string' ? req.body.message.slice(0, 8000) : '';
    const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];

    if (!message.trim()) return res.status(400).json({ error: 'A message is required.' });

    if (!hasApiKey()) {
      return res.json({
        reply:
          'The workspace is running without a model API key, so this is a local stub reply. ' +
          'Set GEMINI_API_KEY to enable live responses. Deterministic modules — routing, Hermes evaluation, the vault and the synchronizer — all work without it.',
        source: 'fallback',
      });
    }

    const credit = await checkAiCredit(tenantOf(req));
    if (!credit.allowed) return res.status(402).json(creditExhausted(credit));

    try {
      const contents = [
        ...rawHistory
          .filter((m: any) => m && typeof m.text === 'string' && (m.sender === 'user' || m.sender === 'agent'))
          .slice(-12)
          .map((m: any) => ({
            role: m.sender === 'user' ? 'user' : 'model',
            parts: [{ text: String(m.text).slice(0, 4000) }],
          })),
        { role: 'user', parts: [{ text: message }] },
      ];

      const response = await getGenAI().models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config: { systemInstruction: `${constitution.oath}\n\n${CHAT_SYSTEM_PROMPT}` },
      });
      await recordAiUsage(tenantOf(req), response);

      res.json({ reply: response.text || '(empty response)', source: 'model', model: GEMINI_MODEL });
    } catch (err) {
      console.error('[chat] generation failed:', err instanceof Error ? err.message : err);
      res.status(502).json({ error: 'The model backend is unavailable. Please retry.' });
    }
  }),
);

// --------------------------------------------------------------------------
// Hermes
// --------------------------------------------------------------------------
app.get(
  '/api/hermes/assets',
  optionalAuth,
  wrap(async (req, res) => {
    res.json({
      assets: await store.assets.list(publicTenant(req)),
      simulated: true,
      disclaimer: 'Prices are generated by the built-in simulator. Do not treat them as market data.',
    });
  }),
);

app.post(
  '/api/hermes/evaluate',
  optionalAuth,
  wrap(async (req, res) => {
    const { asset_id, stop_loss_pct, profit_target_pct } = req.body ?? {};
    const asset = await store.assets.get(publicTenant(req), asset_id);
    if (!asset) return res.status(404).json({ error: 'Asset not found.' });

    const policy: Record<string, number> = {};
    if (typeof stop_loss_pct === 'number' && stop_loss_pct > 0 && stop_loss_pct < 1) {
      policy.stop_loss_pct = stop_loss_pct;
    }
    if (typeof profit_target_pct === 'number' && profit_target_pct > 0 && profit_target_pct < 10) {
      policy.profit_target_pct = profit_target_pct;
    }

    res.json({ evaluation: evaluateAsset(asset, policy), simulated: true });
  }),
);

app.post(
  '/api/hermes/trade',
  authenticate,
  writeLimiter,
  requireRole('Executive', 'Arbitrage Trader', 'System Admin'),
  wrap(async (req, res) => {
    const { asset_id } = req.body ?? {};
    const actor = req.user!;
    const tenant = tenantOf(req);
    const asset = await store.assets.get(tenant, asset_id);

    if (!asset) return res.status(404).json({ error: 'Asset not found.' });

    // The decision is made here, from server-held state.
    const { allowed, evaluation, reason } = authoriseSell(asset);

    if (!allowed) {
      await store.audit.append(tenant, {
        event: 'trade.refused',
        actorId: actor.id,
        actorName: actor.name,
        actorRole: actor.role,
        subject: asset.asset_id,
        outcome: 'refused',
        detail: { reason, evaluation },
      });
      return res.status(409).json({ error: reason, evaluation });
    }

    // Compare-and-swap. If another request liquidated this position between the
    // read above and here, we get null and refuse rather than double-selling.
    const liquidation = await store.assets.liquidate(tenant, asset.asset_id);
    if (!liquidation) {
      await store.audit.append(tenant, {
        event: 'trade.refused',
        actorId: actor.id,
        actorName: actor.name,
        actorRole: actor.role,
        subject: asset.asset_id,
        outcome: 'refused',
        detail: { reason: 'Position was liquidated by a concurrent request.' },
      });
      return res.status(409).json({ error: 'Position was liquidated by a concurrent request.' });
    }

    const netPerUnit = evaluation.realized_net_per_unit ?? 0;
    const netTotal = Math.round(netPerUnit * liquidation.quantity * 100) / 100;

    const trade = {
      id: `trd-${crypto.randomUUID()}`,
      asset_id: asset.asset_id,
      action: evaluation.action,
      quantity: liquidation.quantity,
      unit_price: liquidation.unitPrice,
      realized_net_per_unit: netPerUnit,
      realized_net_total: netTotal,
      executedBy: actor.name,
      executedById: actor.id,
      timestamp: new Date().toISOString(),
      simulated: true,
    };

    await store.trades.record(tenant, trade);
    await store.audit.append(tenant, {
      event: 'trade.executed',
      actorId: actor.id,
      actorName: actor.name,
      actorRole: actor.role,
      subject: asset.asset_id,
      outcome: 'allowed',
      detail: { trade, evaluation },
    });

    if (asset.asset_class === 'H266_Video_NFT') {
      const warehouse = await store.nodes.get(tenant, 'node-warehouse-alpha');
      if (warehouse) {
        await store.nodes.update(
          tenant,
          'node-warehouse-alpha',
          {
            metrics: { allocated_inventory: 0 },
            content: `${warehouse.content}\n\n[${trade.timestamp}] ${evaluation.action} ${trade.quantity} units @ $${trade.unit_price.toFixed(2)} — net $${netTotal.toFixed(2)} (simulated)`,
          },
          actor.name,
        );
      }
    }

    res.json({ success: true, tradeLog: trade, evaluation, asset: liquidation.asset });
  }),
);

app.get(
  '/api/hermes/trades',
  authenticate,
  wrap(async (req, res) => {
    res.json({ trades: await store.trades.list(tenantOf(req), 100) });
  }),
);

// --------------------------------------------------------------------------
// Audit log
// --------------------------------------------------------------------------
app.get(
  '/api/audit',
  authenticate,
  requireRole('Executive', 'System Admin'),
  wrap(async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const tenant = tenantOf(req);
    const [entries, chain] = await Promise.all([store.audit.list(tenant, limit), store.audit.verify(tenant)]);
    res.json({ entries, chain });
  }),
);

app.get(
  '/api/audit/verify',
  authenticate,
  requireRole('Executive', 'System Admin'),
  wrap(async (req, res) => {
    res.json({ chain: await store.audit.verify(tenantOf(req)) });
  }),
);

// --------------------------------------------------------------------------
// Execution desk — orders, fills, positions, risk
// --------------------------------------------------------------------------
const TRADE_ROLES: UserRole[] = ['Executive', 'Arbitrage Trader', 'System Admin'];

/** Snapshot of everything the desk needs, in one round trip. */
app.get(
  '/api/execution/state',
  optionalAuth,
  wrap(async (req, res) => {
    const tenant = publicTenant(req);
    const trading = await runtimeFor(tenant);
    const assetSpecs = [...trading.assetSpecs.values()];

    const rows = await Promise.all(
      assetSpecs.map(async (instrument) => {
        const [quote, position] = await Promise.all([
          trading.execution.quote(instrument.assetId),
          trading.execution.position(instrument.assetId),
        ]);
        return {
          spec: instrument,
          quote,
          position,
          unrealisedPnl: quote ? unrealisedPnl(position, quote.bid || quote.last) : 0,
          plan: planFor(instrument, position, quote),
        };
      }),
    );

    const [orders, fills, dailyNotional, tenantRecord] = await Promise.all([
      store.orders.list(tenant, 50),
      store.fills.list(tenant, 50),
      trading.execution.dailyNotional(),
      store.tenants.get(tenant),
    ]);

    res.json({
      tenant: tenantRecord
        ? { id: tenantRecord.id, name: tenantRecord.name, plan: tenantRecord.plan, assetLedgerEnabled: tenantRecord.assetLedgerEnabled }
        : null,
      mode: 'internal',
      marketplace: trading.marketplace.id,
      bidFeed: trading.bids.id,
      simulated: true,
      risk: { ...trading.risk.current, dailyNotionalUsed: round(dailyNotional, 2) },
      lastReconciliation: trading.lastReconciliation,
      rows,
      orders,
      fills,
    });
  }),
);

/** Place an order. Risk-checked server-side, audited either way. */
app.post(
  '/api/execution/order',
  authenticate,
  writeLimiter,
  requireRole(...TRADE_ROLES),
  wrap(async (req, res) => {
    const actor = req.user!;
    const tenant = tenantOf(req);
    const trading = await runtimeFor(tenant);

    // Ledger writes are a plan entitlement, checked before anything is persisted.
    const tenantRecord = await store.tenants.get(tenant);
    if (!tenantRecord?.assetLedgerEnabled) {
      return res.status(402).json({
        error: `The ${tenantRecord?.plan ?? 'current'} plan does not include the asset ledger.`,
        code: 'asset_ledger_not_entitled',
      });
    }

    const { assetId, side, quantity, type, limitPrice, timeInForce, reason } = req.body ?? {};
    const instrument = trading.assetSpecs.get(assetId);
    if (!instrument) return res.status(404).json({ error: 'Unknown asset.' });
    if (side !== 'buy' && side !== 'sell') return res.status(400).json({ error: 'Side must be buy or sell.' });
    if (typeof quantity !== 'number' || !Number.isFinite(quantity)) {
      return res.status(400).json({ error: 'Quantity must be a number.' });
    }

    const orderType = type === 'market' ? 'market' : 'limit';
    const intent = {
      clientOrderId: ExecutionService.newClientOrderId(),
      assetId,
      side,
      quantity,
      type: orderType as 'market' | 'limit',
      limitPrice: orderType === 'limit' ? Number(limitPrice) : undefined,
      timeInForce: (['gtc', 'ioc', 'fok'].includes(timeInForce) ? timeInForce : 'gtc') as 'gtc' | 'ioc' | 'fok',
      reason: typeof reason === 'string' ? reason.slice(0, 200) : 'manual',
    };

    const [quote, position, dailyNotionalUsed, vaultNodes] = await Promise.all([
      trading.execution.quote(assetId),
      trading.execution.position(assetId),
      trading.execution.dailyNotional(),
      store.nodes.list(tenant),
    ]);

    /*
     * The fundamental invalidation breaker reads the vault at decision time,
     * not at boot.
     *
     * `assetSpecs` is built once when the runtime starts. If an operator marks
     * a render line degraded in Obsidian at 09:00, a breaker that consulted the
     * boot-time snapshot would keep authorising acquisitions until the next
     * restart — which is exactly the window the breaker exists to close. The
     * vault is small and the parse is microseconds; correctness wins.
     *
     * The two conditions are ANDed, not replaced: an asset flagged invalid in
     * the asset table stays invalid regardless of what the twin says.
     */
    const graph = buildGraph(vaultNodes);
    const spec = {
      ...instrument,
      fundamentals_intact:
        instrument.fundamentals_intact && fundamentalsIntact(graph, instrument.asset_class),
    };

    const verdict = trading.risk.assess(intent, {
      spec,
      quote,
      position,
      dailyNotionalUsed,
      referencePrice: quote?.last ?? null,
      mode: 'internal',
      now: Date.now(),
    });

    if (!verdict.allowed) {
      await store.audit.append(tenant, {
        event: 'order.refused',
        actorId: actor.id,
        actorName: actor.name,
        actorRole: actor.role,
        subject: assetId,
        outcome: 'refused',
        detail: { intent, violations: verdict.violations, notional: verdict.notional },
      });
      return res.status(409).json({
        error: verdict.violations[0]?.message ?? 'Order refused by risk controls.',
        violations: verdict.violations,
      });
    }

    try {
      const result = await trading.execution.place(intent, { id: actor.id, name: actor.name });

      await store.audit.append(tenant, {
        event: result.order.status === 'rejected' ? 'order.rejected' : 'order.placed',
        actorId: actor.id,
        actorName: actor.name,
        actorRole: actor.role,
        subject: assetId,
        outcome: result.order.status === 'rejected' ? 'refused' : 'allowed',
        detail: {
          clientOrderId: intent.clientOrderId,
          side,
          quantity,
          type: orderType,
          limitPrice: intent.limitPrice ?? null,
          notional: verdict.notional,
          status: result.order.status,
          deduplicated: result.deduplicated,
          resolvedAfterFailure: result.resolvedAfterFailure ?? null,
        },
      });

      res.status(201).json({ order: result.order, resolvedAfterFailure: result.resolvedAfterFailure ?? null });
    } catch (err) {
      // Unknown state: the order is left pending for reconciliation. This is
      // recorded as a refusal so it surfaces in the audit log for review.
      const message = err instanceof Error ? err.message : 'Venue unreachable.';
      await store.audit.append(tenant, {
        event: 'order.unknown_state',
        actorId: actor.id,
        actorName: actor.name,
        actorRole: actor.role,
        subject: assetId,
        outcome: 'refused',
        detail: { clientOrderId: intent.clientOrderId, message },
      });
      res.status(502).json({ error: message, clientOrderId: intent.clientOrderId });
    }
  }),
);

app.post(
  '/api/execution/order/:clientOrderId/cancel',
  authenticate,
  writeLimiter,
  requireRole(...TRADE_ROLES),
  wrap(async (req, res) => {
    const tenant = tenantOf(req);
    const trading = await runtimeFor(tenant);
    const order = await trading.execution.cancel(req.params.clientOrderId);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    await store.audit.append(tenant, {
      event: 'order.cancelled',
      actorId: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      subject: order.assetId,
      outcome: order.status === 'cancelled' ? 'allowed' : 'refused',
      detail: { clientOrderId: order.clientOrderId, status: order.status },
    });

    res.json({ order });
  }),
);

/** Kill switch. Halting is always permitted; resuming needs a senior role. */
app.post(
  '/api/execution/halt',
  authenticate,
  requireRole(...TRADE_ROLES),
  wrap(async (req, res) => {
    const tenant = tenantOf(req);
    const trading = await runtimeFor(tenant);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 300) : 'Halted by operator.';
    const limits = trading.risk.halt(reason);

    await store.audit.append(tenant, {
      event: 'risk.halted',
      actorId: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      subject: 'execution',
      outcome: 'allowed',
      detail: { reason },
    });

    res.json({ risk: limits });
  }),
);

app.post(
  '/api/execution/resume',
  authenticate,
  requireRole('Executive', 'System Admin'),
  wrap(async (req, res) => {
    const tenant = tenantOf(req);
    const trading = await runtimeFor(tenant);
    const limits = trading.risk.resume();
    await store.audit.append(tenant, {
      event: 'risk.resumed',
      actorId: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      subject: 'execution',
      outcome: 'allowed',
      detail: {},
    });
    res.json({ risk: limits });
  }),
);

app.post(
  '/api/execution/reconcile',
  authenticate,
  requireRole('Executive', 'System Admin'),
  wrap(async (req, res) => {
    const tenant = tenantOf(req);
    const trading = await runtimeFor(tenant);
    const report = await trading.execution.reconcile();
    trading.lastReconciliation = report;

    await store.audit.append(tenant, {
      event: 'execution.reconciled',
      actorId: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      subject: trading.marketplace.id,
      outcome: report.discrepancies.length > 0 ? 'refused' : 'info',
      detail: { ...report },
    });

    res.json({ report });
  }),
);

// --------------------------------------------------------------------------
// Digital twin vault
// --------------------------------------------------------------------------
app.get(
  '/api/vault/nodes',
  optionalAuth,
  wrap(async (req, res) => {
    res.json({ nodes: await store.nodes.list(publicTenant(req)) });
  }),
);

app.put(
  '/api/vault/node',
  authenticate,
  writeLimiter,
  requireRole('Executive', 'System Admin', 'LoRABlender Engineer'),
  wrap(async (req, res) => {
    const { id, content, metrics } = req.body ?? {};

    if (content !== undefined && (typeof content !== 'string' || content.length > 100_000)) {
      return res.status(400).json({ error: 'Node content must be a string under 100,000 characters.' });
    }
    if (metrics !== undefined && (typeof metrics !== 'object' || metrics === null || Array.isArray(metrics))) {
      return res.status(400).json({ error: 'Metrics must be an object.' });
    }

    const node = await store.nodes.update(tenantOf(req), id, { content, metrics }, req.user!.name);
    if (!node) return res.status(404).json({ error: 'Node not found.' });

    await store.audit.append(tenantOf(req), {
      event: 'vault.updated',
      actorId: req.user!.id,
      actorName: req.user!.name,
      actorRole: req.user!.role,
      subject: node.filePath,
      outcome: 'allowed',
      detail: { bytes: node.content.length },
    });

    res.json({ success: true, node });
  }),
);

// --------------------------------------------------------------------------
// Orion ecosystem — inbound relays from other applications
// --------------------------------------------------------------------------
// Mounted only when ORION_APP_SECRET is configured. This is a surface other
// systems can reach, so it carries liveness and capabilities and nothing that
// mutates state. See server/ecosystem.ts for the trust model.
if (ECOSYSTEM.orionPublicKey) {
  const ecosystem = createEcosystemRoutes({
    config: ECOSYSTEM,
    audit: (event, outcome, detail) => {
      void store.audit
        .append(DEFAULT_TENANT_ID, {
          event,
          actorId: null,
          actorName: 'orion',
          actorRole: null,
          subject: 'ecosystem',
          outcome,
          detail,
        })
        .catch((err) => console.error('[ecosystem] audit append failed:', err));
    },
    summary: async () => {
      // Shape only — counts and health, never inventory or tenant data.
      const nodes = await store.nodes.list(DEFAULT_TENANT_ID);
      const graph = buildGraph(nodes);
      return {
        hubs: graph.hubs.size,
        factories: graph.factories.size,
        warehouses: graph.warehouses.size,
        twinIssues: graph.issues.length,
        marketplace: 'internal',
      };
    },
  });

  app.get('/api/ecosystem/ping', ecosystem.authenticate, ecosystem.ping);
  app.post('/api/ecosystem/ping', ecosystem.authenticate, ecosystem.ping);
  app.get('/api/ecosystem/capabilities', ecosystem.authenticate, ecosystem.capabilities);
}

// --------------------------------------------------------------------------
// Administrative API — invite minting
// --------------------------------------------------------------------------
// Mounted ONLY when an admin token is configured. A deployment that never sets
// one has no such routes: not disabled ones, none. See server/admin.ts.
if (ADMIN.token) {
  const admin = createAdminRouter(() => store, ADMIN);
  app.post('/api/admin/invites', admin.limiter, admin.authenticate, admin.mint);
  app.get('/api/admin/invites', admin.limiter, admin.authenticate, admin.list);
  app.post('/api/admin/invites/:id/revoke', admin.limiter, admin.authenticate, admin.revoke);
  app.get('/api/admin/usage', admin.limiter, admin.authenticate, admin.usage);
}

// --------------------------------------------------------------------------
// External integration API — /api/v1
// --------------------------------------------------------------------------
// Mounted ALWAYS, and reachable by nobody until a key is issued. That is the
// safer default: a surface that appears when an env var is set is a surface
// that gets tested in production the first time somebody sets it. Every route
// is read-only, tenant-scoped by the presented key, and passes the
// constitutional gate before it answers.
//
// See server/external/router.ts for the trust model and EXTERNAL_ROUTES for the
// complete surface a stranger can reach.
{
  const external = createExternalRouter({
    // Storage, not a cache. A revoked key must stop working on the next
    // request, on every instance — not when a cache expires.
    lookupKey: (keyId) => store.externalKeys.get(keyId),

    audit: (event) => {
      void store.audit
        .append(asTenantId(event.tenantId ?? DEFAULT_TENANT_ID), {
          event: event.event,
          actorId: event.keyId,
          actorName: 'external-integration',
          actorRole: null,
          subject: 'external',
          outcome: event.outcome,
          detail: event.detail,
        })
        .catch((err) => console.error('[external] audit append failed:', err));
    },

    /**
     * The gate every external answer passes through.
     *
     * An integration must not become the way around a halt or a suspension. A
     * halted estate refuses BEFORE anything about the tenant is checked, so a
     * caller cannot learn their tenant's state from a halted system.
     */
    constitutionalGate: ({ route }) => {
      if (constitution.engine.sanctions.halted) {
        return {
          permitted: false,
          reason: 'A human halt is in force under Article X §10.2. No answer is given while it stands.',
        };
      }
      if (!constitution.engine.inspectorate.hasQuorum) {
        return {
          permitted: false,
          reason: `The Inspectorate lacks quorum. ${route} is refused until it is seated.`,
        };
      }
      return { permitted: true };
    },

    inventory: async (tenantId) => {
      const assets = await store.assets.list(asTenantId(tenantId));
      // Deliberately a projection, not the row. An external integration gets
      // what it needs to reconcile; it does not get the internal shape to
      // depend on, and it never gets another tenant's anything.
      return assets.map((a) => ({
        assetId: a.asset_id,
        name: a.name,
        assetClass: a.asset_class,
        quantity: a.quantity,
        acquisitionPrice: a.acquisition_price,
        currentPrice: a.current_price,
        guaranteed: a.is_guaranteed,
        fundamentalsIntact: a.fundamentals_intact,
      }));
    },

    twin: async (tenantId) => {
      const graph = buildGraph(await store.nodes.list(asTenantId(tenantId)));
      return {
        hubs: [...graph.hubs.values()],
        factories: [...graph.factories.values()],
        warehouses: [...graph.warehouses.values()],
        issues: graph.issues,
      };
    },

    valuation: async (tenantId) => {
      const tenant = asTenantId(tenantId);
      const [nodes, assets] = await Promise.all([store.nodes.list(tenant), store.assets.list(tenant)]);
      const fees: FeeTable = {};
      for (const asset of assets) fees[asset.asset_class] = { buy: asset.buy_fees, sell: asset.sell_fees };
      return { valuation: valueEcosystem(buildGraph(nodes), fees), mandate: SPEC_MANDATE };
    },

    auditTrail: async (tenantId, limit) => {
      const entries = await store.audit.list(asTenantId(tenantId), limit);
      // The hashes are included on purpose: the point of a chained log is that
      // a third party can verify it themselves rather than take our word.
      return entries.map((e) => ({
        seq: e.seq,
        timestamp: e.timestamp,
        event: e.event,
        outcome: e.outcome,
        subject: e.subject,
        prevHash: e.prevHash,
        hash: e.hash,
      }));
    },
  });

  app.get('/api/v1', external.meta);
  app.get('/api/v1/routes', external.meta);
  app.get('/api/v1/inventory', external.authenticate(['inventory:read']), external.inventory);
  app.get('/api/v1/twin', external.authenticate(['twin:read']), external.twin);
  app.get('/api/v1/valuation', external.authenticate(['valuation:read']), external.valuation);
  app.get('/api/v1/audit', external.authenticate(['audit:read']), external.auditTrail);

  console.log(`[external] /api/v1 mounted — ${EXTERNAL_ROUTES.length} routes, all read-only.`);
}

/**
 * The twin as a computed graph.
 *
 * Everything here is derived from the vault on every request. That is a
 * deliberate choice over caching: the graph is small, the parse is
 * microseconds, and a cached twin that disagrees with the markdown a user just
 * edited is worse than no twin at all. If this ever gets slow, the fix is a
 * cache keyed on the vault's last-updated timestamp — not a second copy of the
 * data in its own tables.
 */
app.get(
  '/api/twin/graph',
  optionalAuth,
  wrap(async (req, res) => {
    const tenant = publicTenant(req);
    const [nodes, assets] = await Promise.all([store.nodes.list(tenant), store.assets.list(tenant)]);

    const graph = buildGraph(nodes);

    // Fee rates come from the asset table rather than the vault: they are a
    // property of the counterparty, not of the warehouse holding the goods.
    const fees: FeeTable = {};
    for (const asset of assets) {
      fees[asset.asset_class] = { buy: asset.buy_fees, sell: asset.sell_fees };
    }

    const valuation = valueEcosystem(graph, fees);

    res.json({
      hubs: [...graph.hubs.values()],
      factories: [...graph.factories.values()],
      warehouses: [...graph.warehouses.values()],
      issues: graph.issues,
      valuation,
      mandate: SPEC_MANDATE,
      derivedAt: new Date().toISOString(),
    });
  }),
);

// --------------------------------------------------------------------------
// Synchronizer telemetry
// --------------------------------------------------------------------------
app.get(
  '/api/sync/telemetry',
  optionalAuth,
  wrap(async (req, res) => {
    const spike = Math.random() < 0.04;
    const latency = spike ? Math.floor(210 + Math.random() * 180) : Math.floor(42 + Math.random() * 6);
    const tenant = publicTenant(req);
    const h266 = await store.assets.get(tenant, 'AST-H266-001');

    /*
     * The chain head is REAL, and it replaces four random bytes that were being
     * rendered to the operator as "Cryptographic Proof" beside a shield icon.
     *
     * Four random bytes prove nothing, are not SHA-3, and are not a hash of
     * anything. Worse, showing a fake proof next to a shield devalues the
     * genuine guarantee this system does have: a hash-chained, verified-on-read
     * audit log. This now surfaces that chain's actual head.
     *
     * The latency figure below is still generated. It is labelled as such in
     * the UI rather than dressed up.
     */
    const chain = await store.audit.verify(tenant);
    const head = (await store.audit.list(tenant, 1))[0];

    res.json({
      timestamp: new Date().toISOString(),
      latencyMs: latency,
      targetNode: '30_Logistics_Nodes/Warehouse-Midwest-Alpha.md',
      status: latency > 200 ? 'REPLICATING' : 'SYNCED',
      bidFloor: h266?.active_offer ?? h266?.current_price ?? 16.8,
      auditChain: {
        ok: chain.ok,
        entries: chain.entries,
        /** Head of the tenant's hash chain. A real SHA-256 over real entries. */
        head: head?.hash ?? null,
      },
      activeThroughputFps: 24000,
      activeHz: 192000,
      /** The latency series is modelled; the audit chain above is not. */
      latencySimulated: true,
    });
  }),
);

// --------------------------------------------------------------------------
// Static hosting / dev middleware
// --------------------------------------------------------------------------
app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route.' }));

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[error]', err);
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large.' });
  res.status(500).json({ error: 'Internal server error.' });
});

async function startServer() {
  /*
   * Boot runs unscoped, and says why.
   *
   * Creating the schema, creating the FIRST tenant, and verifying every
   * tenant's chain are all work that legitimately has no tenant — there is
   * nothing to scope to until they finish. `runAsSystem` is the honest name for
   * that: it is a bypass, it is auditable, and what limits the damage is that
   * nothing reachable from a request runs inside one.
   */
  const initialised = await runAsSystem('boot: schema, first tenant, constitution', async () =>
    initialiseStore(await createStore()),
  );
  store = initialised.store;
  defaultTenant = initialised.defaultTenant;
  console.log(
    `[V12 Apex Atlas] storage backend: ${store.dialect} · tenancy: ${MULTI_TENANT ? 'multi' : 'single'}` +
      ` · default tenant: ${defaultTenant.slug} (${defaultTenant.plan})`,
  );

  // -------------------------------------------------------------------------
  // V12-CONST-001, Article I §1.2/§1.3.
  //
  // This runs BEFORE the first route is served and AFTER the store is known,
  // because Article II §2.1 is a question about the storage backend. It either
  // returns an engine or terminates the process — there is no third outcome and
  // no flag that produces one.
  // -------------------------------------------------------------------------
  constitution = bootConstitution({
    posture: {
      posture: IS_PROD ? 'production' : 'development',
      storageBackend: store.dialect,
      // Article VII §7.2. No Sentinel classifier is wired into this deployment
      // yet, so every ingress decision that requires one is DENIED rather than
      // assumed clean (§1.5). Stating it here keeps it visible instead of
      // letting a `true` default make Schedule A decorative.
      classifierAvailable: false,
      halted: false,
    },
    audit: (event) => {
      void store.audit
        .append(defaultTenant.id, {
          event: event.type,
          // Article XI §11.4 — the responsible agent identity is the actor, so
          // a violation is attributable in the chain rather than anonymous.
          actorId: event.agentId,
          actorName: event.agentId,
          actorRole: 'agent',
          subject: `Article ${event.article} ${event.section}`,
          outcome: 'refused',
          detail: {
            severity: event.severity,
            article: `Article ${event.article} ${event.section}`,
            agentId: event.agentId,
            payloadDigest: event.payloadDigest,
            sanction: event.sanction ?? null,
            detail: event.detail,
          },
        })
        // Article XI §11.4 requires the record. If it cannot be written the
        // violation is still surfaced rather than swallowed.
        .catch((err) => console.error('[constitution] AUDIT APPEND FAILED:', err, event));
    },
  });

  const chain = await store.audit.verifyAll();
  if (!chain.ok) {
    console.error(`[V12 Apex Atlas] AUDIT CHAIN BROKEN for tenant(s): ${chain.broken.join(', ')}`);
  }

  // Warm the default tenant so a single-tenant deployment reconciles at boot
  // rather than on first request. Other tenants spin up lazily.
  const boot = await runtimeFor(defaultTenant.id);
  console.log(
    `[V12 Apex Atlas] assets: marketplace=${boot.marketplace.id}` +
      `${boot.risk.isHalted ? ' (HALTED)' : ''}`,
  );

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const clientDir = path.join(process.cwd(), 'dist', 'client');

    // The intro film and the logo derivatives are content-stable build
    // artefacts and are the largest thing a first visit downloads. A one-hour
    // TTL means a returning visitor re-fetches 2.4 MB of video for nothing.
    app.use(
      '/media',
      express.static(path.join(clientDir, 'media'), { maxAge: '30d', immutable: true, index: false }),
    );
    app.use(express.static(clientDir, { maxAge: '1h', index: false }));
    app.get('*', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  }

  const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`[V12 Apex Atlas] listening on http://0.0.0.0:${PORT} (${IS_PROD ? 'production' : 'development'})`);
    if (!hasApiKey()) console.log('[V12 Apex Atlas] GEMINI_API_KEY not set — model features run in fallback mode.');
  });

  const shutdown = async (signal: string) => {
    console.log(`[V12 Apex Atlas] ${signal} received, shutting down.`);
    server.close();
    await Promise.all([...runtimes.values()].map((r) => r.stop().catch(() => undefined)));
    await store.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

startServer().catch((err) => {
  console.error('[fatal] Server failed to start:', err);
  process.exit(1);
});
