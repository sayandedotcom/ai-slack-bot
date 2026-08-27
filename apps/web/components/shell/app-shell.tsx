"use client";

import {
  SidebarInset,
  SidebarProvider,
} from "@workspace/ui/components/sidebar";
import { type ReactNode, Suspense } from "react";

import { SignedOutPage } from "@/components/common/signed-out";
import { useIdentityQuery } from "@/lib/hooks/use-dashboard-data";
import { AppSidebar } from "./app-sidebar";
import { SiteHeader } from "./site-header";

/**
 * The shell owns exactly one decision: whether there is a page at all.
 *
 * Identity is checked here and nowhere else. If Access says 401 or 403, every
 * panel below would fail in the same way for the same reason, so the whole
 * frame is replaced by one honest message rather than a grid of panels each
 * blaming its own endpoint.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { state } = useIdentityQuery();

  if (state.kind === "error") return <SignedOutPage error={state.error} />;

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <SiteHeader />
        {/*
          `useSearchParams` (the `?run=` selection) opts a subtree out of
          prerendering, and more than one component reads it. One boundary here
          covers every route rather than scattering them at each consumer. The
          fallback is nothing on purpose: the frame is the useful part of a
          first paint, and every panel below fetches after mount anyway.
        */}
        <Suspense fallback={null}>{children}</Suspense>
      </SidebarInset>
    </SidebarProvider>
  );
}
