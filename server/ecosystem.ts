/**
 * Inbound side of the Orion ecosystem: other apps calling this one.
 *
 * WHAT THIS APP TRUSTS, AND WHAT IT DOES NOT
 * ------------------------------------------
 * When Nexion relays to `v12-apex-atlas`, this app does **not** verify Nexion.
 * It has no way to and should not want one: verifying Nexion directly would
 * mean holding Nexion key material, and an estate where every member holds
 * something of every other member's is an estate where one breach is all of
 * them.
 *
 * It verifies **Orion**, using Orion's PUBLIC key, and reads the caller's
 * identity out of Orion's signed claims. Nothing symmetric exists anywhere in
 * this path: this app holds no secret of Orion's, so compromising this app
 * yields no ability to forge Orion, and compromising Orion yields no ability to
 * be this app.
 *
 * GOVERNANCE IS LOCAL, AND THIS IS THE POINT
 * ------------------------------------------
 * Orion decides what it is willing to *route*. This application decides,
 * independently, what it is willing to *accept* — and it can and does refuse
 * calls the broker was happy to carry.
 *
 * That is not redundancy to be optimised away. Apex Atlas is a MEMBER of the
 * V12 ecosystem on equal terms with Nexion, V12 OS, Orion Prime and CEOS, and
 * it is independently governed — those are not in tension. Membership decides
 * who may reach whom; governance decides who says yes. If this app's inbound
 * policy lived in the broker's registry, its security boundary would be
 * somebody else's configuration file. `ORION_ALLOWED_CALLERS` and the route
 * allowlist below are this app's own controls, owned by whoever owns this app.
 *
 * The outbound half — this app calling its peers — is `server/orion-client.ts`.
 * A member initiates as well as receives.
 *
 * WHAT THE TOKEN GUARANTEES
 * -------------------------
 * The relay token is bound to the caller, the target, the method, the exact
 * path and a hash of the body. So a token minted for `POST /api/ecosystem/ping`
 * cannot be presented on `/api/execution/order`, and the body cannot be swapped
 * after Orion authorised it. It expires in 60 seconds.
 *
 * WHAT IS EXPOSED
 * ---------------
 * Deliberately almost nothing. This is a surface other systems can reach, so it
 * carries only what an ecosystem peer legitimately needs: liveness, a
 * capability listing, and a read-only summary of the twin. No mutation, no
 * tenant data, no ledger writes. Extending it is a decision to be made one
 * route at a time, with the same question each time: what happens when the
 * calling app is compromised?
 */

import crypto from 'crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Kept in step with orion/src/identity.ts. The contract is in orion/README.md. */
const sha256 = (input: string): string => crypto.createHash('sha256').update(input ?? '').digest('hex');

export interface RelayClaims {
  realm: string;
  caller: string;
  target: string;
  method: string;
  path: string;
  bodyHash: string;
  expiresAt: number;
  traceId: string;
}

export type RelayFailure =
  | 'not_configured'
  | 'missing_token'
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'wrong_target'
  | 'wrong_realm'
  | 'wrong_request'
  | 'caller_not_allowed'
  | 'route_not_allowed';

export type RelayVerification = { ok: true; claims: RelayClaims } | { ok: false; reason: RelayFailure };

export interface EcosystemConfig {
  /** This app's identifier in the Orion registry. */
  appId: string;
  /** The ecosystem this app answers within. A token from another realm is refused. */
  realm: string;
  /**
   * Orion's PUBLIC key. Null disables the whole inbound surface.
   *
   * Public, so it can sit in configuration, in a repository, in a container
   * image. There is nothing here worth stealing, which is the entire benefit of
   * the asymmetric design.
   */
  orionPublicKey: string | null;
  /**
   * Which members may reach this app. EMPTY MEANS NONE.
   *
   * Deliberately deny-by-default rather than "any caller Orion authorised".
   * Trusting the broker's allowlist as the only control would make another
   * team's configuration file this application's security boundary — which is
   * exactly the coupling that separate governance is meant to prevent.
   */
  allowedCallers: string[];
  /** Which of this app's routes are reachable from the ecosystem at all. */
  allowedRoutes: string[];
}

/** The only routes this app is willing to expose, whatever the broker says. */
const DEFAULT_ROUTES = ['/api/ecosystem/ping', '/api/ecosystem/capabilities'];

export function ecosystemConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EcosystemConfig {
  const publicKey = env.ORION_PUBLIC_KEY?.trim() || null;

  const callers = (env.ORION_ALLOWED_CALLERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (publicKey && callers.length === 0) {
    // Configured to listen, but nobody may call. Almost certainly a mistake,
    // and one that fails closed — so it is a warning rather than a refusal to
    // boot, and it is said out loud rather than left to be discovered.
    console.warn(
      '[ecosystem] ORION_PUBLIC_KEY is set but ORION_ALLOWED_CALLERS is empty — ' +
        'every inbound relay will be refused. This app governs its own inbound policy.',
    );
  }

  return {
    appId: env.ORION_APP_ID?.trim() || 'v12-apex-atlas',
    realm: env.ORION_REALM?.trim() || 'v12-ecosystem',
    orionPublicKey: publicKey,
    allowedCallers: callers,
    allowedRoutes: (env.ORION_ALLOWED_ROUTES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .concat(DEFAULT_ROUTES)
      .filter((v, i, a) => a.indexOf(v) === i),
  };
}

export function verifyRelay(args: {
  token: string | undefined;
  config: EcosystemConfig;
  method: string;
  path: string;
  body: string;
  now?: number;
}): RelayVerification {
  if (!args.config.orionPublicKey) return { ok: false, reason: 'not_configured' };
  if (!args.token) return { ok: false, reason: 'missing_token' };

  const [payload, signature] = args.token.split('.');
  if (!payload || !signature) return { ok: false, reason: 'malformed' };

  let verified = false;
  try {
    verified = crypto.verify(
      null,
      Buffer.from(payload, 'utf8'),
      crypto.createPublicKey({
        key: Buffer.from(args.config.orionPublicKey, 'base64'),
        format: 'der',
        type: 'spki',
      }),
      Buffer.from(signature, 'base64url'),
    );
  } catch {
    // A malformed key or signature is a failed verification, not a crash. This
    // path is reachable by anyone who can set a header.
    return { ok: false, reason: 'malformed' };
  }
  if (!verified) return { ok: false, reason: 'bad_signature' };

  let claims: RelayClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // --- Orion's assertions, checked against the request actually in front of us
  if ((args.now ?? Date.now()) > claims.expiresAt) return { ok: false, reason: 'expired' };
  if (claims.target !== args.config.appId) return { ok: false, reason: 'wrong_target' };
  if (claims.realm !== args.config.realm) return { ok: false, reason: 'wrong_realm' };
  if (claims.method.toUpperCase() !== args.method.toUpperCase() || claims.path !== args.path) {
    return { ok: false, reason: 'wrong_request' };
  }
  if (claims.bodyHash !== sha256(args.body)) return { ok: false, reason: 'wrong_request' };

  // --- THIS APP'S OWN POLICY, applied after and independently of the broker's
  // Deny by default. Orion having been willing to route the call is not this
  // application's decision to accept it.
  if (!args.config.allowedCallers.includes(claims.caller)) {
    return { ok: false, reason: 'caller_not_allowed' };
  }
  // The route allowlist matches the PATH, not the query string — an allowlist
  // that had to enumerate query strings would be unmaintainable, and the query
  // is already covered by the signature above.
  const pathname = args.path.split('?')[0];
  if (!args.config.allowedRoutes.includes(pathname)) {
    return { ok: false, reason: 'route_not_allowed' };
  }

  return { ok: true, claims };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      relay?: RelayClaims;
    }
  }
}

export interface EcosystemDeps {
  config: EcosystemConfig;
  /** Records the call. Failures here must not block the response. */
  audit: (event: string, outcome: 'allowed' | 'refused', detail: Record<string, unknown>) => void;
  /** Read-only twin summary for the capabilities surface. */
  summary: () => Promise<Record<string, unknown>>;
}

export function createEcosystemRoutes({ config, audit, summary }: EcosystemDeps) {
  const authenticate: RequestHandler = (req, res, next) => {
    const result = verifyRelay({
      token: req.header('x-orion-relay') ?? undefined,
      config,
      method: req.method,
      // The full URL including any query string — same reasoning as Orion's
      // verifier. A signature that covers only the path leaves query
      // parameters rewritable in flight.
      path: req.originalUrl,
      // Express has already parsed the body, so it is re-serialised here. The
      // hash Orion signed was computed over ITS serialisation of the same
      // object, so this holds for JSON that round-trips — which is everything
      // Orion sends, because Orion builds the body itself.
      body: req.method === 'GET' || req.method === 'HEAD' ? '' : JSON.stringify(req.body ?? {}),
    });

    if (!result.ok) {
      audit('ecosystem.refused', 'refused', {
        reason: result.reason,
        path: req.path,
        ip: req.ip ?? null,
        // Whether the refusal was ours or the broker's matters when someone is
        // debugging why a permitted-looking relay fails.
        refusedBy: result.reason === 'caller_not_allowed' || result.reason === 'route_not_allowed' ? 'local-policy' : 'signature',
      });
      // One status, one message. Distinguishing "expired" from "wrong target"
      // would let a caller probe this app's configuration.
      return res.status(403).json({ error: 'Relay rejected.' });
    }

    req.relay = result.claims;
    next();
  };

  const wrap =
    (fn: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => {
      void fn(req, res).catch(next);
    };

  return {
    authenticate,

    /** Liveness for the ecosystem. The one route every broker health check hits. */
    ping: wrap(async (req, res) => {
      audit('ecosystem.ping', 'allowed', { caller: req.relay!.caller, traceId: req.relay!.traceId });
      res.json({
        app: config.appId,
        name: 'V12 Apex Atlas',
        pong: true,
        respondedAt: new Date().toISOString(),
        caller: req.relay!.caller,
        realm: req.relay!.realm,
        traceId: req.relay!.traceId,
      });
    }),

    /**
     * What this app can do for the ecosystem.
     *
     * Capabilities, not data. A peer discovering "this app knows about media
     * inventory" is useful; a peer reading the inventory is a decision nobody
     * has made yet.
     */
    capabilities: wrap(async (req, res) => {
      audit('ecosystem.capabilities', 'allowed', { caller: req.relay!.caller, traceId: req.relay!.traceId });
      res.json({
        app: config.appId,
        capabilities: [
          { id: 'media-inventory', description: 'Media asset holdings, acquisition cost and mandate verdicts' },
          { id: 'digital-twin', description: 'Production and logistics graph derived from the vault' },
          { id: 'audit', description: 'Hash-chained record of every settlement decision and refusal' },
        ],
        summary: await summary(),
        traceId: req.relay!.traceId,
      });
    }),
  };
}
