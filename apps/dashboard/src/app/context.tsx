import type { HeybeClient } from "@heybe/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import { ConfirmProvider } from "../ui/Confirm";
import { ToastProvider } from "../ui/Toasts";

export interface AppContext {
  client: HeybeClient;
  queryClient: QueryClient;
}

const ClientContext = createContext<HeybeClient | null>(null);

export function useClient(): HeybeClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error("ClientContext is missing");
  return client;
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

export function Providers({
  client,
  queryClient,
  children,
}: AppContext & { children: ReactNode }) {
  return (
    <ClientContext.Provider value={client}>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
        </ToastProvider>
      </QueryClientProvider>
    </ClientContext.Provider>
  );
}
