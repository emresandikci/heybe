// The compiled binary's worker entrypoint: next to the entry in /$bunfs/root, where
// db.ts resolves "./checkpoint-worker.ts" from the bundle's import.meta.url.
import "../checkpoint-worker";
