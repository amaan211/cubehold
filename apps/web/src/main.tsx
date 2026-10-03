import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { ThemeProvider } from "@/lib/theme";
import { queryClient, TRPCProvider, trpc, trpcClient } from "@/lib/trpc";
import { routeTree } from "./routeTree.gen";
import "./styles.css";

const router = createRouter({
  routeTree,
  context: { queryClient, trpc },
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");

createRoot(rootEl).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
          <RouterProvider router={router} />
          <Toaster richColors position="bottom-right" mobileOffset={{ bottom: "84px" }} />
        </TRPCProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);

// Offline page and cached app files for the installed app. Browsers only allow
// this over HTTPS or on localhost; elsewhere the panel works as a normal page.
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
