/**
 * Closed-beta gating: invites and inference metering.
 *
 * Two controls, both server-side, both auditable.
 *
 * WHY INVITES ARE HASHED
 * ----------------------
 * An invite code is a credential — it is the only thing standing between a
 * stranger and a free account on a deployment with a real inference budget.
 * Storing it in plaintext means a database dump, a backup, or an over-broad
 * support query hands out working codes. So the store holds SHA-256 of the
 * code and nothing else; the plaintext exists exactly once, in the response to
 * the operator who minted it, and is never recoverable afterwards. If they lose
 * it, they mint another. That is the correct trade.
 *
 * WHY REDEMPTION IS A COMPARE-AND-SWAP
 * ------------------------------------
 * Read-then-write on a single-use code is a race: two people who paste the same
 * code at the same moment both see `uses = 0` and both get in, and the cap the
 * operator set is silently exceeded. Redemption is therefore ONE statement whose
 * WHERE clause carries every precondition, and the row count decides the
 * outcome. Same pattern as the liquidation compare-and-swap.
 */

import crypto from 'crypto';

export interface Invite {
  id: string;
  /** SHA-256 of the code. The plaintext is never stored. */
  codeHash: string;
  /** Free text: who this was issued to, for the operator's own bookkeeping. */
  label: string | null;
  createdAt: string;
  createdBy: string | null;
  maxUses: number;
  uses: number;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedBy: string | null;
}

/** Why a redemption failed. Deliberately coarse in what reaches the client. */
export type RedeemFailure = 'unknown_code' | 'exhausted' | 'revoked' | 'expired';

export type RedeemResult =
  | { ok: true; invite: Invite }
  | { ok: false; reason: RedeemFailure };

/**
 * Invite codes are shown to humans who retype them, so the alphabet excludes
 * the characters people confuse: 0/O, 1/I/L. Grouped for legibility.
 */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateInviteCode(groups = 3, groupSize = 5): string {
  const bytes = crypto.randomBytes(groups * groupSize);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  const out: string[] = [];
  for (let i = 0; i < groups; i++) out.push(chars.slice(i * groupSize, (i + 1) * groupSize).join(''));
  return out.join('-');
}

/** Case- and separator-insensitive: `abc de-fgh` and `ABCDE-FGH` are one code. */
export const normaliseInviteCode = (code: string): string =>
  code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');

export const hashInviteCode = (code: string): string =>
  crypto.createHash('sha256').update(normaliseInviteCode(code)).digest('hex');

// ---------------------------------------------------------------- metering

export interface AiUsage {
  tenantId: string;
  /** `YYYY-MM`, UTC. Calendar months, because that is how a credit is sold. */
  period: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  updatedAt: string;
}

export interface UsageDelta {
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  costCents?: number;
}

export const currentPeriod = (now = new Date()): string =>
  `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

export const emptyUsage = (tenantId: string, period = currentPeriod()): AiUsage => ({
  tenantId,
  period,
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  costCents: 0,
  updatedAt: new Date(0).toISOString(),
});

/**
 * Cost per million tokens, in cents.
 *
 * THESE DEFAULTS ARE A PLACEHOLDER AND WILL BE WRONG.
 *
 * Model prices change and I am not going to pretend to know today's. They are
 * deliberately set ABOVE any plausible real rate, so an operator who never
 * configures them over-counts and cuts users off early — annoying, and
 * recoverable. The opposite default under-counts and hands out an unbounded
 * bill, which is not recoverable. Set them from your provider's current price
 * list; `/api/health` reports whether they were configured or defaulted.
 */
export const DEFAULT_INPUT_CENTS_PER_MTOK = 100;
export const DEFAULT_OUTPUT_CENTS_PER_MTOK = 400;

export interface CostRates {
  inputCentsPerMTok: number;
  outputCentsPerMTok: number;
  /** False when the defaults above are in force, so health can say so. */
  configured: boolean;
}

export function ratesFromEnv(env: NodeJS.ProcessEnv = process.env): CostRates {
  const num = (key: string) => {
    const raw = env[key];
    if (raw === undefined || raw === '') return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };

  const input = num('AI_INPUT_CENTS_PER_MTOK');
  const output = num('AI_OUTPUT_CENTS_PER_MTOK');

  return {
    inputCentsPerMTok: input ?? DEFAULT_INPUT_CENTS_PER_MTOK,
    outputCentsPerMTok: output ?? DEFAULT_OUTPUT_CENTS_PER_MTOK,
    configured: input !== undefined && output !== undefined,
  };
}

export function estimateCostCents(
  inputTokens: number,
  outputTokens: number,
  rates: CostRates,
): number {
  const cost =
    (inputTokens / 1_000_000) * rates.inputCentsPerMTok +
    (outputTokens / 1_000_000) * rates.outputCentsPerMTok;
  // Six decimal places of a cent. Rounding to whole cents per request would
  // round almost every call to zero and meter nothing.
  return Math.round(cost * 1e6) / 1e6;
}

export interface CreditVerdict {
  allowed: boolean;
  usedCents: number;
  limitCents: number;
  remainingCents: number;
}

/**
 * Is this tenant still inside its monthly inference credit?
 *
 * Checked BEFORE the model call, not after. Checking after means the call that
 * breaks the budget is the one you already paid for, and with a large enough
 * response that single call can be most of the overage.
 *
 * A limit of zero means unlimited rather than blocked — otherwise a plan that
 * simply has not had a credit configured would refuse every request, and an
 * operator would reasonably read the resulting 402s as a bug.
 */
export function assessCredit(usage: AiUsage, limitCents: number): CreditVerdict {
  if (limitCents <= 0) {
    return { allowed: true, usedCents: usage.costCents, limitCents: 0, remainingCents: Infinity };
  }
  const remaining = limitCents - usage.costCents;
  return {
    allowed: remaining > 0,
    usedCents: usage.costCents,
    limitCents,
    remainingCents: Math.max(0, remaining),
  };
}
