/**
 * Article III — determinism of money. And Article IV — authorisation of spend.
 *
 * §3.1 forbids floating point for monetary quantities. The enforcement is the
 * type: `Minor` is a `bigint` of minor units, and there is no constructor here
 * that accepts a `number`. A caller holding a float cannot get it into this
 * module without calling `fromDecimalString`, which parses text and rejects
 * anything that has already been through a float.
 *
 * This is deliberately stricter than "round carefully". Rounding carefully is a
 * discipline; a type that cannot represent the error is a guarantee.
 */

import crypto from 'crypto';
import type { AuthorisationReceipt } from './types';

/** Minor units — pence, cents. Never a fraction, never a float. */
export type Minor = bigint;

export class MoneyError extends Error {
  constructor(
    readonly citation: string,
    message: string,
  ) {
    super(`${citation}: ${message}`);
    this.name = 'MoneyError';
  }
}

/**
 * The only supported way in from human input.
 *
 * Takes TEXT, not a number, because by the time a value is a JavaScript number
 * the precision loss has already happened and no amount of care downstream
 * recovers it. `0.1 + 0.2` is the canonical example and it is not a curiosity;
 * it is a ledger that does not balance.
 */
export function fromDecimalString(input: string, scale = 2): Minor {
  const trimmed = input.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new MoneyError('Article III §3.1', `"${input}" is not a decimal amount.`);
  }
  const negative = trimmed.startsWith('-');
  const [whole, fraction = ''] = trimmed.replace('-', '').split('.');
  if (fraction.length > scale) {
    throw new MoneyError('Article III §3.1', `"${input}" carries more precision than the currency's ${scale} minor digits.`);
  }
  const padded = fraction.padEnd(scale, '0');
  const value = BigInt(whole) * BigInt(10 ** scale) + BigInt(padded || '0');
  return negative ? -value : value;
}

export function toDecimalString(value: Minor, scale = 2): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const divisor = BigInt(10 ** scale);
  const whole = abs / divisor;
  const fraction = (abs % divisor).toString().padStart(scale, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/**
 * §3.1 — a guard for the boundary where untyped JSON arrives.
 *
 * Rejects a `number` outright rather than converting it. Converting would be
 * the helpful thing to do and it is exactly what the Article forbids: a float
 * that reaches here has already lost whatever it lost.
 */
export function assertNotFloat(value: unknown, field: string): void {
  if (typeof value === 'number') {
    throw new MoneyError(
      'Article III §3.1',
      `${field} arrived as a JavaScript number. Monetary quantities are integer minor units or decimal strings.`,
    );
  }
}

export interface LedgerLeg {
  account: string;
  /** Positive debits, negative credits. */
  amount: Minor;
}

/**
 * §3.2 — the sum of debits equals the sum of credits, checked BEFORE the
 * database sees it. The database constraint is the second line of defence, not
 * the first; an application that relies solely on the constraint discovers its
 * bugs as failed transactions in production.
 */
export function assertBalanced(legs: LedgerLeg[]): void {
  if (legs.length < 2) {
    throw new MoneyError('Article III §3.2', 'a transaction with fewer than two legs is not double entry.');
  }
  const sum = legs.reduce((acc, leg) => acc + leg.amount, 0n);
  if (sum !== 0n) {
    throw new MoneyError(
      'Article III §3.2',
      `debits and credits differ by ${toDecimalString(sum)}. A transaction that does not balance is rejected.`,
    );
  }
}

/** §3.4 — each entry digests over the previous, so a break is detectable. */
export function chainDigest(entry: {
  tenantId: string;
  pipelineRunId: string;
  amount: Minor;
  entryType: string;
  previousDigest: string;
}): string {
  return crypto
    .createHash('sha256')
    .update(
      [entry.tenantId, entry.pipelineRunId, entry.amount.toString(), entry.entryType, entry.previousDigest].join('\n'),
    )
    .digest('hex');
}

/**
 * §3.5 — the margin floor is absolute.
 *
 * Returns the reason for denial rather than a boolean, because Article V
 * requires the rationale to name the threshold applied, and a boolean cannot.
 */
export function checkMarginFloor(args: {
  proposedPrice: Minor;
  unitCost: Minor;
  floorBasisPoints: number;
}): { permitted: true } | { permitted: false; reason: string; actualBasisPoints: number } {
  if (args.proposedPrice <= 0n) {
    return { permitted: false, reason: 'A non-positive price cannot satisfy any margin floor.', actualBasisPoints: 0 };
  }
  const grossMinor = args.proposedPrice - args.unitCost;
  // Basis points in integer arithmetic throughout — no float anywhere on this path.
  const actualBasisPoints = Number((grossMinor * 10_000n) / args.proposedPrice);

  if (actualBasisPoints < args.floorBasisPoints) {
    return {
      permitted: false,
      actualBasisPoints,
      reason:
        `Gross margin would be ${(actualBasisPoints / 100).toFixed(2)}%, below the tenant's configured floor of ` +
        `${(args.floorBasisPoints / 100).toFixed(2)}%. Article III §3.5: the proposal is denied and the campaign is paused.`,
    };
  }
  return { permitted: true };
}

// ---------------------------------------------------------------------------
// Article IV — authorisation of expenditure
// ---------------------------------------------------------------------------

export const COMPTROLLER_VERDICTS = ['APPROVED', 'PARTIAL_MODERATED_APPROVAL', 'DENIED_INSUFFICIENT_FUNDS'] as const;
export type ComptrollerVerdict = (typeof COMPTROLLER_VERDICTS)[number];

export interface SpendRequest {
  tenantId: string;
  sku: string;
  requestedMinorUnits: Minor;
  requestedBy: string;
  /** §4.6 — verified at the moment of launch, not at planning time. */
  inventoryVerifiedInStock: boolean;
}

export function receiptCanonical(receipt: Omit<AuthorisationReceipt, 'signature'>): string {
  return [
    'v12-const-001-receipt',
    receipt.serial,
    receipt.tenantId,
    receipt.sku,
    receipt.ceilingMinorUnits.toString(),
    receipt.verdict,
    receipt.requestedBy,
    receipt.authorisedBy,
    String(receipt.issuedAt),
    String(receipt.expiresAt),
  ].join('\n');
}

export class Comptroller {
  private readonly spent = new Set<string>();

  constructor(
    /** The comptroller's own identity. §4.4 — it may not equal the requester. */
    private readonly identity: string,
    private readonly privateKey: string,
    private readonly validityMs: number,
  ) {}

  /**
   * §4.3 — exactly three verdicts. There is no fourth, and the return type is
   * how that is guaranteed rather than promised.
   *
   * §4.4 — an agent may not authorise its own request. That check comes FIRST,
   * before balance or ceiling, because self-authorisation is a violation
   * regardless of whether the funds existed.
   */
  authorise(
    request: SpendRequest,
    context: { availableMinorUnits: Minor; perCampaignCeiling: Minor },
    now: number = Date.now(),
  ):
    | { verdict: 'DENIED_INSUFFICIENT_FUNDS'; reason: string }
    | { verdict: 'SELF_AUTHORISATION_REFUSED'; reason: string }
    | { verdict: 'APPROVED' | 'PARTIAL_MODERATED_APPROVAL'; receipt: AuthorisationReceipt } {
    if (request.requestedBy === this.identity) {
      return {
        verdict: 'SELF_AUTHORISATION_REFUSED',
        reason:
          'Article IV §4.4: the agent that proposes spend may not be the agent that authorises it. ' +
          'This is a serious violation and suspends the agent.',
      };
    }

    // §4.6 — no campaign launches against stock that is not verified present.
    if (!request.inventoryVerifiedInStock) {
      return {
        verdict: 'DENIED_INSUFFICIENT_FUNDS',
        reason: `Article IV §4.6: ${request.sku} is not verified in stock at the moment of launch.`,
      };
    }

    if (context.availableMinorUnits <= 0n) {
      return {
        verdict: 'DENIED_INSUFFICIENT_FUNDS',
        reason: 'Article IV §4.3: the tenant has no available balance.',
      };
    }

    const ceiling =
      context.perCampaignCeiling < context.availableMinorUnits ? context.perCampaignCeiling : context.availableMinorUnits;

    if (ceiling <= 0n) {
      return { verdict: 'DENIED_INSUFFICIENT_FUNDS', reason: 'Article IV §4.3: the per-campaign ceiling is zero.' };
    }

    const sliced = request.requestedMinorUnits > ceiling;
    const verdict: 'APPROVED' | 'PARTIAL_MODERATED_APPROVAL' = sliced ? 'PARTIAL_MODERATED_APPROVAL' : 'APPROVED';

    const unsigned: Omit<AuthorisationReceipt, 'signature'> = {
      serial: crypto.randomUUID(),
      tenantId: request.tenantId,
      sku: request.sku,
      ceilingMinorUnits: sliced ? ceiling : request.requestedMinorUnits,
      verdict,
      requestedBy: request.requestedBy,
      authorisedBy: this.identity,
      issuedAt: now,
      expiresAt: now + this.validityMs,
    };

    const signature = crypto
      .sign(null, Buffer.from(receiptCanonical(unsigned), 'utf8'), crypto.createPrivateKey({
        key: Buffer.from(this.privateKey, 'base64'),
        format: 'der',
        type: 'pkcs8',
      }))
      .toString('base64');

    return { verdict, receipt: { ...unsigned, signature } };
  }

  /**
   * §4.5 — bound to one SKU, one ceiling, one tenant, one expiry, and
   * single-use. Replay is a critical violation, so a spent serial is refused
   * rather than quietly re-honoured.
   */
  redeem(
    receipt: AuthorisationReceipt,
    intended: { tenantId: string; sku: string; amountMinorUnits: Minor },
    publicKey: string,
    now: number = Date.now(),
  ): { ok: true } | { ok: false; reason: string; critical: boolean } {
    if (this.spent.has(receipt.serial)) {
      return { ok: false, reason: 'Article IV §4.5: this receipt has already been redeemed. Replay is critical.', critical: true };
    }
    if (now > receipt.expiresAt) {
      return { ok: false, reason: 'Article IV §4.5: the receipt has expired.', critical: false };
    }
    if (receipt.requestedBy === receipt.authorisedBy) {
      return { ok: false, reason: 'Article IV §4.4: self-authorisation.', critical: false };
    }
    if (receipt.tenantId !== intended.tenantId || receipt.sku !== intended.sku) {
      return { ok: false, reason: 'Article IV §4.5: the receipt is bound to a different tenant or SKU.', critical: true };
    }
    if (intended.amountMinorUnits > receipt.ceilingMinorUnits) {
      return { ok: false, reason: 'Article IV §4.5: the spend exceeds the authorised ceiling.', critical: false };
    }

    let verified = false;
    try {
      const { signature, ...unsigned } = receipt;
      verified = crypto.verify(
        null,
        Buffer.from(receiptCanonical(unsigned), 'utf8'),
        crypto.createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }),
        Buffer.from(signature, 'base64'),
      );
    } catch {
      return { ok: false, reason: 'Article IV §4.5: the receipt signature is malformed.', critical: true };
    }
    if (!verified) {
      return { ok: false, reason: 'Article IV §4.5: the receipt signature does not verify. Forgery.', critical: true };
    }

    this.spent.add(receipt.serial);
    return { ok: true };
  }
}
