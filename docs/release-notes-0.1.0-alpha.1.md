# DeepSync 0.1.0-alpha.1

DeepSync's first public alpha provides a target-neutral headless Core, deterministic transaction journal, idempotent requests, last-known-good snapshots, verified rollback, artifact quarantine, deterministic Doctor evidence, a minimal SHA-256-verified GitHub public release source, and a real DSH 0.1.1-rc.2 adapter.

The release includes an isolated DSH lifecycle probe with healthy, activation-failure, and health-failure scenarios. It does not modify existing profiles, migrate plugins, execute extensions in Core, or depend on Cortex.

## Known limitations

- Only DSH 0.1.1-rc.2 is supported.
- Apply creates and mutates only a DeepSync-marked isolated `deepsync-test` profile.
- GitHub source is a programmatic package API in Alpha.1; CLI `plan add` accepts local package directories.
- Packages remain marked private until npm ownership of `deepsync` and `@deepsync` is confirmed.
- Trust signing, AI Doctor, Hub, accounts, telemetry, containers, certification, and additional targets are not included.
