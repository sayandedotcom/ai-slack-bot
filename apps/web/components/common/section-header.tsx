import type { ReactNode } from "react";

/**
 * The one way a page labels a region: eyebrow (mono, the system naming its
 * part), a title (sans), and an optional right-side action. Every page uses
 * this, so a reader learns the hierarchy once.
 */
export function SectionHeader({
  eyebrow,
  title,
  action,
  description,
}: {
  eyebrow?: string;
  title: string;
  action?: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div className="space-y-1">
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2 className="font-semibold text-base tracking-tight">{title}</h2>
        {description ? (
          <p className="text-muted-foreground text-sm">{description}</p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
