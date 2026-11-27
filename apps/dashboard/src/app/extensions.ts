import type { HeybeClient } from "@heybejs/client";

export interface ExtensionPage {
  path: string;
  title: string;
  mount(el: HTMLElement, ctx: { client: HeybeClient }): void | (() => void);
}

export interface ExtensionLink {
  label: string;
  href: string;
}

export interface DashboardApi {
  client: HeybeClient;
  addPage(page: ExtensionPage): void;
  addLink(link: ExtensionLink): void;
}

export interface ExtensionRegistry {
  readonly pages: ExtensionPage[];
  readonly links: ExtensionLink[];
  api(client: HeybeClient): DashboardApi;
  freeze(): void;
}

declare global {
  interface Window {
    heybe?: { dashboard: DashboardApi };
  }
}

const PATH = /^[a-z0-9-]+(\/[a-z0-9-]+)*$/;

export function createExtensionRegistry(): ExtensionRegistry {
  const pages: ExtensionPage[] = [];
  const links: ExtensionLink[] = [];
  let frozen = false;
  const assertOpen = () => {
    if (frozen)
      throw new Error(
        "Dashboard extensions must be registered while extensions.js loads.",
      );
  };
  return {
    pages,
    links,
    api: (client) => ({
      client,
      addPage(page) {
        assertOpen();
        if (!PATH.test(page.path))
          throw new Error(`Invalid extension page path "${page.path}".`);
        if (pages.some((p) => p.path === page.path))
          throw new Error(
            `Extension page "${page.path}" is already registered.`,
          );
        pages.push(page);
      },
      addLink(link) {
        assertOpen();
        links.push(link);
      },
    }),
    freeze() {
      frozen = true;
    },
  };
}

export function emptyExtensionRegistry(): ExtensionRegistry {
  const registry = createExtensionRegistry();
  registry.freeze();
  return registry;
}

export function loadExtensions(
  registry: ExtensionRegistry,
  client: HeybeClient,
  src?: string,
): Promise<void> {
  window.heybe = { dashboard: registry.api(client) };
  return new Promise<void>((resolve) => {
    const script = document.createElement("script");
    script.type = "module";
    script.src = src ?? client.buildURL("/_/extensions.js");
    script.addEventListener("load", () => resolve());
    script.addEventListener("error", () => {
      console.warn("Failed to load dashboard extensions");
      resolve();
    });
    document.head.append(script);
  }).then(() => registry.freeze());
}
