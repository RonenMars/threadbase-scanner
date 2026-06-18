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
