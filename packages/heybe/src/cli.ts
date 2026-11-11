#!/usr/bin/env bun
import { createApp } from "./app";

process.exitCode = await createApp().start();
