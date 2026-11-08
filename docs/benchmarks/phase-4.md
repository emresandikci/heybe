# Phase 4 benchmark: Heybe vs PocketBase 0.41.1

Same method, machine, data and scenarios as phase 2 (`phase-2.md`). Phase 4 moved every write to async transactions behind a writer mutex and put a hook chain around every read and write, so this run checks what that cost. Nothing was tuned and nothing was rerun.

## Setup

- Heybe commit measured: 1a69a27
- Bun 1.4.4, PocketBase 0.41.1, autocannon 9, 100 connections, 10 s after a 3 s warm-up
- Command: `caffeinate -i pnpm bench`
- Every run has zero non-2xx responses and zero errors.

## Results

| scenario                 | round | target     | rps   | p50 (ms) | p99 (ms) | non-2xx | errors |
| ------------------------ | ----- | ---------- | ----- | -------- | -------- | ------- | ------ |
| view one                 | 1     | pocketbase | 28240 | 1        | 35       | 0       | 0      |
| view one                 | 1     | heybe      | 17531 | 5        | 12       | 0       | 0      |
| list sorted              | 1     | pocketbase | 129   | 754      | 920      | 0       | 0      |
| list sorted              | 1     | heybe      | 145   | 650      | 1114     | 0       | 0      |
| list filter status+views | 1     | pocketbase | 1296  | 75       | 129      | 0       | 0      |
| list filter status+views | 1     | heybe      | 1504  | 65       | 77       | 0       | 0      |
| list filter author.email | 1     | pocketbase | 621   | 150      | 303      | 0       | 0      |
| list filter author.email | 1     | heybe      | 591   | 168      | 180      | 0       | 0      |
| list expand author       | 1     | pocketbase | 128   | 736      | 1074     | 0       | 0      |
| list expand author       | 1     | heybe      | 145   | 655      | 1039     | 0       | 0      |
| download 50 KB file      | 1     | pocketbase | 11672 | 7        | 24       | 0       | 0      |
| download 50 KB file      | 1     | heybe      | 8070  | 11       | 23       | 0       | 0      |
| create                   | 1     | pocketbase | 11359 | 5        | 39       | 0       | 0      |
| create                   | 1     | heybe      | 6284  | 14       | 28       | 0       | 0      |
| view one                 | 2     | heybe      | 15965 | 6        | 8        | 0       | 0      |
| view one                 | 2     | pocketbase | 27317 | 1        | 35       | 0       | 0      |
| list sorted              | 2     | heybe      | 137   | 690      | 1195     | 0       | 0      |
| list sorted              | 2     | pocketbase | 129   | 744      | 934      | 0       | 0      |
| list filter status+views | 2     | heybe      | 1495  | 65       | 96       | 0       | 0      |
| list filter status+views | 2     | pocketbase | 1268  | 76       | 131      | 0       | 0      |
| list filter author.email | 2     | heybe      | 576   | 172      | 185      | 0       | 0      |
| list filter author.email | 2     | pocketbase | 616   | 151      | 301      | 0       | 0      |
| list expand author       | 2     | heybe      | 144   | 656      | 1053     | 0       | 0      |
| list expand author       | 2     | pocketbase | 129   | 738      | 1002     | 0       | 0      |
| download 50 KB file      | 2     | heybe      | 8051  | 11       | 24       | 0       | 0      |
| download 50 KB file      | 2     | pocketbase | 11593 | 7        | 23       | 0       | 0      |
| create                   | 2     | heybe      | 6299  | 14       | 26       | 0       | 0      |
| create                   | 2     | pocketbase | 11313 | 4        | 38       | 0       | 0      |

## Where Heybe is worse than PocketBase

- view one: p50 worse in both rounds (5 vs 1, 6 vs 1 ms); rps is 62 and 58 percent of PB's. p99 is better.
- list sorted: p99 worse in both rounds (1114 vs 920, 1195 vs 934 ms); p50 and rps are better.
- list filter author.email: p50 worse in both rounds (168 vs 150, 172 vs 151 ms); rps is 95 and 94 percent of PB's. p99 is better.
- list expand author: p99 worse in round 2 (1053 vs 1002 ms); p50 and rps are better in both rounds.
- download 50 KB file: p50 worse in both rounds (11 vs 7 ms); rps is 69 percent of PB's in both. p99 about equal.
- create: p50 worse in both rounds (14 vs 5, 14 vs 4 ms); rps is 55 and 56 percent of PB's. p99 is better.

Heybe is not worse in list filter status+views in either round.

## Comparison with phase 2

Ratio Heybe/PB (rps, rounds 1 and 2):

| scenario                 | phase 2    | phase 4    |
| ------------------------ | ---------- | ---------- |
| view one                 | 0.68, 0.61 | 0.62, 0.58 |
| list sorted              | 1.20, 1.12 | 1.12, 1.06 |
| list filter status+views | 1.17, 1.16 | 1.16, 1.18 |
| list filter author.email | 0.88, 1.01 | 0.95, 0.94 |
| list expand author       | 1.12, 1.12 | 1.13, 1.12 |
| download 50 KB file      | 0.71, 0.72 | 0.69, 0.69 |
| create                   | 0.58, 0.57 | 0.55, 0.56 |

Create went from 6470 and 6434 rps in phase 2 to 6284 and 6299 rps (about 3 percent lower, ratio 0.58 to 0.55), so the async write path and the hook chain cost little next to the existing gap. View one dropped slightly relative to PB (0.68 and 0.61 to 0.62 and 0.58) while PB itself ran faster in this run; the gaps carry over to phase 9.
