import React from 'react';
import { compact, percent } from './format';
import { STATUS_STYLE, type StatusRole } from './status';

/*
 * Data display primitives — the pieces a dashboard is actually made of.
 *
 * These follow the data-visualisation contracts rather than local taste:
 *
 *  - **Not everything is a chart.** A single current value is a stat tile, not
 *    a one-bar bar chart. A ratio against a limit is a meter, not a two-slice
 *    pie. Both forms are here so nobody reaches for a chart library to draw
 *    one number.
 *  - **Labels are sentence case with no trailing colon.** The app previously
 *    shouted every label in uppercase, which is harder to read and makes
 *    everything look equally urgent.
 *  - **Proportional figures for display numbers; tabular only in columns.**
 *    `tabular-nums` gives every digit the width of a zero, which is correct in
 *    a table and looks loose at display size. This is why `StatTile` does NOT
 *    set it and `DataTable` does.
 */

export interface StatTileProps {
  label: string;
  value: string | number;
  /** Rendered as currency when `value` is a number. */
  currency?: boolean;
  /** Signed change against a named period, e.g. `{ value: 412, period: '24h' }`. */
  delta?: { value: number; period: string; upIsGood?: boolean };
  /** One line of context under the value. */
  hint?: string;
  role?: StatusRole;
}

export const StatTile: React.FC<StatTileProps> = ({
  label,
  value,
  currency = false,
  delta,
  hint,
  role,
}) => {
  const display = typeof value === 'number' ? compact(value, currency) : value;
  const tone = role ? STATUS_STYLE[role].ink : 'var(--ink-primary)';

  // Direction × whether up is good. A falling error count is good news.
  const upIsGood = delta?.upIsGood ?? true;
  const deltaGood = delta ? (delta.value >= 0) === upIsGood : true;

  return (
    <div
      className="rounded-[var(--radius-md)] border p-2.5"
      style={{ background: 'var(--surface-2)', borderColor: 'var(--line-subtle)' }}
    >
      <div className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
        {label}
      </div>
      <div className="text-base font-semibold leading-tight" style={{ color: tone }}>
        {display}
      </div>
      {delta && (
        <div
          className="text-[10px]"
          style={{
            color: deltaGood ? 'var(--status-good-ink)' : 'var(--status-critical-ink)',
          }}
        >
          {delta.value >= 0 ? '+' : ''}
          {compact(delta.value, currency)} vs {delta.period}
        </div>
      )}
      {hint && (
        <div className="text-[10px]" style={{ color: 'var(--ink-muted)' }}>
          {hint}
        </div>
      )}
    </div>
  );
};

/**
 * The one number a view leads with. Exactly one per screen.
 *
 * Sans, not a display face — a decorative numeral on an operations dashboard
 * reads as marketing, and this number is meant to be trusted.
 */
export const HeroFigure: React.FC<{ label: string; value: string; hint?: string }> = ({
  label,
  value,
  hint,
}) => (
  <div>
    <div className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
      {label}
    </div>
    <div
      className="font-semibold leading-none"
      style={{ fontSize: '3rem', color: 'var(--ink-primary)' }}
    >
      {value}
    </div>
    {hint && (
      <div className="text-[11px] mt-1" style={{ color: 'var(--ink-secondary)' }}>
        {hint}
      </div>
    )}
  </div>
);

export interface MeterProps {
  label: string;
  /** 0–1. `null` means unknown, which is rendered as unknown rather than empty. */
  value: number | null;
  /** Shown to the right of the label, e.g. `2,101 / 5,000 TB`. */
  detail?: string;
  /** Fraction above which the fill escalates. */
  warnAt?: number;
  criticalAt?: number;
}

/**
 * A single ratio against a limit.
 *
 * Two details that are easy to get wrong:
 *
 *  - **The track is a light step of the fill's own ramp**, not grey. State then
 *    reads across the whole bar rather than only in the filled part.
 *  - **`null` is not zero.** An unknown ratio renders as a hatched, labelled
 *    "unknown" bar. A meter that shows 0% because a field is missing reads as
 *    healthy, which is the most dangerous way to be missing data.
 */
export const Meter: React.FC<MeterProps> = ({
  label,
  value,
  detail,
  warnAt = 0.8,
  criticalAt = 0.95,
}) => {
  const known = value !== null && Number.isFinite(value);
  const clamped = known ? Math.min(1, Math.max(0, value!)) : 0;

  const fill = !known
    ? 'var(--line)'
    : clamped >= criticalAt
      ? 'var(--status-critical)'
      : clamped >= warnAt
        ? 'var(--status-warning)'
        : 'var(--seq-400)';

  // Same hue as the fill, lighter step — never grey.
  const track = !known
    ? 'var(--surface-3)'
    : clamped >= criticalAt
      ? 'color-mix(in srgb, var(--status-critical) 22%, var(--surface-2))'
      : clamped >= warnAt
        ? 'color-mix(in srgb, var(--status-warning) 22%, var(--surface-2))'
        : 'color-mix(in srgb, var(--seq-250) 26%, var(--surface-2))';

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-[11px]" style={{ color: 'var(--ink-muted)' }}>
          {label}
        </span>
        <span className="text-[11px] tabular" style={{ color: 'var(--ink-secondary)' }}>
          {detail ? `${detail} · ` : ''}
          {percent(value)}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuenow={known ? Math.round(clamped * 100) : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={known ? percent(value) : 'unknown'}
        className="h-1.5 w-full rounded-[var(--radius-pill)] overflow-hidden"
        style={{ background: track }}
      >
        {known ? (
          <div
            className="h-full rounded-[var(--radius-pill)]"
            style={{
              width: `${clamped * 100}%`,
              background: fill,
              transition: `width var(--duration-slow) var(--ease-out)`,
            }}
          />
        ) : (
          <div
            className="h-full w-full"
            style={{
              // 45° hatching — the documented backup channel for "no value",
              // so the state survives greyscale and forced-colors.
              backgroundImage:
                'repeating-linear-gradient(45deg, var(--line-strong) 0 2px, transparent 2px 6px)',
            }}
          />
        )}
      </div>
    </div>
  );
};

/** A row of stat tiles. The default form for a handful of headline numbers. */
export const KpiRow: React.FC<{ children: React.ReactNode; columns?: 2 | 3 | 4 }> = ({
  children,
  columns = 4,
}) => (
  <div
    className={`grid gap-2 ${
      columns === 2 ? 'grid-cols-2' : columns === 3 ? 'grid-cols-2 md:grid-cols-3' : 'grid-cols-2 md:grid-cols-4'
    }`}
  >
    {children}
  </div>
);
