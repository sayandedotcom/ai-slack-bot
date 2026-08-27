import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * An empty region is a statement about the system, not an absence of content.
 * "No runs" is a fact; "the agent wakes when a customer thread needs it" is the
 * reason, and the reason is what stops a reader wondering whether the page is
 * broken.
 */
export function Empty({
  icon: Icon,
  title,
  hint,
}: {
  icon: LucideIcon;
  title: string;
  hint?: ReactNode;
}): ReactNode {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-8 text-center">
      <Icon className="size-5 text-muted-foreground/60" aria-hidden="true" />
      <p className="font-medium text-sm">{title}</p>
      {hint ? (
        <p className="max-w-sm text-balance text-muted-foreground text-xs">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
