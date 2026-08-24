/**
 * Mandates — how an agent CAN bind, without the owner losing control.
 *
 * THE CORRECTION THIS FILE IS
 * ---------------------------
 * I first wrote a flat rule: agents find, principals bind, no exceptions. That
 * rule is safe and it is wrong, because it contradicts the reason the market is
 * worth building.
 *
 * The whole economic argument is that agents make the LONG TAIL of trades
 * viable — the $400 lot of render hours that never happened because finding a
 * counterparty and papering it cost more than the trade was worth. Requiring a
 * human signature on every one of those puts the cost straight back and leaves
 * only the large trades, which were already happening.
 *
 * So both are true, and a mandate is how:
 *
 *   The principal decides. They decide IN ADVANCE, in writing, with limits.
 *   Inside those limits an agent may sign, because the decision was already
 *   made by a person. Outside them the agent escalates.
 *
 * That is how delegated authority has always worked. A purchasing manager with
 * a signing limit is not an absence of oversight; it is oversight expressed as
 * a boundary rather than as a queue.
 *
 * WHAT MAKES IT SAFE
 * ------------------
 *   - A mandate is SIGNED by the principal, so the market cannot mint one.
 *   - It is bounded on every axis that matters: per-trade, per-day, which SKUs,
 *     which counterparties, and when it expires.
 *   - It is revocable immediately and unilaterally.
 *   - Spend against it is counted, so the daily bound is real rather than
 *     aspirational.
 *   - It can never authorise what the principal could not: a mandate that
 *     exceeds the company's own limits is void, not merely capped.
 */

import crypto from 'crypto';
import { toDecimalString, type Minor } from '../constitution/money';
import type { Actor } from './agreement';
import type { ParticipantId } from './types';

export interface Mandate {
  id: string;
  participant: ParticipantId;
  /** The agent this mandate empowers. One agent, one mandate. */
  agentId: string;
  /** Who granted it. A principal, always. */
  grantedBy: { id: string; name: string };
  /** Largest single trade the agent may sign. */
  maxPerTrade: Minor;
  /** Rolling 24-hour ceiling across all trades the agent signs. */
  maxPerDay: Minor;
  /** Empty means ANY sku. Non-empty is an allow-list. */
  skus: string[];
  /** Empty means ANY admitted counterparty. Non-empty is an allow-list. */
  counterparties: ParticipantId[];
  /** May the agent sell, buy, or both? */
  sides: ('buy' | 'sell')[];
  grantedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  /** Ed25519 by the granting principal, over the canonical mandate. */
  signature: string;
}

export interface MandateUsage {
  /** Committed by this agent under this mandate inside the rolling window. */
  spentToday: Minor;
}

export type MandateRefusal =
  | 'no_mandate'
  | 'wrong_agent'
  | 'wrong_participant'
  | 'revoked'
  | 'expired'
  | 'signature_invalid'
  | 'exceeds_per_trade'
  | 'exceeds_per_day'
  | 'sku_not_permitted'
  | 'counterparty_not_permitted'
  | 'side_not_permitted'
  | 'exceeds_principal_limits';

export interface MandateRefusalDetail {
  reason: MandateRefusal;
  detail: string;
  /** What a principal would need to do to make this pass. */
  escalation: string;
}

export type MandateCheck = { permitted: true; mandate: Mandate } | { permitted: false } & MandateRefusalDetail;

const deny = (reason: MandateRefusal, detail: string, escalation: string): MandateCheck => ({
  permitted: false, reason, detail, escalation,
});

/** The bytes a principal signs when granting authority. */
export function mandateCanonical(m: Omit<Mandate, 'signature'>): string {
  return [
    'v12-mandate-1',
    m.id, m.participant, m.agentId, m.grantedBy.id,
    m.maxPerTrade.toString(), m.maxPerDay.toString(),
    [...m.skus].sort().join(','), [...m.counterparties].sort().join(','), [...m.sides].sort().join(','),
    String(m.grantedAt), String(m.expiresAt),
  ].join('\n');
}

export function verifyMandate(mandate: Mandate, principalPublicKey: string): boolean {
  try {
    const { signature, ...unsigned } = mandate;
    return crypto.verify(
      null,
      Buffer.from(mandateCanonical(unsigned), 'utf8'),
      crypto.createPublicKey({ key: Buffer.from(principalPublicKey, 'base64'), format: 'der', type: 'spki' }),
      Buffer.from(signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * May this agent sign these terms?
 *
 * Returns an escalation path on every refusal. An agent that is told only "no"
 * will retry; an agent told "a principal must sign this one" does the right
 * thing, and so does the human reading the log.
 */
export function checkMandate(args: {
  actor: Actor;
  mandate: Mandate | null;
  usage: MandateUsage;
  principalPublicKey: string | null;
  side: 'buy' | 'sell';
  sku: string;
  counterparty: ParticipantId;
  amount: Minor;
  now: number;
  /** The company's OWN limits. A mandate can never exceed them. */
  participantMaxPerTrade: Minor;
}): MandateCheck {
  const { mandate, actor } = args;

  if (!mandate) {
    return deny(
      'no_mandate',
      `${actor.name} holds no mandate and cannot bind ${actor.participant}.`,
      'A principal must sign this trade, or grant the agent a mandate covering it.',
    );
  }
  if (mandate.agentId !== actor.id) {
    return deny('wrong_agent', 'This mandate empowers a different agent.', 'Grant this agent its own mandate.');
  }
  if (mandate.participant !== actor.participant) {
    return deny('wrong_participant', 'This mandate belongs to another company.', 'A principal of this company must grant one.');
  }
  if (mandate.revokedAt !== null) {
    return deny('revoked', 'The mandate was revoked.', 'A principal must sign this trade, or grant a fresh mandate.');
  }
  if (args.now > mandate.expiresAt) {
    return deny('expired', 'The mandate has expired.', 'Renew it, or have a principal sign this trade.');
  }
  if (!args.principalPublicKey || !verifyMandate(mandate, args.principalPublicKey)) {
    return deny(
      'signature_invalid',
      'The mandate does not verify against the granting principal\'s key.',
      'This mandate cannot be trusted. A principal must sign directly.',
    );
  }

  /*
   * A mandate can never authorise what the company itself could not. Capping
   * silently would be friendlier and wrong: an over-broad mandate is a mistake
   * somebody should be told about, not one the system quietly absorbs.
   */
  if (mandate.maxPerTrade > args.participantMaxPerTrade) {
    return deny(
      'exceeds_principal_limits',
      `The mandate permits ${toDecimalString(mandate.maxPerTrade)} per trade but the company's own ceiling is ` +
        `${toDecimalString(args.participantMaxPerTrade)}. A delegation cannot exceed the authority delegating it.`,
      'Reduce the mandate, or raise the company limit deliberately.',
    );
  }

  if (!mandate.sides.includes(args.side)) {
    return deny('side_not_permitted', `This mandate does not permit ${args.side} orders.`, 'Grant a mandate covering this side.');
  }
  if (mandate.skus.length > 0 && !mandate.skus.includes(args.sku)) {
    return deny('sku_not_permitted', `${args.sku} is outside this mandate.`, 'Add the SKU to the mandate, or have a principal sign.');
  }
  if (mandate.counterparties.length > 0 && !mandate.counterparties.includes(args.counterparty)) {
    return deny(
      'counterparty_not_permitted',
      `${args.counterparty} is not on this mandate's counterparty list.`,
      'A principal must approve this counterparty — which is the point of the list.',
    );
  }
  if (args.amount > mandate.maxPerTrade) {
    return deny(
      'exceeds_per_trade',
      `${toDecimalString(args.amount)} exceeds the mandate's per-trade limit of ${toDecimalString(mandate.maxPerTrade)}.`,
      'A principal must sign this one.',
    );
  }
  if (args.usage.spentToday + args.amount > mandate.maxPerDay) {
    return deny(
      'exceeds_per_day',
      `This would take today's total to ${toDecimalString(args.usage.spentToday + args.amount)}, past the ` +
        `mandate's daily limit of ${toDecimalString(mandate.maxPerDay)}.`,
      'A principal must sign this one, or the daily limit must be raised deliberately.',
    );
  }

  return { permitted: true, mandate };
}

/** Immediate and unilateral. A principal never has to argue with an agent about this. */
export function revoke(mandate: Mandate, at: number): Mandate {
  return { ...mandate, revokedAt: at };
}

/** Plain language, for the log and for the person who granted it. */
export function describeMandate(m: Mandate): string {
  const scope = [
    m.sides.join(' and '),
    m.skus.length ? `${m.skus.join(', ')}` : 'any SKU',
    m.counterparties.length ? `with ${m.counterparties.join(', ')}` : 'with any admitted counterparty',
  ].join(', ');
  return [
    `${m.grantedBy.name} authorised agent ${m.agentId} to ${scope},`,
    `up to ${toDecimalString(m.maxPerTrade)} per trade and ${toDecimalString(m.maxPerDay)} per day,`,
    m.revokedAt ? 'REVOKED.' : `until ${new Date(m.expiresAt).toISOString()}.`,
  ].join(' ');
}
