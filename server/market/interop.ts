/**
 * Interoperability — letting an agent that already speaks AP2, ACP, x402 or MPP
 * trade in Apex without a bespoke integration.
 *
 * WHY THIS EXISTS
 * ---------------
 * A market nobody can reach is an island. The agentic-commerce world is
 * standardising on a small number of credential formats, and an outside agent
 * arriving with a valid AP2 Intent Mandate should not have to be re-plumbed to
 * do business here.
 *
 * THE GOVERNING RULE, AND IT IS THE WHOLE FILE
 * --------------------------------------------
 *   A foreign credential is EVIDENCE OF AUTHORISATION. It is never authority.
 *
 * This mirrors how Apex already treats the rest of the estate: Nexion, V12 OS,
 * ORION PRIME and CEOS are integrated and independent, and a request from one of
 * them is a request, not a command. The same posture applies at the outer
 * boundary, and more strictly, because the issuer is a stranger.
 *
 * Concretely, three things are made structural rather than left to discipline:
 *
 *   1. AN IMPORT CANNOT PRODUCE A SIGNED APEX MANDATE. `importIntentMandate`
 *      returns a `DraftMandate`, which has no `signature` field and therefore
 *      cannot be passed to `checkMandate`. A principal must counter-sign it with
 *      a key Apex does not hold. The type system enforces what a comment cannot.
 *
 *   2. THE FOREIGN PAYLOAD CANNOT SET THE PRICE OR THE FEE. Gross is recomputed
 *      from unit price × quantity and refused if the stated total disagrees; the
 *      market fee is always Apex's own schedule. An imported cart proposes; it
 *      does not price.
 *
 *   3. THE TOKEN CANNOT CHOOSE ITS OWN ALGORITHM. The signature algorithm and
 *      key id come from the registered issuer, and a token whose header disagrees
 *      is refused. `alg: none` and every HMAC algorithm are refused outright —
 *      a symmetric secret means the verifier could have minted the credential it
 *      is verifying, which is not evidence of anything.
 *
 * ARTICLE III AT THE BOUNDARY
 * ---------------------------
 * AP2 and ACP carry money as JSON numbers. By the time `JSON.parse` hands you
 * `45.99` the value is an IEEE-754 double and the loss has already happened —
 * downstream care cannot recover it. So this module parses the raw JSON TEXT
 * with its own reader that keeps every number as its literal digits, and
 * monetary fields are converted from those digits straight to `Minor`. A
 * JavaScript `number` reaching an amount field is refused, never converted.
 *
 * The same reader refuses duplicate object keys. Two parsers disagreeing about
 * which `"total"` wins is a real way to smuggle one price past a validator and a
 * different one into a ledger.
 *
 * WHAT IS DELIBERATELY NOT SUPPORTED
 * ----------------------------------
 * x402 settles on-chain in stablecoin. Apex is not a crypto broker and does not
 * hold, transfer or price digital assets; that excision was deliberate and it
 * stands. x402 is therefore RECOGNISED and REFUSED with a stated reason, so an
 * inbound agent gets an answer it can act on instead of a stack trace.
 */

import crypto from 'crypto';
import { toDecimalString, type Minor } from '../constitution/money';
import type { Signature, Terms } from './agreement';
import type { Mandate } from './mandate';
import { participantId, type FeeSchedule, type ParticipantId } from './types';

/* ------------------------------------------------------------------ *
 * Protocols
 * ------------------------------------------------------------------ */

export type ForeignProtocol = 'ap2' | 'acp' | 'x402' | 'mpp';

export type InteropRefusal =
  | 'unknown_protocol'
  | 'protocol_not_settleable'
  | 'malformed_payload'
  | 'duplicate_keys'
  | 'missing_field'
  | 'amount_is_float'
  | 'amount_not_decimal'
  | 'quantity_invalid'
  | 'total_mismatch'
  | 'currency_unsupported'
  | 'issuer_unregistered'
  | 'algorithm_not_permitted'
  | 'algorithm_mismatch'
  | 'key_mismatch'
  | 'signature_invalid'
  | 'no_expiry'
  | 'credential_expired'
  | 'clock_skew'
  | 'replayed'
  | 'scope_unbounded'
  | 'counterparty_not_admitted'
  | 'binds_nothing';

export interface RefusalDetail {
  reason: InteropRefusal;
  detail: string;
  /** What the sending side would have to change. Never just "no". */
  remedy: string;
}

export type Import<T> = { ok: true; value: T } | ({ ok: false } & RefusalDetail);

const no = (reason: InteropRefusal, detail: string, remedy: string): Import<never> => ({
  ok: false,
  reason,
  detail,
  remedy,
});

/* ------------------------------------------------------------------ *
 * A JSON reader that does not destroy money
 * ------------------------------------------------------------------ */

/**
 * A JSON number kept as the characters that were actually written.
 *
 * This is the only form a monetary field may arrive in. It exists because
 * `JSON.parse('{"v":45.99}').v` is already `45.990000000000002`-class garbage
 * for some literals, and no downstream rounding recovers the digits the sender
 * wrote.
 */
export class JsonNumber {
  constructor(readonly literal: string) {}
  toString(): string {
    return this.literal;
  }
}

class JsonReadError extends Error {
  constructor(
    readonly kind: 'malformed_payload' | 'duplicate_keys',
    message: string,
  ) {
    super(message);
  }
}

/**
 * Strict JSON reader.
 *
 * Differences from `JSON.parse`, all of them deliberate:
 *   - numbers become `JsonNumber`, preserving their literal digits;
 *   - duplicate object keys are an error rather than last-one-wins;
 *   - trailing content after the top-level value is an error.
 */
export function parseJsonStrict(text: string): unknown {
  let i = 0;

  const fail = (message: string): never => {
    throw new JsonReadError('malformed_payload', `${message} at offset ${i}`);
  };

  const ws = (): void => {
    while (i < text.length && (text[i] === ' ' || text[i] === '\n' || text[i] === '\r' || text[i] === '\t')) i += 1;
  };

  const literal = (word: string, value: unknown): unknown => {
    if (text.slice(i, i + word.length) !== word) fail(`expected ${word}`);
    i += word.length;
    return value;
  };

  const readString = (): string => {
    if (text[i] !== '"') fail('expected a string');
    i += 1;
    let out = '';
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"') {
        i += 1;
        return out;
      }
      if (ch === '\\') {
        i += 1;
        const esc = text[i];
        i += 1;
        switch (esc) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = text.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('bad \\u escape');
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default: fail('unknown escape');
        }
        continue;
      }
      if (ch < ' ') fail('unescaped control character');
      out += ch;
      i += 1;
    }
    return fail('unterminated string');
  };

  const readNumber = (): JsonNumber => {
    const start = i;
    if (text[i] === '-') i += 1;
    if (text[i] === '0') i += 1;
    else if (text[i] >= '1' && text[i] <= '9') while (text[i] >= '0' && text[i] <= '9') i += 1;
    else fail('expected a digit');
    if (text[i] === '.') {
      i += 1;
      if (!(text[i] >= '0' && text[i] <= '9')) fail('expected a digit after the decimal point');
      while (text[i] >= '0' && text[i] <= '9') i += 1;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i += 1;
      if (text[i] === '+' || text[i] === '-') i += 1;
      if (!(text[i] >= '0' && text[i] <= '9')) fail('expected a digit in the exponent');
      while (text[i] >= '0' && text[i] <= '9') i += 1;
    }
    return new JsonNumber(text.slice(start, i));
  };

  const readValue = (depth: number): unknown => {
    if (depth > 64) fail('nested too deeply');
    ws();
    const ch = text[i];
    if (ch === '{') {
      i += 1;
      const out: Record<string, unknown> = Object.create(null);
      ws();
      if (text[i] === '}') {
        i += 1;
        return out;
      }
      for (;;) {
        ws();
        const key = readString();
        if (Object.prototype.hasOwnProperty.call(out, key)) {
          throw new JsonReadError(
            'duplicate_keys',
            `the object carries "${key}" more than once; two readers could disagree about which value is real`,
          );
        }
        ws();
        if (text[i] !== ':') fail('expected ":"');
        i += 1;
        out[key] = readValue(depth + 1);
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] === '}') {
          i += 1;
          return out;
        }
        fail('expected "," or "}"');
      }
    }
    if (ch === '[') {
      i += 1;
      const out: unknown[] = [];
      ws();
      if (text[i] === ']') {
        i += 1;
        return out;
      }
      for (;;) {
        out.push(readValue(depth + 1));
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] === ']') {
          i += 1;
          return out;
        }
        fail('expected "," or "]"');
      }
    }
    if (ch === '"') return readString();
    if (ch === 't') return literal('true', true);
    if (ch === 'f') return literal('false', false);
    if (ch === 'n') return literal('null', null);
    if (ch === '-' || (ch >= '0' && ch <= '9')) return readNumber();
    return fail('unexpected character');
  };

  const value = readValue(0);
  ws();
  if (i !== text.length) fail('trailing content after the top-level value');
  return value;
}

/** Parse a foreign payload, turning reader errors into refusals. */
export function readPayload(text: string): Import<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = parseJsonStrict(text);
  } catch (err) {
    if (err instanceof JsonReadError) {
      return no(
        err.kind,
        err.message,
        err.kind === 'duplicate_keys'
          ? 'Send each field once. Ambiguity about which value is authoritative is not resolvable in the receiver.'
          : 'Send well-formed JSON.',
      );
    }
    return no('malformed_payload', String(err), 'Send well-formed JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return no('malformed_payload', 'The top-level value is not a JSON object.', 'Send a JSON object.');
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

const field = (obj: Record<string, unknown>, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);

function requireString(obj: Record<string, unknown>, path: string): Import<string> {
  const value = field(obj, path);
  if (typeof value !== 'string' || value.length === 0) {
    return no('missing_field', `${path} is missing or is not a non-empty string.`, `Provide ${path}.`);
  }
  return { ok: true, value };
}

/**
 * A monetary field, converted from written digits to minor units.
 *
 * Accepts a `JsonNumber` (the literal the sender wrote) or a decimal string.
 * Refuses a JavaScript `number` outright: if one has reached here the payload
 * went through `JSON.parse` rather than `parseJsonStrict`, and the digits are
 * already gone.
 */
export function toMinor(value: unknown, fieldName: string, scale = 2): Import<Minor> {
  if (typeof value === 'number') {
    return no(
      'amount_is_float',
      `${fieldName} arrived as a JavaScript number. Article III §3.1 forbids floating point for money, and by this ` +
        'point the precision the sender wrote has already been lost.',
      'Read the payload with parseJsonStrict, which keeps a number\'s literal digits, or send the amount as a string.',
    );
  }
  const literal = value instanceof JsonNumber ? value.literal : typeof value === 'string' ? value.trim() : null;
  if (literal === null) {
    return no('missing_field', `${fieldName} is missing.`, `Provide ${fieldName} as a decimal amount.`);
  }
  if (!/^-?\d+(\.\d+)?$/.test(literal)) {
    return no(
      'amount_not_decimal',
      `${fieldName} is "${literal}", which is not a plain decimal amount. Exponent notation is refused for money.`,
      'Write the amount in full, e.g. "45.99".',
    );
  }
  const negative = literal.startsWith('-');
  const [whole, fraction = ''] = literal.replace('-', '').split('.');
  if (fraction.length > scale) {
    return no(
      'amount_not_decimal',
      `${fieldName} carries ${fraction.length} decimal places; the currency has ${scale}.`,
      `Round at source to ${scale} decimal places, deliberately, rather than letting the receiver choose.`,
    );
  }
  const minor = BigInt(whole) * BigInt(10 ** scale) + BigInt((fraction.padEnd(scale, '0')) || '0');
  return { ok: true, value: negative ? -minor : minor };
}

export function toCount(value: unknown, fieldName: string): Import<number> {
  const literal = value instanceof JsonNumber ? value.literal : typeof value === 'string' ? value.trim() : null;
  if (literal === null || !/^\d+$/.test(literal)) {
    return no('quantity_invalid', `${fieldName} must be a whole number of units.`, `Send ${fieldName} as an integer.`);
  }
  const count = Number(literal);
  if (!Number.isSafeInteger(count) || count <= 0) {
    return no('quantity_invalid', `${fieldName} must be a positive whole number.`, `Send ${fieldName} as a positive integer.`);
  }
  return { ok: true, value: count };
}

/* ------------------------------------------------------------------ *
 * Issuers and signatures
 * ------------------------------------------------------------------ */

/**
 * The algorithms Apex will verify a foreign credential with.
 *
 * All asymmetric, deliberately. An HMAC credential proves only that someone
 * holding the shared secret produced it — and the verifier holds that secret,
 * so it proves nothing about the sender at all. `none` needs no comment.
 */
export type PermittedAlg = 'EdDSA' | 'ES256' | 'ES256K';

const CURVE_FOR: Record<PermittedAlg, string | null> = {
  EdDSA: null, // Ed25519 keys report no namedCurve
  ES256: 'prime256v1',
  ES256K: 'secp256k1',
};

const PERMITTED: PermittedAlg[] = ['EdDSA', 'ES256', 'ES256K'];

/**
 * A counterparty's credential issuer, registered here BEFORE anything it signs
 * is trusted.
 *
 * `alg` and `kid` live on this record rather than being read from the token,
 * which is the fix for algorithm confusion: a token cannot nominate the
 * algorithm used to check it.
 */
export interface ForeignIssuer {
  issuerId: string;
  protocol: ForeignProtocol;
  alg: PermittedAlg;
  kid: string;
  /** SPKI DER, base64. */
  publicKeySpki: string;
  /** The admitted participant this issuer speaks for, if it speaks for one. */
  participant: ParticipantId | null;
}

const b64urlToBuffer = (s: string): Buffer => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export interface JwsParts {
  header: Record<string, unknown>;
  payloadText: string;
  payload: Record<string, unknown>;
}

/**
 * Verify a compact JWS the way AP2 carries `user_authorization`.
 *
 * The header is read only to CHECK it against the registered issuer, never to
 * decide anything. A mismatch is a refusal with its own reason code, because
 * "the token asked for a different algorithm than we pinned" is a much more
 * interesting event than "the signature did not verify" and should not be
 * flattened into it.
 */
export function verifyCompactJws(token: string, issuer: ForeignIssuer): Import<JwsParts> {
  if (!PERMITTED.includes(issuer.alg)) {
    return no(
      'algorithm_not_permitted',
      `Issuer ${issuer.issuerId} is registered with algorithm ${issuer.alg}, which Apex does not verify.`,
      `Register the issuer with one of: ${PERMITTED.join(', ')}.`,
    );
  }

  const segments = token.split('.');
  if (segments.length !== 3) {
    return no('malformed_payload', 'A compact JWS has three dot-separated segments.', 'Send a compact JWS.');
  }
  const [headerB64, payloadB64, signatureB64] = segments;

  let header: Record<string, unknown>;
  let payloadText: string;
  let payload: unknown;
  try {
    header = JSON.parse(b64urlToBuffer(headerB64).toString('utf8')) as Record<string, unknown>;
    payloadText = b64urlToBuffer(payloadB64).toString('utf8');
    payload = parseJsonStrict(payloadText);
  } catch (err) {
    if (err instanceof JsonReadError && err.kind === 'duplicate_keys') {
      return no('duplicate_keys', err.message, 'Send each claim once.');
    }
    return no('malformed_payload', 'The JWS header or payload is not readable JSON.', 'Send a well-formed JWS.');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return no('malformed_payload', 'The JWS payload is not a JSON object.', 'Send a JSON object payload.');
  }

  const alg = header.alg;
  if (typeof alg !== 'string' || alg !== issuer.alg) {
    return no(
      'algorithm_mismatch',
      `The token declares alg=${String(alg)}; issuer ${issuer.issuerId} is pinned to ${issuer.alg}. A credential ` +
        'that chooses how it will be checked is not a credential.',
      `Sign with ${issuer.alg}, or re-register the issuer deliberately.`,
    );
  }
  if (typeof header.kid === 'string' && header.kid !== issuer.kid) {
    return no(
      'key_mismatch',
      `The token names key ${header.kid}; issuer ${issuer.issuerId} is registered with ${issuer.kid}.`,
      'Register the new key before using it, so a rotation is an act rather than an accident.',
    );
  }

  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey({ key: Buffer.from(issuer.publicKeySpki, 'base64'), format: 'der', type: 'spki' });
  } catch {
    return no('issuer_unregistered', 'The registered public key is not readable SPKI.', 'Re-register the issuer key.');
  }

  const expectedCurve = CURVE_FOR[issuer.alg];
  const actualCurve = key.asymmetricKeyDetails?.namedCurve ?? null;
  if (expectedCurve !== actualCurve) {
    return no(
      'key_mismatch',
      `Issuer ${issuer.issuerId} is pinned to ${issuer.alg} but its registered key is ` +
        `${actualCurve ?? key.asymmetricKeyType ?? 'of an unknown type'}.`,
      'Register a key matching the algorithm.',
    );
  }

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
  const signature = b64urlToBuffer(signatureB64);
  let verified = false;
  try {
    verified =
      issuer.alg === 'EdDSA'
        ? crypto.verify(null, signingInput, key, signature)
        : crypto.verify('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    verified = false;
  }
  if (!verified) {
    return no(
      'signature_invalid',
      `The credential does not verify against issuer ${issuer.issuerId}'s registered key.`,
      'Re-sign the credential, or register the key that actually signed it.',
    );
  }

  return { ok: true, value: { header, payloadText, payload: payload as Record<string, unknown> } };
}

/* ------------------------------------------------------------------ *
 * Freshness and replay
 * ------------------------------------------------------------------ */

export interface FreshnessArgs {
  /** Epoch millis the credential stops being valid. */
  expiresAt: number | null;
  /** Epoch millis the credential claims to have been issued. */
  issuedAt: number | null;
  now: number;
  /** Tolerance for the sender's clock being wrong. */
  skewMs?: number;
  /** Maximum life Apex will accept regardless of what the credential claims. */
  maxLifetimeMs?: number;
}

export const DEFAULT_SKEW_MS = 120_000;
export const MAX_CREDENTIAL_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * A foreign credential must expire, and soon.
 *
 * AP2 puts a TTL on an Intent Mandate for exactly this reason. An unbounded
 * credential is a standing key: whoever obtains it later has the same authority
 * as the day it was issued, and the principal has no way to get it back other
 * than revocation they may never think to perform.
 */
export function checkFreshness(args: FreshnessArgs): Import<{ expiresAt: number }> {
  const skew = args.skewMs ?? DEFAULT_SKEW_MS;
  const maxLife = args.maxLifetimeMs ?? MAX_CREDENTIAL_LIFETIME_MS;

  if (args.expiresAt === null) {
    return no(
      'no_expiry',
      'The credential carries no expiry. An authorisation that never lapses is a standing key.',
      'Set a TTL. Minutes for a cart, hours for an intent.',
    );
  }
  if (args.issuedAt !== null && args.issuedAt - skew > args.now) {
    return no(
      'clock_skew',
      `The credential claims to have been issued at ${new Date(args.issuedAt).toISOString()}, which is in the future.`,
      'Fix the sending clock; Apex allows two minutes of drift, not more.',
    );
  }
  if (args.now > args.expiresAt + skew) {
    return no(
      'credential_expired',
      `The credential expired at ${new Date(args.expiresAt).toISOString()}.`,
      'Obtain a fresh authorisation from the principal.',
    );
  }
  if (args.issuedAt !== null && args.expiresAt - args.issuedAt > maxLife) {
    return no(
      'no_expiry',
      `The credential is valid for ${Math.round((args.expiresAt - args.issuedAt) / 3_600_000)} hours; Apex accepts at ` +
        `most ${Math.round(maxLife / 3_600_000)}.`,
      'Shorten the TTL and re-issue as needed. Short-lived credentials fail safe.',
    );
  }
  return { ok: true, value: { expiresAt: args.expiresAt } };
}

/** Somewhere to remember credential ids. Backed by a store in production. */
export interface ReplayPort {
  seen(credentialId: string): boolean;
  remember(credentialId: string, until: number): void;
}

export function claimOnce(port: ReplayPort, credentialId: string, until: number): Import<string> {
  if (port.seen(credentialId)) {
    return no(
      'replayed',
      `Credential ${credentialId} has already been presented. A single authorisation authorises a single act.`,
      'Obtain a fresh credential for each transaction.',
    );
  }
  port.remember(credentialId, until);
  return { ok: true, value: credentialId };
}

/* ------------------------------------------------------------------ *
 * Provenance of the foreign side
 * ------------------------------------------------------------------ */

/**
 * What arrived, from whom, verified how.
 *
 * Kept as evidence and hashed into the trade's provenance, so a dispute two
 * years later can be answered with "this is the credential we were shown, this
 * is the key it verified against" rather than an assurance.
 */
export interface ForeignAttestation {
  protocol: ForeignProtocol;
  issuerId: string;
  credentialId: string;
  alg: PermittedAlg;
  kid: string;
  /** SHA-256 over the exact bytes presented. */
  payloadDigest: string;
  verifiedAt: number;
  expiresAt: number;
  /** Whether a human was present when the credential was created, as claimed. */
  humanPresent: boolean;
}

export function attestationDigest(a: ForeignAttestation): string {
  return crypto
    .createHash('sha256')
    .update(
      [
        'v12-foreign-attestation-1',
        a.protocol,
        a.issuerId,
        a.credentialId,
        a.alg,
        a.kid,
        a.payloadDigest,
        String(a.verifiedAt),
        String(a.expiresAt),
        String(a.humanPresent),
      ].join('\n'),
    )
    .digest('hex');
}

/* ------------------------------------------------------------------ *
 * AP2 Intent Mandate → a DRAFT Apex mandate
 * ------------------------------------------------------------------ */

/**
 * A mandate proposal, and pointedly NOT a `Mandate`.
 *
 * There is no `signature` field, so this value cannot be handed to
 * `checkMandate` and cannot authorise anything. The only way forward is
 * `mandateBytesToSign` → a principal signs with their own Ed25519 key →
 * `acceptCountersignature`. Apex never holds that key, so Apex cannot promote a
 * foreign credential to local authority even by mistake.
 */
export interface DraftMandate {
  participant: ParticipantId;
  agentId: string;
  grantedBy: { id: string; name: string };
  maxPerTrade: Minor;
  maxPerDay: Minor;
  skus: string[];
  counterparties: ParticipantId[];
  sides: ('buy' | 'sell')[];
  expiresAt: number;
  /** The credential this draft was derived from. */
  attestation: ForeignAttestation;
}

export interface IntentImportArgs {
  /** The raw credential text, exactly as received. */
  rawJson: string;
  issuer: ForeignIssuer;
  /** The Apex participant the importing side acts for. */
  participant: ParticipantId;
  /** Who, on the Apex side, will be asked to counter-sign. */
  grantedBy: { id: string; name: string };
  now: number;
  replay: ReplayPort;
  /** Admitted counterparties, for checking the intent names real ones. */
  isAdmitted: (id: ParticipantId) => boolean;
}

/**
 * AP2 Intent Mandate → DraftMandate.
 *
 * The mapping:
 *   shopping_intent.skus         → skus        (REQUIRED; see below)
 *   shopping_intent.merchants    → counterparties
 *   constraints.max_per_purchase → maxPerTrade
 *   constraints.max_total        → maxPerDay
 *   ttl / expires_at             → expiresAt
 *
 * The one place this is stricter than AP2 itself: an intent with no SKU or
 * category restriction is REFUSED rather than imported as "any". A locally
 * granted Apex mandate may say "any SKU", because a principal here typed that
 * deliberately into a system we govern. A credential minted elsewhere, by an
 * issuer whose key-handling we cannot inspect, does not get the benefit of that
 * default. Trust granted from inside and trust arriving from outside are not the
 * same quantity and should not collapse into the same code path.
 */
export function importIntentMandate(args: IntentImportArgs): Import<DraftMandate> {
  const read = readPayload(args.rawJson);
  if (!read.ok) return read;
  const body = read.value;

  const credentialId = requireString(body, 'intent_mandate_id');
  if (!credentialId.ok) return credentialId;

  const agentId = requireString(body, 'agent_id');
  if (!agentId.ok) return agentId;

  const expiresAtRaw = field(body, 'expires_at');
  const expiresAt = expiresAtRaw instanceof JsonNumber ? Number(expiresAtRaw.literal) : null;
  const issuedAtRaw = field(body, 'issued_at');
  const issuedAt = issuedAtRaw instanceof JsonNumber ? Number(issuedAtRaw.literal) : null;

  const fresh = checkFreshness({ expiresAt, issuedAt, now: args.now });
  if (!fresh.ok) return fresh;

  const maxPerTrade = toMinor(field(body, 'constraints.max_per_purchase'), 'constraints.max_per_purchase');
  if (!maxPerTrade.ok) return maxPerTrade;
  const maxPerDay = toMinor(field(body, 'constraints.max_total'), 'constraints.max_total');
  if (!maxPerDay.ok) return maxPerDay;
  if (maxPerTrade.value <= 0n || maxPerDay.value <= 0n) {
    return no(
      'scope_unbounded',
      'An intent with a zero or negative ceiling authorises nothing meaningful.',
      'State positive per-purchase and total ceilings.',
    );
  }

  const skusRaw = field(body, 'shopping_intent.skus');
  const skus = Array.isArray(skusRaw) ? skusRaw.filter((s): s is string => typeof s === 'string') : [];
  if (skus.length === 0) {
    return no(
      'scope_unbounded',
      'The intent names no SKUs. Apex will not import an unbounded foreign mandate: a locally granted mandate may ' +
        'say "any SKU" because a principal chose that here, but a credential minted elsewhere does not inherit that ' +
        'latitude.',
      'List the SKUs or categories the agent may transact in.',
    );
  }

  const merchantsRaw = field(body, 'shopping_intent.merchants');
  const merchants = Array.isArray(merchantsRaw) ? merchantsRaw.filter((s): s is string => typeof s === 'string') : [];
  const counterparties = merchants.map(participantId);
  const unknown = counterparties.filter((c) => !args.isAdmitted(c));
  if (unknown.length > 0) {
    return no(
      'counterparty_not_admitted',
      `The intent names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not admitted to the Galaxy.`,
      'Name admitted counterparties, or have them apply for admission.',
    );
  }

  const sidesRaw = field(body, 'shopping_intent.sides');
  const sides = Array.isArray(sidesRaw)
    ? sidesRaw.filter((s): s is 'buy' | 'sell' => s === 'buy' || s === 'sell')
    : ['buy' as const];
  if (sides.length === 0) {
    return no('binds_nothing', 'The intent permits neither buying nor selling.', 'State at least one side.');
  }

  const authorization = requireString(body, 'user_authorization');
  if (!authorization.ok) return authorization;
  const jws = verifyCompactJws(authorization.value, args.issuer);
  if (!jws.ok) return jws;

  /*
   * The signed payload must be about THIS credential. A valid signature over
   * some other intent is a valid signature and authorises nothing here — which
   * is the whole substitution attack, and it is cheap to close.
   */
  const signedId = jws.value.payload.intent_mandate_id;
  if (signedId !== credentialId.value) {
    return no(
      'signature_invalid',
      `The authorisation is signed over intent ${String(signedId)} but was presented with ${credentialId.value}.`,
      'Sign the credential you are presenting.',
    );
  }

  const claimed = claimOnce(args.replay, credentialId.value, fresh.value.expiresAt);
  if (!claimed.ok) return claimed;

  const attestation: ForeignAttestation = {
    protocol: 'ap2',
    issuerId: args.issuer.issuerId,
    credentialId: credentialId.value,
    alg: args.issuer.alg,
    kid: args.issuer.kid,
    payloadDigest: crypto.createHash('sha256').update(args.rawJson, 'utf8').digest('hex'),
    verifiedAt: args.now,
    expiresAt: fresh.value.expiresAt,
    humanPresent: field(body, 'human_present') === true,
  };

  return {
    ok: true,
    value: {
      participant: args.participant,
      agentId: agentId.value,
      grantedBy: args.grantedBy,
      maxPerTrade: maxPerTrade.value,
      maxPerDay: maxPerDay.value,
      skus,
      counterparties,
      sides,
      expiresAt: fresh.value.expiresAt,
      attestation,
    },
  };
}

/**
 * The bytes a principal signs to adopt a draft as an Apex mandate.
 *
 * Deliberately the same canonical form `mandate.ts` verifies, so an adopted
 * mandate is indistinguishable from one granted locally — because by then it
 * IS one. What made it foreign was that nobody here had agreed to it, and a
 * principal's signature is exactly the act of agreeing.
 */
export function draftToUnsignedMandate(draft: DraftMandate, id: string, grantedAt: number): Omit<Mandate, 'signature'> {
  return {
    id,
    participant: draft.participant,
    agentId: draft.agentId,
    grantedBy: draft.grantedBy,
    maxPerTrade: draft.maxPerTrade,
    maxPerDay: draft.maxPerDay,
    skus: draft.skus,
    counterparties: draft.counterparties,
    sides: draft.sides,
    grantedAt,
    expiresAt: draft.expiresAt,
    revokedAt: null,
  };
}

/* ------------------------------------------------------------------ *
 * AP2 Cart Mandate → Apex Terms
 * ------------------------------------------------------------------ */

export interface CartImportArgs {
  rawJson: string;
  issuer: ForeignIssuer;
  seller: ParticipantId;
  buyer: ParticipantId;
  proposalId: string;
  /** Apex's fee schedule. Never the payload's. */
  fees: FeeSchedule;
  now: number;
  replay: ReplayPort;
  supportedCurrency: string;
}

export interface ImportedCart {
  terms: Terms;
  attestation: ForeignAttestation;
  /**
   * What still has to happen. An imported cart is a PROPOSAL; both principals
   * (or agents inside a mandate) still sign Apex terms under `agreement.ts`.
   */
  stillRequired: string;
}

/**
 * AP2 Cart Mandate → Terms.
 *
 * Two things the payload is not allowed to decide:
 *
 *   GROSS. Recomputed as unitPrice × quantity and refused if the stated total
 *   disagrees by a single minor unit. A cart whose line items do not add up to
 *   its own total is either broken or an attempt to have the reader and the
 *   ledger believe different numbers.
 *
 *   FEE. Always computed from Apex's schedule. A foreign document setting the
 *   market's own fee is a category error, and a profitable one for whoever
 *   sends it.
 */
export function importCartMandate(args: CartImportArgs): Import<ImportedCart> {
  const read = readPayload(args.rawJson);
  if (!read.ok) return read;
  const body = read.value;

  const cartId = requireString(body, 'id');
  if (!cartId.ok) return cartId;

  const currency = requireString(body, 'payment_request.details.total.amount.currency');
  if (!currency.ok) return currency;
  if (currency.value !== args.supportedCurrency) {
    return no(
      'currency_unsupported',
      `The cart is denominated in ${currency.value}; this market settles in ${args.supportedCurrency}.`,
      'Present the cart in the market currency. Apex does not convert — a rate is a price, and prices belong to parties.',
    );
  }

  const items = field(body, 'payment_request.details.displayItems');
  if (!Array.isArray(items) || items.length !== 1) {
    return no(
      'missing_field',
      'Apex terms cover exactly one SKU. A multi-line cart is several trades, each with its own counterparty ' +
        'obligation and its own escrow.',
      'Present one line item per cart, or split the cart.',
    );
  }
  const item = items[0] as Record<string, unknown>;

  const sku = requireString(item, 'sku');
  if (!sku.ok) return sku;
  const quantity = toCount(item.quantity, 'displayItems[0].quantity');
  if (!quantity.ok) return quantity;
  const unitPrice = toMinor(field(item, 'unit_amount.value'), 'displayItems[0].unit_amount.value');
  if (!unitPrice.ok) return unitPrice;
  if (unitPrice.value <= 0n) {
    return no('amount_not_decimal', 'A unit price of zero or less is not a sale.', 'Price the line item.');
  }

  const statedTotal = toMinor(field(body, 'payment_request.details.total.amount.value'), 'total.amount.value');
  if (!statedTotal.ok) return statedTotal;

  const gross = unitPrice.value * BigInt(quantity.value);
  if (gross !== statedTotal.value) {
    return no(
      'total_mismatch',
      `The cart states a total of ${toDecimalString(statedTotal.value)} but its line item multiplies out to ` +
        `${toDecimalString(gross)}. Apex takes the line items and refuses the difference rather than choosing which ` +
        'number the parties meant.',
      'Make the total equal the sum of the line items.',
    );
  }

  const expiresAtRaw = field(body, 'expires_at');
  const expiresAt = expiresAtRaw instanceof JsonNumber ? Number(expiresAtRaw.literal) : null;
  const issuedAtRaw = field(body, 'timestamp');
  const issuedAt = issuedAtRaw instanceof JsonNumber ? Number(issuedAtRaw.literal) : null;
  const fresh = checkFreshness({ expiresAt, issuedAt, now: args.now, maxLifetimeMs: 60 * 60 * 1000 });
  if (!fresh.ok) return fresh;

  const merchantSignature = requireString(body, 'merchant_signature');
  if (!merchantSignature.ok) return merchantSignature;
  const jws = verifyCompactJws(merchantSignature.value, args.issuer);
  if (!jws.ok) return jws;
  if (jws.value.payload.id !== cartId.value) {
    return no(
      'signature_invalid',
      `The merchant signature covers cart ${String(jws.value.payload.id)}, not ${cartId.value}.`,
      'Sign the cart you are presenting.',
    );
  }

  const claimed = claimOnce(args.replay, cartId.value, fresh.value.expiresAt);
  if (!claimed.ok) return claimed;

  const deliverByRaw = field(body, 'deliver_by');
  const deliverBy = deliverByRaw instanceof JsonNumber ? Number(deliverByRaw.literal) : fresh.value.expiresAt;

  const feeAmount = (gross * BigInt(args.fees.basisPoints)) / 10_000n;

  const terms: Terms = {
    proposalId: args.proposalId,
    seller: args.seller,
    buyer: args.buyer,
    sku: sku.value,
    quantity: quantity.value,
    unitPrice: unitPrice.value,
    grossAmount: gross,
    feeAmount,
    deliverBy,
  };

  const attestation: ForeignAttestation = {
    protocol: 'ap2',
    issuerId: args.issuer.issuerId,
    credentialId: cartId.value,
    alg: args.issuer.alg,
    kid: args.issuer.kid,
    payloadDigest: crypto.createHash('sha256').update(args.rawJson, 'utf8').digest('hex'),
    verifiedAt: args.now,
    expiresAt: fresh.value.expiresAt,
    humanPresent: field(body, 'user_signature_required') === true,
  };

  return {
    ok: true,
    value: {
      terms,
      attestation,
      stillRequired:
        'Both sides must sign these Apex terms under agreement.ts. The imported cart is evidence that a buyer ' +
        'authorised a purchase elsewhere; it is not a signature on this trade and cannot bind the seller, who has ' +
        'not yet agreed to this counterparty.',
    },
  };
}

/* ------------------------------------------------------------------ *
 * ACP, x402, MPP
 * ------------------------------------------------------------------ */

/**
 * ACP's SharedPaymentToken is a single-use payment credential, not authority to
 * trade. Imported as attestation only: it can evidence that funds were
 * authorised, and it cannot create a mandate, set terms or bind a seller.
 */
export function importSharedPaymentToken(args: {
  rawJson: string;
  issuer: ForeignIssuer;
  now: number;
  replay: ReplayPort;
}): Import<ForeignAttestation> {
  const read = readPayload(args.rawJson);
  if (!read.ok) return read;
  const body = read.value;

  const tokenId = requireString(body, 'shared_payment_token');
  if (!tokenId.ok) return tokenId;

  const expiresAtRaw = field(body, 'expires_at');
  const expiresAt = expiresAtRaw instanceof JsonNumber ? Number(expiresAtRaw.literal) : null;
  const fresh = checkFreshness({ expiresAt, issuedAt: null, now: args.now, maxLifetimeMs: 60 * 60 * 1000 });
  if (!fresh.ok) return fresh;

  const signature = requireString(body, 'signature');
  if (!signature.ok) return signature;
  const jws = verifyCompactJws(signature.value, args.issuer);
  if (!jws.ok) return jws;

  const claimed = claimOnce(args.replay, tokenId.value, fresh.value.expiresAt);
  if (!claimed.ok) return claimed;

  return {
    ok: true,
    value: {
      protocol: 'acp',
      issuerId: args.issuer.issuerId,
      credentialId: tokenId.value,
      alg: args.issuer.alg,
      kid: args.issuer.kid,
      payloadDigest: crypto.createHash('sha256').update(args.rawJson, 'utf8').digest('hex'),
      verifiedAt: args.now,
      expiresAt: fresh.value.expiresAt,
      humanPresent: true,
    },
  };
}

/**
 * Recognised, and refused, with the reason stated.
 *
 * An inbound agent that gets a 500 learns nothing and retries. One that is told
 * "this rail settles on-chain and this market does not" can route elsewhere, and
 * the operator reading the log learns the same thing.
 */
export function assessProtocol(protocol: string): Import<ForeignProtocol> {
  switch (protocol) {
    case 'ap2':
    case 'acp':
      return { ok: true, value: protocol };
    case 'x402':
      return no(
        'protocol_not_settleable',
        'x402 settles in stablecoin over HTTP 402. Apex holds no digital assets and operates no crypto rail; that ' +
          'excision was deliberate and it stands. The credential is well-formed and this market cannot settle it.',
        'Present an AP2 or ACP credential against a fiat settlement account.',
      );
    case 'mpp':
      return no(
        'protocol_not_settleable',
        'MPP pre-authorises a session against a single merchant. Apex trades are bilateral agreements between two ' +
          'admitted companies, and a session token names no seller to agree with.',
        'Present an AP2 Intent Mandate, which carries the scope a market needs.',
      );
    default:
      return no(
        'unknown_protocol',
        `"${protocol}" is not a protocol Apex recognises.`,
        'Use ap2 or acp. Unrecognised credential formats are refused rather than guessed at.',
      );
  }
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

/**
 * The line that goes in the log and, if it ever comes to it, in front of an
 * adjudicator. AP2 resolves disputes by sharing the public key with the
 * adjudicating authority; this records which key that would be.
 */
export function describeAttestation(a: ForeignAttestation): string {
  return [
    `${a.protocol.toUpperCase()} credential ${a.credentialId} from ${a.issuerId},`,
    `verified ${new Date(a.verifiedAt).toISOString()} against key ${a.kid} (${a.alg}),`,
    `human ${a.humanPresent ? 'present' : 'not present'} at creation,`,
    `expires ${new Date(a.expiresAt).toISOString()}.`,
    `Payload digest ${a.payloadDigest.slice(0, 16)}….`,
    'Evidence of authorisation elsewhere. Not authority here.',
  ].join(' ');
}

/** A foreign attestation is never an Apex signature. Stated as code. */
export function isApexSignature(value: ForeignAttestation | Signature): value is Signature {
  return (value as Signature).termsDigest !== undefined;
}
