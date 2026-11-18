import type { App } from "../app";

export function importCollections(
  app: App,
  data: Record<string, unknown>[],
  deleteMissing: boolean,
): Promise<void> {
  return app.collections.import(data, deleteMissing);
}
