import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";

export function CopyId({ runId }: { runId: string }): ReactNode {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(() => {
    // `clipboard` is absent on insecure origins; the id stays selectable text,
    // so a failure here costs nothing worth reporting.
    void navigator.clipboard?.writeText(runId).then(
      () => setCopied(true),
      () => undefined
    );
  }, [runId]);

  return (
    <span className="inline-flex items-center gap-1">
      <code className="rounded bg-muted px-1.5 py-0.5 text-[11px]">
        {runId}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy run id ${runId}`}
        className="rounded px-1 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {copied ? "copied" : "copy"}
      </button>
    </span>
  );
}
