/**
 * External integration keys — how an application that is NOT part of V12
 * authenticates to Apex Atlas.
 *
 * WHY THIS IS NOT THE ECOSYSTEM MECHANISM
 * ---------------------------------------
 * Ecosystem members hold Ed25519 identities in a registry Apex does not
 * maintain. An external integrator has none of that, and requiring it would
 * mean either issuing them a place in someone else's registry or inventing a
 * second-class membership. Both are worse than the boring answer: a scoped API
 * key, issued by Apex, revocable by Apex, bound to one tenant.
 *
 * The key is presented as `Authorization: Bearer apex_<id>_<secret>`. The id is
 * a lookup handle and is stored in the clear; the secret is stored ONLY as a
 * SHA-256 hash. A leaked database therefore yields no working key, and Apex
 * genuinely cannot tell a customer their own key back — which is the correct
 * answer to that request, and the reason the issuing call is the one and only
 * time the plaintext exists.
 *
 * SCOPES ARE DENY-BY-DEFAULT AND NOT HIERARCHICAL
 * -----------------------------------------------
 * A key holds an explicit list. `inventory:read` does not imply
 * `inventory:write`, and there is no `admin` or `*` scope, because a wildcard
 * scope is how a read-only integration quietly becomes a write one after a
 * refactor nobody reviewed.
 */

import crypto from 'crypto';

/** Every scope Apex will issue. Adding one is a deliberate act with a review. */
export const SCOPES = [
  'inventory:read',
  'twin:read',
  'valuation:read',
  'audit:read',
  'webhook:receive',
] as const;
export type Scope = (typeof SCOPES)[number];

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

export interface ExternalKeyRecord {
  /** Public handle, safe to log and to show in a dashboard. */
  keyId: string;
  /** SHA-256 of the secret half. The secret itself is never stored. */
  secretHash: string;
  tenantId: string;
  label: string;
  scopes: Scope[];
  createdAt: number;
  /** Null means it does not expire. Prefer an expiry. */
  expiresAt: number | null;
  revokedAt: number | null;
  /** Requests per minute. Per key, not per tenant — one noisy integration must not starve another. */
  ratePerMinute: number;
}

export interface IssuedKey {
  record: ExternalKeyRecord;
  /** Shown ONCE. Apex cannot recover it afterwards, by design. */
  plaintext: string;
}

const PREFIX = 'apex';
/** Excludes 0/O/1/I/L — these get read aloud and typed by hand. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789abcdefghijkmnpqrstuvwxyz';

function randomToken(length: number): string {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export const hashSecret = (secret: string): string => crypto.createHash('sha256').update(secret).digest('hex');

export function issueKey(args: {
  tenantId: string;
  label: string;
  scopes: Scope[];
  ratePerMinute?: number;
  expiresInDays?: number | null;
  now?: number;
}): IssuedKey {
  if (args.scopes.length === 0) {
    // A key that can do nothing is not a safe default, it is a support ticket.
    throw new Error('An external key must carry at least one scope.');
  }
  for (const scope of args.scopes) {
    if (!isScope(scope)) throw new Error(`Unknown scope "${scope}".`);
  }

  const now = args.now ?? Date.now();
  const keyId = randomToken(12);
  const secret = randomToken(40);

  return {
    plaintext: `${PREFIX}_${keyId}_${secret}`,
    record: {
      keyId,
      secretHash: hashSecret(secret),
      tenantId: args.tenantId,
      label: args.label,
      scopes: [...args.scopes],
      createdAt: now,
      expiresAt: args.expiresInDays === null ? null : now + (args.expiresInDays ?? 90) * 86_400_000,
      revokedAt: null,
      ratePerMinute: args.ratePerMinute ?? 60,
    },
  };
}

export type KeyFailure = 'malformed' | 'unknown' | 'revoked' | 'expired' | 'bad_secret' | 'insufficient_scope';

export type KeyVerification =
  | { ok: true; record: ExternalKeyRecord }
  | { ok: false; reason: KeyFailure };

export function parsePresented(presented: string | undefined): { keyId: string; secret: string } | null {
  if (!presented) return null;
  const token = presented.startsWith('Bearer ') ? presented.slice(7).trim() : presented.trim();
  const parts = token.split('_');
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return null;
  return { keyId: parts[1], secret: parts[2] };
}

/** Where a key record comes from. Async, because the truth is a database row. */
export type KeyLookup = (keyId: string) => Promise<ExternalKeyRecord | null | undefined>;

/**
 * Verify a presented key against its record.
 *
 * The lookup is ASYNC and hits storage on every request, deliberately. An
 * in-process cache would be faster and would mean a revoked key kept working
 * until the cache expired — on every instance that had already loaded it. A
 * revocation that takes effect "shortly" is not a revocation, and this is one
 * database read on a route that is already doing several.
 *
 * The secret comparison is constant-time. It matters less than usual here
 * because the compared values are hashes of a 40-character random string, but
 * timing-safe comparison costs nothing and the habit is worth more than the
 * micro-optimisation.
 */
export async function verifyKey(
  presented: string | undefined,
  lookup: KeyLookup,
  required: Scope[],
  now: number = Date.now(),
): Promise<KeyVerification> {
  const parsed = parsePresented(presented);
  if (!parsed) return { ok: false, reason: 'malformed' };

  const record = await lookup(parsed.keyId);
  if (!record) return { ok: false, reason: 'unknown' };
  if (record.revokedAt !== null) return { ok: false, reason: 'revoked' };
  if (record.expiresAt !== null && now > record.expiresAt) return { ok: false, reason: 'expired' };

  const presentedHash = Buffer.from(hashSecret(parsed.secret), 'hex');
  const storedHash = Buffer.from(record.secretHash, 'hex');
  if (presentedHash.length !== storedHash.length || !crypto.timingSafeEqual(presentedHash, storedHash)) {
    return { ok: false, reason: 'bad_secret' };
  }

  // Scope is checked AFTER authentication, so an unauthenticated caller cannot
  // learn which scopes exist by probing for a different error.
  for (const scope of required) {
    if (!record.scopes.includes(scope)) return { ok: false, reason: 'insufficient_scope' };
  }

  return { ok: true, record };
}

/**
 * Per-key rate limiting.
 *
 * Per KEY rather than per tenant or per IP: a tenant with two integrations
 * should not have one starve the other, and an IP is not an identity when every
 * caller is behind a cloud NAT.
 *
 * KNOWN LIMIT: in-process, like everything else here. Two Apex instances each
 * allow the full rate. Shared storage before a second instance runs.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  check(keyId: string, limitPerMinute: number, now: number = Date.now()): { allowed: boolean; retryAfterMs: number; remaining: number } {
    const window = this.windows.get(keyId);

    if (!window || now >= window.resetAt) {
      this.windows.set(keyId, { count: 1, resetAt: now + 60_000 });
      return { allowed: true, retryAfterMs: 0, remaining: limitPerMinute - 1 };
    }

    if (window.count >= limitPerMinute) {
      return { allowed: false, retryAfterMs: window.resetAt - now, remaining: 0 };
    }

    window.count += 1;
    return { allowed: true, retryAfterMs: 0, remaining: limitPerMinute - window.count };
  }
}
