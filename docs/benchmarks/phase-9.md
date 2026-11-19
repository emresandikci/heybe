# Phase 9 benchmark: Heybe vs PocketBase 0.41.1

Same method, machine and scenarios as phases 6 to 8 (`phase-6.md`, `phase-7.md`, `phase-8.md`). Phase 9 moved request log writes to a worker thread, cached collections behind a `_collections` write version, ran the record view rule and fetch in one query, sniffed downloads once, read settings without cloning in the superuser IP check, and added a `created` index plus a load guard to the benchmark seed (commit a188d4b). The benchmark runs the TypeScript sources with Bun, not the compiled binary. Nothing was tuned for this run and nothing was rerun.

## Setup

- Heybe commit measured: 814c3a7 (package `@heybe/core` 1.1.1)
- Machine: 8-core Apple arm64
- Bun 1.4.4, PocketBase 0.41.1, autocannon 9, 100 connections, 10 s after a 3 s warm-up
- Command: `caffeinate -i pnpm bench`
- Every run has zero non-2xx responses and zero errors.
- Load: `uptime` before the run showed 2.50, 2.41 and 3.26 (1, 5 and 15 minutes). The benchmark's load guard logged 1.92 at the start of round 1 and 5.54 at its end, 1.97 at the start of round 2 and 5.04 at its end; 5.04 after the run. This is the quiet run phase 8 deferred to phase 9.
- `list sorted` and `list expand author` are about 30 times faster than in phase 8 for both targets because of the seed's new `created` index, so compare those two by ratio, not by absolute rps.

## Results

| scenario                 | round | target     | rps   | p50 (ms) | p99 (ms) | non-2xx | errors |
| ------------------------ | ----- | ---------- | ----- | -------- | -------- | ------- | ------ |
| view one                 | 1     | pocketbase | 27534 | 1        | 36       | 0       | 0      |
| view one                 | 1     | heybe      | 25384 | 3        | 8        | 0       | 0      |
| list sorted              | 1     | pocketbase | 3935  | 22       | 68       | 0       | 0      |
| list sorted              | 1     | heybe      | 3632  | 27       | 38       | 0       | 0      |
| list filter status+views | 1     | pocketbase | 1233  | 76       | 199      | 0       | 0      |
| list filter status+views | 1     | heybe      | 1496  | 66       | 70       | 0       | 0      |
| list filter author.email | 1     | pocketbase | 606   | 149      | 314      | 0       | 0      |
| list filter author.email | 1     | heybe      | 610   | 162      | 170      | 0       | 0      |
| list expand author       | 1     | pocketbase | 2896  | 32       | 80       | 0       | 0      |
| list expand author       | 1     | heybe      | 2957  | 33       | 38       | 0       | 0      |
| download 50 KB file      | 1     | pocketbase | 11723 | 7        | 25       | 0       | 0      |
| download 50 KB file      | 1     | heybe      | 8613  | 10       | 21       | 0       | 0      |
| create                   | 1     | pocketbase | 10428 | 6        | 44       | 0       | 0      |
| create                   | 1     | heybe      | 8103  | 10       | 19       | 0       | 0      |
| view one + rate limit    | 1     | pocketbase | 26531 | 1        | 37       | 0       | 0      |
| view one + rate limit    | 1     | heybe      | 24851 | 3        | 8        | 0       | 0      |
| create + rate limit      | 1     | pocketbase | 9148  | 6        | 53       | 0       | 0      |
| create + rate limit      | 1     | heybe      | 6304  | 11       | 32       | 0       | 0      |
| view one                 | 2     | heybe      | 28146 | 3        | 6        | 0       | 0      |
| view one                 | 2     | pocketbase | 26332 | 1        | 38       | 0       | 0      |
| list sorted              | 2     | heybe      | 3507  | 27       | 47       | 0       | 0      |
| list sorted              | 2     | pocketbase | 3820  | 22       | 63       | 0       | 0      |
| list filter status+views | 2     | heybe      | 1473  | 66       | 97       | 0       | 0      |
| list filter status+views | 2     | pocketbase | 1300  | 75       | 112      | 0       | 0      |
| list filter author.email | 2     | heybe      | 592   | 168      | 176      | 0       | 0      |
| list filter author.email | 2     | pocketbase | 670   | 137      | 260      | 0       | 0      |
| list expand author       | 2     | heybe      | 2949  | 33       | 39       | 0       | 0      |
| list expand author       | 2     | pocketbase | 2858  | 33       | 78       | 0       | 0      |
| download 50 KB file      | 2     | heybe      | 8512  | 10       | 22       | 0       | 0      |
| download 50 KB file      | 2     | pocketbase | 11394 | 8        | 26       | 0       | 0      |
| create                   | 2     | heybe      | 8072  | 10       | 19       | 0       | 0      |
| create                   | 2     | pocketbase | 10183 | 5        | 44       | 0       | 0      |
| view one + rate limit    | 2     | heybe      | 28405 | 3        | 6        | 0       | 0      |
| view one + rate limit    | 2     | pocketbase | 25762 | 1        | 37       | 0       | 0      |
| create + rate limit      | 2     | heybe      | 6924  | 11       | 28       | 0       | 0      |
| create + rate limit      | 2     | pocketbase | 8080  | 7        | 60       | 0       | 0      |

## Where Heybe is worse than PocketBase

p99 is better than PocketBase's in every scenario and both rounds. The gaps are p50 and, on writes and downloads, rps:

- view one: p50 worse in both rounds (3 vs 1 ms); rps is 92 and 107 percent of PB's.
- list sorted: p50 worse in both rounds (27 vs 22 ms); rps is 92 percent of PB's in both rounds.
- list filter author.email: p50 worse in both rounds (162 vs 149, 168 vs 137 ms); rps is 101 and 88 percent of PB's.
- list expand author: p50 worse in round 1 (33 vs 32 ms); rps is 102 and 103 percent of PB's.
- download 50 KB file: p50 worse in both rounds (10 vs 7, 10 vs 8 ms); rps is 73 and 75 percent of PB's.
- create: p50 worse in both rounds (10 vs 6, 10 vs 5 ms); rps is 78 and 79 percent of PB's.
- view one + rate limit: p50 worse in both rounds (3 vs 1 ms); rps is 94 and 110 percent of PB's.
- create + rate limit: p50 worse in both rounds (11 vs 6, 11 vs 7 ms); rps is 69 and 86 percent of PB's.

Heybe is not worse in list filter status+views in either round.

The spec target "p50 and p99 not worse than PocketBase" is met for p99 and not yet for p50. The p50 gap is 1 to 5 ms on single-record reads, writes and downloads, and up to 31 ms on the relation filter.

## Comparison with phase 8

Ratio Heybe/PB (rps, rounds 1 and 2):

| scenario                 | phase 8    | phase 9    |
| ------------------------ | ---------- | ---------- |
| view one                 | 0.15, 0.49 | 0.92, 1.07 |
| list sorted              | 2.31, 1.14 | 0.92, 0.92 |
| list filter status+views | 1.22, 1.32 | 1.21, 1.13 |
| list filter author.email | 1.04, 1.32 | 1.01, 0.88 |
| list expand author       | 0.98, 1.12 | 1.02, 1.03 |
| download 50 KB file      | 0.33, 0.54 | 0.73, 0.75 |
| create                   | 0.29, 0.34 | 0.78, 0.79 |
| view one + rate limit    | 0.23, 0.41 | 0.94, 1.10 |
| create + rate limit      | 0.51, 0.45 | 0.69, 0.86 |

View one, download and create moved from 15 to 54 percent of PocketBase's throughput to 73 to 110 percent, which matches the phase 9 work on the request log writes, the view query and the download path. Phase 8's round 1 ran under heavy external load, so its round 2 is the fairer baseline (view one 0.49 to about 1.0, create 0.34 to 0.79, download 0.54 to 0.74). List sorted dropped from 1.14 to 0.92 because the new `created` index made the query cheap for both servers and fixed request overhead now weighs more. The relation filter (author.email) is the one list scenario where PocketBase leads in round 2.

## Changed files

- `docs/benchmarks/phase-9.md`
