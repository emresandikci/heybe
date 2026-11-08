# Phase 3 benchmark: Heybe vs PocketBase 0.41.1

Same method, machine, data and scenarios as phase 2 (`phase-2.md`). Phase 3 (auth) added no scenarios; this run checks that the auth work did not slow the existing paths. Nothing was tuned and nothing was rerun.

## Setup

- Heybe commit measured: eb3613d
- Bun 1.4.4, PocketBase 0.41.1, autocannon 9, 100 connections, 10 s after a 3 s warm-up
- Command: `caffeinate -i pnpm bench` (the Mac is kept awake so it cannot sleep mid-run)
- Every run has zero non-2xx responses and zero errors.

## Results

| scenario                 | round | target     | rps   | p50 (ms) | p99 (ms) | non-2xx | errors |
| ------------------------ | ----- | ---------- | ----- | -------- | -------- | ------- | ------ |
| view one                 | 1     | pocketbase | 25886 | 1        | 39       | 0       | 0      |
| view one                 | 1     | heybe      | 17848 | 5        | 12       | 0       | 0      |
| list sorted              | 1     | pocketbase | 120   | 782      | 1029     | 0       | 0      |
| list sorted              | 1     | heybe      | 146   | 647      | 1064     | 0       | 0      |
| list filter status+views | 1     | pocketbase | 1273  | 74       | 133      | 0       | 0      |
| list filter status+views | 1     | heybe      | 1485  | 66       | 86       | 0       | 0      |
| list filter author.email | 1     | pocketbase | 565   | 160      | 413      | 0       | 0      |
| list filter author.email | 1     | heybe      | 563   | 175      | 193      | 0       | 0      |
| list expand author       | 1     | pocketbase | 128   | 757      | 900      | 0       | 0      |
| list expand author       | 1     | heybe      | 126   | 704      | 1134     | 0       | 0      |
| download 50 KB file      | 1     | pocketbase | 10656 | 7        | 34       | 0       | 0      |
| download 50 KB file      | 1     | heybe      | 7867  | 11       | 25       | 0       | 0      |
| create                   | 1     | pocketbase | 10871 | 5        | 42       | 0       | 0      |
| create                   | 1     | heybe      | 6158  | 14       | 28       | 0       | 0      |
| view one                 | 2     | heybe      | 16158 | 6        | 11       | 0       | 0      |
| view one                 | 2     | pocketbase | 20808 | 1        | 49       | 0       | 0      |
| list sorted              | 2     | heybe      | 126   | 719      | 1357     | 0       | 0      |
| list sorted              | 2     | pocketbase | 120   | 775      | 920      | 0       | 0      |
| list filter status+views | 2     | heybe      | 1378  | 70       | 95       | 0       | 0      |
| list filter status+views | 2     | pocketbase | 1105  | 85       | 179      | 0       | 0      |
| list filter author.email | 2     | heybe      | 475   | 193      | 414      | 0       | 0      |
| list filter author.email | 2     | pocketbase | 500   | 184      | 403      | 0       | 0      |
| list expand author       | 2     | heybe      | 132   | 711      | 1189     | 0       | 0      |
| list expand author       | 2     | pocketbase | 110   | 861      | 1106     | 0       | 0      |
| download 50 KB file      | 2     | heybe      | 6702  | 13       | 32       | 0       | 0      |
| download 50 KB file      | 2     | pocketbase | 9447  | 9        | 38       | 0       | 0      |
| create                   | 2     | heybe      | 5302  | 17       | 34       | 0       | 0      |
| create                   | 2     | pocketbase | 9596  | 5        | 47       | 0       | 0      |

## Where Heybe is worse than PocketBase

- view one: p50 worse in both rounds (5 vs 1, 6 vs 1 ms); rps is 69 and 78 percent of PB's. p99 is better.
- list sorted: p99 worse in both rounds (1064 vs 1029, 1357 vs 920 ms); p50 and rps are better.
- list filter author.email: p50 worse in both rounds (175 vs 160, 193 vs 184 ms); rps about equal in round 1, 95 percent of PB's in round 2.
- list expand author: p99 worse in both rounds (1134 vs 900, 1189 vs 1106 ms); rps about equal in round 1, better in round 2.
- download 50 KB file: p50 worse in both rounds (11 vs 7, 13 vs 9 ms); rps is 74 and 71 percent of PB's. p99 is better.
- create: p50 worse in both rounds (14 vs 5, 17 vs 5 ms); rps is 57 and 55 percent of PB's. p99 is better.

Heybe is not worse in list filter status+views in either round.

## Comparison with phase 2

Ratio Heybe/PB (rps, rounds 1 and 2):

| scenario                 | phase 2    | phase 3    |
| ------------------------ | ---------- | ---------- |
| view one                 | 0.68, 0.61 | 0.69, 0.78 |
| list sorted              | 1.20, 1.12 | 1.22, 1.05 |
| list filter status+views | 1.17, 1.16 | 1.17, 1.25 |
| list filter author.email | 0.88, 1.01 | 1.00, 0.95 |
| list expand author       | 1.12, 1.12 | 0.98, 1.20 |
| download 50 KB file      | 0.71, 0.72 | 0.74, 0.71 |
| create                   | 0.58, 0.57 | 0.57, 0.55 |

Round 2 was noisier than round 1 for both servers (PB view one 25886 to 20808 rps, Heybe list sorted 146 to 126 rps), so single-round swings of this size are not meaningful. No phase 3 regression is established: every ratio stays within the phase 2 range or the round-to-round spread. The gaps carry over to phase 9 unchanged.
