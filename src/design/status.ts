/**
 * Status semantics.
 *
 * Four reserved roles, mapped once. A status colour never doubles as a series
 * colour, and it never appears without an icon and a label — colour alone
 * carries no meaning for a colourblind reader, a greyscale print, or anyone
 * with `forced-colors` on.
 *
 * The mapping from a domain word ("degraded", "SELL_STRIKE", "refused") to a
 * role lives here rather than in each component, so the same condition cannot
 * render amber on one screen and red on another. That happened.
 */

export type StatusRole = 'good' | 'warning' | 'serious' | 'critical' | 'neutral' | 'info';

export interface StatusStyle {
  /** Text colour. Meets AA on the panel surface. */
  ink: string;
  /** Border and icon colour. The canonical status hue. */
  mark: string;
  /** Low-alpha wash for chips and banners. */
  wash: string;
}

export const STATUS_STYLE: Record<StatusRole, StatusStyle> = {
  good: {
    ink: 'var(--status-good-ink)',
    mark: 'var(--status-good)',
    wash: 'color-mix(in srgb, var(--status-good) 14%, transparent)',
  },
  warning: {
    ink: 'var(--status-warning-ink)',
    mark: 'var(--status-warning)',
    wash: 'color-mix(in srgb, var(--status-warning) 14%, transparent)',
  },
  serious: {
    ink: 'var(--status-serious-ink)',
    mark: 'var(--status-serious)',
    wash: 'color-mix(in srgb, var(--status-serious) 14%, transparent)',
  },
  critical: {
    ink: 'var(--status-critical-ink)',
    mark: 'var(--status-critical)',
    wash: 'color-mix(in srgb, var(--status-critical) 16%, transparent)',
  },
  info: {
    ink: 'var(--series-1)',
    mark: 'var(--series-1)',
    wash: 'color-mix(in srgb, var(--series-1) 14%, transparent)',
  },
  neutral: {
    ink: 'var(--ink-secondary)',
    mark: 'var(--line-strong)',
    wash: 'transparent',
  },
};

/**
 * Domain vocabulary to status role.
 *
 * Every string the application actually emits is listed. An unrecognised value
 * returns `neutral` rather than throwing — an unknown state should render as
 * "we do not know", not crash a dashboard.
 */
const ROLE_BY_TERM: Record<string, StatusRole> = {
  // Production line and node health
  operational: 'good',
  degraded: 'warning',
  offline: 'critical',
  maintenance: 'info',

  // Mandate verdicts
  SELL_STRIKE: 'good',
  SELL_STOP_LOSS: 'critical',
  HOLD_UNECONOMIC: 'warning',
  HOLD: 'neutral',

  // Order lifecycle
  pending: 'warning',
  working: 'info',
  partially_filled: 'info',
  filled: 'good',
  cancelled: 'neutral',
  rejected: 'critical',
  expired: 'neutral',

  // Graph validation
  error: 'critical',

  // Audit outcomes
  allowed: 'good',
  refused: 'critical',
  info: 'info',
};

export const roleFor = (term: string | null | undefined): StatusRole =>
  (term && ROLE_BY_TERM[term]) || 'neutral';

/**
 * Every role's default label, so a chip is never rendered as a bare colour.
 * Callers usually pass their own, but the fallback must never be empty.
 */
export const DEFAULT_LABEL: Record<StatusRole, string> = {
  good: 'OK',
  warning: 'Warning',
  serious: 'Attention',
  critical: 'Critical',
  info: 'Info',
  neutral: 'Unknown',
};
