import { createApp } from "./app";

process.exitCode = await createApp().start();
