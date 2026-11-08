import { type App, type AppOptions, createApp } from "./app";

// Fixtures hash with bcrypt cost 4 (PB's minimum); fields.test.ts covers the default cost.
export function testApp(opts: AppOptions = {}): App {
  const app = createApp({ dir: ":memory:", ...opts });
  const { db } = app;
  db.tx(() => {
    const rows = db.query<{ id: string; data: string }>(
      "SELECT id, data FROM _collections WHERE type = 'auth' OR name = '_otps'",
    );
    for (const { id, data } of rows) {
      const c = JSON.parse(data);
      for (const f of c.fields) if (f.type === "password") f.cost = 4;
      db.run("UPDATE _collections SET data = ? WHERE id = ?", [
        JSON.stringify(c),
        id,
      ]);
    }
  });
  return app;
}

export const cheapPassword = {
  name: "password",
  type: "password",
  min: 8,
  cost: 4,
};
