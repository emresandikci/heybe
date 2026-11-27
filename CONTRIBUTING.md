# Contributing

Requirements: Node.js 24 and pnpm 10 for the tooling, Bun 1.4 for the runtime.

```bash
pnpm install
```

Checks:

```bash
pnpm typecheck
pnpm test             # unit tests of every package
pnpm test:contract    # HTTP API contract tests of @heybe/core
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org). Direct `git commit` is blocked, use:

```bash
pnpm commit
```

Each package is versioned and released on its own with semantic-release when changes land on `main`.

## Dashboard

The dashboard lives in `apps/dashboard` (React, Vite) and talks to the server only through `@heybe/client`. Build it before serving:

```bash
pnpm --filter @heybe/dashboard build
```

The build writes `packages/core/ui/dist`. Without it the server does not register `/_/`. For development run `heybe serve` on 8090 and `pnpm --filter @heybe/dashboard dev`.

Tests:

```bash
pnpm --filter @heybe/dashboard test
pnpm --filter @heybe/dashboard exec playwright install chromium   # once
pnpm test:e2e
```

## Single binary

Build one executable that embeds the dashboard and the sharp native files (needs Bun 1.4 and a prior `pnpm install`):

```bash
cd packages/core
bun scripts/build-binary.ts          # writes dist/heybe for this machine
bun scripts/smoke-binary.ts --binary dist/heybe
./dist/heybe serve
```

`--target bun-linux-x64` (or `bun-linux-arm64`, `bun-darwin-arm64`) builds for another platform; build on a matching machine so sharp's native package fits. The thumbnail libraries are extracted to the temp directory on first use.
