# [@heybe/core-v1.1.3](https://github.com/emresandikci/heybe/compare/@heybe/core@1.1.2...@heybe/core@1.1.3) (2026-11-26)


### Bug Fixes

* **core:** reject a file that is not a Heybe backup before restoring ([40a029e](https://github.com/emresandikci/heybe/commit/40a029e6da3df182cb6d09d3bfc5b15f6797cc24))

# [@heybe/core-v1.1.2](https://github.com/emresandikci/heybe/compare/@heybe/core@1.1.1...@heybe/core@1.1.2) (2026-11-24)


### Bug Fixes

* **core:** cap the WAL file at 16 MiB after a write burst ([777ac75](https://github.com/emresandikci/heybe/commit/777ac75ccfef951f6ef63c87d77510846df9f8bd))
* **core:** find modifier key fields renamed or replaced in place ([4a191d1](https://github.com/emresandikci/heybe/commit/4a191d15b3c1d361b04c0e463c25a1117f44f598))
* **core:** merge middleware headers from the original values on a reused response ([e2b57ff](https://github.com/emresandikci/heybe/commit/e2b57ff9d1fdaa7f0e633b230879af4fe41cb352))


### Performance Improvements

* **core:** cut request cost on reads, writes and downloads ([f912b65](https://github.com/emresandikci/heybe/commit/f912b65b775b732357aa5bc4a94f9356c1fe7a55))

# [@heybe/core-v1.1.1](https://github.com/emresandikci/heybe/compare/@heybe/core@1.1.0...@heybe/core@1.1.1) (2026-11-18)

# [heybe-v1.1.0](https://github.com/emresandikci/heybe/compare/heybe@1.0.0...heybe@1.1.0) (2026-11-18)


* refactor!: use the hb prefix for heybe's own ids ([63695bc](https://github.com/emresandikci/heybe/commit/63695bc3960a07fa4fb885a2c23dc279fa529121))


### BREAKING CHANGES

* Heybe data created before this change keeps pb ids and
is not migrated. Code that hardcodes pbc_ or _pb_users_auth_ ids must
use the hb ids or collection names.

# heybe-v1.0.0 (2026-11-16)


### Bug Fixes

* **backups:** apply phase 6 final review fixes ([e752b17](https://github.com/emresandikci/heybe/commit/e752b172de0a1c65daa43c2bfb85889203bcf3c2))
* **heybe:** accept a bare port for serve --http ([907d58a](https://github.com/emresandikci/heybe/commit/907d58ac78ae15f9712cf591077413a8ab20657c))
* **heybe:** align record, filter, view and batch edge cases with pocketbase ([da14d3f](https://github.com/emresandikci/heybe/commit/da14d3f98b8a1a0482526f37138338b606c2e1b8))
* **heybe:** apply phase 3 final review fixes ([eb3613d](https://github.com/emresandikci/heybe/commit/eb3613d32fcd484a2958e949cf59e2f87753549e))
* **heybe:** apply phase 4 final review fixes ([490c1ad](https://github.com/emresandikci/heybe/commit/490c1ada404bdb87c79d684db7a7ee3722e2419f))
* **heybe:** apply phase 8 final review fixes ([e8e5957](https://github.com/emresandikci/heybe/commit/e8e5957d34eb4bd63f46badb8809d7a8ce939b36))
* **heybe:** apply phase 9 final review fixes ([64f9b41](https://github.com/emresandikci/heybe/commit/64f9b4130e70e2e802c008c75f66071c4f93757c))
* **heybe:** bound the statement cache, log unexpected errors and drop dead query paths ([344fd2c](https://github.com/emresandikci/heybe/commit/344fd2c1d620f408cfe625e5f4da71dbc49edb1a))
* **heybe:** harden multipart keys, thumb cleanup and file route timeouts ([ae52398](https://github.com/emresandikci/heybe/commit/ae52398b806a5054b55595cb5ca4f832590569e9))
* **heybe:** parse oauth2 provider json strictly like go json v2 ([3b1daed](https://github.com/emresandikci/heybe/commit/3b1daed53000817fc998202068129b5e76815b88))
* **heybe:** port go servecontent ranges and preconditions, one s3 get per download ([214d1dc](https://github.com/emresandikci/heybe/commit/214d1dc4cc05ae00d8e61d936a7368e53b437cea))
* **heybe:** skip cascaded rows when truncating and cover unique index parity ([43f7488](https://github.com/emresandikci/heybe/commit/43f7488ece8fb02137b17c91e46a05b86532d6f5))
* **heybe:** stream multipart bodies with disk spill and bind forms like go ([881bf09](https://github.com/emresandikci/heybe/commit/881bf0969db85e4232d3ed5f80b115c01337659b))
* **heybe:** verify go bcrypt hashes on the first 72 bytes ([54d533f](https://github.com/emresandikci/heybe/commit/54d533f1a87dd88f386caa5ad6e4de8a3005d353))
* **mail:** port PB sendmail, scope OAuth2 auth styles and expire resend limits ([a9ea61f](https://github.com/emresandikci/heybe/commit/a9ea61f2d7256b6b1051d19a0bbe5c30c6d104cd))
* **query:** type relation paths separately and match pocketbase filter escaping ([d369fc3](https://github.com/emresandikci/heybe/commit/d369fc3410d34e58cf364626cbb0074dd0bb5dff))


### Features

* **backups:** add backup create, restore, restart and auto backups ([ba5fefa](https://github.com/emresandikci/heybe/commit/ba5fefaf4b5575444c66a48a40328134eae696d1))
* **backups:** add backups API ([312287b](https://github.com/emresandikci/heybe/commit/312287bf637e7a3fbc47a6ca105263db1e0ac6c2))
* **backups:** add streaming zip writer and extractor ([66a464d](https://github.com/emresandikci/heybe/commit/66a464dcd20114b2880e8218d635a16056fc3e52))
* **files:** add filesystem seam with list, watchers and symlink hardening ([32b187b](https://github.com/emresandikci/heybe/commit/32b187b31caf9d9595c71ef694809a4a2fc476d8))
* **files:** add S3 storage backend and settings test S3 ([04cf208](https://github.com/emresandikci/heybe/commit/04cf20810f2082697654ad0c589ae7aa2472aad9))
* **heybe:** add app lifecycle hooks and console commands ([7affcfb](https://github.com/emresandikci/heybe/commit/7affcfb4b63fe9e95664a34c4d6401834636047a))
* **heybe:** add auth, mail and settings hooks ([9e0ab8b](https://github.com/emresandikci/heybe/commit/9e0ab8b116f1e64b2a19d0689017540ca2522830))
* **heybe:** add automigrate and collections snapshot migrations ([1a69a27](https://github.com/emresandikci/heybe/commit/1a69a27d0bb2968f485c29a3828c7064340edb3b))
* **heybe:** add batch api with single-transaction writes and rule checks ([a846add](https://github.com/emresandikci/heybe/commit/a846add4d1efb594286033769f23e4e7a96682d4))
* **heybe:** add binary runtime pieces for embedded dashboard, sharp and restart ([69e3eda](https://github.com/emresandikci/heybe/commit/69e3edafc6cb6b4c27835207eb28241009a8847c))
* **heybe:** add collections api with pocketbase parity ([aa8547e](https://github.com/emresandikci/heybe/commit/aa8547e4b3e6163e88aa0b47f495623ab8f4a312))
* **heybe:** add cron scheduler, system jobs and crons api ([244d16c](https://github.com/emresandikci/heybe/commit/244d16c2e4f4f44e8858ffa8672bf9e69f1e6c30))
* **heybe:** add editor and geoPoint field types ([0aedfca](https://github.com/emresandikci/heybe/commit/0aedfcaf11baa41ca24251e4c195e80f7ad1b60e))
* **heybe:** add email verification, password reset and email change flows ([7ec8681](https://github.com/emresandikci/heybe/commit/7ec868195f8545c7ecf9eccf8f68b9e477d17f6c))
* **heybe:** add file downloads, protected files and file tokens ([7737178](https://github.com/emresandikci/heybe/commit/7737178b9818bba893220ce79b57c9362f759f6a))
* **heybe:** add heybe import for pocketbase data dirs ([8b07e60](https://github.com/emresandikci/heybe/commit/8b07e605b3130be51bf912cc4e23b789bbe8d564))
* **heybe:** add hook engine and pocketbase hook registry ([009ec65](https://github.com/emresandikci/heybe/commit/009ec6509674281886c3950cbcd67a93ce8cb71c))
* **heybe:** add http server, cli and pocketbase contract test harness ([2dd14d8](https://github.com/emresandikci/heybe/commit/2dd14d85460ddad0f4205f88a6705b6f0523936c))
* **heybe:** add impersonation and apple client secret generation ([b0dc76b](https://github.com/emresandikci/heybe/commit/b0dc76b6d06e34dc6752a89f2115004ae539723c))
* **heybe:** add local file storage, filename normalization and mime sniffing ([2957e37](https://github.com/emresandikci/heybe/commit/2957e37579af9d36a35bb66c897302297dbca6cb))
* **heybe:** add mailer, auth mail templates and test email route ([7eb1e87](https://github.com/emresandikci/heybe/commit/7eb1e87a3db5aea24d8c2f2d813a0b716e45c61a))
* **heybe:** add migrations runner and migrate command ([64f9d0d](https://github.com/emresandikci/heybe/commit/64f9d0dd64408094f53d8363d5d4bde87981c0fd))
* **heybe:** add model, record and collection lifecycle hooks ([279ed80](https://github.com/emresandikci/heybe/commit/279ed8055b868cb7fb854460d5dcb79435a4929c))
* **heybe:** add multi-factor authentication ([f3ea00d](https://github.com/emresandikci/heybe/commit/f3ea00d298b0282fc2e0d811bfd207f82968f7b0))
* **heybe:** add multipart file uploads with rollback on failed writes ([146e479](https://github.com/emresandikci/heybe/commit/146e479c254e54838905eb852a7ca884e6cc90c1))
* **heybe:** add new-login auth alerts and apply fields to auth responses ([89506f0](https://github.com/emresandikci/heybe/commit/89506f0c86609113a3425357c8d3b6cd1af8d4b3))
* **heybe:** add oauth2 login with account linking and pinned avatar downloads ([4bf7593](https://github.com/emresandikci/heybe/commit/4bf7593fc5d2870ccbf7aaecba80a01cc5038c51))
* **heybe:** add on-demand thumbnails with atomic file writes ([f2644a7](https://github.com/emresandikci/heybe/commit/f2644a7eb3d5d6c1fe6a25d7039e4e0a120fb525))
* **heybe:** add otp login with attempt limits and anti pre-hijack password reset ([b22e4c6](https://github.com/emresandikci/heybe/commit/b22e4c686e99c6cabf04dc94529b211fa16b3688))
* **heybe:** add password auth, token refresh and auth methods ([0e2cdd1](https://github.com/emresandikci/heybe/commit/0e2cdd147edae6cfe6e7bc8cb95a7f007758be15))
* **heybe:** add per-command help, version flag and strict flag parsing ([2c146cc](https://github.com/emresandikci/heybe/commit/2c146cc97103fba70049a82f65e6f7b5a8708ec7))
* **heybe:** add pocketbase filter and sort string parser ([4694c59](https://github.com/emresandikci/heybe/commit/4694c596dbfc27841c5f48d9f0324c9aaa65d1d5))
* **heybe:** add public records api and record model ([e781f15](https://github.com/emresandikci/heybe/commit/e781f151a35bbad7bf67ee395de2c06704379c7a))
* **heybe:** add realtime subscriptions and oauth2 redirect ([dca1798](https://github.com/emresandikci/heybe/commit/dca1798ea2a8e0d364b7a247ca09edd1eb3fe618))
* **heybe:** add record field types ([0e301df](https://github.com/emresandikci/heybe/commit/0e301dfb3b07bb86f281e902f63672b659dd0581))
* **heybe:** add record service and app factory ([fa387d8](https://github.com/emresandikci/heybe/commit/fa387d89932dc0f26757deeaefc6186cbe236ad9))
* **heybe:** add record, collection, batch and file request hooks ([915c8c0](https://github.com/emresandikci/heybe/commit/915c8c097086584522a2da476e7d02261bca2cb9))
* **heybe:** add records api with api rule enforcement ([d735a98](https://github.com/emresandikci/heybe/commit/d735a9887c571c01d57f22b78bda8431369e6908))
* **heybe:** add relation expand and back-relations with view rule checks ([2adec83](https://github.com/emresandikci/heybe/commit/2adec834c60c2c3b9d7cb4e3777c070aa3dd06e8))
* **heybe:** add router middleware chain and custom routes ([7fb93e9](https://github.com/emresandikci/heybe/commit/7fb93e911a51587324e2a99c1146b33af4b661d2))
* **heybe:** add serve domain args and https autocert ([18647dc](https://github.com/emresandikci/heybe/commit/18647dc9a4e025e24caf60821430611f0c9f6aaa))
* **heybe:** add settings api, superuser ip allowlist and installer ([af65923](https://github.com/emresandikci/heybe/commit/af65923b227c7efd7b5d6d1624d289829e769f76))
* **heybe:** add sqlite storage and collection schema sync ([bc53226](https://github.com/emresandikci/heybe/commit/bc53226d91a2ec38013a0e8a73b69a6e7fab0fde))
* **heybe:** add user mappers for all pocketbase oauth2 providers ([0c34bd9](https://github.com/emresandikci/heybe/commit/0c34bd9067baaf5ef126d634d07446302b004669))
* **heybe:** add view collections with inferred fields and dry-run ([f8cdbff](https://github.com/emresandikci/heybe/commit/f8cdbffa96236f1b2b00380d6216392fcedceb6b))
* **heybe:** compile filter ast into parameterized sql ([8df9a14](https://github.com/emresandikci/heybe/commit/8df9a14a5ece5b7b20929ba0e0f2bf0318a14d79))
* **heybe:** generate typescript types from collection schema ([825d4e5](https://github.com/emresandikci/heybe/commit/825d4e52756f44b55710176faacee21060f3cb4d))
* **http:** add rate limits and randomized list throttle ([03a59c1](https://github.com/emresandikci/heybe/commit/03a59c179092e219ce89f19b9de37e12bcd36115))
* **http:** add RequestEvent parity methods and field error codes ([d2811d2](https://github.com/emresandikci/heybe/commit/d2811d22d80874e75c755a68f71c372f0a99f35e))
* **http:** add superuser SQL API ([733ad74](https://github.com/emresandikci/heybe/commit/733ad74b5638c21ccc72ccdcbedc2e93f1d4dddb))
* **http:** serve the dashboard and ui extensions under /_/ ([69dfb40](https://github.com/emresandikci/heybe/commit/69dfb40be2d9b2c646325d7c6affcdbd418590b2))
* **logs:** add auxiliary db and batched app logger ([87239a6](https://github.com/emresandikci/heybe/commit/87239a6b464d46ff869a4caf12cfd0aea97f6eef))
* **logs:** add request activity logging and logs API ([1891870](https://github.com/emresandikci/heybe/commit/1891870c9b1e1e109db241cbb8d1b6db4d6e28a6))
* **query:** type expand results and relation targets, fix insensitive on non-strings ([7d49da6](https://github.com/emresandikci/heybe/commit/7d49da60f08a11d44088d89615c842467747c9a5))


### Performance Improvements

* **heybe:** add benchmark load guard, scenario filter and created index ([a188d4b](https://github.com/emresandikci/heybe/commit/a188d4be21f0e88920493ca02cd3d1fc81e2e864))
* **heybe:** cache collections and refresh them on _collections writes ([ddbb3f7](https://github.com/emresandikci/heybe/commit/ddbb3f733dffec4838eea04ba7ca0b89717ca39d))
* **heybe:** keep the log worker connection open and close it before restore ([5bec04f](https://github.com/emresandikci/heybe/commit/5bec04fbe401bdfd0c001eeb2e14d2a632f5e74e))
* **heybe:** read settings without cloning in the superuser ip check ([0928b2e](https://github.com/emresandikci/heybe/commit/0928b2e64c448fa9c1608d9c4a18c731cccca475))
* **heybe:** run the record view rule and fetch in one query ([1a41316](https://github.com/emresandikci/heybe/commit/1a41316d5118ed9be50f1f37daed5b494af30fa1))
* **heybe:** sniff downloads once and gzip dashboard assets ([7cef4eb](https://github.com/emresandikci/heybe/commit/7cef4ebb488cd03191c8f4f1eef05f71ef98b97a))
* **heybe:** write request logs from a worker thread ([bf68a7e](https://github.com/emresandikci/heybe/commit/bf68a7ed9c1b2f0b501247a1746a7361d4f9dd94))
