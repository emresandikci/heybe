# Phase 1 benchmark: Heybe vs PocketBase 0.41.1

Same machine, same data, both servers running at the same time (one idle while the other is measured). Results feed phase 9 (performance); they do not block phase 1.

## Setup

- Machine: Apple M2, 8 cores, 16 GB RAM, macOS (Darwin 24.6.0, arm64)
- Heybe commit measured: 825d4e5, with uncommitted Task 14 files
- Bun 1.4.4 (runs Heybe), Node 24.16.0 (runs autocannon), PocketBase 0.41.1
- Command: `pnpm bench` (from the repo root; runs `bun bench/run.ts` in `packages/core`)
- Load: autocannon 9, 100 connections, 10 s measured after a 3 s warm-up, 4 workers, client in a separate Node process that shares the 8 cores with both servers (so absolute numbers are lower and noisier than a dedicated client machine would give)
- Data: public `posts` collection (`title`, `body`, `views`, `status`, `author` relation to `users`, `created`), 10,000 records seeded over HTTP, 10 users (`a@x.com` is one of them). Fresh servers and fresh data for each round.
- `users` list/view rules were set to `""` so the guest relation filter can match (PB checks the relation collection's rules).
- Scenarios run as guest, except create (superuser). Rounds alternate target order (round 1: PB first, round 2: Heybe first).
- Every run has zero non-2xx responses and zero errors; each filter scenario was checked to match records before measuring.

## Results

| scenario                 | round | target     | rps   | p50 (ms) | p99 (ms) | non-2xx | errors |
| ------------------------ | ----- | ---------- | ----- | -------- | -------- | ------- | ------ |
| view one                 | 1     | pocketbase | 16698 | 1        | 69       | 0       | 0      |
| view one                 | 1     | heybe      | 4829  | 15       | 106      | 0       | 0      |
| list sorted              | 1     | pocketbase | 16    | 4750     | 7160     | 0       | 0      |
| list sorted              | 1     | heybe      | 54    | 1696     | 2889     | 0       | 0      |
| list filter status+views | 1     | pocketbase | 523   | 153      | 618      | 0       | 0      |
| list filter status+views | 1     | heybe      | 559   | 138      | 757      | 0       | 0      |
| list filter author.email | 1     | pocketbase | 244   | 357      | 959      | 0       | 0      |
| list filter author.email | 1     | heybe      | 261   | 333      | 695      | 0       | 0      |
| create                   | 1     | pocketbase | 5726  | 11       | 99       | 0       | 0      |
| create                   | 1     | heybe      | 3613  | 22       | 93       | 0       | 0      |
| view one                 | 2     | heybe      | 11660 | 6        | 35       | 0       | 0      |
| view one                 | 2     | pocketbase | 17055 | 1        | 58       | 0       | 0      |
| list sorted              | 2     | heybe      | 96    | 970      | 1362     | 0       | 0      |
| list sorted              | 2     | pocketbase | 64    | 1306     | 2673     | 0       | 0      |
| list filter status+views | 2     | heybe      | 908   | 99       | 331      | 0       | 0      |
| list filter status+views | 2     | pocketbase | 736   | 127      | 283      | 0       | 0      |
| list filter author.email | 2     | heybe      | 425   | 232      | 300      | 0       | 0      |
| list filter author.email | 2     | pocketbase | 345   | 261      | 670      | 0       | 0      |
| create                   | 2     | heybe      | 4233  | 19       | 111      | 0       | 0      |
| create                   | 2     | pocketbase | 6869  | 9        | 68       | 0       | 0      |

## Where Heybe is worse than PocketBase

- view one: p50 worse in both rounds (15 vs 1 ms, 6 vs 1 ms); p99 worse in round 1 only (106 vs 69 ms). rps is 30 to 70 percent of PB's.
- list filter status+views: p99 worse in both rounds (757 vs 618 ms, 331 vs 283 ms); p50 and rps are better.
- create: p50 worse in both rounds (22 vs 11 ms, 19 vs 9 ms); p99 worse in round 2 only (111 vs 68 ms). rps is 63 to 62 percent of PB's.

Heybe is not worse in list sorted and list filter author.email in either round.

## Noise

The two rounds differ a lot for the same target, so treat the numbers as indicative, not exact:

- list sorted: PB went from 16 to 64 rps and Heybe from 54 to 96 rps between rounds. Heybe is ahead in both rounds, but the absolute values are unreliable. See the next section for why this scenario is slow.
- view one (Heybe): 4829 rps in round 1, 11660 rps in round 2.
- p99 values swing by 2x between rounds in several scenarios (for example author.email on PB: 959 vs 670 ms).

## Why list sorted is slow

Checked directly against SQLite on seeded `data.db` files (same 10,000 posts, Heybe and PB), using the query Heybe runs for `perPage=30&sort=-created`:

- `EXPLAIN QUERY PLAN` on both databases: `SCAN posts` plus `USE TEMP B-TREE FOR ORDER BY`. `created` has no index, so every request reads all 10,000 rows (including `body`) and sorts them before taking 30. PB's data.db has the same plan.
- Single query, sqlite3 CLI: sorted list about 17 ms on Heybe's db and 9 ms on PB's db. The filter list scenarios take about 1 ms (no ORDER BY, so LIMIT 30 stops the scan early), and the `COUNT(DISTINCT _rowid_)` queries take under 1 ms. So the count is not the cause; the sort is.
- With `CREATE INDEX ON posts(created)` on a copy of Heybe's db the plan becomes `SCAN posts USING INDEX` and the query drops to under 1 ms.

Cause: confirmed, full scan plus sort on an unindexed `created`. It affects PB equally, so it is a property of this scenario and schema, not a Heybe-only defect. Not confirmed: why both servers reach only 16 to 96 rps while a single sort takes 9 to 17 ms (CPU contention with the shared load client and concurrent sorts is the likely reason). The scenario was not changed.

Results were not rerun or tuned. Round 1 ran PB first, round 2 ran Heybe first, so a warm-up or thermal effect tied to run order is possible. Phase 9 should repeat these with more rounds before acting on small differences.

## Phase 9 items

- Sorted list: scans and sorts all rows for `ORDER BY created`. Consider an index on the autodate `created` field (or a documented recommendation to index sort fields), and re-measure against PB, which has the same plan.
- Re-run with more than two rounds and, if possible, with the load client off the servers' machine.
- view one and create: Heybe's p50 is above PB's in every round; profile the request path (routing, auth, serialization, write transaction).
- list filter status+views: Heybe's p99 is above PB's in both rounds.
