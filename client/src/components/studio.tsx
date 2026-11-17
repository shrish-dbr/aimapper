// "Mapping studio" UI kit — small presentational building blocks shared by every
// page so the redesign stays consistent. Purely visual: no data fetching, no state
// beyond what callers pass in.
import type { ReactNode } from 'react';
import { Search } from 'lucide-react';
import { cn } from '../lib/utils';
import { initials, type Tone } from '../lib/display';

// ── Page header ─────────────────────────────────────────────────────────────
/** Eyebrow ("Workspace") → large title → description, with right-aligned actions. */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-4 md:flex-row md:items-end md:justify-between', className)}>
      <div className="min-w-0">
        {eyebrow && <p className="text-[0.8125rem] text-muted-foreground mb-1">{eyebrow}</p>}
        <h1 className="text-[2rem] leading-tight font-bold tracking-tight text-foreground">{title}</h1>
        {description && <div className="mt-1.5 text-[0.9375rem] text-muted-foreground max-w-3xl">{description}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 md:justify-end shrink-0">{actions}</div>}
    </div>
  );
}

// ── Surfaces ────────────────────────────────────────────────────────────────
/** White card with hairline border (or the dark "ink" variant for hero panels). */
export function Panel({
  children,
  className,
  tone = 'default',
}: {
  children: ReactNode;
  className?: string;
  tone?: 'default' | 'ink' | 'sunken';
}) {
  return (
    <div
      className={cn(
        'rounded-[var(--radius)] border',
        tone === 'default' && 'bg-card text-card-foreground border-border shadow-[0_1px_2px_0_rgb(27_46_54/0.04)]',
        tone === 'ink' && 'bg-ink text-ink-foreground border-transparent',
        tone === 'sunken' && 'bg-surface-sunken border-transparent',
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Panel heading row: title + description on the left, actions/meta on the right. */
export function PanelHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3 px-6 pt-5 pb-4', className)}>
      <div className="min-w-0">
        <h2 className="text-[1.125rem] font-bold tracking-tight">{title}</h2>
        {description && <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

/** Numbered section heading used in the Mapper flow: "01 Project". */
export function StepHeading({
  index,
  title,
  description,
  actions,
}: {
  index: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[1.40625rem] font-bold tracking-tight">
          <span className="text-brand mr-1.5">{index}</span>
          {title}
        </h2>
        {description && <div className="mt-0.5 text-sm text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}

// ── Stats ───────────────────────────────────────────────────────────────────
const DOT: Record<Tone, string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-brand',
  brand: 'bg-brand',
  neutral: 'bg-muted-foreground/50',
  ink: 'bg-ink',
};

/** KPI tile: uppercase label, big number, small hint. `active` renders it in ink. */
export function StatCard({
  label,
  value,
  hint,
  dot,
  active = false,
  className,
  onClick,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  dot?: Tone;
  active?: boolean;
  className?: string;
  onClick?: () => void;
}) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'text-left rounded-[var(--radius)] border px-6 py-5 min-w-0',
        active ? 'bg-ink text-ink-foreground border-transparent' : 'bg-card text-card-foreground border-border',
        onClick && 'cursor-pointer hover:border-foreground/25',
        className,
      )}
    >
      <div className={cn('flex items-center gap-2', dot ? 'text-sm font-semibold' : 'eyebrow', active && !dot && 'text-ink-muted')}>
        {dot && <span className={cn('h-2 w-2 rounded-full', DOT[dot])} />}
        <span className={cn(active && dot && 'text-ink-foreground')}>{label}</span>
      </div>
      <div className="mt-1.5 text-[2rem] leading-none font-bold tracking-tight tabular-nums">{value}</div>
      {hint && <div className={cn('mt-2 text-[0.8125rem]', active ? 'text-ink-muted' : 'text-muted-foreground')}>{hint}</div>}
    </Comp>
  );
}

// ── Pills, chips, tags ──────────────────────────────────────────────────────
const PILL: Record<Tone, string> = {
  success: 'bg-success-soft text-success-soft-foreground',
  warning: 'bg-warning-soft text-warning-soft-foreground',
  danger: 'bg-danger-soft text-danger-soft-foreground',
  brand: 'bg-brand-soft text-brand-soft-foreground',
  neutral: 'bg-muted text-muted-foreground',
  ink: 'bg-ink text-ink-foreground',
};

/** Soft status pill with a leading dot: ● Success. */
export function StatusPill({
  tone,
  children,
  dot = true,
  className,
  title,
}: {
  tone: Tone;
  children: ReactNode;
  dot?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap', PILL[tone], className)}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

/** Outlined chip for categorical metadata (source system, vendor, version). */
export function Chip({ children, dot = false, className, title }: { children: ReactNode; dot?: boolean; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn('inline-flex items-center gap-1.5 rounded-full border border-input bg-card px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap', className)}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-brand" />}
      {children}
    </span>
  );
}

/** Small uppercase tag ("DEFAULT") or version tag ("v4"). */
export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[0.6875rem] font-semibold text-muted-foreground', className)}>
      {children}
    </span>
  );
}

/** Monospace identifier (table/column names). */
export function Mono({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('font-mono text-[0.8125rem]', className)}>
      {children}
    </span>
  );
}

/** Initials avatar on ink. */
export function Avatar({ name, size = 'md', className }: { name: string | null | undefined; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  return (
    <span
      title={name ?? undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-ink text-ink-foreground font-bold',
        size === 'sm' && 'h-7 w-7 text-[0.625rem]',
        size === 'md' && 'h-9 w-9 text-xs',
        size === 'lg' && 'h-12 w-12 text-sm',
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}

// ── Meters ──────────────────────────────────────────────────────────────────
/** Thin horizontal meter (0..1). Null renders an empty track. */
export function Meter({ value, className, tone = 'brand' }: { value: number | null | undefined; className?: string; tone?: 'brand' | 'ink' | 'success' }) {
  const pct = value === null || value === undefined || Number.isNaN(value) ? 0 : Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className={cn('h-1.5 w-full rounded-full bg-muted overflow-hidden', className)}>
      <div
        className={cn('h-full rounded-full', tone === 'brand' && 'bg-brand', tone === 'ink' && 'bg-ink dark:bg-ink-muted', tone === 'success' && 'bg-success')}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

// ── Inputs ──────────────────────────────────────────────────────────────────
/** Search field with a leading magnifier. */
export function SearchField({
  value,
  onChange,
  placeholder,
  className,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <label className={cn('relative block', className)}>
      <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        className="h-11 w-full rounded-[0.625rem] border border-input bg-card pl-10 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
      />
    </label>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────────
export function EmptyState({ icon, children, className }: { icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-input px-6 py-10 text-center text-sm text-muted-foreground', className)}>
      {icon && <span className="text-muted-foreground">{icon}</span>}
      {children}
    </div>
  );
}
