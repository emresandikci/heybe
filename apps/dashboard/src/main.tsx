import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createDashboardClient } from "./app/client";
import { Providers, createQueryClient } from "./app/context";
import { createAppRouter } from "./app/router";
import { isSuperuserSession, refreshSession } from "./auth/session";
import { initTheme } from "./app/theme";
import "./styles.css";

initTheme();

const client = createDashboardClient();
if (isSuperuserSession(client)) await refreshSession(client);
const queryClient = createQueryClient();
const router = createAppRouter({ client, queryClient });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Providers client={client} queryClient={queryClient}>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
);
