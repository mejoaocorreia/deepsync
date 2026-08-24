# Compatibility matrix

| Target | Version | Detection | Config proof | Activation proof | Mutation mode |
|---|---:|---|---|---|---|
| DeepSeek Harness | 0.1.1-rc.2 | Supported | `--dump-config` | Isolated Loader plus declared health evidence | New `deepsync-test` profile only |
| DeepSeek Harness | Other | Unsupported | Not claimed | Not claimed | Rejected |

Version is one input, not the compatibility result. The adapter also verifies a canonical-home and nonce-bound isolation marker, readable profile composition, packed archive safety, full artifact identity, target and capability declarations, package installation, exact artifact selection, bundle selection, Loader execution, declared plugin health evidence, rollback config hash, and rollback profile-tree digest.

DSH 0.1.1-rc.2 has no profile lease that can prove an existing profile is stopped. This alpha therefore offers no existing-profile or in-place mutation mode, including for the Web profile.
