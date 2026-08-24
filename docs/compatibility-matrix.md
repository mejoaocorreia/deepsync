# Compatibility matrix

| Target | Version | Detection | Config proof | Activation proof | Mutation mode |
|---|---:|---|---|---|---|
| DeepSeek Harness | 0.1.1-rc.2 | Supported | `--dump-config` | Isolated Loader fixture evidence | Isolated `deepsync-test` profile only |
| DeepSeek Harness | Other | Unsupported | Not claimed | Not claimed | Rejected |

Version is one input, not the compatibility result. The adapter also verifies the isolation marker, readable profile composition, bundle manifest confinement, artifact identity, package installation, bundle selection, Loader execution, plugin health evidence, and rollback config hash.

DSH 0.1.1-rc.2 has no profile lease that can prove an existing profile is stopped. Alpha.1 therefore offers no in-place mutation mode, including for the Web profile.
