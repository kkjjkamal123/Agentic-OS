import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({ variant = 'secondary', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...p}
      className={cx(
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-accent text-accent-fg hover:bg-accent-hover',
        variant === 'secondary' && 'border border-line-strong bg-surface-solid text-fg hover:bg-surface-2',
        variant === 'ghost' && 'text-muted hover:bg-surface-3 hover:text-fg',
        variant === 'danger' && 'text-danger hover:bg-danger-soft',
        className,
      )}
    />
  );
}

export function Input({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...p}
      className={cx(
        'h-8 w-full rounded-lg border border-line-strong bg-surface-solid px-2.5 text-[13px] text-fg placeholder:text-faint',
        'focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent-soft',
        className,
      )}
    />
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[200px_1fr] items-start gap-6 py-4">
      <div className="pt-1.5">
        <div className="text-[13px] font-medium text-fg">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-muted">{hint}</div>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="mb-8">
      <h2 className="text-base font-semibold text-fg">{title}</h2>
      {description && <p className="mt-1 max-w-prose text-[13px] text-muted">{description}</p>}
      <div className="mt-3 divide-y divide-line border-t border-line">{children}</div>
    </section>
  );
}

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex h-5 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium',
        tone === 'neutral' && 'bg-surface-3 text-muted',
        tone === 'accent' && 'bg-accent-soft text-accent',
        tone === 'success' && 'bg-success-soft text-success',
        tone === 'warning' && 'bg-warning-soft text-warning',
        tone === 'danger' && 'bg-danger-soft text-danger',
      )}
    >
      {children}
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-lg bg-surface-3 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'h-7 rounded-md px-3 text-[13px] font-medium transition-colors',
            value === o.value ? 'bg-surface-solid text-fg shadow-sm' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx('relative h-5 w-9 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-surface-3 ring-1 ring-line-strong')}
    >
      <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  );
}

/** Honest placeholder for an app whose engine lands in a later milestone. */
export function ComingSoon({ icon, title, milestone, children }: { icon: ReactNode; title: string; milestone: number; children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-10">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-accent-soft text-accent">{icon}</div>
        <h2 className="text-base font-semibold">{title}</h2>
        <div className="mt-1.5 text-[13px] leading-relaxed text-muted">{children}</div>
        <div className="mt-4">
          <Badge tone="accent">Arrives in milestone {milestone}</Badge>
        </div>
      </div>
    </div>
  );
}
