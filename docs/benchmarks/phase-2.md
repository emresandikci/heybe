# Phase 2 benchmark: Heybe vs PocketBase 0.41.1

Same method as phase 1 (`phase-1.md`): same machine, same data, both servers running at the same time (one idle while the other is measured). Results feed phase 9 (performance). Nothing was tuned and nothing was rerun.

## Setup

- Machine: Apple M2, 8 cores, 16 GB RAM, macOS (Darwin 24.6.0, arm64)
- Heybe commit measured: e4439d2, with uncommitted Task 10 files (`packages/core/bench/run.ts`)
- Bun 1.4.4 (runs Heybe), Node 24.16.0 (runs autocannon), PocketBase 0.41.1
- Command: `pnpm bench` (from the repo root; runs `bun bench/run.ts` in `packages/core`)
- Load: autocannon 9, 100 connections, 10 s measured after a 3 s warm-up, 4 workers, client in a separate Node process that shares the 8 cores with both servers
- Data: same as phase 1 (public `posts` with `author` relation to 10 `users`, 10,000 records, fresh servers and data per round), plus a public `attachments` collection with one record holding a 50 KB file (the same 51200 bytes uploaded to both servers).
- Scenarios run as guest, except create (superuser). Rounds alternate target order (round 1: PB first, round 2: Heybe first).
- New scenarios: `list expand author` (`perPage=30&sort=-created&expand=author`, same query as `list sorted` plus expand) and `download 50 KB file` (`/api/files/attachments/<id>/<filename>`). The five phase 1 scenarios are unchanged.
- Every run has zero non-2xx responses and zero errors. Before measuring, the expand scenario was checked to return 30 items with `expand.author.email` on every item, and the download was checked to return 200 with exactly 51200 bytes, on both servers.

## Results

| scenario                 | round | target     | rps   | p50 (ms) | p99 (ms) | non-2xx | errors |
| ------------------------ | ----- | ---------- | ----- | -------- | -------- | ------- | ------ |
| view one                 | 1     | pocketbase | 27214 | 1        | 36       | 0       | 0      |
| view one                 | 1     | heybe      | 18410 | 5        | 12       | 0       | 0      |
| list sorted              | 1     | pocketbase | 121   | 771      | 952      | 0       | 0      |
| list sorted              | 1     | heybe      | 145   | 641      | 1238     | 0       | 0      |
| list filter status+views | 1     | pocketbase | 1288  | 74       | 123      | 0       | 0      |
| list filter status+views | 1     | heybe      | 1513  | 65       | 80       | 0       | 0      |
| list filter author.email | 1     | pocketbase | 646   | 145      | 290      | 0       | 0      |
| list filter author.email | 1     | heybe      | 568   | 173      | 187      | 0       | 0      |
| list expand author       | 1     | pocketbase | 129   | 744      | 916      | 0       | 0      |
| list expand author       | 1     | heybe      | 145   | 653      | 1082     | 0       | 0      |
| download 50 KB file      | 1     | pocketbase | 11544 | 7        | 23       | 0       | 0      |
| download 50 KB file      | 1     | heybe      | 8203  | 11       | 23       | 0       | 0      |
| create                   | 1     | pocketbase | 11229 | 4        | 39       | 0       | 0      |
| create                   | 1     | heybe      | 6470  | 14       | 26       | 0       | 0      |
| view one                 | 2     | heybe      | 16511 | 5        | 11       | 0       | 0      |
| view one                 | 2     | pocketbase | 27019 | 1        | 36       | 0       | 0      |
| list sorted              | 2     | heybe      | 137   | 686      | 1142     | 0       | 0      |
| list sorted              | 2     | pocketbase | 122   | 754      | 1131     | 0       | 0      |
| list filter status+views | 2     | heybe      | 1511  | 65       | 73       | 0       | 0      |
| list filter status+views | 2     | pocketbase | 1300  | 73       | 118      | 0       | 0      |
| list filter author.email | 2     | heybe      | 596   | 165      | 191      | 0       | 0      |
| list filter author.email | 2     | pocketbase | 590   | 157      | 336      | 0       | 0      |
| list expand author       | 2     | heybe      | 145   | 650      | 1097     | 0       | 0      |
| list expand author       | 2     | pocketbase | 130   | 727      | 886      | 0       | 0      |
| download 50 KB file      | 2     | heybe      | 8148  | 11       | 24       | 0       | 0      |
| download 50 KB file      | 2     | pocketbase | 11330 | 7        | 24       | 0       | 0      |
| create                   | 2     | heybe      | 6434  | 14       | 27       | 0       | 0      |
| create                   | 2     | pocketbase | 11242 | 4        | 39       | 0       | 0      |

## Where Heybe is worse than PocketBase

- view one: p50 worse in both rounds (5 vs 1 ms); rps is 68 and 61 percent of PB's. p99 is better (12 vs 36, 11 vs 36 ms).
- list sorted: p99 worse in both rounds (1238 vs 952 ms, 1142 vs 1131 ms; the round 2 gap is within noise); p50 and rps are better.
- list filter author.email: p50 worse in both rounds (173 vs 145 ms, 165 vs 157 ms); rps worse in round 1 (568 vs 646) and about equal in round 2 (596 vs 590). p99 is better.
- list expand author: p99 worse in both rounds (1082 vs 916 ms, 1097 vs 886 ms); p50 and rps are better (about 145 vs 130 rps).
- download 50 KB file: p50 worse in both rounds (11 vs 7 ms); rps is 71 and 72 percent of PB's. p99 is equal (23 vs 23, 24 vs 24 ms).
- create: p50 worse in both rounds (14 vs 4 ms); rps is 58 and 57 percent of PB's. p99 is better (26 vs 39, 27 vs 39 ms).

Heybe is not worse in list filter status+views in either round.

## Noise

The two rounds agree closely for every scenario and target (rps within about 10 percent, except view one on Heybe: 18410 vs 16511). The huge round-to-round swings seen in phase 1 did not appear. Differences of a few percent (for example list sorted p99 in round 2, or author.email rps in round 2) are not meaningful. Only two rounds were run, so this is still indicative.

`list sorted` and `list expand author` both scan and sort all 10,000 rows (`created` has no index, see phase 1), so their numbers are dominated by that sort on both servers. Expand adds almost nothing on top of the sorted list on either server (145 vs 145 rps on Heybe, 129 to 130 vs 121 to 122 rps on PB).

## Comparison with phase 1 (shared scenarios)

Absolute numbers are not comparable across the two runs: this run was much faster and quieter for both servers (PB view one went from about 16.7k to 27k rps, PB list sorted from 16 and 64 rps to 121 and 122 rps). The ratio Heybe/PB (rps, rounds 1 and 2) is the fairer comparison:

| scenario                 | phase 1    | phase 2    |
| ------------------------ | ---------- | ---------- |
| view one                 | 0.29, 0.68 | 0.68, 0.61 |
| list sorted              | 3.4, 1.5   | 1.20, 1.12 |
| list filter status+views | 1.07, 1.23 | 1.17, 1.16 |
| list filter author.email | 1.07, 1.23 | 0.88, 1.01 |
| create                   | 0.63, 0.62 | 0.58, 0.57 |

In absolute terms Heybe did not get slower in any shared scenario (view one 4829 and 11660 to 18410 and 16511 rps; create 3613 and 4233 to 6470 and 6434 rps), but PB improved too, so that says more about the machine state than about the code. Relative to PB, list filter author.email dropped slightly (round 1 now behind PB) and create dropped slightly (0.63 to 0.58). Both are small and phase 1 itself swung by more than this between rounds, so no phase 2 regression is established. Phase 1's list sorted ratio was inflated by PB's extremely low phase 1 numbers.

## Phase 9 items

- Re-run with more than two rounds, ideally with the load client off the servers' machine, before acting on small differences.
- create and view one: Heybe's p50 is above PB's in every round (14 vs 4 ms and 5 vs 1 ms); profile the request path.
- Download: p50 11 vs 7 ms and 71 percent of PB's rps; check how the file response is streamed and whether the record lookup per request can be avoided.
- list sorted and list expand author: indexing `created` (or recommending an index on sort fields) would remove the full scan and sort on both servers; the scenarios were left unchanged here.
- Heybe p99 is above PB's on the two sorted-list scenarios.
