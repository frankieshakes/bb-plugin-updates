// The bordered lists the Plugin Updates page is built from.
import type { ReactNode } from "react";

export function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card px-4">
        {children}
      </ul>
    </section>
  );
}

export function Collapsed({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <details className="group">
      <summary className="cursor-pointer select-none text-sm text-muted-foreground hover:text-foreground">
        {title} ({count})
      </summary>
      <ul className="mt-2 divide-y divide-border overflow-hidden rounded-lg border border-border bg-card px-4">
        {children}
      </ul>
    </details>
  );
}

export function Row({
  id,
  tag,
  children,
  note,
  actions,
}: {
  id: string;
  /** A short status shown beside the id, e.g. "Disabled". */
  tag?: string;
  /** One truncated line of detail. */
  children?: ReactNode;
  /** A line under the detail that must stay readable, so it wraps rather than truncates. */
  note?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 py-2.5 text-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 font-medium">
          {id}
          {tag === undefined ? null : (
            <span className="rounded border border-border px-1.5 py-px text-[11px] font-normal text-muted-foreground">
              {tag}
            </span>
          )}
        </div>
        {children === undefined ? null : (
          <div className="truncate text-xs text-muted-foreground">{children}</div>
        )}
        {note === undefined ? null : (
          <div className="break-words text-xs text-muted-foreground">{note}</div>
        )}
      </div>
      {actions === undefined ? null : <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </li>
  );
}
