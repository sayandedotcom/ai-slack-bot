import { cn } from "@workspace/ui/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";

export type BadgeTone =
  | "neutral"
  | "attention"
  | "success"
  | "warning"
  | "info"
  | "destructive"
  | "shadow";

/**
 * One badge for every status-shaped thing. Tone is the only colour input, so
 * a reader learns seven meanings once; variant is how loud it is.
 */
const statusBadgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md border font-medium leading-none",
  {
    variants: {
      tone: {
        neutral: "",
        attention: "",
        success: "",
        warning: "",
        info: "",
        destructive: "",
        shadow: "",
      },
      variant: {
        soft: "",
        outline: "bg-transparent",
        dot: "border-transparent bg-transparent px-0",
      },
      size: {
        sm: "h-5 px-1.5 text-[11px]",
        md: "h-6 px-2 text-xs",
      },
    },
    compoundVariants: [
      {
        tone: "neutral",
        variant: "soft",
        class: "border-border bg-muted text-muted-foreground",
      },
      {
        tone: "attention",
        variant: "soft",
        class: "border-attention/30 bg-attention/12 text-attention",
      },
      {
        tone: "success",
        variant: "soft",
        class: "border-success/30 bg-success/12 text-success",
      },
      {
        tone: "warning",
        variant: "soft",
        class: "border-warning/30 bg-warning/12 text-warning",
      },
      {
        tone: "info",
        variant: "soft",
        class: "border-info/30 bg-info/12 text-info",
      },
      {
        tone: "destructive",
        variant: "soft",
        class: "border-destructive/30 bg-destructive/12 text-destructive",
      },
      {
        tone: "shadow",
        variant: "soft",
        class: "border-shadow-run/30 bg-shadow-run/12 text-shadow-run",
      },
      {
        tone: "neutral",
        variant: "outline",
        class: "border-border text-muted-foreground",
      },
      {
        tone: "attention",
        variant: "outline",
        class: "border-attention/50 text-attention",
      },
      {
        tone: "success",
        variant: "outline",
        class: "border-success/50 text-success",
      },
      {
        tone: "warning",
        variant: "outline",
        class: "border-warning/50 text-warning",
      },
      { tone: "info", variant: "outline", class: "border-info/50 text-info" },
      {
        tone: "destructive",
        variant: "outline",
        class: "border-destructive/50 text-destructive",
      },
      {
        tone: "shadow",
        variant: "outline",
        class: "border-shadow-run/50 text-shadow-run",
      },
      { tone: "neutral", variant: "dot", class: "text-muted-foreground" },
      { tone: "attention", variant: "dot", class: "text-attention" },
      { tone: "success", variant: "dot", class: "text-success" },
      { tone: "warning", variant: "dot", class: "text-warning" },
      { tone: "info", variant: "dot", class: "text-info" },
      { tone: "destructive", variant: "dot", class: "text-destructive" },
      { tone: "shadow", variant: "dot", class: "text-shadow-run" },
    ],
    defaultVariants: { tone: "neutral", variant: "soft", size: "sm" },
  }
);

export type StatusBadgeProps = React.ComponentProps<"span"> &
  VariantProps<typeof statusBadgeVariants> & {
    /** Ping ring behind the dot. Only for "changing right now". */
    pulse?: boolean;
    icon?: React.ReactNode;
    /** Mono for system-produced labels (ids, capability names); sans otherwise. */
    mono?: boolean;
  };

function Dot({ pulse }: { pulse: boolean }) {
  return (
    <span className="relative flex size-1.5 shrink-0" aria-hidden="true">
      {pulse ? (
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-70" />
      ) : null}
      <span className="relative inline-flex size-1.5 rounded-full bg-current" />
    </span>
  );
}

export function StatusBadge({
  className,
  tone,
  variant,
  size,
  pulse = false,
  icon,
  mono = false,
  children,
  ...props
}: StatusBadgeProps) {
  const showDot = variant === "dot" || pulse;
  return (
    <span
      data-slot="status-badge"
      data-tone={tone ?? "neutral"}
      className={cn(
        statusBadgeVariants({ tone, variant, size }),
        mono && "font-mono tabular-nums tracking-[-0.01em]",
        className
      )}
      {...props}
    >
      {showDot ? <Dot pulse={pulse} /> : icon}
      {children}
    </span>
  );
}

export { statusBadgeVariants };
