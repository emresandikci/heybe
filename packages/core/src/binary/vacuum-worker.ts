// The compiled binary's worker entrypoint: next to the entry in /$bunfs/root, where
// backups/create.ts resolves "./vacuum-worker.ts" from the bundle's import.meta.url.
import "../backups/vacuum-worker";
