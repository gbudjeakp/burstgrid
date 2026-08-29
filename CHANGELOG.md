# Changelog

## [1.7.3](https://github.com/gbudjeakp/burstgrid/compare/v1.7.2...v1.7.3) (2026-08-29)


### Bug Fixes

* speed up job pickup and isolate runner work dirs ([07b22bc](https://github.com/gbudjeakp/burstgrid/commit/07b22bc076af2d41f7c141526b59d0e6e5dcf295))

## [1.7.2](https://github.com/gbudjeakp/burstgrid/compare/v1.7.1...v1.7.2) (2026-08-29)


### Bug Fixes

* unmark provisioned state on any terminal job status to prevent 30-min stalls ([1dac963](https://github.com/gbudjeakp/burstgrid/commit/1dac96380baf2d29ef59b88e5fdf34196874d665))

## [1.7.1](https://github.com/gbudjeakp/burstgrid/compare/v1.7.0...v1.7.1) (2026-08-29)


### Bug Fixes

* unmark provisioned state on runner failure so reconciler retries immediately ([95e7f9e](https://github.com/gbudjeakp/burstgrid/commit/95e7f9e))
* schedule follow-up probe when per-run lock is held to prevent sibling job starvation ([f241637](https://github.com/gbudjeakp/burstgrid/commit/f241637))

## [1.7.0](https://github.com/gbudjeakp/burstgrid/compare/v1.6.2...v1.7.0) (2026-08-29)


### Features

* GitHub-native job reconciliation for self-hosted runners ([f2c1ada](https://github.com/gbudjeakp/burstgrid/commit/f2c1adab942c2944b6ae8c05b2ee5e9d7c188d97))
* GitHub-native job reconciliation for self-hosted runners ([068ae2d](https://github.com/gbudjeakp/burstgrid/commit/068ae2dba28cf1019ecfd781def42bbd28818bcd))

## [1.6.2](https://github.com/gbudjeakp/burstgrid/compare/v1.6.1...v1.6.2) (2026-08-29)


### Bug Fixes

* **terraform:** escape bash default ${VAR:-fallback} in .tpl; add slot+agent tests ([4936e44](https://github.com/gbudjeakp/burstgrid/commit/4936e440873fd6c7a72546cf7f5da1fcb33ad1a1))
* **tests:** fix agent test duplicate symbol ([8a18034](https://github.com/gbudjeakp/burstgrid/commit/8a1803423e3fd29bd84c0199f4b90a2de15070ea))
* **tests:** fix TS errors — ConstructorParameters and spy cast ([4942cf6](https://github.com/gbudjeakp/burstgrid/commit/4942cf630b46f1102c54143dc4838b338f0179c8))
* **tests:** use wait() for rejection in slot process mode test ([2c614f3](https://github.com/gbudjeakp/burstgrid/commit/2c614f3a9e7e8205bf605ba0ec4abd0ff2361412))
* **worker:** per-slot runner directory isolation ([168b3c0](https://github.com/gbudjeakp/burstgrid/commit/168b3c025665059fcfc03aac99d1f0e69967aabf))
* **worker:** per-slot runner directory isolation ([1429f3f](https://github.com/gbudjeakp/burstgrid/commit/1429f3f356c4e1d1d9d0867a56e1afa00985bb23))

## [1.6.1](https://github.com/gbudjeakp/burstgrid/compare/v1.6.0...v1.6.1) (2026-08-29)


### Bug Fixes

* **worker:** dynamic RUNNER_REPO_URL + clean stale runner state ([be8d722](https://github.com/gbudjeakp/burstgrid/commit/be8d722311b76fd32d6ee4a0c922cbaa025d704e))
* **worker:** dynamic RUNNER_REPO_URL; clean stale runner state ([459af76](https://github.com/gbudjeakp/burstgrid/commit/459af7660b6e433ccbffa4408aa079f04cd7c249))

## [1.6.0](https://github.com/gbudjeakp/burstgrid/compare/v1.5.3...v1.6.0) (2026-08-29)


### Features

* **ci:** fix sudo prem ([c49224a](https://github.com/gbudjeakp/burstgrid/commit/c49224a6b178854945ce46d363d5c170e10ea06b))
* **ci:** fix sudo prem ([917d5e2](https://github.com/gbudjeakp/burstgrid/commit/917d5e2b04a1394dbcd405b9f72600f4d24477bc))

## [1.5.3](https://github.com/gbudjeakp/burstgrid/compare/v1.5.2...v1.5.3) (2026-08-29)


### Bug Fixes

* **autoscaler:** spot → on-demand fallback; 2xlarge fleet uses m6g.4x… ([6ddf641](https://github.com/gbudjeakp/burstgrid/commit/6ddf641de1f016791ba727942e5a22da8b205ebd))
* **autoscaler:** spot → on-demand fallback; 2xlarge fleet uses m6g.4xlarge ([26e900e](https://github.com/gbudjeakp/burstgrid/commit/26e900efdfac3f08b9ff537447ad8c8068d22e0c))

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
