import { fileURLToPath } from "node:url";
import { createApp } from "@heybejs/core";

const app = createApp();
app.onServe((e) => {
  e.uiExtensions.push({
    name: "demo",
    dir: fileURLToPath(new URL("fixtures/demo-extension", import.meta.url)),
  });
  return e.next();
});
process.exitCode = await app.start();
