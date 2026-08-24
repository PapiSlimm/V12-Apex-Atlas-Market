import React from 'react';

/*
 * Surfaces — the two containers everything else sits in.
 *
 * `GlassPanel` is the static surface. `QuantumCard` is the one you can pick.
 * The split exists because they have different accessibility contracts, and
 * conflating them is how this app ended up with a dozen `<div onClick>` rows
 * that a keyboard user could see but never select.
 */

type Tone = 'default' | 'inset' | 'raised';

const TONE_BG: Record<Tone, string> = {
  default: 'var(--surface-glass)',
  inset: 'var(--surface-2)',
  raised: 'var(--surface-3)',
};

const TONE_SHADOW: Record<Tone, string> = {
  default: 'var(--elevation-2)',
  inset: 'none',
  raised: 'var(--elevation-3)',
};

export interface GlassPanelProps extends React.HTMLAttributes<HTMLElement> {
  tone?: Tone;
  /** `section` when the panel is a landmark; `li` inside a list. */
  as?: 'div' | 'section' | 'article' | 'li';
  padded?: boolean;
}

export const GlassPanel: React.FC<GlassPanelProps> = ({
  tone = 'default',
  as: Tag = 'div',
  padded = true,
  className = '',
  style,
  children,
  ...rest
}) => (
  <Tag
    className={`rounded-[var(--radius-xl)] border ${padded ? 'p-4' : ''} ${className}`}
    style={{
      background: TONE_BG[tone],
      borderColor: 'var(--line-subtle)',
      boxShadow: TONE_SHADOW[tone],
      ...style,
    }}
    {...rest}
  >
    {children}
  </Tag>
);

export interface QuantumCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onSelect'> {
  selected?: boolean;
  onSelect?: () => void;
  /**
   * `option` when the card is one of a set the user picks from (wrap the set in
   * `role="listbox"`); `button` when it stands alone and does something.
   */
  role?: 'option' | 'button';
  disabled?: boolean;
  /** Accessible name. Required when selectable — a card named by colour is not named. */
  label?: string;
}

/**
 * A selectable surface.
 *
 * Non-negotiables baked in rather than left to each caller:
 *
 *  - **Reachable by keyboard.** `tabIndex=0`, and Enter or Space activates it.
 *    A card that only responds to a mouse excludes every keyboard and screen
 *    reader user, and it is the single most common defect in a hand-rolled
 *    card list.
 *  - **Selection is announced, not just painted.** `aria-selected` carries the
 *    state; the emerald border is the visual echo of it, not the source.
 *  - **Space is prevented from scrolling** while the card has focus, which is
 *    what a native control does and what a user expects.
 */
export const QuantumCard: React.FC<QuantumCardProps> = ({
  selected = false,
  onSelect,
  role = 'option',
  disabled = false,
  label,
  className = '',
  style,
  children,
  ...rest
}) => {
  const interactive = Boolean(onSelect) && !disabled;

  const activate = () => {
    if (interactive) onSelect!();
  };

  return (
    <div
      role={interactive ? role : undefined}
      aria-selected={interactive && role === 'option' ? selected : undefined}
      aria-disabled={disabled || undefined}
      aria-label={label}
      tabIndex={interactive ? 0 : undefined}
      onClick={activate}
      onKeyDown={(event) => {
        if (!interactive) return;
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault(); // Space would otherwise scroll the page.
          activate();
        }
      }}
      className={`rounded-[var(--radius-lg)] border p-4 ${
        interactive ? 'cursor-pointer' : ''
      } ${disabled ? 'opacity-50' : ''} ${className}`}
      style={{
        background: selected ? 'var(--surface-1)' : 'color-mix(in srgb, var(--surface-1) 60%, transparent)',
        borderColor: selected ? 'var(--accent)' : 'var(--line-subtle)',
        boxShadow: selected ? 'var(--elevation-2)' : 'var(--elevation-1)',
        transition: `border-color var(--duration-base) var(--ease-out), background var(--duration-base) var(--ease-out)`,
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
};

/** Section heading with a consistent icon slot. Sentence case, always. */
export const PanelHeading: React.FC<{
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}> = ({ icon, title, subtitle, actions }) => (
  <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
    <div className="flex items-center gap-2.5 min-w-0">
      {icon && <span aria-hidden="true">{icon}</span>}
      <div className="min-w-0">
        <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--ink-primary)' }}>
          {title}
        </h3>
        {subtitle && (
          <p className="text-[11px] leading-relaxed" style={{ color: 'var(--ink-secondary)' }}>
            {subtitle}
          </p>
        )}
      </div>
    </div>
    {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
  </div>
);
