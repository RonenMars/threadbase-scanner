## [0.11.0](https://github.com/RonenMars/threadbase-scanner/compare/v0.10.2...v0.11.0) (2026-07-16)

### Features

* **release:** patch-release every commit type except docs and ci ([#45](https://github.com/RonenMars/threadbase-scanner/issues/45)) ([d8b514a](https://github.com/RonenMars/threadbase-scanner/commit/d8b514aacb50d6f5d67407de818e89dcb579e169)), closes [#44](https://github.com/RonenMars/threadbase-scanner/issues/44)

## [0.10.2](https://github.com/RonenMars/threadbase-scanner/compare/v0.10.1...v0.10.2) (2026-07-16)

### Bug Fixes

* **deps:** trigger release for biome, types/node, and flexsearch bumps ([#44](https://github.com/RonenMars/threadbase-scanner/issues/44)) ([b4a008b](https://github.com/RonenMars/threadbase-scanner/commit/b4a008b35b8ab7f0a4c21cd4ad49ff985bfffaed)), closes [#13](https://github.com/RonenMars/threadbase-scanner/issues/13) [#14](https://github.com/RonenMars/threadbase-scanner/issues/14) [#15](https://github.com/RonenMars/threadbase-scanner/issues/15)

## [0.10.1](https://github.com/RonenMars/threadbase-scanner/compare/v0.10.0...v0.10.1) (2026-07-12)

### Bug Fixes

* **scanner:** ignore checkpoints past the current eof when paging ([#42](https://github.com/RonenMars/threadbase-scanner/issues/42)) ([d5dbd68](https://github.com/RonenMars/threadbase-scanner/commit/d5dbd68c73778cba77eec92533c696221f6bf17b))

## [0.10.0](https://github.com/RonenMars/threadbase-scanner/compare/v0.9.4...v0.10.0) (2026-07-12)

### Features

* **scanner:** make live-file refresh and paging incremental ([#41](https://github.com/RonenMars/threadbase-scanner/issues/41)) ([0940933](https://github.com/RonenMars/threadbase-scanner/commit/094093345e93c1739c37fb0cd41aa14ec5063663))

## [0.9.4](https://github.com/RonenMars/threadbase-scanner/compare/v0.9.3...v0.9.4) (2026-07-05)

### Bug Fixes

* **scanner:** re-glob a watermarked dir when its file rows are missing ([#40](https://github.com/RonenMars/threadbase-scanner/issues/40)) ([789875e](https://github.com/RonenMars/threadbase-scanner/commit/789875ee7a3677a9955f925ed7b82e592edeecc7))

## [0.9.3](https://github.com/RonenMars/threadbase-scanner/compare/v0.9.2...v0.9.3) (2026-07-05)

### Bug Fixes

* **scanner:** scope deletion-reconcile to the accounts a scan covered ([#39](https://github.com/RonenMars/threadbase-scanner/issues/39)) ([d903868](https://github.com/RonenMars/threadbase-scanner/commit/d903868ccbed473dc0c68efda6d54fd9a5b74101))

## [0.9.2](https://github.com/RonenMars/threadbase-scanner/compare/v0.9.1...v0.9.2) (2026-07-05)

### Bug Fixes

* **scanner:** await in-flight scan and reconcile before close() shuts the DB ([#38](https://github.com/RonenMars/threadbase-scanner/issues/38)) ([a3e7fee](https://github.com/RonenMars/threadbase-scanner/commit/a3e7fee405ee5662d8029f3e7e1ef5b38e5ce176)), closes [#4](https://github.com/RonenMars/threadbase-scanner/issues/4)

## [0.9.1](https://github.com/RonenMars/threadbase-scanner/compare/v0.9.0...v0.9.1) (2026-07-04)

### Bug Fixes

* **migrations:** create scanned_dirs on existing v3 databases ([#37](https://github.com/RonenMars/threadbase-scanner/issues/37)) ([79713a0](https://github.com/RonenMars/threadbase-scanner/commit/79713a037aa80b2086ef872401b0fa04f44c1964))

## [0.9.0](https://github.com/RonenMars/threadbase-scanner/compare/v0.8.4...v0.9.0) (2026-07-04)

### Features

* **scanner:** skip the discovery glob for unchanged project directories ([#36](https://github.com/RonenMars/threadbase-scanner/issues/36)) ([b25652d](https://github.com/RonenMars/threadbase-scanner/commit/b25652d0b36211866cd5cf4bedb3b3348bf98bb4)), closes [#34](https://github.com/RonenMars/threadbase-scanner/issues/34) [#35](https://github.com/RonenMars/threadbase-scanner/issues/35)

## [0.8.4](https://github.com/RonenMars/threadbase-scanner/compare/v0.8.3...v0.8.4) (2026-07-04)

### Bug Fixes

* **scanner:** stop forcing refreshFile() to reparse from offset 0 ([#35](https://github.com/RonenMars/threadbase-scanner/issues/35)) ([180f3eb](https://github.com/RonenMars/threadbase-scanner/commit/180f3ebee9bf77468f0876c645f5dbfac4be49a3)), closes [#34](https://github.com/RonenMars/threadbase-scanner/issues/34)

## [0.8.3](https://github.com/RonenMars/threadbase-scanner/compare/v0.8.2...v0.8.3) (2026-07-04)

### Bug Fixes

* **cursor:** reindex on replace-with-larger-different file, not blended append ([#34](https://github.com/RonenMars/threadbase-scanner/issues/34)) ([e4e1533](https://github.com/RonenMars/threadbase-scanner/commit/e4e1533e74872a7d8f53b10989891c1f69609b8b))

## [0.8.2](https://github.com/RonenMars/threadbase-scanner/compare/v0.8.1...v0.8.2) (2026-06-22)

### Bug Fixes

* **scanner:** serve codex messages from getConversationPage ([#33](https://github.com/RonenMars/threadbase-scanner/issues/33)) ([50c31e1](https://github.com/RonenMars/threadbase-scanner/commit/50c31e1e42f24e8bb4c245062ee3715652020723))

## [0.8.1](https://github.com/RonenMars/threadbase-scanner/compare/v0.8.0...v0.8.1) (2026-06-21)

### Bug Fixes

* **scanner:** treat empty profiles array as scan-none not load-defaults ([#32](https://github.com/RonenMars/threadbase-scanner/issues/32)) ([52d1ee1](https://github.com/RonenMars/threadbase-scanner/commit/52d1ee18f2d0ecf3e93c6d2f7425bab6e2ef177a))

## [0.8.0](https://github.com/RonenMars/threadbase-scanner/compare/v0.7.2...v0.8.0) (2026-06-21)

### Features

* **release:** publish @threadbase-sh/scanner to public npm ([#23](https://github.com/RonenMars/threadbase-scanner/issues/23)) ([0d83a27](https://github.com/RonenMars/threadbase-scanner/commit/0d83a27d3a703984a19d107d75bfba9f9f53872f))
* SQLite persistent engine + add Codex as a new local conversations provider  ([#30](https://github.com/RonenMars/threadbase-scanner/issues/30)) ([56d220b](https://github.com/RonenMars/threadbase-scanner/commit/56d220bd9e6ddce8c51fe4231a5c0374ea2fbfb1)), closes [#29](https://github.com/RonenMars/threadbase-scanner/issues/29) [#27](https://github.com/RonenMars/threadbase-scanner/issues/27) [#25](https://github.com/RonenMars/threadbase-scanner/issues/25) [#26](https://github.com/RonenMars/threadbase-scanner/issues/26) [#28](https://github.com/RonenMars/threadbase-scanner/issues/28) [#25](https://github.com/RonenMars/threadbase-scanner/issues/25) [#26](https://github.com/RonenMars/threadbase-scanner/issues/26) [#27](https://github.com/RonenMars/threadbase-scanner/issues/27) [#28](https://github.com/RonenMars/threadbase-scanner/issues/28) [#29](https://github.com/RonenMars/threadbase-scanner/issues/29)

### Bug Fixes

* **release:** commit-analysis-only precheck + OIDC trusted publishing ([#31](https://github.com/RonenMars/threadbase-scanner/issues/31)) ([3fa4cc0](https://github.com/RonenMars/threadbase-scanner/commit/3fa4cc00875566a8eead793b46c534316e59e4cb)), closes [#30](https://github.com/RonenMars/threadbase-scanner/issues/30)

## [0.7.2](https://github.com/RonenMars/threadbase-scanner/compare/v0.7.1...v0.7.2) (2026-06-18)

### Performance Improvements

* **discovery:** parallelize stat loop ([#21](https://github.com/RonenMars/threadbase-scanner/issues/21)) ([6385e11](https://github.com/RonenMars/threadbase-scanner/commit/6385e116f2caeda2290fd501374a12188b74e2c5))

## [0.7.1](https://github.com/RonenMars/threadbase-scanner/compare/v0.7.0...v0.7.1) (2026-06-17)

### Bug Fixes

* **ci:** dispatch to streamer from release workflow, not tag push event ([#20](https://github.com/RonenMars/threadbase-scanner/issues/20)) ([12ef282](https://github.com/RonenMars/threadbase-scanner/commit/12ef2829980562b6def3f227d10934a4c057b087))

## [0.7.0](https://github.com/RonenMars/threadbase-scanner/compare/v0.6.0...v0.7.0) (2026-06-17)

### Features

* **scanner:** add stat-based scan cache to skip unchanged files ([#17](https://github.com/RonenMars/threadbase-scanner/issues/17)) ([40b6274](https://github.com/RonenMars/threadbase-scanner/commit/40b6274b2740e3b7c2208c3c292da9d14bbc4dff))

## [0.6.0](https://github.com/RonenMars/threadbase-scanner/compare/v0.5.0...v0.6.0) (2026-06-17)

### Features

* **ci:** add semantic-release with GitHub release notes and streamer dispatch ([#18](https://github.com/RonenMars/threadbase-scanner/issues/18)) ([de3865d](https://github.com/RonenMars/threadbase-scanner/commit/de3865ddc26728c77c535cd838d3faa1fbf68032))
* **scanner:** add parseSingleFilePage for scan-free single-file reads ([#16](https://github.com/RonenMars/threadbase-scanner/issues/16)) ([b2990db](https://github.com/RonenMars/threadbase-scanner/commit/b2990dba0be06d7085bf4e073d3468bc0eb574da))

### Bug Fixes

* **ci:** rename secret to SEMANTIC_RELEASE_PAT ([#19](https://github.com/RonenMars/threadbase-scanner/issues/19)) ([3870e3f](https://github.com/RonenMars/threadbase-scanner/commit/3870e3fa0d3e9850af3929f24e345079dffd970a))
