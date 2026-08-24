import React from 'react';
import { AlertTriangle, CheckCircle2, CircleAlert, Info, MinusCircle, OctagonAlert } from 'lucide-react';
import { DEFAULT_LABEL, STATUS_STYLE, type StatusRole } from './status';

/*
 * Status feedback.
 *
 * The rule these enforce: **a status is never colour alone.** Every chip and
 * every banner carries an icon and a word. That is what makes the state legible
 * to a colourblind reader, in greyscale, under `forced-colors`, and to anyone
 * glancing at a screen from three feet away.
 *
 * The icon is chosen by role here rather than passed in, precisely so a caller
 * cannot put a tick on a critical state.
 */

const ICON: Record<StatusRole, React.ComponentType<{ className?: string }>> = {
  good: CheckCircle2,
  warning: AlertTriangle,
  serious: CircleAlert,
  critical: OctagonAlert,
  info: Info,
  neutral: MinusCircle,
};

export interface StatusChipProps {
  role: StatusRole;
  /** Falls back to the role's own word — a chip is never rendered wordless. */
  label?: string;
  /** Hidden label for very tight rows. The word still reaches assistive tech. */
  compactLabel?: boolean;
  title?: string;
}

export const StatusChip: React.FC<StatusChipProps> = ({ role, label, compactLabel = false, title }) => {
  const Icon = ICON[role];
  const style = STATUS_STYLE[role];
  const text = label ?? DEFAULT_LABEL[role];

  return (
    <span
      title={title ?? text}
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-[var(--radius-sm)] border text-[10px] font-bold whitespace-nowrap"
      style={{ color: style.ink, borderColor: style.mark, background: style.wash }}
    >
      <Icon className="w-2.5 h-2.5 shrink-0" />
      {compactLabel ? <span className="sr-only">{text}</span> : <span>{text}</span>}
    </span>
  );
};

export interface AlertProps {
  role: StatusRole;
  title?: string;
  children: React.ReactNode;
  /** `alert` interrupts a screen reader; `status` waits politely. */
  live?: 'alert' | 'status' | 'none';
}

export const Alert: React.FC<AlertProps> = ({ role, title, children, live = 'status' }) => {
  const Icon = ICON[role];
  const style = STATUS_STYLE[role];

  return (
    <div
      // `role="alert"` is reserved for things that genuinely interrupt — a halted
      // kill switch, a failed request. A recurring warning banner that shouts on
      // every poll trains people to ignore it.
      role={live === 'none' ? undefined : live}
      className="flex items-start gap-2.5 p-3 rounded-[var(--radius-xl)] border text-[11px] leading-relaxed"
      style={{
        color: style.ink,
        borderColor: style.mark,
        background: style.wash,
      }}
    >
      <Icon className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="min-w-0">
        {title && <strong className="font-bold">{title}</strong>} {children}
      </div>
    </div>
  );
};
