import * as heybe from "../index";
import { createApp } from "../app";
import {
  DASHBOARD_FILES,
  SHARP_NATIVE_ENTRY,
  SHARP_NATIVE_FILES,
  SHARP_VERSION,
} from "./embedded";
import { sharpNativeLoader } from "./sharp-native";

declare global {
  // called by the build's replacement of sharp's dist/sharp.mjs
  var __heybeSharpNative: () => string;
}

// migrations and hooks on disk import "@heybejs/core" (or the legacy "heybe"), which a compiled binary cannot resolve
Bun.plugin({
  name: "heybe",
  setup(build) {
    for (const name of ["@heybejs/core", "heybe"])
      build.module(name, () => ({ exports: heybe, loader: "object" }));
  },
});

globalThis.__heybeSharpNative = sharpNativeLoader(
  SHARP_NATIVE_FILES,
  SHARP_NATIVE_ENTRY,
  SHARP_VERSION,
);

process.exitCode = await createApp({
  dashboardFiles: DASHBOARD_FILES.size ? DASHBOARD_FILES : undefined,
}).start();
