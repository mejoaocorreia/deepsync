# DeepSync 0.1.0-alpha.3

Alpha.3 closes the plugin readiness gate for independent DSH plugin authors. It evolves the public alpha contracts and therefore supersedes the unpublished Alpha.2 draft; it does not rewrite the published Alpha.1 release.

## Public author surface

- `@deepsync/contracts` exports typed universal manifests, versioned target bindings, DSH binding v1, source and packed-artifact references, structured validation issues, and `deepsync.health/v1`.
- The package ships explicit JSON Schema exports for plugin manifests, DSH bindings, and DSH health results. Runtime validators and typed fixtures test the schemas against the TypeScript contracts.
- DSH health is plugin-neutral and correlated to plugin ID, built version, target instance, timestamp, and activation attempt. Loader observation and plugin health are independent evidence checks.
- `deepsync plugin validate <path|artifact>` and `deepsync doctor plugin <path|artifact>` validate source packages and complete archives with stable codes, JSON Pointer paths, remediation, and JSON output.
- `plan add` accepts a local package or an exact public GitHub Release asset selected by repository, immutable tag, exact asset name, and mandatory SHA-256.
- A public template and author guide cover package creation, manifest and binding declarations, generic health, validation, packing, isolated apply, and GitHub Release publication.

## Evidence

Release gates validate all package exports and three schema subpath exports from local tarballs in an offline consumer. The same temporary consumer creates an independent plugin package, validates source and packed forms through the packed CLI, and imports only public package exports.

Pinned DSH E2E covers healthy commit, activation failure, unhealthy or invalid correlated health, verified rollback, artifact quarantine, and restoration of a prior committed LKG. The external-author E2E installs the packed Alpha.3 CLI and packages into a clean consumer before exercising that lifecycle.

## Compatibility and limits

DSH compatibility remains limited to version `0.1.1-rc.2` at public source commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`. Only a new `deepsync-test` profile in a dedicated nonce-bound home is supported. Existing profiles, copied markers, the active Web profile, migration, other targets, Hub/UI, telemetry, signing, Creator, AI Doctor, and Hermes Projects adaptation remain out of scope.

All npm package manifests remain private. npm publication requires membership of the existing `@deepsync` organization and is not part of this release preparation run.
