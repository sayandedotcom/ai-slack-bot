import type { ReactNode } from "react";

/**
 * The one heading on a page.
 *
 * The eyebrow is a window, not a repeat of the nav label — the sidebar already
 * says which page you are on, so spending the line on "DASHBOARD" would be
 * decoration. It says what the numbers below it cover instead.
 */
export function PageHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="space-y-2.5">
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">{title}</h1>
      {children ? (
        <p className="max-w-2xl text-sm text-pretty text-muted-foreground">{children}</p>
      ) : null}
    </div>
  );
}
