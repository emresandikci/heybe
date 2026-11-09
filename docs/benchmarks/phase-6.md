# Phase 6 benchmark: Heybe vs PocketBase 0.41.1

Same method, machine, data and scenarios as phase 4 (`phase-4.md`). Phase 6 added request logging to a separate `auxiliary.db` and the rate limiter. Both servers log every request (`logs.maxDays` defaults to 5), so the seven phase 4 scenarios now measure logging. Two scenarios were added: "view one + rate limit" and "create + rate limit", run with `rateLimits` enabled on both servers through `PATCH /api/settings` (one `/api/` rule of 1000000000 requests per second, never hit, so every request walks the full rule lookup and limiter). The settings are patched before those two scenarios and restored after. Nothing was tuned and nothing was rerun.

## Setup

- Heybe commit measured: e752b17
- Bun 1.4.4, PocketBase 0.41.1, autocannon 9, 100 connections, 10 s after a 3 s warm-up
- Command: `caffeinate -i pnpm bench`
- Every run has zero non-2xx responses and zero errors.

## Results

| scenario                 | round | target     | rps   | p50 (ms) | p99 (ms) | non-2xx | errors |
| ------------------------ | ----- | ---------- | ----- | -------- | -------- | ------- | ------ |
| view one                 | 1     | pocketbase | 23621 | 1        | 43       | 0       | 0      |
| view one                 | 1     | heybe      | 10051 | 7        | 41       | 0       | 0      |
| list sorted              | 1     | pocketbase | 118   | 816      | 1004     | 0       | 0      |
| list sorted              | 1     | heybe      | 143   | 655      | 1087     | 0       | 0      |
| list filter status+views | 1     | pocketbase | 1271  | 75       | 129      | 0       | 0      |
| list filter status+views | 1     | heybe      | 1338  | 69       | 121      | 0       | 0      |
| list filter author.email | 1     | pocketbase | 577   | 158      | 348      | 0       | 0      |
| list filter author.email | 1     | heybe      | 507   | 185      | 337      | 0       | 0      |
| list expand author       | 1     | pocketbase | 110   | 840      | 1513     | 0       | 0      |
| list expand author       | 1     | heybe      | 132   | 707      | 1169     | 0       | 0      |
| download 50 KB file      | 1     | pocketbase | 10169 | 8        | 36       | 0       | 0      |
| download 50 KB file      | 1     | heybe      | 5302  | 16       | 43       | 0       | 0      |
| create                   | 1     | pocketbase | 9693  | 6        | 49       | 0       | 0      |
| create                   | 1     | heybe      | 4758  | 17       | 53       | 0       | 0      |
| view one + rate limit    | 1     | pocketbase | 25616 | 1        | 38       | 0       | 0      |
| view one + rate limit    | 1     | heybe      | 9267  | 7        | 39       | 0       | 0      |
| create + rate limit      | 1     | pocketbase | 8080  | 5        | 83       | 0       | 0      |
| create + rate limit      | 1     | heybe      | 4264  | 18       | 60       | 0       | 0      |
| view one                 | 2     | heybe      | 11550 | 7        | 26       | 0       | 0      |
| view one                 | 2     | pocketbase | 24968 | 1        | 39       | 0       | 0      |
| list sorted              | 2     | heybe      | 93    | 1049     | 1279     | 0       | 0      |
| list sorted              | 2     | pocketbase | 70    | 1301     | 1966     | 0       | 0      |
| list filter status+views | 2     | heybe      | 809   | 112      | 452      | 0       | 0      |
| list filter status+views | 2     | pocketbase | 807   | 111      | 407      | 0       | 0      |
| list filter author.email | 2     | heybe      | 445   | 211      | 414      | 0       | 0      |
| list filter author.email | 2     | pocketbase | 505   | 183      | 392      | 0       | 0      |
| list expand author       | 2     | heybe      | 126   | 734      | 1393     | 0       | 0      |
| list expand author       | 2     | pocketbase | 90    | 1017     | 1527     | 0       | 0      |
| download 50 KB file      | 2     | heybe      | 4249  | 19       | 67       | 0       | 0      |
| download 50 KB file      | 2     | pocketbase | 9105  | 9        | 44       | 0       | 0      |
| create                   | 2     | heybe      | 4754  | 17       | 45       | 0       | 0      |
| create                   | 2     | pocketbase | 9072  | 6        | 60       | 0       | 0      |
| view one + rate limit    | 2     | heybe      | 8602  | 8        | 44       | 0       | 0      |
| view one + rate limit    | 2     | pocketbase | 23480 | 1        | 42       | 0       | 0      |
| create + rate limit      | 2     | heybe      | 3770  | 19       | 70       | 0       | 0      |
| create + rate limit      | 2     | pocketbase | 8702  | 6        | 65       | 0       | 0      |

## Where Heybe is worse than PocketBase

- view one: p50 worse in both rounds (7 vs 1 ms in both); rps is 43 and 46 percent of PB's. p99 is better.
- list sorted: p99 worse in round 1 (1087 vs 1004 ms); p50 and rps are better in both rounds.
- list filter status+views: round 2 p50 112 vs 111 ms and p99 452 vs 407 ms are worse; rps is equal (809 vs 807).
- list filter author.email: p50 worse in both rounds (185 vs 158, 211 vs 183 ms); rps is 88 percent of PB's in both. p99 is worse in round 2 (414 vs 392 ms).
- download 50 KB file: p50 and p99 worse in both rounds (16 vs 8, 19 vs 9 ms; 43 vs 36, 67 vs 44 ms); rps is 52 and 47 percent of PB's.
- create: p50 worse in both rounds (17 vs 6 ms in both); rps is 49 and 52 percent of PB's. p99 is worse in round 1 (53 vs 49 ms).
- view one + rate limit: p50 and p99 worse in both rounds (7 vs 1, 8 vs 1 ms; 39 vs 38, 44 vs 42 ms); rps is 36 and 37 percent of PB's.
- create + rate limit: p50 worse in both rounds (18 vs 5, 19 vs 6 ms); rps is 53 and 43 percent of PB's. p99 is worse in round 2 (70 vs 65 ms).

Heybe is not worse in list expand author in either round.

## Comparison with phase 4

Ratio Heybe/PB (rps, rounds 1 and 2):

| scenario                 | phase 4    | phase 6    |
| ------------------------ | ---------- | ---------- |
| view one                 | 0.62, 0.58 | 0.43, 0.46 |
| list sorted              | 1.12, 1.06 | 1.21, 1.33 |
| list filter status+views | 1.16, 1.18 | 1.05, 1.00 |
| list filter author.email | 0.95, 0.94 | 0.88, 0.88 |
| list expand author       | 1.13, 1.12 | 1.20, 1.40 |
| download 50 KB file      | 0.69, 0.69 | 0.52, 0.47 |
| create                   | 0.55, 0.56 | 0.49, 0.52 |
| view one + rate limit    |            | 0.36, 0.37 |
| create + rate limit      |            | 0.53, 0.43 |

Logging: the ratios of the cheap scenarios fell (view one 0.62 and 0.58 to 0.43 and 0.46, download 0.69 and 0.69 to 0.52 and 0.47, create 0.55 and 0.56 to 0.49 and 0.52). Heybe view one went from 17531 and 15965 rps to 10051 and 11550 and create from 6284 and 6299 to 4758 and 4754, while PB itself, which already logged in phase 4, moved from 28240 and 27317 to 23621 and 24968 (view one) and from 11359 and 11313 to 9693 and 9072 (create). The whole machine ran slower in this run (round 2 list rps fell on both servers), so part of the drop is not logging; the list scenarios are dominated by query time and barely moved.

Rate limiter: with it, Heybe view one went from 10051 and 11550 rps to 9267 and 8602 (8 and 26 percent lower) and create from 4758 and 4754 to 4264 and 3770 (10 and 21 percent lower). PB under the same switch moved from 23621 and 24968 to 25616 and 23480 (view one, +8 and -6 percent) and from 9693 and 9072 to 8080 and 8702 (create, -17 and -4 percent), so the run-to-run spread is about as large as the effect; the limiter costs Heybe roughly 10 to 25 percent on the cheap scenarios, and the gaps carry over to phase 9.

## Changed files

- `packages/heybe/bench/run.ts`
- `docs/benchmarks/phase-6.md`
