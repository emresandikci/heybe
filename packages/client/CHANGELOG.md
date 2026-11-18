# [@heybe/client-v1.1.1](https://github.com/emresandikci/heybe/compare/@heybe/client@1.1.0...@heybe/client@1.1.1) (2026-11-18)

# [@heybe/client-v1.1.0](https://github.com/emresandikci/heybe/compare/@heybe/client@1.0.0...@heybe/client@1.1.0) (2026-11-18)


* refactor!: use the hb prefix for heybe's own ids ([63695bc](https://github.com/emresandikci/heybe/commit/63695bc3960a07fa4fb885a2c23dc279fa529121))


### BREAKING CHANGES

* Heybe data created before this change keeps pb ids and
is not migrated. Code that hardcodes pbc_ or _pb_users_auth_ ids must
use the hb ids or collection names.

# @heybe/client-v1.0.0 (2026-11-16)


### Bug Fixes

* **client:** apply phase 5 final review fixes ([a8badc3](https://github.com/emresandikci/heybe/commit/a8badc3f1e7db9a158e8f90f9637d8551be1d923))


### Features

* **client:** accept raw filter and sort strings in list methods ([54861b0](https://github.com/emresandikci/heybe/commit/54861b03123420d621952185cd04633dfb7e7ea2))
* **client:** add auth methods and auto token refresh ([c5406fb](https://github.com/emresandikci/heybe/commit/c5406fb7e09b28f15168d79d023611b5e5f63f31))
* **client:** add auth store with memory and local storage ([5b155bd](https://github.com/emresandikci/heybe/commit/5b155bd6ab072fbb7e971854f352d200608ceb72))
* **client:** add file urls, file tokens and batch requests ([6cf3d4e](https://github.com/emresandikci/heybe/commit/6cf3d4ed0733e305bf42f027aabadd2b2d5c9086))
* **client:** add logs, backups, sql and test S3 services ([a82730a](https://github.com/emresandikci/heybe/commit/a82730a96ac4d8576976e1cb3c274face3977e4b))
* **client:** add oauth2 popup and code flows ([59fbadb](https://github.com/emresandikci/heybe/commit/59fbadbf2c96fbcbf164d94b4b68988eb00bf40f))
* **client:** add realtime subscriptions over sse ([a3a67cb](https://github.com/emresandikci/heybe/commit/a3a67cbdcf137be98a73777cbf967e2b74318358))
* **client:** add request core with errors, auto-cancel and integration pair ([8fa5b1e](https://github.com/emresandikci/heybe/commit/8fa5b1eefd809f592711383ebea2272723cb446a))
* **client:** add superuser collections, settings, crons and health services ([8a58741](https://github.com/emresandikci/heybe/commit/8a587410ada6d0eca457d5d5fadc6ac8991e4c44))
* **client:** add typed records client ([3b61518](https://github.com/emresandikci/heybe/commit/3b615189310afcaadea3130451606e3aeb708c21))
