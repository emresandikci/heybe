# Phase 7 benchmark: Heybe vs PocketBase 0.41.1

Same method, machine, data and scenarios as phase 6 (`phase-6.md`); the scenarios were not changed. Phase 7 added the dashboard, so the server now registers the `/_/` routes (the dist is built before the run) and the `onServe` handler for UI extensions. The benchmark never requests `/_/`, so the numbers show what the extra routes cost the API. Nothing was tuned and nothing was rerun.

## Setup

- Heybe commit measured: a004afe
- Bun 1.4.4, PocketBase 0.41.1, autocannon 9, 100 connections, 10 s after a 3 s warm-up
- Commands: `pnpm --filter @heybe/dashboard build`, then `caffeinate -i pnpm bench`
- Every run has zero non-2xx responses and zero errors.
- Load: `uptime` before the run showed load averages 2.57, 3.38 and 7.82 (1, 5 and 15 minutes), so the machine may have been under external load earlier. The benchmark itself drives the load to about 7.8.

## Results

| scenario                 | round | target     | rps   | p50 (ms) | p99 (ms) | non-2xx | errors |
| ------------------------ | ----- | ---------- | ----- | -------- | -------- | ------- | ------ |
| view one                 | 1     | pocketbase | 25838 | 1        | 37       | 0       | 0      |
| view one                 | 1     | heybe      | 11378 | 6        | 29       | 0       | 0      |
| list sorted              | 1     | pocketbase | 119   | 820      | 992      | 0       | 0      |
| list sorted              | 1     | heybe      | 147   | 644      | 1053     | 0       | 0      |
| list filter status+views | 1     | pocketbase | 1313  | 73       | 114      | 0       | 0      |
| list filter status+views | 1     | heybe      | 1411  | 68       | 93       | 0       | 0      |
| list filter author.email | 1     | pocketbase | 577   | 155      | 340      | 0       | 0      |
| list filter author.email | 1     | heybe      | 579   | 169      | 197      | 0       | 0      |
| list expand author       | 1     | pocketbase | 126   | 729      | 1337     | 0       | 0      |
| list expand author       | 1     | heybe      | 145   | 661      | 933      | 0       | 0      |
| download 50 KB file      | 1     | pocketbase | 11129 | 8        | 27       | 0       | 0      |
| download 50 KB file      | 1     | heybe      | 5728  | 15       | 40       | 0       | 0      |
| create                   | 1     | pocketbase | 11626 | 5        | 37       | 0       | 0      |
| create                   | 1     | heybe      | 4936  | 17       | 45       | 0       | 0      |
| view one + rate limit    | 1     | pocketbase | 25733 | 1        | 37       | 0       | 0      |
| view one + rate limit    | 1     | heybe      | 9804  | 7        | 36       | 0       | 0      |
| create + rate limit      | 1     | pocketbase | 9895  | 4        | 48       | 0       | 0      |
| create + rate limit      | 1     | heybe      | 4373  | 17       | 62       | 0       | 0      |
| view one                 | 2     | pocketbase | 28002 | 1        | 35       | 0       | 0      |
| view one                 | 2     | heybe      | 11855 | 6        | 25       | 0       | 0      |
| list sorted              | 2     | pocketbase | 116   | 801      | 1290     | 0       | 0      |
| list sorted              | 2     | heybe      | 137   | 689      | 1126     | 0       | 0      |
| list filter status+views | 2     | pocketbase | 1078  | 88       | 143      | 0       | 0      |
| list filter status+views | 2     | heybe      | 1409  | 67       | 96       | 0       | 0      |
| list filter author.email | 2     | pocketbase | 533   | 175      | 350      | 0       | 0      |
| list filter author.email | 2     | heybe      | 574   | 171      | 206      | 0       | 0      |
| list expand author       | 2     | pocketbase | 100   | 964      | 1146     | 0       | 0      |
| list expand author       | 2     | heybe      | 143   | 664      | 1081     | 0       | 0      |
| download 50 KB file      | 2     | pocketbase | 9116  | 10       | 28       | 0       | 0      |
| download 50 KB file      | 2     | heybe      | 4939  | 17       | 51       | 0       | 0      |
| create                   | 2     | pocketbase | 8753  | 7        | 52       | 0       | 0      |
| create                   | 2     | heybe      | 5004  | 16       | 45       | 0       | 0      |
| view one + rate limit    | 2     | pocketbase | 21748 | 1        | 44       | 0       | 0      |
| view one + rate limit    | 2     | heybe      | 10262 | 6        | 32       | 0       | 0      |
| create + rate limit      | 2     | pocketbase | 7940  | 6        | 58       | 0       | 0      |
| create + rate limit      | 2     | heybe      | 4087  | 19       | 59       | 0       | 0      |

## Where Heybe is worse than PocketBase

- view one: p50 worse in both rounds (6 vs 1 ms in both); rps is 44 and 42 percent of PB's. p99 is better.
- list sorted: p99 worse in round 1 (1053 vs 992 ms); p50 and rps are better in both rounds.
- list filter author.email: p50 worse in round 1 (169 vs 155 ms); rps is equal (579 vs 577) and 108 percent of PB's in round 2.
- download 50 KB file: p50 and p99 worse in both rounds (15 vs 8, 17 vs 10 ms; 40 vs 27, 51 vs 28 ms); rps is 51 and 54 percent of PB's.
- create: p50 worse in both rounds (17 vs 5, 16 vs 7 ms); rps is 42 and 57 percent of PB's. p99 is worse in round 1 (45 vs 37 ms).
- view one + rate limit: p50 worse in both rounds (7 vs 1, 6 vs 1 ms); rps is 38 and 47 percent of PB's. p99 is better.
- create + rate limit: p50 and p99 worse in both rounds (17 vs 4, 19 vs 6 ms; 62 vs 48, 59 vs 58 ms); rps is 44 and 51 percent of PB's.

Heybe is not worse in list filter status+views or list expand author in either round.

## Comparison with phase 6

Ratio Heybe/PB (rps, rounds 1 and 2):

| scenario                 | phase 6    | phase 7    |
| ------------------------ | ---------- | ---------- |
| view one                 | 0.43, 0.46 | 0.44, 0.42 |
| list sorted              | 1.21, 1.33 | 1.24, 1.18 |
| list filter status+views | 1.05, 1.00 | 1.07, 1.31 |
| list filter author.email | 0.88, 0.88 | 1.00, 1.08 |
| list expand author       | 1.20, 1.40 | 1.15, 1.43 |
| download 50 KB file      | 0.52, 0.47 | 0.51, 0.54 |
| create                   | 0.49, 0.52 | 0.42, 0.57 |
| view one + rate limit    | 0.36, 0.37 | 0.38, 0.47 |
| create + rate limit      | 0.53, 0.43 | 0.44, 0.51 |

The ratios stay within the run-to-run spread seen between phases 4 and 6 (the machine load differs per run, and PB moves as much as Heybe), so the `/_/` routes and the extension `onServe` handler show no measurable cost on the API scenarios. The gaps listed in phase 6 carry over to phase 9.

## Dashboard bundle size

From the Vite build (`pnpm --filter @heybe/dashboard build`), gzip as reported by Vite:

| file                                  | type | raw (bytes) | gzip (kB) | loaded                   |
| ------------------------------------- | ---- | ----------- | --------- | ------------------------ |
| `assets/index-B8Od3h_B.js`            | JS   | 492177      | 151.95    | at start                 |
| `assets/rolldown-runtime-BWaJ3C7D.js` | JS   | 911         | 0.51      | at start                 |
| `assets/lib-C_lvLDN7.js`              | JS   | 1353356     | 431.83    | on demand (mjml-browser) |
| `assets/index-CIxxWBo4.css`           | CSS  | 16941       | 4.32      | at start                 |

The first load is 493088 bytes of JS (about 152.5 kB gzip) and 16941 bytes of CSS (4.32 kB gzip). The `lib` chunk holds `mjml-browser` and is fetched only when the email template editor compiles MJML. Vite warns that it is above 500 kB.

## Changed files

- `docs/benchmarks/phase-7.md`
