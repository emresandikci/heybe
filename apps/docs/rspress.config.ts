import path from "node:path";
import { defineConfig } from "@rspress/core";

export default defineConfig({
  root: "docs",
  base: "/heybe/",
  title: "Heybe",
  description:
    "An open source backend in a single binary, built with TypeScript on Bun.",
  lang: "en",
  icon: "/logo.svg",
  logo: "/logo.svg",
  logoText: "Heybe",
  llms: false,
  globalStyles: path.join(import.meta.dirname, "theme/index.css"),
  themeConfig: {
    llmsUI: false,
    socialLinks: [
      {
        icon: "github",
        mode: "link",
        content: "https://github.com/emresandikci/heybe",
      },
    ],
    sidebar: {
      "/": [
        {
          text: "Guide",
          items: [
            { text: "Introduction", link: "/" },
            { text: "Getting started", link: "/getting-started" },
            { text: "Docker", link: "/docker" },
            { text: "Deploying", link: "/deploying" },
          ],
        },
        {
          text: "Building",
          items: [
            { text: "Collections and rules", link: "/collections-and-rules" },
            { text: "Queries", link: "/queries" },
            { text: "Client", link: "/client" },
            { text: "Realtime", link: "/realtime" },
            { text: "Files", link: "/files" },
          ],
        },
        {
          text: "Extending",
          items: [
            { text: "Hooks and routes", link: "/hooks-and-routes" },
            { text: "Cron and migrations", link: "/cron-and-migrations" },
            { text: "Dashboard extensions", link: "/dashboard-extensions" },
          ],
        },
        {
          text: "More",
          items: [
            {
              text: "Migrating from PocketBase",
              link: "/migrating-from-pocketbase",
            },
          ],
        },
      ],
    },
  },
});
