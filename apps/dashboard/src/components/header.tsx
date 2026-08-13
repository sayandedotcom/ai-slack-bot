import type { Identity } from "../lib/api";

/**
 * The seam for identity: a later task fetches `/api/identity` once, at the
 * shell, and passes it down. The header itself never fetches.
 */
export function Header({ identity }: { identity?: Identity }) {
  return (
    <header className="flex items-center justify-between border-b px-6 py-4">
      <span className="text-sm font-semibold tracking-tight">Fire-Fighter</span>
      {identity ? (
        <span className="text-sm text-muted-foreground">
          {identity.email} · {identity.role}
        </span>
      ) : null}
    </header>
  );
}
