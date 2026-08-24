/**
 * Number and value formatting for display.
 *
 * Kept out of the components so it is testable without a DOM, and kept in ONE
 * place so three screens cannot disagree about what "$4.2M" means.
 */

/**
 * Compact a number for a stat tile: 1,284 · 12.9K · $4.2M.
 *
 * The threshold is 10,000 rather than 1,000 deliberately. "1.3K" is strictly
 * less informative than "1,284" and saves three characters; the compaction only
 * earns its place once the full number stops being readable at a glance.
 */
export function compact(value: number, currency = false): string {
  if (!Number.isFinite(value)) return '—';

  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const prefix = currency ? '$' : '';

  // One decimal, stripped when it is `.0`. So 12.9K and 4.2M keep the digit
  // that carries information, while 12M does not gain a meaningless `.0`.
  const scale = (divisor: number, suffix: string) =>
    `${sign}${prefix}${(abs / divisor).toFixed(1).replace(/\.0$/, '')}${suffix}`;

  if (abs >= 1_000_000_000) return scale(1_000_000_000, 'B');
  if (abs >= 1_000_000) return scale(1_000_000, 'M');
  if (abs >= 10_000) return scale(1_000, 'K');

  return `${sign}${prefix}${abs.toLocaleString('en-US', {
    maximumFractionDigits: currency ? 2 : 0,
    minimumFractionDigits: currency && abs % 1 !== 0 ? 2 : 0,
  })}`;
}

/** Full precision, for tables and anywhere a figure must reconcile. */
export const usd = (value: number): string =>
  Number.isFinite(value)
    ? value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
    : '—';

/** Signed, for deltas and P&L. A leading `+` is information, not decoration. */
export const signedUsd = (value: number): string =>
  Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${usd(value)}` : '—';

/**
 * A ratio as a percentage, or an em dash.
 *
 * `null` is deliberately distinguished from `0`. A warehouse showing "0% full"
 * because a field is missing reads as healthy, which is the worst way to be
 * missing data.
 */
export const percent = (value: number | null | undefined, digits = 1): string =>
  value === null || value === undefined || !Number.isFinite(value)
    ? '—'
    : `${(value * 100).toFixed(digits)}%`;

/** Throughput and counts. Always grouped, never compacted — these get compared. */
export const count = (value: number): string =>
  Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
