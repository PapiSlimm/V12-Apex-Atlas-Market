/**
 * Outbound side of the ecosystem: this app calling other members, through Orion.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Because Apex Atlas is a MEMBER of the V12 ecosystem, on equal terms with
 * Nexion, V12 OS, Orion Prime and CEOS — not something that sits outside it and
 * answers when spoken to. I originally modelled it as a sibling of the
 * ecosystem, and the cost of that mistake was precisely this file: an app that
 * could be called but could not call. Membership is symmetric.
 *
 * Independence is preserved somewhere else entirely, and it is worth being
 * precise about where: in `server/ecosystem.ts`, this app refuses inbound
 * callers and routes by default and answers to no other product's
 * configuration. That is what independent means. It never meant "cannot
 * initiate".
 *
 * WHAT THIS SENDS
 * ---------------
 * A signature over a canonical string, and nothing else that identifies a
 * tenant, a user or a holding. Apex's private key signs; it is never
 * transmitted, never logged, and never written to the audit record.
 *
 * The wire contract is `orion/README.md` and this is deliberately a second,
 * independent implementation of it rather than a shared import. Two products
 * that share a signing library share a failure: an accidental change to the
 * canonical string breaks nothing visibly, because both sides changed together.
 * Kept separate, a divergence shows up as a 401 in a test instead of as a
 * silently weakened signature in production.
 */

import crypto from 'crypto';

const PROTOCOL = 'orion-v2';
const DEFAULT_TIMEOUT_MS = 8_000;
/** Bounded so a compromised or confused broker cannot exhaust this process. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface OrionClientConfig {
  /** Base URL of the broker. Null disables every outbound call. */
  orionUrl: string | null;
  appId: string;
  realm: string;
  /** THIS app's private key. Never leaves this process. */
  privateKey: string | null;
  timeoutMs: number;
}

export type OrionErrorKind =
  | 'disabled'
  | 'unauthorised'
  | 'forbidden'
  | 'bad_request'
  | 'not_found'
  | 'unavailable'
  | 'timeout'
  | 'network_error'
  | 'bad_response';

export class OrionError extends Error {
  constructor(
    readonly kind: OrionErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OrionError';
  }
}

export function orionClientConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OrionClientConfig {
  const raw = env.ORION_URL?.trim();
  let orionUrl: string | null = null;

  if (raw) {
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
        console.warn('[orion-client] ORION_URL must be https (or localhost) — outbound calls disabled.');
      } else {
        orionUrl = url.origin;
      }
    } catch {
      console.warn('[orion-client] ORION_URL is not a valid URL — outbound calls disabled.');
    }
  }

  const privateKey = env.ORION_PRIVATE_KEY?.trim() || null;

  if (orionUrl && !privateKey) {
    console.warn('[orion-client] ORION_URL is set but ORION_PRIVATE_KEY is not — outbound calls disabled.');
  }

  const timeout = Number(env.ORION_TIMEOUT_MS);
  return {
    orionUrl: privateKey ? orionUrl : null,
    appId: env.ORION_APP_ID?.trim() || 'v12-apex-atlas',
    realm: env.ORION_REALM?.trim() || 'v12-ecosystem',
    privateKey,
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

const sha256 = (input: string): string => crypto.createHash('sha256').update(input ?? '').digest('hex');

/**
 * The canonical string, byte for byte as `orion/README.md` specifies.
 *
 * `requestTarget` is the full path INCLUDING the query string. Signing only the
 * path leaves every query parameter rewritable in flight — that was a real bug,
 * found by a call that took a `limit`.
 */
export function canonicalString(parts: {
  realm: string;
  appId: string;
  method: string;
  requestTarget: string;
  body: string;
  timestamp: string;
  nonce: string;
}): string {
  return [
    PROTOCOL,
    parts.realm,
    parts.appId,
    parts.method.toUpperCase(),
    parts.requestTarget,
    sha256(parts.body),
    parts.timestamp,
    parts.nonce,
  ].join('\n');
}

export interface AskResult {
  answer: string;
  routedTo: string;
  agentName: string;
  confidence: number;
  fellBack: boolean;
  reasoning?: string;
}

export interface RelayResult {
  status: number;
  body: unknown;
  traceId: string;
}

export class OrionClient {
  constructor(
    private readonly config: OrionClientConfig,
    /** Injected so tests exercise the real signing path without a global. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return Boolean(this.config.orionUrl && this.config.privateKey);
  }

  /** Route a prompt to whichever agent the broker scores highest. */
  ask(prompt: string): Promise<AskResult> {
    return this.call<AskResult>('POST', '/v1/ask', { prompt }, true);
  }

  /** Address one agent by name. */
  agent(agentId: string, prompt: string): Promise<AskResult> {
    return this.call<AskResult>('POST', '/v1/agent', { agentId, prompt }, true);
  }

  /**
   * Call another member through the broker.
   *
   * NEVER RETRIED, at any level. Orion may have delivered the request and lost
   * the response, and this side cannot know whether the target's handler is
   * idempotent. Repeating it is how one payout becomes two.
   */
  relay(target: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<RelayResult> {
    return this.call<RelayResult>(
      'POST',
      '/v1/relay',
      { target, path, method: init.method ?? 'GET', body: init.body },
      false,
    );
  }

  private async call<T>(method: string, requestTarget: string, payload: unknown, idempotent: boolean): Promise<T> {
    if (!this.enabled) {
      throw new OrionError('disabled', 'Orion is not configured for this deployment.');
    }

    const attempts = idempotent ? 3 : 1;
    let lastError: OrionError | null = null;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.once<T>(method, requestTarget, payload);
      } catch (err) {
        const error = err instanceof OrionError ? err : new OrionError('network_error', String(err));
        // Only transport faults are worth another attempt. A 401 or a 403 will
        // be a 401 or a 403 next time too, and retrying an authorisation
        // failure is how a misconfiguration becomes a lockout.
        const retryable = error.kind === 'timeout' || error.kind === 'network_error' || error.kind === 'unavailable';
        if (!retryable || attempt === attempts - 1) throw error;
        lastError = error;
        // Jittered backoff. Every attempt re-signs with a FRESH nonce and
        // timestamp — reusing them would be rejected as a replay, which is the
        // system working correctly and would look like an outage.
        const backoff = 150 * 2 ** attempt + Math.floor(Math.random() * 100);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }

    throw lastError ?? new OrionError('network_error', 'unreachable');
  }

  private async once<T>(method: string, requestTarget: string, payload: unknown): Promise<T> {
    const body = JSON.stringify(payload ?? {});
    const timestamp = String(Date.now());
    const nonce = crypto.randomUUID();

    const canonical = canonicalString({
      realm: this.config.realm,
      appId: this.config.appId,
      method,
      requestTarget,
      body,
      timestamp,
      nonce,
    });

    const signature = crypto
      .sign(null, Buffer.from(canonical, 'utf8'), crypto.createPrivateKey({
        key: Buffer.from(this.config.privateKey!, 'base64'),
        format: 'der',
        type: 'pkcs8',
      }))
      .toString('base64');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.config.orionUrl}${requestTarget}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-orion-realm': this.config.realm,
          'x-orion-app': this.config.appId,
          'x-orion-timestamp': timestamp,
          'x-orion-nonce': nonce,
          'x-orion-signature': signature,
        },
        body,
        signal: controller.signal,
        // A redirect could carry a signed request to a host nobody authorised.
        redirect: 'manual',
      });

      const text = (await response.text()).slice(0, MAX_RESPONSE_BYTES);

      if (!response.ok) {
        throw new OrionError(statusToKind(response.status), messageFrom(text, response.status), response.status);
      }

      try {
        return JSON.parse(text) as T;
      } catch {
        throw new OrionError('bad_response', 'Orion returned a body that is not JSON.', response.status);
      }
    } catch (err) {
      if (err instanceof OrionError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new OrionError('timeout', `Orion did not respond within ${this.config.timeoutMs}ms.`);
      }
      throw new OrionError('network_error', err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(timer);
    }
  }
}

function statusToKind(status: number): OrionErrorKind {
  if (status === 401) return 'unauthorised';
  if (status === 403) return 'forbidden';
  if (status === 400) return 'bad_request';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'unavailable';
  return 'bad_response';
}

function messageFrom(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    if (typeof parsed.error === 'string') return parsed.error;
  } catch {
    /* a non-JSON error body is not itself an error worth raising */
  }
  return `Orion responded ${status}.`;
}
