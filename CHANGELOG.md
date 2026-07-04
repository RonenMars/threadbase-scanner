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
