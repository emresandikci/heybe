# Phase 8 benchmark: Heybe vs PocketBase 0.41.1

Same method, machine, data and scenarios as phase 6 and 7 (`phase-6.md`, `phase-7.md`); the scenarios were not changed. Phase 8 added the CLI help, `serve` domain arguments, `heybe import` and the binary build; none of them runs on the request path. The benchmark runs the TypeScript sources with Bun, not the compiled binary. Nothing was tuned and nothing was rerun.

## Setup

- Heybe commit measured: ed59690
- Bun 1.4.4, PocketBase 0.41.1, autocannon 9, 100 connections, 10 s after a 3 s warm-up
- Command: `caffeinate -i pnpm bench`
- Every run has zero non-2xx responses and zero errors.
- Load: `uptime` right before the run showed load averages 46.14, 31.41 and 17.65 (1, 5 and 15 minutes), so another process was loading the machine heavily when round 1 started. Round 1 is visibly affected (view one: 3545 rps for Heybe against 11378 in phase 7; PB's own list sorted fell to 36 rps). Load was back to 4.42 after the run. Round 2 is the cleaner one. Both rounds are kept as measured.

## Results

| scenario                 | round | target     | rps   | p50 (ms) | p99 (ms) | non-2xx | errors |
| ------------------------ | ----- | ---------- | ----- | -------- | -------- | ------- | ------ |
| view one                 | 1     | pocketbase | 24130 | 0        | 43       | 0       | 0      |
| view one                 | 1     | heybe      | 3545  | 17       | 226      | 0       | 0      |
| list sorted              | 1     | pocketbase | 36    | 2646     | 4647     | 0       | 0      |
| list sorted              | 1     | heybe      | 83    | 975      | 2671     | 0       | 0      |
| list filter status+views | 1     | pocketbase | 796   | 105      | 407      | 0       | 0      |
| list filter status+views | 1     | heybe      | 970   | 85       | 319      | 0       | 0      |
| list filter author.email | 1     | pocketbase | 512   | 175      | 493      | 0       | 0      |
| list filter author.email | 1     | heybe      | 532   | 186      | 306      | 0       | 0      |
| list expand author       | 1     | pocketbase | 62    | 1514     | 1982     | 0       | 0      |
| list expand author       | 1     | heybe      | 61    | 1592     | 2792     | 0       | 0      |
| download 50 KB file      | 1     | pocketbase | 8160  | 10       | 51       | 0       | 0      |
| download 50 KB file      | 1     | heybe      | 2667  | 32       | 118      | 0       | 0      |
| create                   | 1     | pocketbase | 8194  | 7        | 60       | 0       | 0      |
| create                   | 1     | heybe      | 2399  | 37       | 112      | 0       | 0      |
| view one + rate limit    | 1     | pocketbase | 20286 | 1        | 57       | 0       | 0      |
| view one + rate limit    | 1     | heybe      | 4651  | 16       | 74       | 0       | 0      |
| create + rate limit      | 1     | pocketbase | 7192  | 8        | 70       | 0       | 0      |
| create + rate limit      | 1     | heybe      | 3669  | 23       | 73       | 0       | 0      |
| view one                 | 2     | pocketbase | 23230 | 1        | 43       | 0       | 0      |
| view one                 | 2     | heybe      | 11452 | 7        | 23       | 0       | 0      |
| list sorted              | 2     | pocketbase | 93    | 971      | 1397     | 0       | 0      |
| list sorted              | 2     | heybe      | 106   | 884      | 1484     | 0       | 0      |
| list filter status+views | 2     | pocketbase | 951   | 98       | 215      | 0       | 0      |
| list filter status+views | 2     | heybe      | 1256  | 75       | 124      | 0       | 0      |
| list filter author.email | 2     | pocketbase | 357   | 251      | 596      | 0       | 0      |
| list filter author.email | 2     | heybe      | 473   | 189      | 446      | 0       | 0      |
| list expand author       | 2     | pocketbase | 102   | 887      | 1640     | 0       | 0      |
| list expand author       | 2     | heybe      | 114   | 814      | 1466     | 0       | 0      |
| download 50 KB file      | 2     | pocketbase | 9791  | 8        | 36       | 0       | 0      |
| download 50 KB file      | 2     | heybe      | 5306  | 16       | 54       | 0       | 0      |
| create                   | 2     | pocketbase | 10227 | 6        | 45       | 0       | 0      |
| create                   | 2     | heybe      | 3470  | 22       | 108      | 0       | 0      |
| view one + rate limit    | 2     | pocketbase | 24274 | 1        | 40       | 0       | 0      |
| view one + rate limit    | 2     | heybe      | 9926  | 7        | 34       | 0       | 0      |
| create + rate limit      | 2     | pocketbase | 7408  | 6        | 70       | 0       | 0      |
| create + rate limit      | 2     | heybe      | 3360  | 20       | 140      | 0       | 0      |

## Where Heybe is worse than PocketBase

- view one: p50 and p99 worse in round 1 (17 vs 0 ms, 226 vs 43 ms), p50 worse in round 2 (7 vs 1 ms); rps is 15 and 49 percent of PB's.
- list sorted: p99 worse in round 2 (1484 vs 1397 ms); p50 and rps are better in both rounds.
- list filter author.email: p50 worse in round 1 (186 vs 175 ms); rps is 104 and 132 percent of PB's.
- list expand author: p50 and p99 worse in round 1 (1592 vs 1514 ms, 2792 vs 1982 ms); rps is 98 percent of PB's in round 1 and better in round 2.
- download 50 KB file: p50 and p99 worse in both rounds (32 vs 10, 16 vs 8 ms; 118 vs 51, 54 vs 36 ms); rps is 33 and 54 percent of PB's.
- create: p50 and p99 worse in both rounds (37 vs 7, 22 vs 6 ms; 112 vs 60, 108 vs 45 ms); rps is 29 and 34 percent of PB's.
- view one + rate limit: p50 worse in both rounds (16 vs 1, 7 vs 1 ms), p99 worse in round 1 (74 vs 57 ms); rps is 23 and 41 percent of PB's.
- create + rate limit: p50 and p99 worse in both rounds (23 vs 8, 20 vs 6 ms; 73 vs 70, 140 vs 70 ms); rps is 51 and 45 percent of PB's.

Heybe is not worse in list filter status+views in either round.

## Comparison with phase 7

Ratio Heybe/PB (rps, rounds 1 and 2):

| scenario                 | phase 7    | phase 8    |
| ------------------------ | ---------- | ---------- |
| view one                 | 0.44, 0.42 | 0.15, 0.49 |
| list sorted              | 1.24, 1.18 | 2.31, 1.14 |
| list filter status+views | 1.07, 1.31 | 1.22, 1.32 |
| list filter author.email | 1.00, 1.08 | 1.04, 1.32 |
| list expand author       | 1.15, 1.43 | 0.98, 1.12 |
| download 50 KB file      | 0.51, 0.54 | 0.33, 0.54 |
| create                   | 0.42, 0.57 | 0.29, 0.34 |
| view one + rate limit    | 0.38, 0.47 | 0.23, 0.41 |
| create + rate limit      | 0.44, 0.51 | 0.51, 0.45 |

Round 1 ratios on the single-record and write scenarios are far below phase 7 because the machine was under external load when it started; Heybe took the hit harder than PB on those. The round 2 ratios are within the spread seen between phases 4 and 7 except create (0.34, against 0.42 to 0.57 before), which this run does not explain. Phase 8 adds one middleware to every request (the `www.` redirect, which PB also binds); after the final review it only reads the Host header. A second full run on e8e5957 (load 2 at start, 22 by the end) was noisy too (create 0.16 and 0.25, view one 0.22 and 0.40), so the request path was checked with a direct A/B instead. The gaps listed in phase 6 carry over to phase 9.

## Request path A/B

Phase 7 end (813da18) and phase 8 (e8e5957) served side by side, `GET /api/health` (the whole middleware chain), autocannon 100 connections, 3 s warm-up then 8 s, alternating, 3 rounds, load 6 to 9:

| round | phase 7 rps | phase 8 rps |
| ----- | ----------- | ----------- |
| 1     | 22432       | 21414       |
| 2     | 18011       | 16062       |
| 3     | 9313        | 12789       |

The differences go both ways and follow the machine load, so phase 8 adds no measurable cost per request. A quiet full re-measure stays in phase 9.

## Binary

Built and smoke-tested on this machine (`bun scripts/smoke-binary.ts`, host target `bun-darwin-arm64`):

- Size: 106.6 MB
- Cold start (process start to a served request): about 107 ms
- Build plus smoke test: about 9 s

## Dashboard bundle size

The dashboard main chunk grew from 152 kB to about 166 kB gzip after the TanStack Form migration (commit b542747). Phase 8 did not change the dashboard.

## Changed files

- `docs/benchmarks/phase-8.md`
