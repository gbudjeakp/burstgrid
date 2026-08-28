# Changelog

## [1.5.2](https://github.com/gbudjeakp/burstgrid/compare/v1.5.1...v1.5.2) (2026-08-28)


### Bug Fixes

* **ci:** update spot test fixture to real EventBridge format; terraform fmt ([90973e4](https://github.com/gbudjeakp/burstgrid/commit/90973e425970a1dbe0ae50945f77ccb99e49a7a8))
* resolve 7 bugs found during live load-test run ([bef8ebf](https://github.com/gbudjeakp/burstgrid/commit/bef8ebf9c43d20ee48d5d85cbecdc50cab2a9dde))

## [1.5.1](https://github.com/gbudjeakp/burstgrid/compare/v1.5.0...v1.5.1) (2026-08-28)


### Bug Fixes

* **build:** bundle all deps for standalone EC2 deployment ([154c017](https://github.com/gbudjeakp/burstgrid/commit/154c01760e627297659c871ac28d27a58214076d))
* **deploy:** fix 28 bugs found during live load-test setup ([b627f3d](https://github.com/gbudjeakp/burstgrid/commit/b627f3d2829eb8759d667eea9859bb5b70601082))

## [1.5.0](https://github.com/gbudjeakp/burstgrid/compare/v1.4.0...v1.5.0) (2026-08-28)


### Features

* Grafana dashboard, changelog link, make demo ([662a860](https://github.com/gbudjeakp/burstgrid/commit/662a8601c088dff1d3a93254d737c748c9ac7e25))
* Grafana dashboard, changelog link, make demo ([966df7b](https://github.com/gbudjeakp/burstgrid/commit/966df7be041b854118c2fd3afb27be67bc8eaf18))

## [1.4.0](https://github.com/gbudjeakp/burstgrid/compare/v1.3.0...v1.4.0) (2026-08-27)


### Features

* health/readiness endpoints, worker health server, autoscaler pending-launch guard ([af49a3b](https://github.com/gbudjeakp/burstgrid/commit/af49a3b14938aa1f59d7c1a82d9d7d128f6346f2))

## [1.3.0](https://github.com/gbudjeakp/burstgrid/compare/v1.2.0...v1.3.0) (2026-08-27)


### Features

* **reliability:** watchdog, graceful drain, config validation, on-de… ([d5aec43](https://github.com/gbudjeakp/burstgrid/commit/d5aec4320efb5d4606730406158e5e047c7b7de2))
* **reliability:** watchdog, graceful drain, config validation, on-demand EC2 ([60f7c38](https://github.com/gbudjeakp/burstgrid/commit/60f7c3838c3a6ab5cd65a5e65ff2b70e9480d7c9))

## [1.2.0](https://github.com/gbudjeakp/burstgrid/compare/v1.1.0...v1.2.0) (2026-08-27)


### Features

* **observability:** job-level OTel metrics, DynamoDB lifecycle write… ([9f3e7f4](https://github.com/gbudjeakp/burstgrid/commit/9f3e7f49233036c5333919bfc79146f8d2c0ab2c))
* **observability:** job-level OTel metrics, DynamoDB lifecycle writes, and traces ([62b4146](https://github.com/gbudjeakp/burstgrid/commit/62b41464e8ea726c6b615bec6377c42290d7753c))

## [1.1.0](https://github.com/gbudjeakp/burstgrid/compare/v1.0.0...v1.1.0) (2026-08-26)


### Features

* VM_BOOT_TARGET_MS contract; simulate models boot latency; update hero copy ([27d6b18](https://github.com/gbudjeakp/burstgrid/commit/27d6b180fad369b7abccf264212e8a7a76f5caf1))

## 1.0.0 (2026-08-26)


### Features

* Docker registry pull-through cache for VMs ([2d90001](https://github.com/gbudjeakp/burstgrid/commit/2d90001718da99585bbb669fd05d9c5ecfa8cd11))
* **gpu-ai:** GPU/AI workload tier with pre-baked AMI support ([8b1cc7d](https://github.com/gbudjeakp/burstgrid/commit/8b1cc7d11ae83d156f997c0ef98c2ff26e3f8031))
* GPU/bare-metal routing, large VM sizes, image labels, registry cache, local dev stack ([aebde9e](https://github.com/gbudjeakp/burstgrid/commit/aebde9e1747c653135388155b4cc2fb66b59a62c))
* GPU/bare-metal routing, large VM sizes, image labels, simulate mode ([bc9b39a](https://github.com/gbudjeakp/burstgrid/commit/bc9b39a23984ab17ac5aacb477f6bea84751010f))
* GpuAmiProfile.dockerEnabled, prePulledImages, env fields ([ed31f16](https://github.com/gbudjeakp/burstgrid/commit/ed31f1653287e24c1f2022f367cc042e34a04be1))
* **images:** explicit rootfs image catalog in config ([e61d68c](https://github.com/gbudjeakp/burstgrid/commit/e61d68cdcdc79c00b69b0ca8bd71b4116935fc0a))
* optional Redis, SQS, and DynamoDB backends ([f726db5](https://github.com/gbudjeakp/burstgrid/commit/f726db54ae7ce7fbe1685e5499878faa0d7857b4))
* **rootfs:** image build toolchain + self-documenting catalog ([28981f6](https://github.com/gbudjeakp/burstgrid/commit/28981f613085552c2ded26f3a02313a15fa7eb61))


### Bug Fixes

* **ci:** remove dependency-review job (requires Dependency graph) ([b2ecf7a](https://github.com/gbudjeakp/burstgrid/commit/b2ecf7a10823e69fe8e9b2ab757c24ed2e456df7))
* **ci:** remove duplicate pnpm version — read from packageManager ([09056fd](https://github.com/gbudjeakp/burstgrid/commit/09056fdffa67d7c1d0dc3694b7c2e9a7dc0251ff))
* **docs:** change sidebar nav element to div ([dcc176a](https://github.com/gbudjeakp/burstgrid/commit/dcc176a7f59b8350f36485093b1101ffb0002c5a))
* **docs:** remove double border on how-it-works section ([c342699](https://github.com/gbudjeakp/burstgrid/commit/c342699cef07ac002eda2bec673f41966ae4979e))
* **docs:** sidebar nav inheriting global nav styles ([8bc8bd9](https://github.com/gbudjeakp/burstgrid/commit/8bc8bd961ef3da87caad1fb026ff273e6a80af57))
* GpuAI missing from TIER_PRIORITY — gpu jobs would crash queue on enqueue ([ed31f16](https://github.com/gbudjeakp/burstgrid/commit/ed31f1653287e24c1f2022f367cc042e34a04be1))
* registry pull-through cache TTL and GC ([5bc0def](https://github.com/gbudjeakp/burstgrid/commit/5bc0def96986e191ec9c128fdb91e12d73dd9c44))
* **security:** resolve all moderate+ audit CVEs ([44b0279](https://github.com/gbudjeakp/burstgrid/commit/44b02795b1b5790f032f09b5ab3266ced33f671b))
