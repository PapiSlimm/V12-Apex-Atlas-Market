/**
 * Outbound side: Apex Atlas looking at Orion Prime.
 *
 * WHAT ORION PRIME ACTUALLY IS
 * ----------------------------
 * A live, deployed multi-agent aggregator and operations console —
 * "ORION PRIME MEGA (O.P.M.)", version v12.4.0-MULTIMEDIA-ENTERPRISE. It is a
 * peer application under V12 Multimedia. It is NOT this application, it is not
 * a broker, and it is not something Apex depends on to function.
 *
 * WHY THIS MODULE IS SO SMALL
 * ---------------------------
 * Because only one thing about the live service has been VERIFIED:
 *
 *   GET /api/health -> {"status":"online","system":"ORION PRIME MEGA (O.P.M.)",
 *                       "version":"...","timestamp":"...","aiConnected":true}
 *
 * Every other path probed returned the console's own HTML, which means either
 * the route does not exist or it is POST-only and a GET fell through to the
 * single-page-app catch-all. Those two are indistinguishable from outside, so
 * this module implements the one call that is known and refuses to guess at the
 * rest. Guessed endpoints do not fail loudly; they fail in production, later,
 * to somebody else.
 *
 * The seam is here. When Orion Prime's route list is known, an adapter goes in
 * beside `health()` and nothing else in Apex has to move.
 *
 * WHAT THIS DOES NOT SEND
 * -----------------------
 * Nothing. No tenant data, no credentials, no keypair, no user content. This is
 * an unauthenticated liveness read of a public endpoint, and it stays that way
 * until there is a credential model to reason about. Apex and Orion Prime are
 * independently governed; an outbound call that carried Apex's identity would
 * quietly couple them.
 */

const DEFAULT_TIMEOUT_MS = 4_000;
/** A health document is a few hundred bytes. Anything larger is not one. */
const MAX_BYTES = 64 * 1024;

export interface OrionPrimeConfig {
  /** Base URL, no trailing slash. Null disables every call in this module. */
  baseUrl: string | null;
  timeoutMs: number;
}

export interface OrionPrimeHealth {
  status: string;
  system: string;
  version: string;
  timestamp: string;
  aiConnected: boolean;
}

export type OrionPrimeStatus =
  | { state: 'disabled' }
  | { state: 'online'; health: OrionPrimeHealth; latencyMs: number }
  | { state: 'unreachable'; reason: string; latencyMs: number };

export function orionPrimeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OrionPrimeConfig {
  const raw = env.ORION_PRIME_URL?.trim();
  let baseUrl: string | null = null;

  if (raw) {
    try {
      const url = new URL(raw);
      // http:// to a peer service over the public internet is a downgrade
      // waiting to happen. Refuse it here rather than discover it in a capture.
      if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        console.warn('[orion-prime] ORION_PRIME_URL must be https (or localhost) — ignoring it.');
      } else {
        baseUrl = url.origin;
      }
    } catch {
      console.warn('[orion-prime] ORION_PRIME_URL is not a valid URL — ignoring it.');
    }
  }

  const timeout = Number(env.ORION_PRIME_TIMEOUT_MS);
  return {
    baseUrl,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Liveness only.
 *
 * Never throws. A peer being down is a fact to display, not an exception for
 * Apex to propagate — this app works perfectly well with Orion Prime offline,
 * and a page that 500s because a sibling service is asleep is a page that has
 * made an optional dependency mandatory by accident.
 */
export async function checkOrionPrime(
  config: OrionPrimeConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<OrionPrimeStatus> {
  if (!config.baseUrl) return { state: 'disabled' };

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(`${config.baseUrl}/api/health`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
      // A redirect could carry this request to a host nobody authorised. There
      // is no legitimate reason for a health endpoint to redirect.
      redirect: 'manual',
    });

    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return { state: 'unreachable', reason: `http_${response.status}`, latencyMs };
    }

    const text = (await response.text()).slice(0, MAX_BYTES);

    // The console serves its own HTML for unknown routes, so a 200 is not
    // evidence of anything. Parse before believing.
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { state: 'unreachable', reason: 'not_json', latencyMs };
    }

    const body = parsed as Partial<OrionPrimeHealth>;
    if (typeof body?.status !== 'string' || typeof body?.system !== 'string') {
      return { state: 'unreachable', reason: 'unexpected_shape', latencyMs };
    }

    return {
      state: 'online',
      latencyMs,
      health: {
        status: body.status,
        system: body.system,
        version: typeof body.version === 'string' ? body.version : 'unknown',
        timestamp: typeof body.timestamp === 'string' ? body.timestamp : new Date().toISOString(),
        aiConnected: body.aiConnected === true,
      },
    };
  } catch (err) {
    const latencyMs = Date.now() - started;
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network_error';
    return { state: 'unreachable', reason, latencyMs };
  } finally {
    clearTimeout(timer);
  }
}
