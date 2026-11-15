// The compiled binary's worker entrypoint: next to the entry in /$bunfs/root, where
// logs/logger.ts resolves "./log-worker.ts" from the bundle's import.meta.url.
import "../logs/log-worker";
