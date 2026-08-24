import React from 'react';

/*
 * Buttons.
 *
 * Three things this centralises that were inconsistent when every button was
 * hand-rolled:
 *
 *  1. **`type="button"` by default.** A `<button>` inside a form defaults to
 *     `submit`. Several buttons in this app sat inside forms and were one
 *     refactor away from submitting them.
 *  2. **A disabled button explains itself.** `disabled` with no `title` leaves
 *     the user staring at a greyed control with no idea why. `disabledReason`
 *     makes the explanation a required thought rather than an optional one.
 *  3. **Danger is a variant, not a colour someone remembered.**
 */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type Size = 'sm' | 'md';

const VARIANT: Record<Variant, React.CSSProperties> = {
  primary: {
    background: 'var(--accent)',
    color: 'var(--accent-contrast)',
    borderColor: 'var(--accent)',
    fontWeight: 700,
  },
  secondary: {
    background: 'var(--surface-3)',
    color: 'var(--ink-primary)',
    borderColor: 'var(--line)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--ink-secondary)',
    borderColor: 'transparent',
  },
  danger: {
    background: 'var(--status-critical)',
    color: '#ffffff',
    borderColor: 'var(--status-critical)',
    fontWeight: 700,
  },
  success: {
    background: 'var(--status-good)',
    color: '#ffffff',
    borderColor: 'var(--status-good)',
    fontWeight: 700,
  },
};

const SIZE: Record<Size, string> = {
  sm: 'px-2.5 py-1 text-[11px] gap-1.5',
  md: 'px-3.5 py-1.5 text-xs gap-2',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: React.ReactNode;
  /**
   * Why the button is unavailable. Surfaced as the tooltip and the accessible
   * description, so the reason reaches a screen reader too.
   */
  disabledReason?: string;
  busy?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'secondary',
  size = 'md',
  icon,
  disabled,
  disabledReason,
  busy = false,
  className = '',
  style,
  children,
  type,
  title,
  ...rest
}) => {
  const isDisabled = disabled || busy;

  return (
    <button
      // Never `submit` unless a caller deliberately asks for it.
      type={type ?? 'button'}
      disabled={isDisabled}
      title={title ?? (isDisabled ? disabledReason : undefined)}
      aria-label={rest['aria-label']}
      aria-describedby={rest['aria-describedby']}
      aria-busy={busy || undefined}
      className={`inline-flex items-center justify-center rounded-[var(--radius-md)] border ${SIZE[size]} ${
        isDisabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
      } ${className}`}
      style={{
        ...VARIANT[variant],
        transition: `filter var(--duration-fast) var(--ease-out)`,
        ...style,
      }}
      {...rest}
    >
      {icon && <span aria-hidden="true">{icon}</span>}
      <span>{children}</span>
      {/*
        The reason travels with the button for assistive tech, not just as a
        hover tooltip — a tooltip is invisible to a keyboard-only user.
      */}
      {isDisabled && disabledReason && <span className="sr-only"> — {disabledReason}</span>}
    </button>
  );
};
