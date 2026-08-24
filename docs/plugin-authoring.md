# Author a DSH plugin

DeepSync 0.1.0-alpha.3 accepts ordinary DSH bundle packages that implement the public DeepSync manifest and health protocol. Start from [`docs/templates/dsh-plugin`](templates/dsh-plugin); the template has no imports from DeepSync or repository internals.

## 1. Create the package

A plugin package needs four published files:

- `package.json` with `main` or `exports`, an explicit `files` list, and native `dsh.bundle.patch` metadata;
- the entrypoint used by DSH Loader;
- the native Cordis patch named by `dsh.bundle.patch`;
- `deepsync.manifest.json`, the small lifecycle declaration consumed by DeepSync.

The universal manifest owns identity, version, capabilities, and target bindings. The DSH binding owns the exact DSH runtime, Node.js range, and health declaration. The native package metadata continues to own the Cordis patch. Hub descriptions, marketing metadata, signatures, and verification results do not belong in the manifest.

The schemas are public package exports:

```text
@deepsync/contracts/schemas/plugin-manifest-v1.json
@deepsync/contracts/schemas/dsh-target-binding-v1.json
@deepsync/contracts/schemas/dsh-health-result-v1.json
```

The corresponding TypeScript exports are `PluginManifestV1`, `DshTargetBindingV1`, `DshHealthDeclarationV1`, and `DshHealthResultV1`. Runtime validation is available through the package-root `validate*Document` functions; external code must not use deep imports.

## 2. Emit generic health evidence

During the isolated activation attempt, DeepSync supplies these environment variables to DSH Loader:

| Variable | Meaning |
|---|---|
| `DEEPSYNC_HEALTH_PROTOCOL` | Always `deepsync.health/v1` for this protocol |
| `DEEPSYNC_HEALTH_RESULT_PATH` | Confined output filename declared by the plugin |
| `DEEPSYNC_PLUGIN_ID` | Planned identity; informational only |
| `DEEPSYNC_PLUGIN_VERSION` | Planned version; informational only |
| `DEEPSYNC_TARGET_INSTANCE_ID` | Isolated target identity to copy into the result |
| `DEEPSYNC_ACTIVATION_ATTEMPT_ID` | Planned activation identity to copy into the result |

The plugin must hard-code or obtain its own `pluginId` and `pluginVersion` from its built package; it must not echo the informational identity variables. It writes one JSON result to `DEEPSYNC_HEALTH_RESULT_PATH`:

```json
{
  "schemaVersion": 1,
  "protocol": "deepsync.health/v1",
  "pluginId": "example-ready",
  "pluginVersion": "1.0.0",
  "targetInstanceId": "value from DEEPSYNC_TARGET_INSTANCE_ID",
  "activationAttemptId": "value from DEEPSYNC_ACTIVATION_ATTEMPT_ID",
  "status": "healthy",
  "observedAt": "2026-08-24T00:00:00.000Z",
  "summary": "Example plugin is ready"
}
```

DeepSync removes an old result before activation, validates the schema and timestamp, and correlates plugin ID, plugin version, target instance, and activation attempt. Loader observation and plugin health are separate evidence entries. Missing, malformed, stale, mismatched, or `unhealthy` evidence prevents commit.

## 3. Validate and pack

From a built DeepSync checkout:

```powershell
node apps/cli/dist/bin.mjs plugin validate C:\path\to\plugin --json
node apps/cli/dist/bin.mjs doctor plugin C:\path\to\plugin --json

pnpm --dir C:\path\to\plugin pack --pack-destination C:\path\to\release
node apps/cli/dist/bin.mjs plugin validate C:\path\to\release\plugin-1.0.0.tgz --json
```

Validation checks JSON schemas, IDs and versions, package/manifest consistency, DSH runtime and capability requirements, Node.js range, health declaration, published files, entrypoint, native patch metadata, archive safety, and complete artifact digest. `plugin validate` returns exit 12 for an invalid plugin; `doctor plugin` returns exit 10. Both emit stable issue codes, JSON Pointer paths, and remediation with `--json`.

## 4. Plan and apply locally

Use a new empty home. DeepSync creates only the nonce-bound `deepsync-test` profile and never touches the active Web profile.

```powershell
$Home = Join-Path $env:TEMP ('external-plugin-' + [guid]::NewGuid())
$Plan = Join-Path $Home 'plan.json'
$State = Join-Path $Home 'state.json'

node apps/cli/dist/bin.mjs plan add C:\path\to\plugin `
  --dsh-root C:\path\to\deepseek-harness `
  --home $Home --out $Plan --state $State --json
node apps/cli/dist/bin.mjs apply $Plan --state $State --json
node apps/cli/dist/bin.mjs status --state $State --json
```

The positional source may be the package directory or its already packed `.tgz`. A directory is packed first; an existing artifact is copied atomically into the same digest-addressed cache. DeepSync validates the complete `.tgz` and binds its SHA-256 into the request and plan. Apply verifies the same bytes before staging. DSH `--dump-config`, exact installation, selected bundle, Loader execution, and correlated plugin health must all pass before commit. Failed activation or health triggers verified rollback and artifact quarantine; a prior committed LKG remains the target head.

A direct `dsh --profile deepsync-test --dump-config` can inspect the isolated composed config, but DeepSync must own creation and lifecycle of the test home because it supplies the correlation values and verifies rollback.

## 5. Plan from a GitHub Release

Publish the plugin `.tgz` as an exact release asset and publish its SHA-256. Then use an immutable tag, exact asset name, and complete digest:

```powershell
node apps/cli/dist/bin.mjs plan add `
  --github owner/plugin-repository `
  --tag v1.0.0 `
  --asset plugin-1.0.0.tgz `
  --digest sha256:<64-lowercase-hex> `
  --dsh-root C:\path\to\deepseek-harness `
  --home $Home --out $Plan --state $State --json
```

Public repositories need no OAuth token. `latest`, branch-like mutable references, missing checksums, implicit asset selection, and digest mismatches are rejected. Downloads are bounded, streamed, atomically cached, and reusable offline after verification.

## Alpha limitations

The supported target is exactly DSH `0.1.1-rc.2` at commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`. Only new, dedicated isolated homes are supported; existing profiles and the active Web profile are rejected. The public contracts are versioned but remain alpha and may evolve through a new schema version. npm packages are not available until the `@deepsync` scope is accessible. SDK, Creator, Hub, signing, additional targets, and Hermes Projects adaptation remain future work.
