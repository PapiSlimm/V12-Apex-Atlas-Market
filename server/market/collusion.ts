/**
 * Market abuse between participants — the gap my own self-dealing check left.
 *
 * WHAT I GOT WRONG EARLIER
 * ------------------------
 * `checkSelfDealing` refuses a trade where seller and buyer are the SAME
 * participant, cites Schedule A9, and calls it wash-trading protection. It is
 * not. Anyone willing to register twice walks straight through it: two admitted
 * shells with one beneficial owner can trade with each other all day, print
 * volume, manufacture a price history and build reputation, and every single
 * trade passes the check because the two appIds differ.
 *
 * A market that admits participants but never asks WHO OWNS THEM has an
 * identity check, not an integrity check.
 *
 * WHY THE PAYMENT PROTOCOLS DO NOT COVER THIS
 * -------------------------------------------
 * AP2, ACP, x402 and MPP all describe a buyer's agent paying a merchant the
 * buyer chose. There is no second seller, no order book, and no price to
 * manipulate, so collusion is not their problem. It is precisely Apex's
 * problem, because Apex is a market and the counterparties are strangers.
 *
 * WHAT IS DETECTABLE AND WHAT IS NOT
 * ----------------------------------
 * Deterministic, structural things are detectable: shared beneficial ownership,
 * shared banking details, circular trades, offers posted and pulled without
 * ever intending to fill, bids that walk upward to find someone's ceiling.
 *
 * Intent is not detectable, and this file does not pretend otherwise. Every
 * function returns a SIGNAL with a severity, not a verdict. Signals feed the
 * sanctions ladder and human review. A market that auto-bans on a heuristic
 * will eventually auto-ban a real business having an unusual week.
 */

import { toDecimalString, type Minor } from '../constitution/money';
import type { ParticipantId } from './types';

export type AbuseSignal =
  | 'shared_beneficial_owner'
  | 'shared_settlement_account'
  | 'circular_trading'
  | 'reciprocal_churn'
  | 'spoofing'
  | 'limit_probing'
  | 'reputation_farming'
  /** More supply on the board than the seller's own record can deliver. */
  | 'phantom_supply'
  /** Repeat selling with no inventory record at all. */
  | 'inventory_unaccounted';

export type Severity = 'advisory' | 'moderate' | 'serious' | 'critical';

export interface Finding {
  signal: AbuseSignal;
  severity: Severity;
  citation: string;
  detail: string;
  /** Who to look at. Order is not an accusation. */
  participants: ParticipantId[];
}

/**
 * What a participant declared and what the market observed about it.
 *
 * `beneficialOwners` is the field that does the work, and collecting it is an
 * admission requirement rather than a technical one — which is the honest place
 * for it to live. A market can refuse to admit anyone who will not say who owns
 * them.
 */
export interface ParticipantProfile {
  id: ParticipantId;
  /** Ultimate beneficial owners, as declared at admission. */
  beneficialOwners: string[];
  /** Hashes of settlement account identifiers. Never the raw details. */
  settlementAccountHashes: string[];
  admittedAt: number;
}

/**
 * Two participants sharing a beneficial owner is the front-door version of
 * wash trading, and it is a CRITICAL finding rather than a warning: the trade
 * looks arm's-length in every record and is not.
 *
 * Related parties trading is not automatically abuse — group companies buy from
 * each other for perfectly good reasons — so this refuses to call it fraud. It
 * says the relationship exists and must be disclosed on the trade, which is
 * what an auditor or a counterparty actually needs.
 */
export function checkRelatedParties(seller: ParticipantProfile, buyer: ParticipantProfile): Finding[] {
  const findings: Finding[] = [];

  const sharedOwners = seller.beneficialOwners.filter((o) => buyer.beneficialOwners.includes(o));
  if (sharedOwners.length > 0) {
    findings.push({
      signal: 'shared_beneficial_owner',
      severity: 'critical',
      citation: 'Schedule A9',
      detail:
        `${seller.id} and ${buyer.id} share ${sharedOwners.length} beneficial owner(s). A trade between them is ` +
        'related-party, not arm\'s-length, and must be disclosed as such. Same-participant checks do not catch this.',
      participants: [seller.id, buyer.id],
    });
  }

  const sharedAccounts = seller.settlementAccountHashes.filter((h) => buyer.settlementAccountHashes.includes(h));
  if (sharedAccounts.length > 0) {
    findings.push({
      signal: 'shared_settlement_account',
      severity: 'critical',
      citation: 'Schedule A9',
      detail:
        'Both participants settle to the same account. Money would leave one pocket and arrive in the same one, ' +
        'which is wash activity however the identities are registered.',
      participants: [seller.id, buyer.id],
    });
  }

  return findings;
}

export interface TradeSummary {
  seller: ParticipantId;
  buyer: ParticipantId;
  gross: Minor;
  at: number;
  sku: string;
}

/**
 * Value going around a ring and returning to its start.
 *
 * A → B → C → A moves nothing in aggregate while generating three price prints
 * and three reputations. Detected as a cycle over the trade graph within a
 * window; depth-limited because a long enough chain is ordinary commerce.
 */
export function detectCircularTrading(trades: TradeSummary[], windowMs: number, now: number, maxRing = 4): Finding[] {
  const recent = trades.filter((t) => now - t.at <= windowMs);
  const edges = new Map<string, Set<string>>();
  for (const t of recent) {
    if (!edges.has(t.seller)) edges.set(t.seller, new Set());
    edges.get(t.seller)!.add(t.buyer);
  }

  const findings: Finding[] = [];
  const reported = new Set<string>();

  const walk = (start: string, current: string, path: string[]): void => {
    if (path.length > maxRing) return;
    for (const next of edges.get(current) ?? []) {
      if (next === start && path.length >= 2) {
        // Canonical key so A→B→C and B→C→A report once.
        const key = [...path].sort().join('|');
        if (reported.has(key)) continue;
        reported.add(key);
        findings.push({
          signal: 'circular_trading',
          severity: 'serious',
          citation: 'Schedule A9',
          detail:
            `Value returned to its origin through ${path.length} participants (${path.join(' → ')} → ${start}) ` +
            'within the window. In aggregate nothing moved, but a price history was created.',
          participants: path as ParticipantId[],
        });
        continue;
      }
      if (!path.includes(next)) walk(start, next, [...path, next]);
    }
  };

  for (const start of edges.keys()) walk(start, start, [start]);
  return findings;
}

/**
 * The same two parties trading back and forth.
 *
 * Not a ring — just A selling to B and B selling to A repeatedly. Legitimate
 * between genuine trading partners, so this is `moderate` and reports the net,
 * which is the number that distinguishes real two-way business from churn: real
 * partners have a direction over time, churn nets to roughly nothing.
 */
export function detectReciprocalChurn(
  trades: TradeSummary[],
  windowMs: number,
  now: number,
  minRoundTrips = 3,
): Finding[] {
  const pairs = new Map<string, { a: ParticipantId; b: ParticipantId; aToB: Minor; bToA: Minor; count: number }>();

  for (const t of trades.filter((x) => now - x.at <= windowMs)) {
    const [a, b] = [t.seller, t.buyer].sort() as [ParticipantId, ParticipantId];
    const key = `${a}|${b}`;
    const entry = pairs.get(key) ?? { a, b, aToB: 0n, bToA: 0n, count: 0 };
    if (t.seller === a) entry.aToB += t.gross;
    else entry.bToA += t.gross;
    entry.count += 1;
    pairs.set(key, entry);
  }

  const findings: Finding[] = [];
  for (const entry of pairs.values()) {
    const bothDirections = entry.aToB > 0n && entry.bToA > 0n;
    if (!bothDirections || entry.count < minRoundTrips) continue;

    const gross = entry.aToB + entry.bToA;
    const net = entry.aToB > entry.bToA ? entry.aToB - entry.bToA : entry.bToA - entry.aToB;
    // Netting to under a tenth of turnover is the shape of churn.
    if (net * 10n > gross) continue;

    findings.push({
      signal: 'reciprocal_churn',
      severity: 'moderate',
      citation: 'Schedule A9',
      detail:
        `${entry.count} trades between ${entry.a} and ${entry.b} turning over ${toDecimalString(gross)} but netting ` +
        `only ${toDecimalString(net)}. Two-way business has a direction over time; churn does not.`,
      participants: [entry.a, entry.b],
    });
  }
  return findings;
}

export interface OfferActivity {
  participant: ParticipantId;
  posted: number;
  withdrawnUnfilled: number;
  filled: number;
}

/**
 * Offers posted with no intention of filling.
 *
 * The point of spoofing is to move a price or draw out a counterparty's
 * position, then vanish. A high withdraw-to-fill ratio at volume is the
 * signature. Low-volume sellers are excluded: a small business that listed
 * three things and pulled two has not manipulated anything.
 */
export function detectSpoofing(activity: OfferActivity, minimumVolume = 20, ratio = 0.9): Finding[] {
  if (activity.posted < minimumVolume) return [];
  const withdrawRate = activity.withdrawnUnfilled / activity.posted;
  if (withdrawRate < ratio) return [];

  return [{
    signal: 'spoofing',
    severity: 'serious',
    citation: 'Schedule A9',
    detail:
      `${activity.participant} posted ${activity.posted} offers and withdrew ${activity.withdrawnUnfilled} unfilled ` +
      `(${Math.round(withdrawRate * 100)}%), filling ${activity.filled}. Offers nobody intends to fill move prices ` +
      'and draw out counterparties.',
    participants: [activity.participant],
  }];
}

export interface BidAttempt {
  bidder: ParticipantId;
  target: ParticipantId;
  amount: Minor;
  refused: boolean;
  at: number;
}

/**
 * Walking bids upward until one is refused, to discover a counterparty's limit.
 *
 * Apex already returns only the FIRST refusal reason to avoid mapping limits in
 * one shot. This catches the patient version: a monotonically rising sequence
 * of refusals against one counterparty is somebody binary-searching a ceiling,
 * and the value of knowing it is entirely in what you do next with it.
 */
export function detectLimitProbing(attempts: BidAttempt[], windowMs: number, now: number, minRun = 4): Finding[] {
  const byPair = new Map<string, BidAttempt[]>();
  for (const a of attempts.filter((x) => now - x.at <= windowMs && x.refused)) {
    const key = `${a.bidder}|${a.target}`;
    byPair.set(key, [...(byPair.get(key) ?? []), a]);
  }

  const findings: Finding[] = [];
  for (const [, run] of byPair) {
    if (run.length < minRun) continue;
    const ordered = [...run].sort((x, y) => x.at - y.at);
    const monotonic = ordered.every((a, i) => i === 0 || a.amount > ordered[i - 1].amount);
    if (!monotonic) continue;

    findings.push({
      signal: 'limit_probing',
      severity: 'moderate',
      citation: 'Article IV §4.3',
      detail:
        `${ordered.length} rising refused bids from ${ordered[0].bidder} against ${ordered[0].target} ` +
        `(${toDecimalString(ordered[0].amount)} → ${toDecimalString(ordered[ordered.length - 1].amount)}). ` +
        'That is a search for a ceiling, not a negotiation.',
      participants: [ordered[0].bidder, ordered[0].target],
    });
  }
  return findings;
}

/**
 * Highest severity found, for feeding the sanctions ladder.
 *
 * Returns the severity and nothing else: this module reports, the enforcement
 * engine decides. Keeping those apart is why a heuristic here cannot ban
 * anybody on its own.
 */
export function highestSeverity(findings: Finding[]): Severity | null {
  const order: Severity[] = ['advisory', 'moderate', 'serious', 'critical'];
  return findings.reduce<Severity | null>(
    (worst, f) => (worst === null || order.indexOf(f.severity) > order.indexOf(worst) ? f.severity : worst),
    null,
  );
}
